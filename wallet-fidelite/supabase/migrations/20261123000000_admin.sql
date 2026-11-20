-- ════════════════════════════════════════════════════════════════════════════
-- Phase 5 — Administration.
--   • platform_admins / admin_audit_log / admin_create_merchant : la propriétaire de la solution crée les commerces.
--   • Protection du dernier propriétaire d'un commerce.
--   • merchant_stats : statistiques simples d'un commerce (membres seulement).
--   • program_push_targets / program_google_serials : cartes à mettre à jour après un changement du commerçant.
--   • Dossier d'images « merchant-assets » (logos et tampons importés, écrits par le serveur uniquement).
-- Ajouts uniquement.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Administrateurs de la plateforme (serveur uniquement) ─────────────────────────────────────
create table public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.admin_audit_log (
  id            uuid primary key default gen_random_uuid(),
  admin_user_id uuid references auth.users (id) on delete set null,
  action        text not null,
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default clock_timestamp()
);
alter table public.platform_admins enable row level security;
alter table public.admin_audit_log enable row level security;
revoke all on table public.platform_admins, public.admin_audit_log from public, anon, authenticated;
grant all on table public.platform_admins, public.admin_audit_log to service_role;

create or replace function public.is_platform_admin(p_user_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from public.platform_admins a where a.user_id = p_user_id);
$$;

-- Crée un commerce, son programme pré-rempli et son propriétaire (déjà créé dans Supabase Auth), et le consigne.
create or replace function public.admin_create_merchant(
  p_admin_id       uuid,
  p_name           text,
  p_owner_user_id  uuid,
  p_stamps_required integer default 10,
  p_reward_label   text default 'Une récompense offerte'
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_m    uuid;
  v_p    uuid;
begin
  if p_admin_id is null or not public.is_platform_admin(p_admin_id) then
    raise exception 'not_platform_admin' using errcode = 'PT403';
  end if;
  if char_length(v_name) not between 1 and 100 then
    raise exception 'invalid_name' using errcode = 'PT400';
  end if;
  if p_stamps_required is null or p_stamps_required not between 1 and 50 then
    raise exception 'invalid_stamps' using errcode = 'PT400';
  end if;
  if char_length(btrim(coalesce(p_reward_label, ''))) not between 1 and 100 then
    raise exception 'invalid_reward' using errcode = 'PT400';
  end if;

  insert into public.merchants (name) values (v_name) returning id into v_m;
  insert into public.merchant_users (merchant_id, user_id, role) values (v_m, p_owner_user_id, 'owner');
  insert into public.loyalty_programs (merchant_id, name, stamps_required, reward_label)
  values (v_m, 'Carte de fidélité', p_stamps_required, btrim(p_reward_label))
  returning id into v_p;

  insert into public.admin_audit_log (admin_user_id, action, details)
  values (p_admin_id, 'create_merchant', jsonb_build_object('merchant_id', v_m, 'owner_user_id', p_owner_user_id, 'name', v_name));

  return jsonb_build_object('merchant_id', v_m, 'program_id', v_p);
end;
$$;

-- ─── Un commerce ne peut jamais rester sans propriétaire ──────────────────────────────────────
-- (la suppression d'un commerce entier reste possible : le commerce n'existe alors plus au moment du contrôle)
create or replace function private.keep_one_owner()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.role = 'owner'
     and exists (select 1 from public.merchants m where m.id = old.merchant_id)
     and not exists (
       select 1 from public.merchant_users u
       where u.merchant_id = old.merchant_id and u.role = 'owner' and u.id <> old.id
     ) then
    raise exception 'last_owner' using errcode = 'PT409';
  end if;
  return old;
end;
$$;
create trigger merchant_users_keep_one_owner
  before delete on public.merchant_users
  for each row execute function private.keep_one_owner();

-- ─── Statistiques d'un commerce (réservées à ses membres) ─────────────────────────────────────
-- « Aujourd'hui » = jour calendaire en France. Les tampons annulés (corrections) sont retranchés.
create or replace function public.merchant_stats(p_merchant_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris';
begin
  if not private.is_member(p_merchant_id) then
    raise exception 'forbidden' using errcode = 'PT403';
  end if;

  return (
    select jsonb_build_object(
      'cards', (select count(*) from public.cards c join public.loyalty_programs p on p.id = c.program_id where p.merchant_id = p_merchant_id),
      'new_cards_7_days', (select count(*) from public.cards c join public.loyalty_programs p on p.id = c.program_id
                            where p.merchant_id = p_merchant_id and c.created_at >= now() - interval '7 days'),
      'stamps_today', coalesce(sum(case e.type when 'stamp' then 1 when 'correction' then -1 else 0 end) filter (where e.created_at >= v_today), 0),
      'stamps_7_days', coalesce(sum(case e.type when 'stamp' then 1 when 'correction' then -1 else 0 end) filter (where e.created_at >= now() - interval '7 days'), 0),
      'rewards_redeemed', coalesce(count(*) filter (where e.type = 'reward_redeemed'), 0),
      'rewards_redeemed_7_days', coalesce(count(*) filter (where e.type = 'reward_redeemed' and e.created_at >= now() - interval '7 days'), 0)
    )
    from public.stamp_events e
    join public.cards c on c.id = e.card_id
    join public.loyalty_programs p on p.id = c.program_id
    where p.merchant_id = p_merchant_id
  );
end;
$$;

-- ─── Cartes à mettre à jour après un changement du commerçant (serveur uniquement) ───────────
create or replace function public.program_push_targets(p_program_id uuid, p_limit integer default 5000)
returns table (push_token text)
language sql stable
set search_path = ''
as $$
  select r.push_token
  from public.apple_registrations r
  join public.cards c on c.id = r.card_id
  where c.program_id = p_program_id
  order by r.created_at, r.id
  limit least(greatest(coalesce(p_limit, 5000), 1), 20000);
$$;

create or replace function public.program_google_serials(p_program_id uuid, p_limit integer default 5000)
returns table (serial_number text)
language sql stable
set search_path = ''
as $$
  select c.serial_number
  from public.cards c
  where c.program_id = p_program_id and c.platform in ('google', 'both')
  order by c.created_at, c.id
  limit least(greatest(coalesce(p_limit, 5000), 1), 20000);
$$;

-- ─── Dossier des images (écrites par le serveur seulement : logos et tampons importés, PNG ≤ 2 Mo) ──
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('merchant-assets', 'merchant-assets', true, 2097152, array['image/png'])
on conflict (id) do nothing;

-- ─── Droits ─────────────────────────────────────────────────────────────────────────────────────
revoke all on function
  public.is_platform_admin(uuid),
  public.admin_create_merchant(uuid, text, uuid, integer, text),
  public.program_push_targets(uuid, integer),
  public.program_google_serials(uuid, integer)
  from public, anon, authenticated;
grant execute on function
  public.is_platform_admin(uuid),
  public.admin_create_merchant(uuid, text, uuid, integer, text),
  public.program_push_targets(uuid, integer),
  public.program_google_serials(uuid, integer)
  to service_role;

revoke all on function public.merchant_stats(uuid) from public, anon;
grant execute on function public.merchant_stats(uuid) to authenticated;
