/* eslint-disable @typescript-eslint/no-explicit-any -- tests : on lit du JSON sans le typer en détail */
import type { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWalletApi, GoogleApiError } from "@/lib/google/api";
import { createTokenProvider, GoogleAuthError } from "@/lib/google/auth";
import { buildClass, buildObject, lookHash, notificationMessage, programLogoUrl, truncate } from "@/lib/google/builders";
import { GoogleConfigError, getGoogleConfig } from "@/lib/google/config";
import { createSaveUrl, SAVE_URL_PREFIX } from "@/lib/google/save-link";
import { createSaveLink, notifyGoogleCardUpdated, syncClass, type GoogleDeps } from "@/lib/google/service";
import { handleGoogleLink, handleHeroImage, handleLogoImage } from "@/lib/google/web-service";
import { verifyQrPayload } from "@/lib/loyalty/qr";
import type { PassData } from "@/lib/wallet/types";
import type { WalletStore } from "@/lib/wallet/store";
import { createShop, createTestDb, stamp } from "./db/helpers";
import { createServiceAccountKeys, startFakeGoogle, verifyJwt } from "./helpers/fake-google";
import { createPgliteWalletStore } from "./helpers/pglite-store";

const EMAIL = "wallet@projet-test.iam.gserviceaccount.com";
const ISSUER = "3388000000022000000";
const QR_SECRET = "g".repeat(48);
const APP = "https://fidelite.test";
const keys = createServiceAccountKeys();

let db: PGlite;
let store: WalletStore;
let google: Awaited<ReturnType<typeof startFakeGoogle>>;
let deps: GoogleDeps;

beforeAll(async () => {
  db = await createTestDb();
  store = createPgliteWalletStore(db);
  google = await startFakeGoogle({ email: EMAIL, publicKey: keys.publicKey });
});
afterAll(async () => {
  await google.close();
  await db.close();
});
beforeEach(() => {
  google.reset();
  const getToken = createTokenProvider({ email: EMAIL, privateKey: keys.privateKey, tokenUrl: google.tokenUrl });
  deps = {
    api: createWalletApi({ getToken, baseUrl: google.apiUrl, timeoutMs: 3000 }),
    config: { issuerId: ISSUER, serviceAccountEmail: EMAIL, privateKey: keys.privateKey, appUrl: APP },
    qrSecret: QR_SECRET,
    store,
  };
});

async function newCard(opts: { stampsRequired?: number; name?: string } = {}) {
  const shop = await createShop(db, { stampsRequired: opts.stampsRequired ?? 5, name: opts.name });
  const { serialNumber, cardId } = await store.createCard({ programId: shop.programId, firstName: "Léa" });
  return { shop, serial: serialNumber, cardId, programId: shop.programId, objectId: `${ISSUER}.${serialNumber}`, classId: `${ISSUER}.${shop.programId}` };
}
const apiCalls = (method?: string) => google.requests.filter((r) => !method || r.method === method);
const makeStamps = async (c: { shop: { staffUserId: string }; cardId: string }, n: number) => {
  for (let i = 0; i < n; i++) {
    await stamp(db, c.shop.staffUserId, c.cardId);
    await db.query("update public.stamp_events set created_at = created_at - interval '1 hour' where card_id = $1", [c.cardId]);
  }
};

