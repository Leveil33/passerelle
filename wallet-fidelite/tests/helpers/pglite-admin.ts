// Équivalents de test (PGlite) des accès d'administration : mêmes requêtes que la vraie version, mêmes droits.
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import type { OwnerStore, Role, ServerAdmin } from "@/lib/admin/types";
import { StoreError } from "@/lib/wallet/store";
import { asServer, asUser } from "../db/helpers";

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    const err = e as { message: string; code?: string; detail?: string };
    throw new StoreError(err.message, err.code, err.detail);
  }
};

export function createPgliteOwnerStore(db: PGlite, userId: string): OwnerStore {
  const q = <T extends object>(sql: string, params: unknown[] = []) => wrap(async () => (await asUser(db, userId, () => db.query<T>(sql, params))).rows);
  const first = async <T extends object>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0] ?? null;
  const update = async (table: string, id: string, patch: Record<string, unknown>) => {
    const cols = Object.keys(patch);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
    return (await q(`update public.${table} set ${sets} where id = $1 returning id`, [id, ...cols.map((c) => patch[c])])).length > 0;
  };
  return {
    userId,
    async myRole(merchantId) {
      return (await first<{ role: Role }>("select role from public.merchant_users where merchant_id = $1 and user_id = $2", [merchantId, userId]))?.role ?? null;
    },
    async merchantOfProgram(id) { return (await first<{ merchant_id: string }>("select merchant_id from public.loyalty_programs where id = $1", [id]))?.merchant_id ?? null; },
    async merchantOfLocation(id) { return (await first<{ merchant_id: string }>("select merchant_id from public.locations where id = $1", [id]))?.merchant_id ?? null; },
    async merchantOfMember(id) { return (await first<{ merchant_id: string }>("select merchant_id from public.merchant_users where id = $1", [id]))?.merchant_id ?? null; },
    async programIds(merchantId) { return (await q<{ id: string }>("select id from public.loyalty_programs where merchant_id = $1", [merchantId])).map((r) => r.id); },
    updateProgram: (id, patch) => update("loyalty_programs", id, patch),
    updateMerchant: (id, patch) => update("merchants", id, patch),
    async insertLocation(merchantId, l) {
      return (await q<{ id: string }>("insert into public.locations (merchant_id, label, address, latitude, longitude) values ($1,$2,$3,$4,$5) returning id", [merchantId, l.label, l.address, l.latitude, l.longitude]))[0].id;
    },
    updateLocation: (id, patch) => update("locations", id, patch),
    async deleteLocation(id) { return (await q("delete from public.locations where id = $1 returning id", [id])).length > 0; },
    async countLocations(merchantId) { return (await first<{ n: number }>("select count(*)::int as n from public.locations where merchant_id = $1", [merchantId]))!.n; },
    async team(merchantId) {
      return (await q<{ id: string; user_id: string; role: Role }>("select id, user_id, role from public.merchant_users where merchant_id = $1 order by created_at, id", [merchantId])).map((m) => ({ id: m.id, userId: m.user_id, role: m.role }));
    },
    async removeMember(id) { return (await q("delete from public.merchant_users where id = $1 returning id", [id])).length > 0; },
  };
}

export type FakeServerAdmin = ServerAdmin & {
  passwords: Map<string, string>;
  deleted: string[];
  uploads: { path: string; bytes: number }[];
  failAddMember?: boolean;
};

export function createPgliteServerAdmin(db: PGlite): FakeServerAdmin {
  const s = <T extends object>(sql: string, params: unknown[] = []) => wrap(async () => (await asServer(db, () => db.query<T>(sql, params))).rows);
  const passwords = new Map<string, string>();
  const deleted: string[] = [];
  const uploads: { path: string; bytes: number }[] = [];

  const self: FakeServerAdmin = {
    passwords, deleted, uploads,
    async createUser(email, password) {
      const existing = await db.query<{ id: string }>("select id from auth.users where lower(email) = $1", [email]);
      if (existing.rows.length) return "exists";
      const id = randomUUID();
      await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
      passwords.set(id, password);
      return { id };
    },
    async ensureUser(email, password) {
      const made = await self.createUser(email, password);
      if (made !== "exists") return { id: made.id, created: true };
      return { id: (await db.query<{ id: string }>("select id from auth.users where lower(email) = $1", [email])).rows[0].id, created: false };
    },
    async deleteUser(userId) { deleted.push(userId); await db.query("delete from auth.users where id = $1", [userId]); },
    async emails(ids) {
      const r = await db.query<{ id: string; email: string }>("select id, email from auth.users where id = any($1::uuid[])", [ids]);
      return Object.fromEntries(r.rows.map((x) => [x.id, x.email]));
    },
    async addMember(merchantId, userId, role) {
      if (self.failAddMember) throw new StoreError("panne simulée");
      await s("insert into public.merchant_users (merchant_id, user_id, role) values ($1, $2, $3)", [merchantId, userId, role]);
    },
    async uploadAsset(path, png) { uploads.push({ path, bytes: png.length }); return `https://test.supabase.co/storage/v1/object/public/merchant-assets/${path}`; },
    async setLogo(merchantId, url) { await s("update public.merchants set logo_url = $2 where id = $1", [merchantId, url]); },
    async setCustomStamp(programId, url) { await s("update public.loyalty_programs set stamp_icon_url = $2, stamp_icon = 'custom' where id = $1", [programId, url]); },
    async setPassword(userId, password) { passwords.set(userId, password); },
    async isPlatformAdmin(userId) { return (await s<{ b: boolean }>("select public.is_platform_admin($1) as b", [userId]))[0].b; },
    async createMerchant(adminId, name, ownerId, stamps, reward) {
      const r = (await s<{ r: { merchant_id: string; program_id: string } }>("select public.admin_create_merchant($1, $2, $3, $4, $5) as r", [adminId, name, ownerId, stamps, reward]))[0].r;
      return { merchantId: r.merchant_id, programId: r.program_id };
    },
    async listMerchants() {
      return (await s<{ id: string; name: string; created_at: string }>("select id, name, created_at::text as created_at from public.merchants order by created_at desc")).map((m) => ({ id: m.id, name: m.name, createdAt: m.created_at }));
    },
  };
  return self;
}
