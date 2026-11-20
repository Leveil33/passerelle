-- ════════════════════════════════════════════════════════════════════════════
-- Phase 2 — fonctions RÉSERVÉES AU SERVEUR (service_role) pour Apple Wallet,
-- la création d'une carte et la limitation du nombre de requêtes.
-- Aucune de ces fonctions n'est appelable par un visiteur ni par un employé connecté.
--
-- + mise à jour AUTOMATIQUE de updated_at des cartes quand le commerçant change son programme,
--   son logo / sa couleur / son nom, ou ses adresses : c'est ce qui fait que les cartes déjà
--   installées sont proposées à nouveau par le service Wallet (« passesUpdatedSince »).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. updated_at d'une carte : ne bouge pas pour un simple changement de plateforme ──────────
-- (sinon l'iPhone retélécharge sa carte juste après l'avoir enregistrée)

create or replace function private.touch_card_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.updated_at is distinct from old.updated_at
     or new.stamps is distinct from old.stamps
     or new.rewards_earned is distinct from old.rewards_earned
     or new.program_id is distinct from old.program_id then
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;

drop trigger cards_touch_updated_at on public.cards;
create trigger cards_touch_updated_at
  before update on public.cards
  for each row execute function private.touch_card_updated_at();

-- ─── 2. Les cartes existantes suivent les modifications du commerçant ──────────────────────────
-- SECURITY DEFINER : un propriétaire n'a pas le droit d'écrire dans cards, mais ces fonctions
-- (internes, jamais appelables directement) le font à sa place.

create or replace function private.bump_cards_of_program()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.cards set updated_at = clock_timestamp() where program_id = new.id;
  return null;
end;
$$;

create trigger loyalty_programs_bump_cards
  after update on public.loyalty_programs
  for each row
  when (
    old.name is distinct from new.name
    or old.stamps_required is distinct from new.stamps_required
    or old.reward_label is distinct from new.reward_label
    or old.proximity_message is distinct from new.proximity_message
    or old.is_active is distinct from new.is_active
    or old.stamp_icon is distinct from new.stamp_icon
    or old.stamp_icon_url is distinct from new.stamp_icon_url
  )
  execute function private.bump_cards_of_program();

create or replace function private.bump_cards_of_merchant()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merchant uuid;
begin
  if tg_table_name = 'merchants' then
    v_merchant := new.id;
  else
    v_merchant := coalesce(new.merchant_id, old.merchant_id);
  end if;

  update public.cards set updated_at = clock_timestamp()
  where program_id in (select p.id from public.loyalty_programs p where p.merchant_id = v_merchant);
  return null;
end;
$$;

create trigger merchants_bump_cards
  after update on public.merchants
  for each row
  when (
    old.name is distinct from new.name
    or old.logo_url is distinct from new.logo_url
    or old.brand_color is distinct from new.brand_color
  )
  execute function private.bump_cards_of_merchant();

create trigger locations_bump_cards
  after insert or update or delete on public.locations
  for each row execute function private.bump_cards_of_merchant();

-- ─── 3. Limitation du nombre de requêtes (routes publiques) ───────────────────────────────────
-- Compteur par « fenêtre fixe » : au plus p_max appels par clé et par fenêtre de p_window_seconds.
-- Renvoie true si l'appel est autorisé, false s'il faut refuser (HTTP 429).

create table private.rate_limits (
  key          text primary key check (char_length(key) <= 200),
  window_start timestamptz not null,
  hits         integer not null
);

create or replace function public.rate_limit_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_now  timestamptz := clock_timestamp();
  v_hits integer;
begin
  if p_key is null or char_length(p_key) not between 1 and 200
     or p_window_seconds not between 1 and 86400 or p_max < 1 then
    raise exception 'invalid_rate_limit_arguments' using errcode = 'PT400';
  end if;

  insert into private.rate_limits as r (key, window_start, hits)
  values (p_key, v_now, 1)
  on conflict (key) do update set
    window_start = case when r.window_start <= v_now - make_interval(secs => p_window_seconds)
                        then v_now else r.window_start end,
    hits         = case when r.window_start <= v_now - make_interval(secs => p_window_seconds)
                        then 1 else r.hits + 1 end
  returning hits into v_hits;

  -- Ménage occasionnel des compteurs anciens (1 appel sur 200).
  if random() < 0.005 then
    delete from private.rate_limits where window_start < v_now - interval '1 day';
  end if;

  return v_hits <= p_max;
end;
$$;

-- ─── 4. Création d'une carte (page d'inscription du client) ───────────────────────────────────

