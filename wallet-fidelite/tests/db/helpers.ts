// Outils de test : une vraie base Postgres (PGlite, en mémoire) sur laquelle on rejoue
// EXACTEMENT les fichiers de supabase/migrations/. Seul ce que Supabase fournit d'office
// (rôles anon / authenticated / service_role, schéma auth) est simulé ici.
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../supabase/migrations",
);

// Ce que Supabase fournit déjà dans un vrai projet.
const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $f$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $f$;

  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant select on auth.users to service_role;
`;

export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

type Role = "anon" | "authenticated" | "service_role";

/** Exécute `fn` comme le ferait Supabase pour une requête venant de ce rôle / cet utilisateur. */
async function withRole<T>(db: PGlite, role: Role, userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.exec("select set_config('request.jwt.claim.sub', '', false)");
  }
}

export const asUser = <T>(db: PGlite, userId: string, fn: () => Promise<T>) =>
  withRole(db, "authenticated", userId, fn);
/** Connecté (rôle authenticated) mais sans identité : ne devrait jamais arriver, on vérifie quand même. */
export const asNobody = <T>(db: PGlite, fn: () => Promise<T>) => withRole(db, "authenticated", null, fn);
export const asAnon = <T>(db: PGlite, fn: () => Promise<T>) => withRole(db, "anon", null, fn);
export const asServer = <T>(db: PGlite, fn: () => Promise<T>) => withRole(db, "service_role", null, fn);

/** Retourne l'erreur levée par `fn` (ou fait échouer le test si rien n'est levé). */
export async function expectDbError(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    return e as { message: string; code?: string; detail?: string };
  }
  throw new Error("Une erreur était attendue, mais l'opération a réussi.");
}

// ─── Données de départ ──────────────────────────────────────────────────────

export type Shop = {
  merchantId: string;
  programId: string;
  ownerUserId: string;
  ownerMemberId: string;
  staffUserId: string;
  staffMemberId: string;
};

export async function createUser(db: PGlite, email?: string): Promise<string> {
  const id = randomUUID();
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email ?? `${id}@test.local`]);
  return id;
}

/** Un commerce avec un propriétaire, un employé et un programme (5 cases par défaut). */
export async function createShop(
  db: PGlite,
  opts: { name?: string; stampsRequired?: number; doubleScanMinutes?: number } = {},
): Promise<Shop> {
  const merchant = await db.query<{ id: string }>(
    "insert into public.merchants (name) values ($1) returning id",
    [opts.name ?? "Café du Coin"],
  );
  const merchantId = merchant.rows[0].id;

  const ownerUserId = await createUser(db);
  const staffUserId = await createUser(db);
  const owner = await db.query<{ id: string }>(
    "insert into public.merchant_users (merchant_id, user_id, role) values ($1, $2, 'owner') returning id",
    [merchantId, ownerUserId],
  );
  const staff = await db.query<{ id: string }>(
    "insert into public.merchant_users (merchant_id, user_id, role) values ($1, $2, 'staff') returning id",
    [merchantId, staffUserId],
  );

  const program = await db.query<{ id: string }>(
    `insert into public.loyalty_programs
       (merchant_id, name, stamps_required, reward_label, double_scan_delay_minutes)
     values ($1, 'Carte café', $2, '1 café offert', $3) returning id`,
    [merchantId, opts.stampsRequired ?? 5, opts.doubleScanMinutes ?? 10],
  );

  return {
    merchantId,
    programId: program.rows[0].id,
    ownerUserId,
    ownerMemberId: owner.rows[0].id,
    staffUserId,
    staffMemberId: staff.rows[0].id,
  };
}

export async function createCard(
  db: PGlite,
  programId: string,
  firstName = "Léa",
): Promise<{ cardId: string; customerId: string }> {
  const customer = await db.query<{ id: string }>(
    "insert into public.customers (first_name) values ($1) returning id",
    [firstName],
  );
  const card = await db.query<{ id: string }>(
    "insert into public.cards (program_id, customer_id) values ($1, $2) returning id",
    [programId, customer.rows[0].id],
  );
  return { cardId: card.rows[0].id, customerId: customer.rows[0].id };
}

/** Fait « vieillir » tous les événements d'une carte (pour simuler le temps qui passe). */
export async function ageEvents(db: PGlite, cardId: string, minutes: number) {
  await db.query(
    "update public.stamp_events set created_at = created_at - ($2::numeric * interval '1 minute') where card_id = $1",
    [cardId, minutes],
  );
}

// ─── Raccourcis pour appeler les 3 fonctions ────────────────────────────────

export type StampResult = {
  card_id: string;
  stamps: number;
  stamps_required: number;
  rewards_earned: number;
  reward_available: boolean;
  event_id: string;
};

async function call(db: PGlite, fn: string, userId: string, cardId: string): Promise<StampResult> {
  return asUser(db, userId, async () => {
    const res = await db.query<StampResult>(`select * from public.${fn}($1)`, [cardId]);
    return res.rows[0];
  });
}
export const stamp = (db: PGlite, userId: string, cardId: string) => call(db, "stamp_card", userId, cardId);
export const redeem = (db: PGlite, userId: string, cardId: string) => call(db, "redeem_reward", userId, cardId);
export const undo = (db: PGlite, userId: string, cardId: string) => call(db, "undo_last_stamp", userId, cardId);

export async function cardRow(db: PGlite, cardId: string) {
  const res = await db.query<{ stamps: number; rewards_earned: number }>(
    "select stamps, rewards_earned from public.cards where id = $1",
    [cardId],
  );
  return res.rows[0];
}

export async function events(db: PGlite, cardId: string) {
  const res = await db.query<{
    type: string;
    stamps_before: number;
    stamps_after: number;
    merchant_user_id: string | null;
  }>(
    "select type, stamps_before, stamps_after, merchant_user_id from public.stamp_events where card_id = $1 order by created_at, id",
    [cardId],
  );
  return res.rows;
}
