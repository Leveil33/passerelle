-- Passerelle : base de données du jeu en ligne.
-- À coller une seule fois dans Supabase → SQL Editor → New query → Run.
-- Une seule table de documents JSON : les fiches joueurs (joueurs/<id>) et les parties (parties/<CODE>).

create table if not exists public.docs (
  path        text primary key check (path ~ '^(joueurs|parties)/[A-Za-z0-9_-]{1,64}$'),
  coll        text generated always as (split_part(path, '/', 1)) stored,
  data        jsonb not null default '{}'::jsonb check (pg_column_size(data) < 200000),
  owner       uuid not null default auth.uid(),
  updated_at  timestamptz not null default now()
);
create index if not exists docs_coll on public.docs (coll);
create index if not exists docs_party_p1 on public.docs ((data->>'p1')) where coll = 'parties';
create index if not exists docs_party_p2 on public.docs ((data->>'p2')) where coll = 'parties';
-- Recherche d'adversaire : les parties « en recherche » (data.mm = 'open').
create index if not exists docs_party_mm on public.docs ((data->>'mm')) where coll = 'parties';

-- Qui peut atteindre la table : seulement les joueurs connectés (même anonymes), jamais la clé seule.
revoke all on table public.docs from anon, public;
grant select, insert, update, delete on table public.docs to authenticated;

-- Règles d'accès (Row Level Security). La clé publique du site ne permet que ce qui est écrit ici.
alter table public.docs enable row level security;

drop policy if exists "lecture" on public.docs;
create policy "lecture" on public.docs for select to authenticated using (true);

-- Fiche joueur : seul son titulaire la crée, la modifie ou la supprime.
drop policy if exists "fiche: créer" on public.docs;
create policy "fiche: créer" on public.docs for insert to authenticated
  with check (path = 'joueurs/' || (select auth.uid()) and owner = (select auth.uid()));
drop policy if exists "fiche: modifier" on public.docs;
create policy "fiche: modifier" on public.docs for update to authenticated
  using (path = 'joueurs/' || (select auth.uid())) with check (path = 'joueurs/' || (select auth.uid()));
drop policy if exists "fiche: supprimer" on public.docs;
create policy "fiche: supprimer" on public.docs for delete to authenticated
  using (path = 'joueurs/' || (select auth.uid()));

-- Partie : n'importe quel joueur connecté en crée une ; on y écrit si on y est assis ou s'il reste une place,
-- et le résultat doit toujours nous compter parmi les deux joueurs. Seul le créateur peut l'annuler.
drop policy if exists "partie: créer" on public.docs;
create policy "partie: créer" on public.docs for insert to authenticated
  with check (coll = 'parties' and owner = (select auth.uid()));
drop policy if exists "partie: jouer" on public.docs;
create policy "partie: jouer" on public.docs for update to authenticated
  using (coll = 'parties' and (owner = (select auth.uid()) or data->>'p1' = (select auth.uid())::text or data->>'p2' = (select auth.uid())::text
         or data->>'p1' is null or data->>'p2' is null))
  with check (coll = 'parties' and (data->>'p1' = (select auth.uid())::text or data->>'p2' = (select auth.uid())::text));
drop policy if exists "partie: annuler" on public.docs;
create policy "partie: annuler" on public.docs for delete to authenticated
  using (coll = 'parties' and owner = (select auth.uid()));

-- Fusion de champs en une seule écriture (les règles ci-dessus s'appliquent : security invoker).
create or replace function public.doc_merge(p text, patch jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  update public.docs set data = data || patch, updated_at = now() where path = p;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
end $$;
revoke execute on function public.doc_merge(text, jsonb) from public, anon;
grant execute on function public.doc_merge(text, jsonb) to authenticated;

-- Mises à jour en direct des parties.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- (Facultatif) Ménage : efface les parties sans activité depuis 30 jours. Nécessite l'extension pg_cron
-- (Database → Extensions → pg_cron), puis décommente les deux lignes :
-- select cron.schedule('passerelle-menage', '17 4 * * *',
--   $$delete from public.docs where coll = 'parties' and updated_at < now() - interval '30 days'$$);
