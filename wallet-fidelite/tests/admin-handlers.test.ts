/* eslint-disable @typescript-eslint/no-explicit-any -- tests : JSON non typé */
import type { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  handleAddLocation, handleAddMember, handleChangePassword, handleCreateMerchant, handleDeleteLocation, handleListMerchants, handleListTeam,
  handleRemoveMember, handleUpdateLocation, handleUpdateMerchant, handleUpdateProgram, handleUploadAsset, temporaryPassword, type AdminDeps,
} from "@/lib/admin/handlers";
import { createShop, createTestDb, createUser } from "./db/helpers";
import { createPgliteOwnerStore, createPgliteServerAdmin, type FakeServerAdmin } from "./helpers/pglite-admin";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.close());

const json = (body?: unknown, method = "POST", headers: Record<string, string> = {}) =>
  new Request("https://fidelite.test/api/x", { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });

type Env = { deps: AdminDeps; server: FakeServerAdmin; propagated: string[][] };
const envFor = (userId: string, server = createPgliteServerAdmin(db)): Env => {
  const propagated: string[][] = [];
  return {
    server, propagated,
    deps: { owner: createPgliteOwnerStore(db, userId), server, propagate: async (ids) => void propagated.push(ids), schedule: (w) => void w(), log: () => {} },
  };
};
const shopRow = async (programId: string) => (await db.query<any>("select * from public.loyalty_programs where id = $1", [programId])).rows[0];
const code = async (r: Response) => [r.status, (await r.json()).code ?? "ok"] as const;

describe("réglages du programme", () => {
  it("le propriétaire modifie son programme ; les cartes déjà distribuées sont mises à jour", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    const res = await handleUpdateProgram(json({
      programId: shop.programId, name: "Fidélité Port", stampsRequired: 8, rewardLabel: "Un thé offert", proximityMessage: "Un thé vous attend !",
      isActive: true, doubleScanDelayMinutes: 5, stampIcon: "coffee",
    }), e.deps);
    expect(res.status).toBe(200);
    expect(await shopRow(shop.programId)).toMatchObject({ name: "Fidélité Port", stamps_required: 8, reward_label: "Un thé offert", proximity_message: "Un thé vous attend !", double_scan_delay_minutes: 5, stamp_icon: "coffee" });
    expect(e.propagated).toEqual([[shop.programId]]);
  });

  it("changer seulement le délai anti double scan ne dérange pas les cartes (rien n'y apparaît)", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    await handleUpdateProgram(json({ programId: shop.programId, doubleScanDelayMinutes: 30 }), e.deps);
    expect((await shopRow(shop.programId)).double_scan_delay_minutes).toBe(30);
    expect(e.propagated).toEqual([]);
  });

  it("un employé, ou le propriétaire d'un autre commerce, ne peut rien changer (404), et rien n'est modifié", async () => {
    const shop = await createShop(db);
    const other = await createShop(db);
    for (const who of [shop.staffUserId, other.ownerUserId]) {
      const e = envFor(who);
      expect(await code(await handleUpdateProgram(json({ programId: shop.programId, rewardLabel: "Gratuit pour tous" }), e.deps))).toEqual([404, "not_found"]);
      expect(e.propagated).toEqual([]);
    }
    expect((await shopRow(shop.programId)).reward_label).toBe("1 café offert");
  });

  it("refuse les valeurs invalides (400) sans rien modifier", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    const bad: unknown[] = [
      {}, { programId: "pas-un-uuid", name: "x" }, { programId: shop.programId }, { programId: shop.programId, stampsRequired: 0 },
      { programId: shop.programId, stampsRequired: 51 }, { programId: shop.programId, stampsRequired: "5" }, { programId: shop.programId, stampsRequired: 2.5 },
      { programId: shop.programId, name: "" }, { programId: shop.programId, name: "x".repeat(101) }, { programId: shop.programId, rewardLabel: 42 },
      { programId: shop.programId, proximityMessage: "x".repeat(201) }, { programId: shop.programId, isActive: "oui" },
      { programId: shop.programId, stampIcon: "inconnue" }, { programId: shop.programId, stampIcon: "constructor" }, { programId: shop.programId, doubleScanDelayMinutes: -1 },
    ];
    for (const body of bad) expect((await handleUpdateProgram(json(body), e.deps)).status, JSON.stringify(body)).toBe(400);
    expect((await shopRow(shop.programId)).name).toBe("Carte café");
  });

  it("« custom » est refusé tant qu'aucune image n'a été importée", async () => {
    const shop = await createShop(db);
    expect((await handleUpdateProgram(json({ programId: shop.programId, stampIcon: "custom" }), envFor(shop.ownerUserId).deps)).status).toBe(400);
  });

  it("ne laisse pas modifier ce qui n'est pas prévu (adresse d'image, commerce du programme)", async () => {
    const shop = await createShop(db);
    const other = await createShop(db);
    const e = envFor(shop.ownerUserId);
    await handleUpdateProgram(json({ programId: shop.programId, name: "OK", stamp_icon_url: "https://pirate/x.png", merchantId: other.merchantId, merchant_id: other.merchantId }), e.deps);
    const row = await shopRow(shop.programId);
    expect(row.stamp_icon_url).toBeNull();
    expect(row.merchant_id).toBe(shop.merchantId);
  });

  it("refuse une requête venant d'un autre site (403) ou sans JSON (415)", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    expect((await handleUpdateProgram(json({ programId: shop.programId, name: "X" }, "PATCH", { origin: "https://pirate.example", host: "fidelite.test" }), e.deps)).status).toBe(403);
    expect((await handleUpdateProgram(new Request("https://f.test/x", { method: "PATCH", headers: { "content-type": "text/plain" }, body: "{}" }), e.deps)).status).toBe(415);
  });

  it("une panne de la mise à jour des cartes n'empêche pas d'enregistrer le réglage", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    e.deps.propagate = async () => { throw new Error("Apple injoignable"); };
    expect((await handleUpdateProgram(json({ programId: shop.programId, name: "Nouveau" }), e.deps)).status).toBe(200);
    expect((await shopRow(shop.programId)).name).toBe("Nouveau");
  });
});

