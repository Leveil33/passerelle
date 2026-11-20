// Accès réels à Supabase pour l'administration.
import type { SupabaseClient } from "@supabase/supabase-js";
import { StoreError } from "@/lib/wallet/store";
import type { OwnerStore, Role, ServerAdmin } from "./types";

type DbError = { message: string; code?: string; details?: string | null } | null;
const asError = (e: NonNullable<DbError>) => new StoreError(e.message, e.code, e.details);

async function rows<T>(query: PromiseLike<{ data: T[] | null; error: DbError }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw asError(error);
  return data ?? [];
}

/** Accès AU NOM de l'employé connecté : la base applique ses règles de sécurité. */
export function createSupabaseOwnerStore(client: SupabaseClient, userId: string): OwnerStore {
  const merchantOf = async (table: string, id: string) =>
    (await rows<{ merchant_id: string }>(client.from(table).select("merchant_id").eq("id", id)))[0]?.merchant_id ?? null;

  return {
    userId,
    async myRole(merchantId) {
      const r = await rows<{ role: Role }>(client.from("merchant_users").select("role").eq("merchant_id", merchantId).eq("user_id", userId));
      return r[0]?.role ?? null;
    },
    merchantOfProgram: (id) => merchantOf("loyalty_programs", id),
    merchantOfLocation: (id) => merchantOf("locations", id),
    merchantOfMember: (id) => merchantOf("merchant_users", id),
    async programIds(merchantId) {
      return (await rows<{ id: string }>(client.from("loyalty_programs").select("id").eq("merchant_id", merchantId))).map((r) => r.id);
    },
    async updateProgram(id, patch) {
      return (await rows(client.from("loyalty_programs").update(patch).eq("id", id).select("id"))).length > 0;
    },
    async updateMerchant(id, patch) {
      return (await rows(client.from("merchants").update(patch).eq("id", id).select("id"))).length > 0;
    },
    async insertLocation(merchantId, loc) {
      const r = await rows<{ id: string }>(client.from("locations").insert({ merchant_id: merchantId, ...loc }).select("id"));
      if (!r[0]) throw new StoreError("insert_failed");
      return r[0].id;
    },
    async updateLocation(id, patch) {
      return (await rows(client.from("locations").update(patch).eq("id", id).select("id"))).length > 0;
    },
    async deleteLocation(id) {
      return (await rows(client.from("locations").delete().eq("id", id).select("id"))).length > 0;
    },
    async countLocations(merchantId) {
      const { count, error } = await client.from("locations").select("id", { count: "exact", head: true }).eq("merchant_id", merchantId);
      if (error) throw asError(error);
      return count ?? 0;
    },
    async team(merchantId) {
      const r = await rows<{ id: string; user_id: string; role: Role }>(
        client.from("merchant_users").select("id, user_id, role").eq("merchant_id", merchantId).order("created_at", { ascending: true }),
      );
      return r.map((m) => ({ id: m.id, userId: m.user_id, role: m.role }));
    },
    async removeMember(id) {
      return (await rows(client.from("merchant_users").delete().eq("id", id).select("id"))).length > 0;
    },
  };
}

const BUCKET = "merchant-assets";

/** Accès avec la clé secrète : réservé à ce qu'un employé ne peut pas faire, toujours après vérification des droits. */
export function createSupabaseServerAdmin(admin: SupabaseClient): ServerAdmin {
  const isTaken = (e: { code?: string; message: string; status?: number }) => e.code === "email_exists" || e.code === "user_already_exists" || /already (been )?registered|already exists/i.test(e.message);

  async function create(email: string, password: string) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { must_change_password: true }, // modifiable par le serveur seulement (pas par l'utilisateur)
    });
    if (error) {
      if (isTaken(error)) return "exists" as const;
      throw new StoreError(error.message, error.code);
    }
    return { id: data.user.id };
  }

  async function findByEmail(email: string): Promise<string | null> {
    for (let page = 1; page <= 25; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new StoreError(error.message, error.code);
      const hit = data.users.find((u) => u.email?.toLowerCase() === email);
      if (hit) return hit.id;
      if (data.users.length < 200) return null;
    }
    return null;
  }

  const run = async (q: PromiseLike<{ error: DbError }>) => {
    const { error } = await q;
    if (error) throw asError(error);
  };

  return {
    createUser: create,
    async ensureUser(email, password) {
      const made = await create(email, password);
      if (made !== "exists") return { id: made.id, created: true };
      const id = await findByEmail(email);
      if (!id) throw new StoreError("user_lookup_failed");
      return { id, created: false };
    },
    async deleteUser(userId) {
      await admin.auth.admin.deleteUser(userId);
    },
    async emails(userIds) {
      const out: Record<string, string> = {};
      await Promise.all(userIds.map(async (id) => {
        const { data } = await admin.auth.admin.getUserById(id);
        if (data.user?.email) out[id] = data.user.email;
      }));
      return out;
    },
    addMember: (merchantId, userId, role) => run(admin.from("merchant_users").insert({ merchant_id: merchantId, user_id: userId, role })),
    async uploadAsset(path, png) {
      const { error } = await admin.storage.from(BUCKET).upload(path, png, { contentType: "image/png", upsert: true, cacheControl: "31536000" });
      if (error) throw new StoreError(error.message);
      return admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    },
    setLogo: (merchantId, url) => run(admin.from("merchants").update({ logo_url: url }).eq("id", merchantId)),
    setCustomStamp: (programId, url) => run(admin.from("loyalty_programs").update({ stamp_icon_url: url, stamp_icon: "custom" }).eq("id", programId)),
    async setPassword(userId, password) {
      const { error } = await admin.auth.admin.updateUserById(userId, { password, app_metadata: { must_change_password: false } });
      if (error) throw new StoreError(error.message, error.code);
    },
    async isPlatformAdmin(userId) {
      const { data, error } = await admin.rpc("is_platform_admin", { p_user_id: userId });
      if (error) throw asError(error);
      return data === true;
    },
    async createMerchant(adminId, name, ownerUserId, stampsRequired, rewardLabel) {
      const { data, error } = await admin.rpc("admin_create_merchant", {
        p_admin_id: adminId, p_name: name, p_owner_user_id: ownerUserId, p_stamps_required: stampsRequired, p_reward_label: rewardLabel,
      });
      if (error) throw asError(error);
      const r = data as { merchant_id: string; program_id: string };
      return { merchantId: r.merchant_id, programId: r.program_id };
    },
    async listMerchants() {
      const r = await rows<{ id: string; name: string; created_at: string }>(admin.from("merchants").select("id, name, created_at").order("created_at", { ascending: false }));
      return r.map((m) => ({ id: m.id, name: m.name, createdAt: m.created_at }));
    },
  };
}
