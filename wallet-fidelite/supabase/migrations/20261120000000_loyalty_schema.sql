-- ════════════════════════════════════════════════════════════════════════════
-- Carte de fidélité Wallet — Phase 1 : tables, sécurité (RLS) et fonctions de tampon.
--
-- AJOUTS UNIQUEMENT : ce fichier ne modifie ni ne supprime rien d'existant
-- (le jeu Passerelle utilise la table public.docs, qui n'est pas touchée).
--
-- Principes de sécurité :
--   • Les visiteurs non connectés (rôle "anon") n'ont accès à AUCUNE table.
--   • Un membre d'un commerce ne voit que les données de SON commerce.
--   • Les tampons ne changent QUE par les 3 fonctions stamp_card / redeem_reward /
--     undo_last_stamp (aucune écriture directe dans cards ni stamp_events).
--   • Le auth_token Apple et l'e-mail des clients ne sont lisibles par aucun
--     employé (seul le serveur, avec la clé secrète, y accède).
-- ════════════════════════════════════════════════════════════════════════════

-- Schéma "private" : fonctions internes, non exposées par l'API Supabase.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

-- ─── Tables ─────────────────────────────────────────────────────────────────

create table public.merchants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 100),
  logo_url    text check (logo_url is null or logo_url ~ '^https://'),
  brand_color text not null default '#1F2937' check (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at  timestamptz not null default now()
);

create table public.merchant_users (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null check (role in ('owner', 'staff')),
  created_at  timestamptz not null default now(),
  unique (merchant_id, user_id)
);
create index merchant_users_user_id on public.merchant_users (user_id);