describe("nom et couleur du commerce", () => {
  it("le propriétaire change la couleur et le nom ; tous les programmes sont mis à jour", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    expect((await handleUpdateMerchant(json({ merchantId: shop.merchantId, name: "Nouveau nom", brandColor: "#e11d48" }), e.deps)).status).toBe(200);
    expect((await db.query<any>("select name, brand_color from public.merchants where id = $1", [shop.merchantId])).rows[0]).toEqual({ name: "Nouveau nom", brand_color: "#E11D48" });
    expect(e.propagated).toEqual([[shop.programId]]);
  });

  it("refuse une couleur invalide, un employé, un autre commerce", async () => {
    const shop = await createShop(db);
    const other = await createShop(db);
    for (const color of ["rouge", "#FFF", "E11D48", "#GGGGGG", 123]) {
      expect((await handleUpdateMerchant(json({ merchantId: shop.merchantId, brandColor: color }), envFor(shop.ownerUserId).deps)).status, String(color)).toBe(400);
    }
    for (const who of [shop.staffUserId, other.ownerUserId]) {
      expect((await handleUpdateMerchant(json({ merchantId: shop.merchantId, brandColor: "#000000" }), envFor(who).deps)).status).toBe(404);
    }
    expect((await db.query<any>("select brand_color from public.merchants where id = $1", [shop.merchantId])).rows[0].brand_color).toBe("#1F2937");
  });
});