create or replace function public.create_card(
  p_program_id        uuid,
  p_first_name        text,
  p_email             text default null,
  p_email_consent     boolean default false,
  p_marketing_consent boolean default false
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_program  public.loyalty_programs;
  v_name     text := btrim(coalesce(p_first_name, ''));
  v_email    text := nullif(btrim(coalesce(p_email, '')), '');
  v_customer uuid;
  v_card     public.cards;
begin
  select * into v_program from public.loyalty_programs where id = p_program_id;
  if not found then
    raise exception 'program_not_found' using errcode = 'PT404';
  end if;
  if not v_program.is_active then
    raise exception 'program_inactive' using errcode = 'PT422';
  end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'invalid_first_name' using errcode = 'PT400';
  end if;
  if v_email is not null and not coalesce(p_email_consent, false) then
    raise exception 'email_requires_consent' using errcode = 'PT400';
  end if;
  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email' using errcode = 'PT400';
  end if;

  insert into public.customers (first_name, email, email_consent_at, marketing_consent_at)
  values (
    v_name,
    v_email,
    case when v_email is not null then clock_timestamp() end,
    case when coalesce(p_marketing_consent, false) then clock_timestamp() end
  )
  returning id into v_customer;

  insert into public.cards (program_id, customer_id)
  values (p_program_id, v_customer)
  returning * into v_card;

  return jsonb_build_object('card_id', v_card.id, 'serial_number', v_card.serial_number);
end;
$$;

-- ─── 5. Données nécessaires pour fabriquer une carte Wallet (Apple ou Google) ─────────────────
-- Contient l'auth_token Apple : réservé au serveur. 10 adresses au maximum (limite Apple/Google),
-- les plus anciennes d'abord. Renvoie null si le numéro de série est inconnu.

create or replace function public.loyalty_pass_data(p_serial text)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'card', jsonb_build_object(
      'id', c.id,
      'serial_number', c.serial_number,
      'auth_token', c.auth_token,
      'stamps', c.stamps,
      'rewards_earned', c.rewards_earned,
      'platform', c.platform,
      'updated_at', c.updated_at
    ),
    'customer', jsonb_build_object('first_name', cu.first_name),
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
  from public.cards c
  join public.customers cu on cu.id = c.customer_id
  join public.loyalty_programs p on p.id = c.program_id
  join public.merchants m on m.id = p.merchant_id
  where c.serial_number = p_serial;
$$;

-- ─── 6. Service Web Apple (PassKit) ───────────────────────────────────────────────────────────

-- Enregistre un iPhone pour suivre une carte. Renvoie : 'created', 'exists', 'unauthorized',
-- 'not_found' ou 'invalid'. Le secret de la carte (auth_token) doit correspondre.
create or replace function public.apple_register_device(
  p_serial text, p_auth_token text, p_device_library_id text, p_push_token text
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_card     public.cards;
  v_inserted boolean;
begin
  if coalesce(char_length(p_device_library_id), 0) not between 1 and 200
     or coalesce(char_length(p_push_token), 0) not between 1 and 500 then
    return 'invalid';
  end if;

  select * into v_card from public.cards where serial_number = p_serial;
  if not found then
    return 'not_found';
  end if;
  if p_auth_token is null or v_card.auth_token <> p_auth_token then
    return 'unauthorized';
  end if;

  insert into public.apple_registrations (card_id, device_library_id, push_token)
  values (v_card.id, p_device_library_id, p_push_token)
  on conflict (card_id, device_library_id) do update set push_token = excluded.push_token
  returning (xmax = 0) into v_inserted;

  -- Mémorise que la carte est dans Apple Wallet (sans la marquer « modifiée », voir plus haut).
  update public.cards
  set platform = case when platform is null then 'apple' when platform = 'google' then 'both' else platform end
  where id = v_card.id and platform is distinct from
        case when platform is null then 'apple' when platform = 'google' then 'both' else platform end;

  return case when v_inserted then 'created' else 'exists' end;
end;
$$;

-- Désinscrit un iPhone. Renvoie : 'ok', 'unauthorized' ou 'not_found'.
create or replace function public.apple_unregister_device(
  p_serial text, p_auth_token text, p_device_library_id text
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_card public.cards;
begin
  select * into v_card from public.cards where serial_number = p_serial;
  if not found then
    return 'not_found';
  end if;
  if p_auth_token is null or v_card.auth_token <> p_auth_token then
    return 'unauthorized';
  end if;

  delete from public.apple_registrations
  where card_id = v_card.id and device_library_id = p_device_library_id;
  return 'ok';
end;
$$;

-- Cartes d'un iPhone modifiées depuis p_since (toutes si p_since est vide), la plus ancienne d'abord.
create or replace function public.apple_updated_serials(p_device_library_id text, p_since timestamptz default null)
returns table (serial_number text, updated_at timestamptz)
language sql stable
set search_path = ''
as $$
  select c.serial_number, c.updated_at
  from public.apple_registrations r
  join public.cards c on c.id = r.card_id
  where r.device_library_id = p_device_library_id
    and (p_since is null or c.updated_at > p_since)
  order by c.updated_at, c.id;
$$;

-- iPhone à prévenir (signal « ta carte a changé ») pour une carte.
create or replace function public.apple_push_targets(p_serial text)
returns table (device_library_id text, push_token text)
language sql stable
set search_path = ''
as $$
  select r.device_library_id, r.push_token
  from public.apple_registrations r
  join public.cards c on c.id = r.card_id
  where c.serial_number = p_serial
  order by r.created_at, r.id;
$$;

-- Oublie un appareil que Apple déclare invalide (carte supprimée du Wallet). Renvoie le nombre de lignes.
create or replace function public.apple_forget_push_token(p_push_token text)
returns integer
language sql
set search_path = ''
as $$
  with d as (delete from public.apple_registrations where push_token = p_push_token returning 1)
  select count(*)::integer from d;
$$;

-- ─── 7. Droits : service_role uniquement ──────────────────────────────────────────────────────

revoke all on table private.rate_limits from public, anon, authenticated;
grant all on table private.rate_limits to service_role;
grant usage on schema private to service_role;

revoke all on function
  public.rate_limit_hit(text, integer, integer),
  public.create_card(uuid, text, text, boolean, boolean),
  public.loyalty_pass_data(text),
  public.apple_register_device(text, text, text, text),
  public.apple_unregister_device(text, text, text),
  public.apple_updated_serials(text, timestamptz),
  public.apple_push_targets(text),
  public.apple_forget_push_token(text)
  from public, anon, authenticated;

grant execute on function
  public.rate_limit_hit(text, integer, integer),
  public.create_card(uuid, text, text, boolean, boolean),
  public.loyalty_pass_data(text),
  public.apple_register_device(text, text, text, text),
  public.apple_unregister_device(text, text, text),
  public.apple_updated_serials(text, timestamptz),
  public.apple_push_targets(text),
  public.apple_forget_push_token(text)
  to service_role;