describe("réglages Google (variables d'environnement)", () => {
  const env = {
    GOOGLE_WALLET_ISSUER_ID: ISSUER,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: EMAIL,
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: keys.privateKey.replace(/\n/g, "\\n"),
    NEXT_PUBLIC_APP_URL: "https://fidelite.test/",
  };

  it("lit les variables et rétablit les retours à la ligne de la clé", () => {
    const c = getGoogleConfig(env);
    expect(c).toMatchObject({ issuerId: ISSUER, serviceAccountEmail: EMAIL, appUrl: "https://fidelite.test" });
    expect(c.privateKey).toBe(keys.privateKey);
  });

  it("liste les variables manquantes sans afficher de valeur", () => {
    const err = (() => { try { getGoogleConfig({}); } catch (e) { return e as Error; } })()!;
    expect(err).toBeInstanceOf(GoogleConfigError);
    for (const n of ["GOOGLE_WALLET_ISSUER_ID", "GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", "NEXT_PUBLIC_APP_URL"]) expect(err.message).toContain(n);
  });

  it("refuse des valeurs absurdes", () => {
    expect(() => getGoogleConfig({ ...env, GOOGLE_WALLET_ISSUER_ID: "abc" })).toThrow(/nombre/);
    expect(() => getGoogleConfig({ ...env, GOOGLE_SERVICE_ACCOUNT_EMAIL: "pas-un-mail" })).toThrow(/e-mail/);
    expect(() => getGoogleConfig({ ...env, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "bonjour" })).toThrow(/PEM/);
    expect(() => getGoogleConfig({ ...env, NEXT_PUBLIC_APP_URL: "http://exemple.fr" })).toThrow(/https/);
  });
});

describe("authentification par compte de service", () => {
  const provider = (over: Partial<Parameters<typeof createTokenProvider>[0]> = {}) =>
    createTokenProvider({ email: EMAIL, privateKey: keys.privateKey, tokenUrl: google.tokenUrl, ...over });

  it("obtient un jeton avec une assertion correctement signée (vérifiée par le faux Google)", async () => {
    const before = google.tokens;
    expect(await provider()()).toMatch(/^tok-\d+$/);
    expect(google.tokens).toBe(before + 1);
    expect(google.assertionProblems).toEqual([]);
  });

  it("réutilise le jeton tant qu'il est valable, et en redemande un après expiration", async () => {
    let t = 1_800_000_000_000;
    const p = provider({ now: () => new Date(t) });
    const before = google.tokens;
    const first = await p();
    expect(await p()).toBe(first);
    expect(google.tokens).toBe(before + 1);
    t += 3600 * 1000; // une heure plus tard
    expect(await p()).not.toBe(first);
    expect(google.tokens).toBe(before + 2);
  });

  it("partage une seule demande entre appels simultanés", async () => {
    const before = google.tokens;
    const p = provider();
    const tokens = await Promise.all([p(), p(), p(), p()]);
    expect(new Set(tokens).size).toBe(1);
    expect(google.tokens).toBe(before + 1);
  });

  it("une clé qui ne correspond pas est refusée, sans jamais afficher la clé", async () => {
    const other = createServiceAccountKeys();
    const err = await provider({ privateKey: other.privateKey })().catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect(err.message).toMatch(/refusé/);
    expect(err.message).not.toContain("PRIVATE KEY");
    expect(google.assertionProblems).toEqual(["signature"]); // c'est bien la signature qui a été jugée fausse
  });

  it("serveur injoignable : erreur claire", async () => {
    const err = await provider({ tokenUrl: "http://127.0.0.1:1/token" })().catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
  });
});

describe("lien « Ajouter à Google Wallet »", () => {
  it("est un JWT signé désignant la carte, avec les bonnes revendications", () => {
    const url = createSaveUrl({ email: EMAIL, privateKey: keys.privateKey, origins: [APP], objectIds: [`${ISSUER}.abc`], now: new Date(1_800_000_000_000) });
    expect(url.startsWith(SAVE_URL_PREFIX)).toBe(true);
    const jwt = verifyJwt(url.slice(SAVE_URL_PREFIX.length), keys.publicKey)!;
    expect(jwt.header.alg).toBe("RS256");
    expect(jwt.claims).toEqual({
      iss: EMAIL, aud: "google", typ: "savetowallet", iat: 1_800_000_000, origins: [APP],
      payload: { loyaltyObjects: [{ id: `${ISSUER}.abc` }] },
    });
    expect(url.length).toBeLessThan(1800);
  });

  it("n'est pas valide si on le modifie", () => {
    const url = createSaveUrl({ email: EMAIL, privateKey: keys.privateKey, origins: [APP], objectIds: ["a.b"] });
    const jwt = url.slice(SAVE_URL_PREFIX.length);
    const [h, , s] = jwt.split(".");
    const forged = Buffer.from(JSON.stringify({ iss: EMAIL, aud: "google", typ: "savetowallet", payload: { loyaltyObjects: [{ id: "a.autre" }] } })).toString("base64url");
    expect(verifyJwt(`${h}.${forged}.${s}`, keys.publicKey)).toBeNull();
  });
});