describe("adresses", () => {
  const add = (e: Env, merchantId: string, over: object = {}) => handleAddLocation(json({ merchantId, label: "Boutique centre", address: "1 rue du Port", latitude: 48.8566, longitude: 2.3522, ...over }), e.deps);

  it("ajoute, modifie et supprime une adresse, et met les cartes à jour à chaque fois", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    const added = await (await add(e, shop.merchantId)).json();
    expect(added).toMatchObject({ ok: true, locationCount: 1, overLimit: false });
    const id = added.id as string;

    expect((await handleUpdateLocation(json({ locationId: id, latitude: 45.76, label: "Lyon" }), e.deps)).status).toBe(200);
    expect((await db.query<any>("select label, latitude from public.locations where id = $1", [id])).rows[0]).toEqual({ label: "Lyon", latitude: 45.76 });
    const del = await (await handleDeleteLocation(json({ locationId: id }), e.deps)).json();
    expect(del).toMatchObject({ locationCount: 0 });
    expect(e.propagated).toHaveLength(3);
  });

  it("signale quand il y a plus de 10 adresses (seules 10 comptent pour Apple et Google)", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    let last: any;
    for (let i = 0; i < 11; i++) last = await (await add(e, shop.merchantId, { label: `B${i}` })).json();
    expect(last).toMatchObject({ locationCount: 11, overLimit: true });
  });

  it("refuse des coordonnées ou noms invalides, les employés et les autres commerces", async () => {
    const shop = await createShop(db);
    const other = await createShop(db);
    const e = envFor(shop.ownerUserId);
    for (const over of [{ latitude: 91 }, { longitude: 181 }, { latitude: "48" }, { label: "" }, { latitude: undefined }]) {
      expect((await add(e, shop.merchantId, over)).status, JSON.stringify(over)).toBe(400);
    }
    expect((await add(envFor(shop.staffUserId), shop.merchantId)).status).toBe(404);
    expect((await add(envFor(other.ownerUserId), shop.merchantId)).status).toBe(404);

    const id = (await (await add(e, shop.merchantId)).json()).id;
    for (const who of [shop.staffUserId, other.ownerUserId]) {
      expect((await handleUpdateLocation(json({ locationId: id, label: "Piraté" }), envFor(who).deps)).status).toBe(404);
      expect((await handleDeleteLocation(json({ locationId: id }), envFor(who).deps)).status).toBe(404);
    }
    expect((await db.query<any>("select label from public.locations where id = $1", [id])).rows[0].label).toBe("Boutique centre");
  });
});

