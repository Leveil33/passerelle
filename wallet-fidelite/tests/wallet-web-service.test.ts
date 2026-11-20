/* eslint-disable @typescript-eslint/no-explicit-any -- tests : on lit du JSON sans le typer en détail */
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAppleConfig } from "@/lib/apple/config";
import { buildPkPass } from "@/lib/apple/pass";
import {
  handleCreateCard, handleDownloadPass, handleGetPass, handleListUpdates, handleLog, handleRegister, handleUnregister,
  type WebServiceDeps,
} from "@/lib/apple/web-service";
import { verifyQrPayload } from "@/lib/loyalty/qr";
import { StoreError, type WalletStore } from "@/lib/wallet/store";
import { createShop, createTestDb, stamp } from "./db/helpers";
import { appleTestEnv, createTestCerts, type TestCerts } from "./helpers/certs";
import { createPgliteWalletStore } from "./helpers/pglite-store";

const PASS_TYPE = "pass.test.fidelite";
const QR_SECRET = "q".repeat(48);
let db: PGlite;
let certs: TestCerts;
let store: WalletStore;
let config: ReturnType<typeof getAppleConfig>;
const logged: unknown[] = [];

beforeAll(async () => {
  db = await createTestDb();
  certs = createTestCerts();
  config = getAppleConfig(appleTestEnv(certs));
  store = createPgliteWalletStore(db);
});
afterAll(async () => {
  certs.cleanup();
  await db.close();
});

const deps = (over: Partial<WebServiceDeps> = {}): WebServiceDeps => ({
  store,
  passTypeId: PASS_TYPE,
  buildPass: (data) => buildPkPass(data, { config, qrSecret: QR_SECRET }),
  log: (m, meta) => void logged.push([m, meta]),
  ...over,
});

/** Chaque test utilise sa propre adresse IP (les limites de débit sont comptées par adresse). */
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const request = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("https://fidelite.test/x", {
    method,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers: { "x-forwarded-for": ip(), ...headers },
  });
const auth = (token: string) => ({ authorization: `ApplePass ${token}` });

async function newCard(opts: { stampsRequired?: number } = {}) {
  const shop = await createShop(db, opts);
  const { serialNumber, cardId } = await store.createCard({ programId: shop.programId, firstName: "Léa" });
  const token = (await store.passData(serialNumber))!.card.auth_token;
  return { shop, serial: serialNumber, cardId, token, device: `dev-${randomUUID()}` };
}
const register = (c: { serial: string; token: string; device: string }, push = "aa".repeat(32)) =>
  handleRegister(request("POST", { pushToken: push }, auth(c.token)), { deviceLibraryId: c.device, passTypeId: PASS_TYPE, serial: c.serial }, deps());
const text = (res: Response) => res.text();
const unzip = async (res: Response) => unzipSync(new Uint8Array(await res.arrayBuffer()));
const passJson = async (res: Response) => JSON.parse(Buffer.from((await unzip(res))["pass.json"]).toString("utf8")) as Record<string, any>;