const sample: PassData = {
  card: { id: "c", serial_number: "0123456789abcdef0123456789abcdef", auth_token: "t", stamps: 3, rewards_earned: 1, platform: "google", updated_at: "2026-11-20T00:00:00.000000Z" },
  customer: { first_name: "Léa" },
  program: { id: "11111111-1111-4111-8111-111111111111", name: "Carte café", stamps_required: 10, reward_label: "1 café offert", proximity_message: "", is_active: true, stamp_icon: "coffee", stamp_icon_url: null },
  merchant: { id: "m", name: "Café du Port", logo_url: null, brand_color: "#E11D48" },
  locations: Array.from({ length: 12 }, (_, i) => ({ label: `B${i}`, address: "", latitude: 48 + i / 100, longitude: 2 })),
};

describe("contenu envoyé à Google", () => {
  const ctx = { issuerId: ISSUER, appUrl: APP };

  it("classe : identité, couleur, logo, et adresses dans merchantLocations (jamais l'ancien champ locations)", () => {
    const c: any = buildClass(sample, ctx);
    expect(c).toMatchObject({ id: `${ISSUER}.${sample.program.id}`, programName: "Carte café", issuerName: "Café du Port", hexBackgroundColor: "#E11D48", reviewStatus: "UNDER_REVIEW" });
    expect(c).not.toHaveProperty("locations");
    expect(c.merchantLocations).toHaveLength(10);
    expect(Object.keys(c.merchantLocations[0]).sort()).toEqual(["latitude", "longitude"]);
    expect(c.programLogo.sourceUri.uri).toMatch(new RegExp(`^${APP}/api/programs/${sample.program.id}/logo\\.png\\?v=[0-9a-f]{8}$`));
  });

  it("classe : le logo du commerçant a la priorité, le nom de l'émetteur est raccourci à 20 caractères", () => {
    const c: any = buildClass({ ...sample, merchant: { ...sample.merchant, logo_url: "https://stockage.exemple/logo.png", name: "Boulangerie Pâtisserie du Grand Port" } }, ctx);
    expect(c.programLogo.sourceUri.uri).toBe("https://stockage.exemple/logo.png");
    expect(c.issuerName.length).toBeLessThanOrEqual(20);
    expect(truncate("court", 20)).toBe("court");
    expect(truncate("x".repeat(30), 10)).toHaveLength(10);
  });

  it("carte : identité, QR signé vérifiable, tampons, récompenses, image des tampons", () => {
    const o: any = buildObject(sample, { ...ctx, qrSecret: QR_SECRET });
    expect(o).toMatchObject({
      id: `${ISSUER}.${sample.card.serial_number}`, classId: `${ISSUER}.${sample.program.id}`, state: "ACTIVE",
      accountId: sample.card.serial_number, accountName: "Léa",
      loyaltyPoints: { label: "Tampons", balance: { string: "3 / 10" } },
      secondaryLoyaltyPoints: { label: "Obtenues", balance: { int: 1 } },
    });
    expect(o.barcode.type).toBe("QR_CODE");
    expect(verifyQrPayload(o.barcode.value, QR_SECRET)).toBe(sample.card.serial_number);
    expect(o.heroImage.sourceUri.uri).toMatch(new RegExp(`^${APP}/api/cards/${sample.card.serial_number}/hero/3\\.png\\?v=[0-9a-f]{8}$`));
    expect(o.textModulesData.map((t: any) => t.id)).toEqual(["reward", "rules"]);
  });

  it("carte : le compteur reste dans la limite de 7 caractères de Google, de 1 à 50 cases", () => {
    for (let n = 1; n <= 50; n++) {
      const o: any = buildObject({ ...sample, program: { ...sample.program, stamps_required: n }, card: { ...sample.card, stamps: n } }, { ...ctx, qrSecret: QR_SECRET });
      expect(o.loyaltyPoints.balance.string.length, `${n}`).toBeLessThanOrEqual(7);
    }
  });

  it("l'adresse de l'image change avec le nombre de tampons, la couleur, l'icône ou le nombre de cases", () => {
    const url = (d: PassData) => (buildObject(d, { ...ctx, qrSecret: QR_SECRET }) as any).heroImage.sourceUri.uri as string;
    const base = url(sample);
    expect(url({ ...sample, card: { ...sample.card, stamps: 4 } })).not.toBe(base);
    expect(url({ ...sample, merchant: { ...sample.merchant, brand_color: "#000000" } })).not.toBe(base);
    expect(url({ ...sample, program: { ...sample.program, stamp_icon: "heart" } })).not.toBe(base);
    expect(url({ ...sample, program: { ...sample.program, stamps_required: 8 } })).not.toBe(base);
    expect(url(sample)).toBe(base); // stable
    expect(lookHash({ brand_color: "#fff", stamp_icon: "star" })).toMatch(/^[0-9a-f]{8}$/);
    expect(programLogoUrl(APP, sample)).toContain("/logo.png?v=");
  });

  it("notification : tampons restants (singulier géré) puis récompense, dans les limites de Google", () => {
    const msg = (stamps: number) => notificationMessage({ ...sample, card: { ...sample.card, stamps } });
    expect(msg(3)).toEqual({ kind: "stamp", header: "Café du Port", body: "Plus que 7 tampons avant ta récompense !" });
    expect(msg(9).body).toBe("Plus qu'1 tampon avant ta récompense !");
    expect(msg(10)).toMatchObject({ kind: "reward", header: "Carte pleine !", body: "Récompense disponible : 1 café offert !" });
    for (let s = 0; s <= 10; s++) {
      const m = msg(s);
      expect(m.header.length, `titre ${s}`).toBeLessThan(29);
      expect(m.body.length, `texte ${s}`).toBeLessThanOrEqual(80);
    }
    const long = notificationMessage({ ...sample, card: { ...sample.card, stamps: 10 }, program: { ...sample.program, reward_label: "x".repeat(120) }, merchant: { ...sample.merchant, name: "y".repeat(80) } });
    expect(long.body.length).toBeLessThanOrEqual(80);
    expect(notificationMessage({ ...sample, merchant: { ...sample.merchant, name: "y".repeat(80) } }).header.length).toBeLessThan(29);
  });
});