create table public.loyalty_programs (
  id                       uuid primary key default gen_random_uuid(),
  merchant_id              uuid not null references public.merchants (id) on delete cascade,
  name                     text not null check (char_length(btrim(name)) between 1 and 100),
  stamps_required          integer not null check (stamps_required between 1 and 50),
  reward_label             text not null check (char_length(btrim(reward_label)) between 1 and 100),
  proximity_message        text not null default '' check (char_length(proximity_message) <= 200),
  is_active                boolean not null default true,
  -- Anti double scan : délai (en minutes) avant de pouvoir retamponner la même carte. 0 = désactivé.
  double_scan_delay_minutes integer not null default 10 check (double_scan_delay_minutes between 0 and 1440),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index loyalty_programs_merchant_id on public.loyalty_programs (merchant_id);

-- Les adresses appartiennent au commerce (pas au programme) : on pourra plus tard
-- choisir les 10 plus pertinentes pour une carte sans changer ce modèle.
create table public.locations (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  label       text not null check (char_length(btrim(label)) between 1 and 100),
  address     text not null default '',
  latitude    double precision not null check (latitude between -90 and 90),
  longitude   double precision not null check (longitude between -180 and 180),
  created_at  timestamptz not null default now()
);
create index locations_merchant_id on public.locations (merchant_id);

create table public.customers (
  id               uuid primary key default gen_random_uuid(),
  first_name       text not null check (char_length(btrim(first_name)) between 1 and 60),
  email            text check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- RGPD : pas d'e-mail enregistré sans trace du consentement.
  email_consent_at timestamptz,
  created_at       timestamptz not null default now(),
  check (email is null or email_consent_at is not null)
);

create table public.cards (
  id               uuid primary key default gen_random_uuid(),
  program_id       uuid not null references public.loyalty_programs (id) on delete restrict,
  customer_id      uuid not null references public.customers (id) on delete cascade,
  -- Identifiant public de la carte (dans le QR code, avec une signature HMAC).
  serial_number    text not null unique default replace(gen_random_uuid()::text, '-', ''),
  -- Secret Apple (en-tête "Authorization: ApplePass …"). Jamais lisible par les employés.
  auth_token       text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  stamps           integer not null default 0 check (stamps >= 0),
  rewards_earned   integer not null default 0 check (rewards_earned >= 0),
  -- Renseigné quand le client ajoute la carte à un Wallet.
  platform         text check (platform in ('apple', 'google', 'both')),
  google_object_id text unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index cards_program_id on public.cards (program_id);
create index cards_customer_id on public.cards (customer_id);

-- Journal de tous les changements de tampons.
create table public.stamp_events (
  id               uuid primary key default gen_random_uuid(),
  card_id          uuid not null references public.cards (id) on delete cascade,
  -- Si un employé est retiré, ses événements restent dans le journal.
  merchant_user_id uuid references public.merchant_users (id) on delete set null,
  type             text not null check (type in ('stamp', 'reward_redeemed', 'correction')),
  stamps_before    integer not null check (stamps_before >= 0),
  stamps_after     integer not null check (stamps_after >= 0),
  -- clock_timestamp() (et non now()) : l'ordre des événements reste exact même
  -- si plusieurs ont lieu dans la même transaction.
  created_at       timestamptz not null default clock_timestamp()
);
create index stamp_events_card_created on public.stamp_events (card_id, created_at desc);
create index stamp_events_created on public.stamp_events (created_at);

-- Appareils Apple qui suivent une carte (PassKit Web Service). Serveur uniquement.
create table public.apple_registrations (
  id                uuid primary key default gen_random_uuid(),
  card_id           uuid not null references public.cards (id) on delete cascade,
  device_library_id text not null,
  push_token        text not null,
  created_at        timestamptz not null default now(),
  unique (card_id, device_library_id)
);
create index apple_registrations_device on public.apple_registrations (device_library_id);

-- ─── Mise à jour automatique de updated_at ──────────────────────────────────

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger cards_touch_updated_at
  before update on public.cards
  for each row execute function private.touch_updated_at();

create trigger loyalty_programs_touch_updated_at
  before update on public.loyalty_programs
  for each row execute function private.touch_updated_at();

-- ─── Fonctions d'aide pour les règles de sécurité (RLS) ─────────────────────
-- SECURITY DEFINER : elles lisent merchant_users sans être bloquées par la RLS
-- (sinon la règle de merchant_users se référencerait elle-même).

create or replace function private.is_member(p_merchant_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.merchant_users mu
    where mu.merchant_id = p_merchant_id and mu.user_id = (select auth.uid())
  );
$$;

create or replace function private.is_owner(p_merchant_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.merchant_users mu
    where mu.merchant_id = p_merchant_id and mu.user_id = (select auth.uid()) and mu.role = 'owner'
  );
$$;

create or replace function private.is_member_of_program(p_program_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.loyalty_programs p
    join public.merchant_users mu on mu.merchant_id = p.merchant_id
    where p.id = p_program_id and mu.user_id = (select auth.uid())
  );
$$;

create or replace function private.is_member_of_card(p_card_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.cards c
    join public.loyalty_programs p on p.id = c.program_id
    join public.merchant_users mu on mu.merchant_id = p.merchant_id
    where c.id = p_card_id and mu.user_id = (select auth.uid())
  );
$$;

create or replace function private.is_member_of_customer(p_customer_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.cards c
    join public.loyalty_programs p on p.id = c.program_id
    join public.merchant_users mu on mu.merchant_id = p.merchant_id
    where c.customer_id = p_customer_id and mu.user_id = (select auth.uid())
  );
$$;

revoke all on function
  private.is_member(uuid), private.is_owner(uuid), private.is_member_of_program(uuid),
  private.is_member_of_card(uuid), private.is_member_of_customer(uuid)
  from public, anon;
grant execute on function
  private.is_member(uuid), private.is_owner(uuid), private.is_member_of_program(uuid),
  private.is_member_of_card(uuid), private.is_member_of_customer(uuid)
  to authenticated;

-- ─── RLS : activée partout ──────────────────────────────────────────────────

alter table public.merchants           enable row level security;
alter table public.merchant_users      enable row level security;
alter table public.loyalty_programs    enable row level security;
alter table public.locations           enable row level security;
alter table public.customers           enable row level security;
alter table public.cards               enable row level security;
alter table public.stamp_events        enable row level security;
alter table public.apple_registrations enable row level security;

-- Point de départ : plus personne n'a de droits, puis on ouvre au cas par cas.
revoke all on table
  public.merchants, public.merchant_users, public.loyalty_programs, public.locations,
  public.customers, public.cards, public.stamp_events, public.apple_registrations
  from public, anon, authenticated;

-- Le serveur (clé secrète / service_role) a tous les droits : création des cartes,
-- Wallet Apple et Google, gestion des commerces.
grant all on table
  public.merchants, public.merchant_users, public.loyalty_programs, public.locations,
  public.customers, public.cards, public.stamp_events, public.apple_registrations
  to service_role;

-- merchants : les membres lisent ; le propriétaire modifie nom, logo, couleur.
-- (La création d'un commerce se fait côté serveur.)
create policy merchants_select on public.merchants
  for select to authenticated using (private.is_member(id));
create policy merchants_update on public.merchants
  for update to authenticated using (private.is_owner(id)) with check (private.is_owner(id));
grant select on public.merchants to authenticated;
grant update (name, logo_url, brand_color) on public.merchants to authenticated;

-- merchant_users : chacun voit sa propre ligne ; le propriétaire voit et gère l'équipe.
create policy merchant_users_select on public.merchant_users
  for select to authenticated
  using (user_id = (select auth.uid()) or private.is_owner(merchant_id));
create policy merchant_users_insert on public.merchant_users
  for insert to authenticated with check (private.is_owner(merchant_id));
create policy merchant_users_delete on public.merchant_users
  for delete to authenticated using (private.is_owner(merchant_id));
grant select, delete on public.merchant_users to authenticated;
grant insert (merchant_id, user_id, role) on public.merchant_users to authenticated;

-- loyalty_programs : les membres lisent ; le propriétaire crée et modifie (jamais de suppression :
-- on désactive avec is_active, car des cartes existent).
create policy loyalty_programs_select on public.loyalty_programs
  for select to authenticated using (private.is_member(merchant_id));
create policy loyalty_programs_insert on public.loyalty_programs
  for insert to authenticated with check (private.is_owner(merchant_id));
create policy loyalty_programs_update on public.loyalty_programs
  for update to authenticated using (private.is_owner(merchant_id)) with check (private.is_owner(merchant_id));
grant select on public.loyalty_programs to authenticated;
grant insert (merchant_id, name, stamps_required, reward_label, proximity_message, is_active, double_scan_delay_minutes)
  on public.loyalty_programs to authenticated;
grant update (name, stamps_required, reward_label, proximity_message, is_active, double_scan_delay_minutes)
  on public.loyalty_programs to authenticated;

-- locations : les membres lisent ; le propriétaire gère.
create policy locations_select on public.locations
  for select to authenticated using (private.is_member(merchant_id));
create policy locations_insert on public.locations
  for insert to authenticated with check (private.is_owner(merchant_id));
create policy locations_update on public.locations
  for update to authenticated using (private.is_owner(merchant_id)) with check (private.is_owner(merchant_id));
create policy locations_delete on public.locations
  for delete to authenticated using (private.is_owner(merchant_id));
grant select, delete on public.locations to authenticated;
grant insert (merchant_id, label, address, latitude, longitude) on public.locations to authenticated;
grant update (label, address, latitude, longitude) on public.locations to authenticated;

-- customers : un employé voit uniquement le prénom des clients de son commerce
-- (pas l'e-mail : minimisation des données personnelles).
create policy customers_select on public.customers
  for select to authenticated using (private.is_member_of_customer(id));
grant select (id, first_name, created_at) on public.customers to authenticated;

-- cards : lecture seule pour les membres, sans le auth_token. Aucune écriture directe.
create policy cards_select on public.cards
  for select to authenticated using (private.is_member_of_program(program_id));
grant select (id, program_id, customer_id, serial_number, stamps, rewards_earned, platform, created_at, updated_at)
  on public.cards to authenticated;

-- stamp_events : lecture seule pour les membres (statistiques). Écrit uniquement par les fonctions.
create policy stamp_events_select on public.stamp_events
  for select to authenticated using (private.is_member_of_card(card_id));
grant select on public.stamp_events to authenticated;

-- apple_registrations : RLS activée, aucune règle, aucun droit → serveur uniquement.

-- ─── Fonctions de tampon : LE seul chemin pour modifier une carte ───────────

create type public.stamp_result as (
  card_id          uuid,
  stamps           integer,
  stamps_required  integer,
  rewards_earned   integer,
  reward_available boolean,
  event_id         uuid
);

-- Vérifie que l'appelant est connecté ET membre du commerce de la carte ;
-- renvoie son identifiant d'employé (merchant_users.id).
-- Pour ne pas révéler qu'une carte existe, un non-membre reçoit « card_not_found ».
create or replace function private.acting_member(p_card_id uuid)
returns uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_member uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;

  select mu.id into v_member
  from public.cards c
  join public.loyalty_programs p on p.id = c.program_id
  join public.merchant_users mu on mu.merchant_id = p.merchant_id and mu.user_id = v_uid
  where c.id = p_card_id;

  if v_member is null then
    raise exception 'card_not_found' using errcode = 'PT404';
  end if;
  return v_member;
end;
$$;

-- +1 tampon.
-- Refus possibles : card_not_found, program_inactive, card_full (aller valider la récompense),
-- double_scan (detail = secondes restantes avant de pouvoir retamponner).
create or replace function public.stamp_card(p_card_id uuid)
returns public.stamp_result
language plpgsql security definer
set search_path = ''
as $$
declare
  v_member   uuid;
  v_card     public.cards;
  v_program  public.loyalty_programs;
  v_last     public.stamp_events;
  v_now      timestamptz := clock_timestamp();
  v_ready_at timestamptz;
  v_new      integer;
  v_event    uuid;
begin
  v_member := private.acting_member(p_card_id);

  -- Verrou sur la carte : deux téléphones qui tamponnent en même temps passent l'un après l'autre.
  select * into v_card from public.cards where id = p_card_id for update;
  select * into v_program from public.loyalty_programs where id = v_card.program_id;

  if not v_program.is_active then
    raise exception 'program_inactive' using errcode = 'PT422';
  end if;
  if v_card.stamps >= v_program.stamps_required then
    raise exception 'card_full' using errcode = 'PT409';
  end if;

  -- Anti double scan : le dernier événement de la carte est-il un tampon trop récent ?
  -- (Après une annulation ou une récompense, on peut tamponner tout de suite.)
  select * into v_last
  from public.stamp_events
  where card_id = p_card_id
  order by created_at desc, id desc
  limit 1;

  if found and v_last.type = 'stamp' then
    v_ready_at := v_last.created_at + make_interval(mins => v_program.double_scan_delay_minutes);
    if v_ready_at > v_now then
      raise exception 'double_scan' using
        errcode = 'PT409',
        detail  = ceil(extract(epoch from (v_ready_at - v_now)))::integer::text;
    end if;
  end if;

  v_new := v_card.stamps + 1;
  update public.cards set stamps = v_new where id = p_card_id;

  insert into public.stamp_events (card_id, merchant_user_id, type, stamps_before, stamps_after)
  values (p_card_id, v_member, 'stamp', v_card.stamps, v_new)
  returning id into v_event;

  return row(p_card_id, v_new, v_program.stamps_required, v_card.rewards_earned,
             v_new >= v_program.stamps_required, v_event)::public.stamp_result;
end;
$$;

-- Valide la récompense : tampons remis à 0, rewards_earned + 1.
-- Refus possibles : card_not_found, card_not_full.
create or replace function public.redeem_reward(p_card_id uuid)
returns public.stamp_result
language plpgsql security definer
set search_path = ''
as $$
declare
  v_member  uuid;
  v_card    public.cards;
  v_program public.loyalty_programs;
  v_rewards integer;
  v_event   uuid;
begin
  v_member := private.acting_member(p_card_id);

  select * into v_card from public.cards where id = p_card_id for update;
  select * into v_program from public.loyalty_programs where id = v_card.program_id;

  if v_card.stamps < v_program.stamps_required then
    raise exception 'card_not_full' using errcode = 'PT409';
  end if;

  update public.cards
  set stamps = 0, rewards_earned = rewards_earned + 1
  where id = p_card_id
  returning rewards_earned into v_rewards;

  insert into public.stamp_events (card_id, merchant_user_id, type, stamps_before, stamps_after)
  values (p_card_id, v_member, 'reward_redeemed', v_card.stamps, 0)
  returning id into v_event;

  return row(p_card_id, 0, v_program.stamps_required, v_rewards, false, v_event)::public.stamp_result;
end;
$$;

-- Annule le dernier tampon (uniquement si c'est le dernier événement de la carte,
-- et seulement pendant 2 minutes). Crée un événement « correction ».
-- Refus possibles : card_not_found, nothing_to_undo, undo_expired.
create or replace function public.undo_last_stamp(p_card_id uuid)
returns public.stamp_result
language plpgsql security definer
set search_path = ''
as $$
declare
  v_member  uuid;
  v_card    public.cards;
  v_program public.loyalty_programs;
  v_last    public.stamp_events;
  v_now     timestamptz := clock_timestamp();
  v_new     integer;
  v_event   uuid;
begin
  v_member := private.acting_member(p_card_id);

  select * into v_card from public.cards where id = p_card_id for update;
  select * into v_program from public.loyalty_programs where id = v_card.program_id;

  select * into v_last
  from public.stamp_events
  where card_id = p_card_id
  order by created_at desc, id desc
  limit 1;

  if not found or v_last.type <> 'stamp' or v_card.stamps < 1 then
    raise exception 'nothing_to_undo' using errcode = 'PT409';
  end if;
  if v_last.created_at < v_now - interval '2 minutes' then
    raise exception 'undo_expired' using errcode = 'PT409';
  end if;

  v_new := v_card.stamps - 1;
  update public.cards set stamps = v_new where id = p_card_id;

  insert into public.stamp_events (card_id, merchant_user_id, type, stamps_before, stamps_after)
  values (p_card_id, v_member, 'correction', v_card.stamps, v_new)
  returning id into v_event;

  return row(p_card_id, v_new, v_program.stamps_required, v_card.rewards_earned,
             v_new >= v_program.stamps_required, v_event)::public.stamp_result;
end;
$$;

-- Seuls les utilisateurs connectés peuvent appeler ces fonctions (et elles vérifient
-- ensuite qu'ils sont membres du bon commerce). Jamais "anon".
revoke all on function private.acting_member(uuid) from public, anon, authenticated;
revoke all on function public.stamp_card(uuid), public.redeem_reward(uuid), public.undo_last_stamp(uuid)
  from public, anon;
grant execute on function public.stamp_card(uuid), public.redeem_reward(uuid), public.undo_last_stamp(uuid)
  to authenticated;