describe("équipe", () => {
  const add = (e: Env, merchantId: string, email: string) => handleAddMember(json({ merchantId, email }), e.deps);

  it("crée un compte employé avec un mot de passe provisoire (affiché une seule fois) et le rattache au commerce", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    const res = await add(e, shop.merchantId, "  Nouvel.Employe@Cafe.TEST ");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.email).toBe("nouvel.employe@cafe.test");
    expect(body.temporaryPassword).toMatch(/^[A-Za-z2-9]{14}$/);
    expect(body.temporaryPassword).not.toMatch(/[0O1lI]/); // pas de caractères ambigus
    const userId = (await db.query<{ id: string }>("select id from auth.users where email = 'nouvel.employe@cafe.test'")).rows[0].id;
    expect(e.server.passwords.get(userId)).toBe(body.temporaryPassword);
    expect((await db.query<any>("select role from public.merchant_users where merchant_id = $1 and user_id = $2", [shop.merchantId, userId])).rows).toEqual([{ role: "staff" }]);
  });

  it("refuse une adresse déjà utilisée (on n'accroche jamais le compte d'un autre commerce)", async () => {
    const shop = await createShop(db);
    const other = await createShop(db);
    const e = envFor(shop.ownerUserId);
    const takenEmail = `pris-${other.staffUserId}@test.local`;
    await db.query("update auth.users set email = $2 where id = $1", [other.staffUserId, takenEmail]);
    expect(await code(await add(e, shop.merchantId, takenEmail))).toEqual([409, "email_taken"]);
    expect((await db.query("select 1 from public.merchant_users where user_id = $1 and merchant_id = $2", [other.staffUserId, shop.merchantId])).rows).toHaveLength(0);
  });

  it("n'oublie pas de supprimer le compte créé si le rattachement échoue", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    e.server.failAddMember = true;
    expect((await add(e, shop.merchantId, "rate@cafe.test")).status).toBe(500);
    expect(e.server.deleted).toHaveLength(1);
    expect((await db.query("select 1 from auth.users where email = 'rate@cafe.test'")).rows).toHaveLength(0);
  });

  it("refuse une adresse invalide, un employé, le propriétaire d'un autre commerce", async () => {
    const shop = await createShop(db);
    const other = await createShop(db);
    for (const email of ["pas-un-mail", "", "a@b", "x".repeat(300) + "@a.fr"]) expect((await add(envFor(shop.ownerUserId), shop.merchantId, email)).status, email).toBe(400);
    for (const who of [shop.staffUserId, other.ownerUserId]) {
      const e = envFor(who);
      expect((await add(e, shop.merchantId, "intrus@cafe.test")).status).toBe(404);
      expect(e.server.passwords.size).toBe(0);
    }
  });

  it("le propriétaire liste son équipe avec les e-mails ; un employé non", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    const res = await handleListTeam(new Request(`https://f.test/x?merchantId=${shop.merchantId}`), e.deps);
    const members = (await res.json()).members;
    expect(members).toHaveLength(2);
    expect(members.find((m: any) => m.isMe)).toMatchObject({ role: "owner" });
    expect(members.every((m: any) => /@/.test(m.email))).toBe(true);
    expect((await handleListTeam(new Request(`https://f.test/x?merchantId=${shop.merchantId}`), envFor(shop.staffUserId).deps)).status).toBe(404);
    expect((await handleListTeam(new Request("https://f.test/x?merchantId=pas-un-uuid"), e.deps)).status).toBe(404);
  });

  it("retire un employé ; refuse de retirer le dernier propriétaire ; ignore les membres d'un autre commerce", async () => {
    const shop = await createShop(db);
    const other = await createShop(db);
    const e = envFor(shop.ownerUserId);
    expect((await handleRemoveMember(json({ memberId: other.staffMemberId }, "DELETE"), e.deps)).status).toBe(404);
    expect(await code(await handleRemoveMember(json({ memberId: shop.ownerMemberId }, "DELETE"), e.deps))).toEqual([409, "last_owner"]);
    expect((await handleRemoveMember(json({ memberId: shop.staffMemberId }, "DELETE"), e.deps)).status).toBe(200);
    expect((await db.query("select 1 from public.merchant_users where id = $1", [shop.staffMemberId])).rows).toHaveLength(0);
    expect((await handleRemoveMember(json({ memberId: shop.ownerMemberId }, "DELETE"), envFor(shop.staffUserId).deps)).status).toBe(404);
  });

  it("les mots de passe provisoires sont différents à chaque fois", () => {
    expect(new Set(Array.from({ length: 50 }, temporaryPassword)).size).toBe(50);
  });
});