describe("création d'une carte (POST /api/cards)", () => {
  it("crée la carte et renvoie le numéro de série et l'adresse de téléchargement", async () => {
    const shop = await createShop(db);
    const res = await handleCreateCard(request("POST", { programId: shop.programId, firstName: "Camille" }), deps());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.serialNumber).toMatch(/^[0-9a-f]{32}$/);
    expect(body.appleUrl).toBe(`/api/cards/${body.serialNumber}/apple`);
    expect((await store.passData(body.serialNumber))?.customer.first_name).toBe("Camille");
  });

  it("enregistre les consentements cochés", async () => {
    const shop = await createShop(db);
    const res = await handleCreateCard(
      request("POST", { programId: shop.programId, firstName: "Léo", email: "leo@example.com", emailConsent: true, marketingConsent: true }),
      deps(),
    );
    const { serialNumber } = await res.json();
    const row = (await db.query<{ e: boolean; m: boolean }>(
      `select cu.email_consent_at is not null as e, cu.marketing_consent_at is not null as m
         from public.cards c join public.customers cu on cu.id = c.customer_id where c.serial_number = $1`, [serialNumber])).rows[0];
    expect(row).toEqual({ e: true, m: true });
  });

  it("refuse les requêtes mal formées (400), sans toucher à la base", async () => {
    const shop = await createShop(db);
    const before = (await db.query<{ n: number }>("select count(*)::int as n from public.customers")).rows[0].n;
    for (const body of [
      "pas du json", "[]", "null", {},
      { programId: "pas-un-uuid", firstName: "A" },
      { programId: shop.programId },
      { programId: shop.programId, firstName: 42 },
      { programId: shop.programId, firstName: "A", emailConsent: "oui" },
      { programId: shop.programId, firstName: "A", email: 12 },
    ]) {
      const res = await handleCreateCard(request("POST", body), deps());
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.customers")).rows[0].n).toBe(before);
  });

  it("traduit les refus de la base en messages clairs", async () => {
    const shop = await createShop(db);
    const call = (body: object) => handleCreateCard(request("POST", body), deps());

    let res = await call({ programId: randomUUID(), firstName: "A" });
    expect([res.status, (await res.json()).error]).toEqual([404, "Ce programme de fidélité n'existe pas."]);

    res = await call({ programId: shop.programId, firstName: "   " });
    expect([res.status, (await res.json()).error]).toEqual([400, "Le prénom doit faire entre 1 et 60 caractères."]);

    res = await call({ programId: shop.programId, firstName: "Bob", email: "bob@example.com" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("consentement");

    res = await call({ programId: shop.programId, firstName: "Bob", email: "pas-un-mail", emailConsent: true });
    expect((await res.json()).error).toContain("e-mail");

    await db.query("update public.loyalty_programs set is_active = false where id = $1", [shop.programId]);
    res = await call({ programId: shop.programId, firstName: "Bob" });
    expect([res.status, (await res.json()).error]).toEqual([422, "Ce programme n'accepte plus de nouvelles cartes."]);
  });

  it("limite le nombre de créations par adresse IP (429)", async () => {
    const shop = await createShop(db);
    const same = { "x-forwarded-for": "203.0.113.7" };
    const d = deps({ limits: { createCard: 2 } });
    const make = () => handleCreateCard(request("POST", { programId: shop.programId, firstName: "A" }, same), d);
    expect((await make()).status).toBe(201);
    expect((await make()).status).toBe(201);
    const third = await make();
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
  });

  it("si le compteur de requêtes est en panne, la création est refusée (503) plutôt que laissée sans protection", async () => {
    const shop = await createShop(db);
    const broken: WalletStore = { ...store, rateLimit: async () => { throw new Error("base injoignable"); } };
    const res = await handleCreateCard(request("POST", { programId: shop.programId, firstName: "A" }), deps({ store: broken }));
    expect(res.status).toBe(503);
  });

  it("une erreur inattendue ne montre aucun détail technique", async () => {
    const shop = await createShop(db);
    const broken: WalletStore = { ...store, createCard: async () => { throw new StoreError('duplicate key value violates unique constraint "cards_pkey"', "23505"); } };
    const res = await handleCreateCard(request("POST", { programId: shop.programId, firstName: "A" }), deps({ store: broken }));
    expect(res.status).toBe(500);
    expect(await text(res)).not.toMatch(/duplicate|cards_pkey|constraint/);
  });
});

describe("téléchargement de la carte (GET /api/cards/{série}/apple)", () => {
  it("renvoie un .pkpass signé, contenant le bon numéro de série et un QR vérifiable", async () => {
    const c = await newCard();
    const res = await handleDownloadPass(request("GET"), { serial: c.serial }, deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.apple.pkpass");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const pass = await passJson(res);
    expect(pass.serialNumber).toBe(c.serial);
    expect(pass.authenticationToken).toBe(c.token);
    expect(verifyQrPayload(pass.barcodes[0].message, QR_SECRET)).toBe(c.serial);
  });

  it("répond 404 pour un numéro inconnu ou mal formé", async () => {
    for (const serial of ["0".repeat(32), "court", "../etc/passwd", "G".repeat(32)]) {
      expect((await handleDownloadPass(request("GET"), { serial }, deps())).status, serial).toBe(404);
    }
  });

  it("répond 500 générique si la fabrication échoue (détail dans les journaux seulement)", async () => {
    const c = await newCard();
    const before = logged.length;
    const res = await handleDownloadPass(request("GET"), { serial: c.serial }, deps({ buildPass: async () => { throw new Error("APPLE_SIGNER_KEY_BASE64 manquante"); } }));
    expect(res.status).toBe(500);
    expect(await text(res)).not.toContain("APPLE_SIGNER");
    expect(logged.length).toBeGreaterThan(before);
  });

  it("limite les téléchargements répétés (429)", async () => {
    const c = await newCard();
    const same = { "x-forwarded-for": "198.51.100.9" };
    const d = deps({ limits: { pass: 2 } });
    const get = () => handleDownloadPass(request("GET", undefined, same), { serial: c.serial }, d);
    expect([(await get()).status, (await get()).status, (await get()).status]).toEqual([200, 200, 429]);
  });
});

describe("service Web Apple : enregistrement", () => {
  const params = (c: { serial: string; device: string }, passTypeId = PASS_TYPE) => ({ deviceLibraryId: c.device, passTypeId, serial: c.serial });

  it("201 à la première inscription, 200 ensuite", async () => {
    const c = await newCard();
    expect((await register(c)).status).toBe(201);
    expect((await register(c, "bb".repeat(32))).status).toBe(200);
  });

  it("401 sans secret, avec un mauvais secret ou un en-tête mal formé ; rien n'est enregistré", async () => {
    const c = await newCard();
    for (const headers of [{}, auth("faux"), { authorization: "Bearer " + c.token }, { authorization: "ApplePass" }, { authorization: `ApplePass ${c.token} en-trop` }]) {
      const res = await handleRegister(request("POST", { pushToken: "aa".repeat(32) }, headers), params(c), deps());
      expect(res.status, JSON.stringify(headers)).toBe(401);
    }
    expect(await store.pushTargets(c.serial)).toEqual([]);
  });

  it("404 pour un autre Pass Type ID ou un numéro inconnu", async () => {
    const c = await newCard();
    const body = { pushToken: "aa".repeat(32) };
    expect((await handleRegister(request("POST", body, auth(c.token)), params(c, "pass.autre"), deps())).status).toBe(404);
    expect((await handleRegister(request("POST", body, auth(c.token)), { ...params(c), serial: "0".repeat(32) }, deps())).status).toBe(404);
  });

  it("400 si le jeton de notification manque, ou si l'identifiant d'appareil est absurde", async () => {
    const c = await newCard();
    for (const body of [{}, { pushToken: "" }, { pushToken: 42 }, "n'importe quoi"]) {
      expect((await handleRegister(request("POST", body, auth(c.token)), params(c), deps())).status).toBe(400);
    }
    const res = await handleRegister(request("POST", { pushToken: "aa" }, auth(c.token)), { ...params(c), deviceLibraryId: "a b/../c" }, deps());
    expect(res.status).toBe(400);
  });

  it("le secret d'une carte n'ouvre pas une autre carte", async () => {
    const a = await newCard();
    const b = await newCard();
    const res = await handleRegister(request("POST", { pushToken: "aa".repeat(32) }, auth(a.token)), params(b), deps());
    expect(res.status).toBe(401);
  });

  it("désinscription : 200 avec le bon secret, 401 sinon ; la carte n'est alors plus suivie", async () => {
    const c = await newCard();
    await register(c);
    expect((await handleUnregister(request("DELETE", undefined, auth("faux")), params(c), deps())).status).toBe(401);
    expect(await store.pushTargets(c.serial)).toHaveLength(1);
    expect((await handleUnregister(request("DELETE", undefined, auth(c.token)), params(c), deps())).status).toBe(200);
    expect(await store.pushTargets(c.serial)).toEqual([]);
  });

  it("limite les appels d'un même appareil (429)", async () => {
    const c = await newCard();
    const d = deps({ limits: { device: 2 } });
    const call = () => handleRegister(request("POST", { pushToken: "aa".repeat(32) }, auth(c.token)), params(c), d);
    expect([(await call()).status, (await call()).status, (await call()).status]).toEqual([201, 200, 429]);
  });

  it("une panne du compteur ne bloque pas l'enregistrement des cartes (on laisse passer)", async () => {
    const c = await newCard();
    const broken: WalletStore = { ...store, rateLimit: async () => { throw new Error("panne"); } };
    const res = await handleRegister(request("POST", { pushToken: "aa".repeat(32) }, auth(c.token)), params(c), deps({ store: broken }));
    expect(res.status).toBe(201);
  });
});

describe("service Web Apple : cartes modifiées et carte à jour", () => {
  const listParams = (c: { device: string }, passTypeId = PASS_TYPE) => ({ deviceLibraryId: c.device, passTypeId });
  const list = (c: { device: string }, since?: string) =>
    handleListUpdates(
      new Request(`https://fidelite.test/x${since ? `?passesUpdatedSince=${encodeURIComponent(since)}` : ""}`, { headers: { "x-forwarded-for": ip() } }),
      listParams(c),
      deps(),
    );

  it("liste la carte d'un iPhone, puis plus rien tant qu'elle ne change pas", async () => {
    const c = await newCard();
    await register(c);

    const first = await list(c);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.serialNumbers).toEqual([c.serial]);
    expect(body.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    expect((await list(c, body.lastUpdated)).status).toBe(204);
  });

  it("un tampon refait apparaître la carte dans la liste, avec un repère plus récent", async () => {
    const c = await newCard();
    await register(c);
    const tag = (await (await list(c)).json()).lastUpdated as string;

    await stamp(db, c.shop.staffUserId, c.cardId);

    const after = await list(c, tag);
    expect(after.status).toBe(200);
    const body = await after.json();
    expect(body.serialNumbers).toEqual([c.serial]);
    expect(body.lastUpdated > tag).toBe(true);
  });

  it("un repère inconnu ou piégé est ignoré (on renvoie tout) ; un appareil inconnu reçoit 204", async () => {
    const c = await newCard();
    await register(c);
    for (const tag of ["1351981923", "'; drop table cards;--", "2026-11-20"]) {
      const body = await (await list(c, tag)).json();
      expect(body.serialNumbers, tag).toEqual([c.serial]);
    }
    expect((await list({ device: "inconnu" })).status).toBe(204);
  });

  it("404 pour un autre Pass Type ID", async () => {
    const c = await newCard();
    expect((await handleListUpdates(request("GET"), listParams(c, "pass.autre"), deps())).status).toBe(404);
  });

  const getPass = (c: { serial: string }, token: string | null, extra: Record<string, string> = {}, d = deps()) =>
    handleGetPass(request("GET", undefined, { ...(token ? auth(token) : {}), ...extra }), { passTypeId: PASS_TYPE, serial: c.serial }, d);

  it("renvoie la carte avec le bon secret, 401 sinon, 404 si inconnue", async () => {
    const c = await newCard();
    const ok = await getPass(c, c.token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/vnd.apple.pkpass");
    expect((await passJson(ok)).serialNumber).toBe(c.serial);

    expect((await getPass(c, null)).status).toBe(401);
    expect((await getPass(c, "faux")).status).toBe(401);
    expect((await getPass({ serial: "0".repeat(32) }, c.token)).status).toBe(404);
    expect((await handleGetPass(request("GET", undefined, auth(c.token)), { passTypeId: "pass.autre", serial: c.serial }, deps())).status).toBe(404);
  });

  it("la carte reflète le dernier tampon", async () => {
    const c = await newCard({ stampsRequired: 10 });
    expect((await passJson(await getPass(c, c.token))).storeCard.headerFields[0].value).toBe("0 / 10");
    await stamp(db, c.shop.staffUserId, c.cardId);
    const pass = await passJson(await getPass(c, c.token));
    expect(pass.storeCard.headerFields[0].value).toBe("1 / 10");
    expect(pass.storeCard.secondaryFields[0]).toMatchObject({ key: "status", value: "9", changeMessage: "Plus que %@ tampons avant ta récompense !" });
  });

  /** Fait « vieillir » la dernière modification d'une carte (le déclencheur écraserait une mise à jour normale). */
  const backdate = async (cardId: string, seconds: number) => {
    await db.query("alter table public.cards disable trigger cards_touch_updated_at");
    await db.query("update public.cards set updated_at = updated_at - ($2::numeric * interval '1 second') where id = $1", [cardId, seconds]);
    await db.query("alter table public.cards enable trigger cards_touch_updated_at");
  };

  it("répond 304 si l'iPhone a déjà la dernière version, 200 dès qu'un changement est survenu", async () => {
    const c = await newCard();
    await backdate(c.cardId, 10); // le dernier changement date de 10 secondes

    const first = await getPass(c, c.token);
    const lastModified = first.headers.get("last-modified");
    expect(lastModified).toBeTruthy();

    const again = await getPass(c, c.token, { "if-modified-since": lastModified! });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");

    await stamp(db, c.shop.staffUserId, c.cardId);
    const afterStamp = await getPass(c, c.token, { "if-modified-since": lastModified! });
    expect(afterStamp.status).toBe(200);
    expect((await passJson(afterStamp)).storeCard.headerFields[0].value).toBe("1 / 5");
  });

  it("n'annonce pas de date de modification pour un changement qui vient d'avoir lieu (piège de la seconde)", async () => {
    const c = await newCard();
    const res = await getPass(c, c.token);
    expect(res.headers.get("last-modified")).toBeNull();
  });

  it("le secret erroné ne déclenche jamais de fabrication de carte", async () => {
    const c = await newCard();
    let built = 0;
    const d = deps({ buildPass: async () => { built++; return Buffer.alloc(0); } });
    await getPass(c, "faux", {}, d);
    expect(built).toBe(0);
  });
});

describe("journaux envoyés par l'iPhone", () => {
  it("accepte une liste de messages et les consigne (tronqués)", async () => {
    const before = logged.length;
    const res = await handleLog(request("POST", { logs: ["erreur A", "x".repeat(5000)] }), deps());
    expect(res.status).toBe(200);
    expect(logged.length - before).toBe(2);
    const last = logged.at(-1) as [string, string];
    expect(last[1].length).toBe(2000);
  });

  it("refuse un format invalide (400) et limite le volume", async () => {
    for (const body of ["pas du json", {}, { logs: "x" }, { logs: [1, 2] }, { logs: [{}] }]) {
      expect((await handleLog(request("POST", body), deps())).status, JSON.stringify(body)).toBe(400);
    }
    const before = logged.length;
    await handleLog(request("POST", { logs: Array.from({ length: 500 }, (_, i) => `m${i}`) }), deps());
    expect(logged.length - before).toBe(50);
  });

  it("est limité par adresse IP (429)", async () => {
    const same = { "x-forwarded-for": "192.0.2.55" };
    const d = deps({ limits: { log: 1 } });
    expect((await handleLog(request("POST", { logs: ["a"] }, same), d)).status).toBe(200);
    expect((await handleLog(request("POST", { logs: ["b"] }, same), d)).status).toBe(429);
  });
});