describe("client de l'API Google", () => {
  it("renvoie « exists » sur un doublon (409) et lève une erreur claire sinon", async () => {
    const c = await newCard();
    const body: any = buildClass((await store.classData(c.programId))!, deps.config);
    expect(await deps.api.insertClass(body)).toBe("created");
    expect(await deps.api.insertClass(body)).toBe("exists");

    const err = await deps.api.patchObject("inconnu", {}).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(404);
  });

  it("transforme une panne réseau en erreur (status 0), sans clé ni jeton dans le message", async () => {
    const api = createWalletApi({ getToken: async () => "tok-secret", baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    const err = await api.insertClass({ id: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(0);
    expect(err.message).not.toContain("tok-secret");
  });

  it("n'envoie jamais de requête sans jeton valable", async () => {
    const api = createWalletApi({ getToken: async () => "mauvais", baseUrl: google.apiUrl });
    const err = await api.insertClass({ id: "x" }).catch((e) => e);
    expect(err.status).toBe(401);
  });
});

describe("créer la carte et le lien (createSaveLink)", () => {
  it("crée la classe puis la carte chez Google, mémorise la carte, et signe un lien valide", async () => {
    const c = await newCard();
    await db.query("insert into public.locations (merchant_id, label, latitude, longitude) values ($1, 'Port', 48.85, 2.35)", [c.shop.merchantId]);

    const url = (await createSaveLink(c.serial, deps))!;

    expect(google.classes.get(c.classId)).toMatchObject({ programName: "Carte café", merchantLocations: [{ latitude: 48.85, longitude: 2.35 }] });
    expect(google.objects.get(c.objectId)).toMatchObject({ classId: c.classId, state: "ACTIVE", accountName: "Léa" });
    const jwt = verifyJwt(url.slice(SAVE_URL_PREFIX.length), keys.publicKey)!;
    expect(jwt.claims.payload.loyaltyObjects).toEqual([{ id: c.objectId }]);
    expect(jwt.claims.origins).toEqual([APP]);
    const row = (await db.query<{ google_object_id: string; platform: string }>("select google_object_id, platform from public.cards where id = $1", [c.cardId])).rows[0];
    expect(row).toEqual({ google_object_id: c.objectId, platform: "google" });
    expect(google.assertionProblems).toEqual([]);
  });

  it("une 2e demande réutilise la classe et remet la carte à jour (aucun doublon, aucune erreur)", async () => {
    const c = await newCard();
    await createSaveLink(c.serial, deps);
    await makeStamps(c, 1);
    google.reset();

    expect(await createSaveLink(c.serial, deps)).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect(google.classes.size).toBeGreaterThan(0);
    expect(google.objects.get(c.objectId)?.loyaltyPoints.balance.string).toBe("1 / 5");
    expect(apiCalls("PATCH")).toHaveLength(1);
  });

  it("devient « both » pour une carte déjà dans Apple Wallet", async () => {
    const c = await newCard();
    await db.query("update public.cards set platform = 'apple' where id = $1", [c.cardId]);
    await createSaveLink(c.serial, deps);
    expect((await db.query<{ platform: string }>("select platform from public.cards where id = $1", [c.cardId])).rows[0].platform).toBe("both");
  });

  it("renvoie null pour un numéro inconnu, sans appeler Google", async () => {
    expect(await createSaveLink("0".repeat(32), deps)).toBeNull();
    expect(google.requests).toEqual([]);
  });

  it("propage une erreur de Google (permission refusée)", async () => {
    const c = await newCard();
    google.fail(/POST \/loyaltyClass/, 403, "forbidden");
    await expect(createSaveLink(c.serial, deps)).rejects.toThrow(/403/);
    expect((await db.query<{ g: string | null }>("select google_object_id as g from public.cards where id = $1", [c.cardId])).rows[0].g).toBeNull();
  });

  it("syncClass met la classe à jour après un changement du commerçant (ou la crée)", async () => {
    const c = await newCard();
    expect(await syncClass(c.programId, deps)).toBe("created");
    await db.query("update public.merchants set brand_color = '#00AA00' where id = $1", [c.shop.merchantId]);
    expect(await syncClass(c.programId, deps)).toBe("updated");
    expect(google.classes.get(c.classId)?.hexBackgroundColor).toBe("#00AA00");
    expect(await syncClass("00000000-0000-4000-8000-000000000000", deps)).toBe("unknown_program");
  });
});

describe("mettre la carte à jour et notifier (notifyGoogleCardUpdated)", () => {
  async function googleCard(opts?: Parameters<typeof newCard>[0]) {
    const c = await newCard(opts);
    await createSaveLink(c.serial, deps);
    google.reset();
    return c;
  }
  const messages = (c: { objectId: string }) => google.objects.get(c.objectId)!.messages as any[];

  it("après un tampon : met la carte à jour ET envoie une notification TEXT_AND_NOTIFY", async () => {
    const c = await googleCard();
    await makeStamps(c, 1);
    const res = await notifyGoogleCardUpdated(c.serial, "stamp", deps);

    expect(res).toEqual({ patched: true, notified: true });
    expect(google.objects.get(c.objectId)?.loyaltyPoints.balance.string).toBe("1 / 5");
    expect(messages(c)).toHaveLength(1);
    expect(messages(c)[0]).toMatchObject({ messageType: "TEXT_AND_NOTIFY", header: expect.any(String), body: "Plus que 4 tampons avant ta récompense !" });
  });

  it("n'envoie rien aux clients qui n'ont pas la carte Google", async () => {
    const c = await newCard();
    expect(await notifyGoogleCardUpdated(c.serial, "stamp", deps)).toEqual({ patched: false, notified: false, reason: "no_google" });
    expect(await notifyGoogleCardUpdated("0".repeat(32), "stamp", deps)).toMatchObject({ reason: "no_google" });
    expect(google.requests).toEqual([]);
  });

  it("récompense, annulation, rafraîchissement : carte mise à jour, mais pas de notification", async () => {
    const c = await googleCard();
    for (const event of ["redeem", "undo", "refresh"] as const) {
      expect(await notifyGoogleCardUpdated(c.serial, event, deps)).toEqual({ patched: true, notified: false, reason: "not_a_stamp" });
    }
    expect(messages(c)).toHaveLength(0);
  });

  it("respecte le budget : 2 notifications de tampon par 24 h, la carte reste à jour, et la récompense garde sa place", async () => {
    const c = await googleCard({ stampsRequired: 4 });
    const out = [];
    for (let i = 0; i < 3; i++) {
      await makeStamps(c, 1);
      out.push(await notifyGoogleCardUpdated(c.serial, "stamp", deps));
    }
    expect(out.map((r) => [r.patched, r.notified, r.reason])).toEqual([[true, true, undefined], [true, true, undefined], [true, false, "budget"]]);
    expect(google.objects.get(c.objectId)?.loyaltyPoints.balance.string).toBe("3 / 4"); // à jour malgré tout

    await makeStamps(c, 1); // carte pleine
    const reward = await notifyGoogleCardUpdated(c.serial, "stamp", deps);
    expect(reward).toEqual({ patched: true, notified: true });
    expect(messages(c).at(-1)).toMatchObject({ header: "Carte pleine !", body: expect.stringContaining("Récompense disponible") });
    expect(messages(c)).toHaveLength(3);
  });

  it("quota Google dépassé (429) : carte à jour, pas d'exception, raison « quota »", async () => {
    const c = await googleCard();
    await makeStamps(c, 1);
    google.fail(/addMessage/, 429, "quotaExceeded");
    expect(await notifyGoogleCardUpdated(c.serial, "stamp", deps)).toMatchObject({ patched: true, notified: false, reason: "quota" });
  });

  it("trop de messages (10) : efface les anciens et réessaie une fois", async () => {
    const c = await googleCard({ stampsRequired: 50 });
    google.objects.get(c.objectId)!.messages = Array.from({ length: 10 }, (_, i) => ({ id: `old${i}` }));
    await makeStamps(c, 1);
    expect(await notifyGoogleCardUpdated(c.serial, "stamp", deps)).toEqual({ patched: true, notified: true });
    expect(messages(c)).toHaveLength(1);
  });

  it("la carte avait disparu chez Google (404) : elle est recréée", async () => {
    const c = await googleCard();
    google.objects.delete(c.objectId);
    await makeStamps(c, 1);
    expect(await notifyGoogleCardUpdated(c.serial, "refresh", deps)).toMatchObject({ patched: true });
    expect(google.objects.get(c.objectId)?.loyaltyPoints.balance.string).toBe("1 / 5");
  });

  it("Google en panne : aucune exception (un tampon ne doit jamais échouer à cause de Google)", async () => {
    const c = await googleCard();
    const down = createWalletApi({ getToken: async () => "tok-1", baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    const res = await notifyGoogleCardUpdated(c.serial, "stamp", { ...deps, api: down });
    expect(res).toMatchObject({ patched: false, notified: false, reason: "error" });
  });

  it("base de données en panne : aucune exception non plus", async () => {
    const broken: WalletStore = { ...store, passData: async () => { throw new Error("base injoignable"); } };
    expect(await notifyGoogleCardUpdated("x", "stamp", { ...deps, store: broken })).toMatchObject({ reason: "error" });
  });
});

describe("adresses publiques Google", () => {
  const req = (ip = `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) =>
    new Request("https://fidelite.test/x", { headers: { "x-forwarded-for": ip } });
  const webDeps = (over: object = {}) => ({ store, google: deps, log: () => {}, ...over });

  it("lien : redirige (302) vers le lien signé « Ajouter à Google Wallet »", async () => {
    const c = await newCard();
    const res = await handleGoogleLink(req(), { serial: c.serial }, webDeps());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\/ey/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("lien : 404 pour un numéro inconnu ou mal formé, 502 générique si Google échoue", async () => {
    const c = await newCard();
    for (const serial of ["0".repeat(32), "court", "../x"]) expect((await handleGoogleLink(req(), { serial }, webDeps())).status, serial).toBe(404);
    google.fail(/POST \/loyaltyClass/, 500);
    const res = await handleGoogleLink(req(), { serial: c.serial }, webDeps());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toMatch(/500|Échec|Bearer|wallet@/);
  });

  it("lien : limite les demandes répétées (429)", async () => {
    const c = await newCard();
    const same = "198.51.100.77";
    const d = webDeps({ limits: { pass: 2 } });
    const codes = [] as number[];
    for (let i = 0; i < 3; i++) codes.push((await handleGoogleLink(req(same), { serial: c.serial }, d)).status);
    expect(codes).toEqual([302, 302, 429]);
  });

  it("image des tampons : un PNG de 1032 × 812, limité au nombre de cases", async () => {
    const c = await newCard({ stampsRequired: 5 });
    const res = await handleHeroImage(req(), { serial: c.serial, file: "3.png" }, webDeps());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([1032, 812, false]); // fond opaque

    const clamped = await handleHeroImage(req(), { serial: c.serial, file: "999.png" }, webDeps());
    const full = await handleHeroImage(req(), { serial: c.serial, file: "5.png" }, webDeps());
    expect(Buffer.from(await clamped.arrayBuffer()).equals(Buffer.from(await full.arrayBuffer()))).toBe(true);
  });

  it("image des tampons : 404 pour un fichier invalide ou une carte inconnue", async () => {
    const c = await newCard();
    for (const [serial, file] of [[c.serial, "x.png"], [c.serial, "3.jpg"], [c.serial, "../3.png"], [c.serial, "1234.png"], ["0".repeat(32), "3.png"], ["court", "3.png"]]) {
      expect((await handleHeroImage(req(), { serial, file }, webDeps())).status, `${serial} ${file}`).toBe(404);
    }
  });

  it("logo : un PNG carré de 660 px aux couleurs du commerce ; 404 pour un programme inconnu ou invalide", async () => {
    const c = await newCard();
    const res = await handleLogoImage(req(), { programId: c.programId }, webDeps());
    expect(res.status).toBe(200);
    const png = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([660, 660]);
    const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([0x1f, 0x29, 0x37]); // #1F2937 par défaut

    expect((await handleLogoImage(req(), { programId: "00000000-0000-4000-8000-000000000000" }, webDeps())).status).toBe(404);
    expect((await handleLogoImage(req(), { programId: "pas-un-uuid" }, webDeps())).status).toBe(404);
  });
});
