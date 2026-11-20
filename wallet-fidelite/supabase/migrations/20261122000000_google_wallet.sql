-- ════════════════════════════════════════════════════════════════════════════
-- Phase 3 — Google Wallet : fonctions RÉSERVÉES AU SERVEUR (service_role).
--
--   • google_claim_notification : budget de notifications par carte. Google limite à 3 par 24 h
--     les messages qui notifient ; on en garde une en réserve pour « récompense disponible ».
--   • google_mark_card : mémorise l'identifiant de la carte côté Google et la plateforme.
--   • loyalty_class_data : ce qu'il faut pour décrire un programme à Google (une « classe » par programme).
-- ════════════════════════════════════════════════════════════════════════════

create table private.google_notifications (
  id      uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id) on delete cascade,
  kind    text not null check (kind in ('stamp', 'reward')),
  sent_at timestamptz not null default clock_timestamp()
);
create index google_notifications_card_sent on private.google_notifications (card_id, sent_at desc);
revoke all on table private.google_notifications from public, anon, authenticated;

-- Demande l'autorisation d'envoyer une notification. true = autorisée (et comptée), false = budget épuisé.
-- Tampon ordinaire : 2 par 24 h au plus ; récompense : jusqu'à 3 (la 3e place lui est réservée).
create or replace function public.google_claim_notification(p_serial text, p_kind text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_card  uuid;
  v_count integer;
  v_limit integer;
begin
  if p_kind is null or p_kind not in ('stamp', 'reward') then
    raise exception 'invalid_kind' using errcode = 'PT400';
  end if;

  -- Verrou sur la carte : deux demandes simultanées passent l'une après l'autre (sans modifier la carte).
  select c.id into v_card from public.cards c where c.serial_number = p_serial for update;
  if not found then
    return false;
  end if;

  select count(*) into v_count
  from private.google_notifications n
  where n.card_id = v_card and n.sent_at > clock_timestamp() - interval '24 hours';

  v_limit := case p_kind when 'reward' then 3 else 2 end;
  if v_count >= v_limit then
    return false;
  end if;

  insert into private.google_notifications (card_id, kind) values (v_card, p_kind);

  if random() < 0.01 then
    delete from private.google_notifications where sent_at < clock_timestamp() - interval '3 days';
  end if;
  return true;
end;
$$;

-- Mémorise la carte Google (identifiant d'objet) et la plateforme, sans marquer la carte « modifiée ».
-- Renvoie : 'ok', 'not_found', 'invalid' ou 'conflict' (la carte a déjà un autre identifiant Google).
create or replace function public.google_mark_card(p_serial text, p_object_id text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_card public.cards;
begin
  if p_object_id is null or char_length(p_object_id) not between 1 and 200 then
    return 'invalid';
  end if;

  select * into v_card from public.cards where serial_number = p_serial;
  if not found then
    return 'not_found';
  end if;
  if v_card.google_object_id is not null and v_card.google_object_id <> p_object_id then
    return 'conflict';
  end if;

  begin
    update public.cards
    set google_object_id = p_object_id,
        platform = case when platform is null then 'google' when platform = 'apple' then 'both' else platform end
    where id = v_card.id;
  exception when unique_violation then
    return 'conflict';
  end;
  return 'ok';
end;
$$;

-- Description d'un programme pour Google : programme, commerce, et 10 adresses au plus (limite Google),
-- les plus anciennes d'abord. Renvoie null si le programme n'existe pas.
create or replace function public.loyalty_class_data(p_program_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'program', jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'stamps_required', p.stamps_required,
      'reward_label', p.reward_label,
      'proximity_message', p.proximity_message,
      'is_active', p.is_active,
      'stamp_icon', p.stamp_icon,
      'stamp_icon_url', p.stamp_icon_url
    ),
    'merchant', jsonb_build_object(
      'id', m.id,
      'name', m.name,
      'logo_url', m.logo_url,
      'brand_color', m.brand_color
    ),
    'locations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'label', l.label, 'address', l.address, 'latitude', l.latitude, 'longitude', l.longitude
             ) order by l.created_at, l.id)
      from (
        select * from public.locations where merchant_id = m.id order by created_at, id limit 10
      ) l
    ), '[]'::jsonb)
  )
  from public.loyalty_programs p
  join public.merchants m on m.id = p.merchant_id
  where p.id = p_program_id;
$$;

revoke all on function
  public.google_claim_notification(text, text),
  public.google_mark_card(text, text),
  public.loyalty_class_data(uuid)
  from public, anon, authenticated;
grant execute on function
  public.google_claim_notification(text, text),
  public.google_mark_card(text, text),
  public.loyalty_class_data(uuid)
  to service_role;