describe("import du logo et du tampon", () => {
  const image = (w = 300, h = 200) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 30, b: 60, alpha: 1 } } }).png().toBuffer();
  const upload = async (e: Env, fields: Record<string, string>, file?: Buffer | string, headers: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, val] of Object.entries(fields)) form.set(k, val);
    if (file !== undefined) form.set("file", new Blob([typeof file === "string" ? file : new Uint8Array(file)]), "image.png");
    return handleUploadAsset(new Request("https://fidelite.test/api/admin/assets", { method: "POST", body: form, headers }), e.deps);
  };

  it("logo : contrôlé, refabriqué, rangé chez nous ; l'adresse est enregistrée et les cartes mises à jour", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    const res = await upload(e, { kind: "logo", id: shop.merchantId }, await image());
    expect(res.status).toBe(200);
    const { url } = await res.json();
    expect(url).toMatch(new RegExp(`/merchant-assets/${shop.merchantId}/logo-[0-9a-f]{12}\\.png$`));
    expect(e.server.uploads).toHaveLength(1);
    expect((await db.query<any>("select logo_url from public.merchants where id = $1", [shop.merchantId])).rows[0].logo_url).toBe(url);
    expect(e.propagated).toEqual([[shop.programId]]);
  });

  it("tampon : active « custom » avec l'image importée", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    const res = await upload(e, { kind: "stamp", id: shop.programId }, await image(200, 200));
    expect(res.status).toBe(200);
    expect(await shopRow(shop.programId)).toMatchObject({ stamp_icon: "custom", stamp_icon_url: (await res.json()).url });
  });

  it("refuse un employé et un autre commerce (404) sans rien ranger", async () => {
    const shop = await createShop(db);
    const other = await createShop(db);
    for (const who of [shop.staffUserId, other.ownerUserId]) {
      const e = envFor(who);
      expect((await upload(e, { kind: "logo", id: shop.merchantId }, await image())).status).toBe(404);
      expect((await upload(e, { kind: "stamp", id: shop.programId }, await image())).status).toBe(404);
      expect(e.server.uploads).toHaveLength(0);
    }
  });

  it("refuse les fichiers qui ne sont pas des images (422), trop lourds (413), et les requêtes mal formées", async () => {
    const shop = await createShop(db);
    const e = envFor(shop.ownerUserId);
    expect((await upload(e, { kind: "logo", id: shop.merchantId }, "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")).status).toBe(422);
    expect((await upload(e, { kind: "logo", id: shop.merchantId }, "du texte")).status).toBe(422);
    expect((await upload(e, { kind: "logo", id: shop.merchantId }, await image(20, 20))).status).toBe(422);
    expect((await upload(e, { kind: "logo", id: shop.merchantId }, await image(), { "content-length": String(10 * 1024 * 1024) })).status).toBe(413);
    for (const fields of [{ kind: "autre", id: shop.merchantId }, { kind: "logo", id: "pas-un-uuid" }, { kind: "logo" }] as Record<string, string>[]) {
      expect((await upload(e, fields, await image())).status, JSON.stringify(fields)).toBe(400);
    }
    expect((await upload(e, { kind: "logo", id: shop.merchantId })).status).toBe(400); // pas de fichier
    expect((await handleUploadAsset(json({}), e.deps)).status).toBe(415);
    expect((await upload(e, { kind: "logo", id: shop.merchantId }, await image(), { origin: "https://pirate.example", host: "fidelite.test" })).status).toBe(403);
    expect(e.server.uploads).toHaveLength(0);
    expect((await db.query<any>("select logo_url from public.merchants where id = $1", [shop.merchantId])).rows[0].logo_url).toBeNull();
  });
});

describe("mot de passe", () => {
  it("accepte un mot de passe solide et le fait enregistrer par le serveur pour CET utilisateur", async () => {
    const e = envFor(await createUser(db));
    const res = await handleChangePassword(json({ password: "un-bon-mot-de-passe-42" }), { server: e.server, userId: "u-1", log: () => {} });
    expect(res.status).toBe(200);
    expect(e.server.passwords.get("u-1")).toBe("un-bon-mot-de-passe-42");
  });

  it("refuse les mots de passe trop courts, trop longs ou trop simples", async () => {
    const e = envFor(await createUser(db));
    for (const password of ["court", "123456789", "aaaaaaaaaaaa", "x".repeat(73), 12345678901, undefined]) {
      const res = await handleChangePassword(json({ password }), { server: e.server, userId: "u-2", log: () => {} });
      expect(res.status, String(password)).toBe(400);
    }
    expect(e.server.passwords.has("u-2")).toBe(false);
  });
});

