/* eslint-disable @typescript-eslint/no-explicit-any -- faux client : formes libres */
import { describe, expect, it } from "vitest";
import { createSupabaseOwnerStore, createSupabaseServerAdmin } from "@/lib/admin/supabase-stores";
import { StoreError } from "@/lib/wallet/store";

/** Faux client Supabase : enregistre les appels, répond ce qu'on lui demande. */
function fake(reply: (call: any) => { data?: any; error?: any; count?: number } = () => ({ data: [] })) {
  const calls: any[] = [];
  const chain = (table: string) => {
    const rec: any = { table, ops: [] };
    const api: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: any) => void) => { calls.push(rec); const r = reply(rec); resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null }); };
        }
        return (...args: any[]) => (rec.ops.push([prop, ...args]), api);
      },
    });
    return api;
  };
  const auth: any = { admin: {} };
  const storage = { from: (b: string) => ({ upload: async (path: string, body: Buffer, opts: any) => (calls.push({ upload: { b, path, size: body.length, opts } }), { error: null }), getPublicUrl: (p: string) => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/${b}/${p}` } }) }) };
  const client: any = { from: chain, rpc: async (fn: string, args: any) => (calls.push({ rpc: fn, args }), { data: reply({ rpc: fn }).data ?? null, error: reply({ rpc: fn }).error ?? null }), auth, storage };
  return { client, calls, auth };
}

describe("accès « employé » (avec ses droits)", () => {
  it("lit et modifie avec les bonnes tables, colonnes et filtres", async () => {
    const f = fake((c) => ({ data: c.table === "locations" && c.ops.some((o: any[]) => o[0] === "insert") ? [{ id: "L1" }] : [{ id: "X", role: "owner", merchant_id: "M1" }] }));
    const store = createSupabaseOwnerStore(f.client, "U1");
    expect(await store.myRole("M1")).toBe("owner");
    expect(await store.merchantOfProgram("P1")).toBe("M1");
    expect(await store.updateProgram("P1", { name: "N" })).toBe(true);
    expect(await store.insertLocation("M1", { label: "A", address: "", latitude: 1, longitude: 2 })).toBe("L1");
    const byTable = (t: string) => f.calls.filter((c) => c.table === t);
    expect(byTable("merchant_users")[0].ops).toEqual(expect.arrayContaining([["eq", "merchant_id", "M1"], ["eq", "user_id", "U1"]]));
    expect(byTable("loyalty_programs")[1].ops).toEqual(expect.arrayContaining([["update", { name: "N" }], ["eq", "id", "P1"]]));
    expect(byTable("locations")[0].ops[0]).toEqual(["insert", { merchant_id: "M1", label: "A", address: "", latitude: 1, longitude: 2 }]);
  });

  it("« aucune ligne modifiée » (règle de sécurité) donne false, jamais une erreur", async () => {
    const store = createSupabaseOwnerStore(fake(() => ({ data: [] })).client, "U1");
    expect(await store.updateProgram("P", { name: "x" })).toBe(false);
    expect(await store.updateMerchant("M", { name: "x" })).toBe(false);
    expect(await store.deleteLocation("L")).toBe(false);
    expect(await store.removeMember("R")).toBe(false);
    expect(await store.myRole("M")).toBeNull();
  });

  it("une vraie erreur de la base devient une StoreError (ex. dernier propriétaire)", async () => {
    const store = createSupabaseOwnerStore(fake(() => ({ error: { message: "last_owner", code: "PT409" } })).client, "U1");
    await expect(store.removeMember("R")).rejects.toMatchObject({ message: "last_owner", code: "PT409" });
    await expect(store.removeMember("R")).rejects.toBeInstanceOf(StoreError);
  });

  it("compte les adresses sans les télécharger (count exact, head)", async () => {
    const f = fake(() => ({ count: 7 }));
    expect(await createSupabaseOwnerStore(f.client, "U1").countLocations("M1")).toBe(7);
    expect(f.calls[0].ops[0]).toEqual(["select", "id", { count: "exact", head: true }]);
  });
});

describe("accès « serveur » (clé secrète)", () => {
  it("crée un compte déjà confirmé, avec l'obligation de changer de mot de passe réservée au serveur (app_metadata)", async () => {
    const f = fake();
    let args: any;
    f.auth.admin.createUser = async (a: any) => ((args = a), { data: { user: { id: "U9" } }, error: null });
    expect(await createSupabaseServerAdmin(f.client).createUser("a@b.fr", "Pw")).toEqual({ id: "U9" });
    expect(args).toEqual({ email: "a@b.fr", password: "Pw", email_confirm: true, app_metadata: { must_change_password: true } });
  });

  it("reconnaît « adresse déjà utilisée » (plusieurs formes de réponse), refuse les autres erreurs", async () => {
    for (const error of [{ code: "email_exists", message: "x" }, { message: "A user with this email address has already been registered" }]) {
      const f = fake();
      f.auth.admin.createUser = async () => ({ data: { user: null }, error });
      expect(await createSupabaseServerAdmin(f.client).createUser("a@b.fr", "Pw")).toBe("exists");
    }
    const f = fake();
    f.auth.admin.createUser = async () => ({ data: { user: null }, error: { message: "boom", code: "unexpected_failure" } });
    await expect(createSupabaseServerAdmin(f.client).createUser("a@b.fr", "Pw")).rejects.toBeInstanceOf(StoreError);
  });

  it("ensureUser retrouve un compte existant par e-mail (sans tenir compte de la casse), sur plusieurs pages", async () => {
    const f = fake();
    f.auth.admin.createUser = async () => ({ data: { user: null }, error: { code: "email_exists", message: "x" } });
    const pages: any[] = [{ users: Array.from({ length: 200 }, (_, i) => ({ id: `u${i}`, email: `u${i}@x.fr` })) }, { users: [{ id: "TROUVE", email: "Patron@Cafe.TEST" }] }];
    f.auth.admin.listUsers = async ({ page }: any) => ({ data: pages[page - 1], error: null });
    expect(await createSupabaseServerAdmin(f.client).ensureUser("patron@cafe.test", "Pw")).toEqual({ id: "TROUVE", created: false });
  });

  it("dépose l'image dans le dossier merchant-assets (PNG, 1 an de cache) et renvoie l'adresse publique", async () => {
    const f = fake();
    const url = await createSupabaseServerAdmin(f.client).uploadAsset("m1/logo-abc.png", Buffer.alloc(10));
    expect(f.calls[0].upload).toEqual({ b: "merchant-assets", path: "m1/logo-abc.png", size: 10, opts: { contentType: "image/png", upsert: true, cacheControl: "31536000" } });
    expect(url).toBe("https://x.supabase.co/storage/v1/object/public/merchant-assets/m1/logo-abc.png");
  });

  it("enregistre logo et tampon importé (custom + adresse en même temps, pour respecter la règle de la base)", async () => {
    const f = fake();
    const admin = createSupabaseServerAdmin(f.client);
    await admin.setLogo("M1", "https://x/l.png");
    await admin.setCustomStamp("P1", "https://x/s.png");
    expect(f.calls[0]).toMatchObject({ table: "merchants", ops: [["update", { logo_url: "https://x/l.png" }], ["eq", "id", "M1"]] });
    expect(f.calls[1].ops[0]).toEqual(["update", { stamp_icon_url: "https://x/s.png", stamp_icon: "custom" }]);
  });

  it("change le mot de passe ET efface l'obligation de le changer (serveur seulement)", async () => {
    const f = fake();
    let args: any[] = [];
    f.auth.admin.updateUserById = async (...a: any[]) => ((args = a), { error: null });
    await createSupabaseServerAdmin(f.client).setPassword("U1", "nouveau-mot-de-passe");
    expect(args).toEqual(["U1", { password: "nouveau-mot-de-passe", app_metadata: { must_change_password: false } }]);
  });

  it("appelle les fonctions SQL d'administration avec les bons paramètres", async () => {
    const f = fake((c) => ({ data: c.rpc === "is_platform_admin" ? true : { merchant_id: "M", program_id: "P" } }));
    const admin = createSupabaseServerAdmin(f.client);
    expect(await admin.isPlatformAdmin("U1")).toBe(true);
    expect(await admin.createMerchant("A1", "Café", "O1", 8, "Un thé")).toEqual({ merchantId: "M", programId: "P" });
    expect(f.calls.filter((c) => c.rpc).map((c) => [c.rpc, c.args])).toEqual([
      ["is_platform_admin", { p_user_id: "U1" }],
      ["admin_create_merchant", { p_admin_id: "A1", p_name: "Café", p_owner_user_id: "O1", p_stamps_required: 8, p_reward_label: "Un thé" }],
    ]);
  });
});