describe("création d'un commerce par la propriétaire de la solution", () => {
  async function platform() {
    const adminId = await createUser(db);
    await db.query("insert into public.platform_admins (user_id) values ($1)", [adminId]);
    const server = createPgliteServerAdmin(db);
    return { adminId, server, deps: { ...envFor(adminId, server).deps, adminUserId: adminId } };
  }
  const create = (deps: AdminDeps & { adminUserId: string }, over: object = {}) => handleCreateMerchant(json({ name: "Café du Port", ownerEmail: "Patron@Cafe.Test", ...over }), deps);

  it("crée le commerce, son programme pré-rempli et le compte du propriétaire (mot de passe provisoire affiché une fois)", async () => {
    const p = await platform();
    const res = await create(p.deps, { stampsRequired: 8, rewardLabel: "1 baguette offerte" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ ownerEmail: "patron@cafe.test" });
    expect(body.temporaryPassword).toHaveLength(14);
    const prog = (await db.query<any>("select stamps_required, reward_label from public.loyalty_programs where id = $1", [body.programId])).rows[0];
    expect(prog).toEqual({ stamps_required: 8, reward_label: "1 baguette offerte" });
    expect((await db.query<any>("select role from public.merchant_users where merchant_id = $1", [body.merchantId])).rows).toEqual([{ role: "owner" }]);
    expect((await db.query<any>("select action from public.admin_audit_log where details->>'merchant_id' = $1", [body.merchantId])).rows).toEqual([{ action: "create_merchant" }]);
  });

  it("par défaut : 10 cases et une récompense générique", async () => {
    const p = await platform();
    const body = await (await create(p.deps, { ownerEmail: "autre@cafe.test" })).json();
    expect((await db.query<any>("select stamps_required, reward_label from public.loyalty_programs where id = $1", [body.programId])).rows[0]).toEqual({ stamps_required: 10, reward_label: "Une récompense offerte" });
  });

  it("un propriétaire déjà inscrit (autre commerce) est rattaché sans nouveau mot de passe", async () => {
    const p = await platform();
    await create(p.deps, { ownerEmail: "multi@cafe.test", name: "Premier" });
    const second = await (await create(p.deps, { ownerEmail: "multi@cafe.test", name: "Second" })).json();
    expect(second.temporaryPassword).toBeNull();
    expect((await db.query("select 1 from public.merchant_users mu join auth.users u on u.id = mu.user_id where u.email = 'multi@cafe.test'")).rows).toHaveLength(2);
  });

  it("répond 404 à qui n'est pas administrateur, SANS créer aucun compte ni commerce", async () => {
    const intruder = await createUser(db);
    const server = createPgliteServerAdmin(db);
    const before = (await db.query<{ n: number }>("select count(*)::int as n from public.merchants")).rows[0].n;
    const deps = { ...envFor(intruder, server).deps, adminUserId: intruder };
    expect(await code(await create(deps, { ownerEmail: "intrus@cafe.test" }))).toEqual([404, "not_found"]);
    expect((await handleListMerchants(deps)).status).toBe(404);
    expect(server.passwords.size).toBe(0);
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.merchants")).rows[0].n).toBe(before);
  });

  it("valeurs invalides : 400 ; et le compte créé en route est supprimé (pas de compte orphelin)", async () => {
    const p = await platform();
    for (const over of [{ name: "" }, { ownerEmail: "pas-un-mail" }, { stampsRequired: 0 }, { stampsRequired: 51 }, { rewardLabel: "" }]) {
      expect((await create(p.deps, { ownerEmail: "valide@cafe.test", ...over })).status, JSON.stringify(over)).toBe(400);
    }
    expect((await db.query("select 1 from auth.users where email = 'valide@cafe.test'")).rows).toHaveLength(0);
  });

  it("liste les commerces pour la propriétaire", async () => {
    const p = await platform();
    await create(p.deps, { ownerEmail: "liste@cafe.test", name: "Café Liste" });
    const merchants = (await (await handleListMerchants(p.deps)).json()).merchants;
    expect(merchants.some((m: any) => m.name === "Café Liste")).toBe(true);
  });
});
