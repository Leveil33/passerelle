import type { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { propagateProgram, propagatePrograms } from "@/lib/admin/propagate";
import { getAppleConfig } from "@/lib/apple/config";
import type { PushOptions, PushResult } from "@/lib/apple/push";
import { createWalletApi } from "@/lib/google/api";
import { createTokenProvider } from "@/lib/google/auth";
import { createSaveLink, type GoogleDeps } from "@/lib/google/service";
import type { WalletStore } from "@/lib/wallet/store";
import { createShop, createTestDb } from "./db/helpers";
import { appleTestEnv, createTestCerts, type TestCerts } from "./helpers/certs";
import { createServiceAccountKeys, startFakeGoogle } from "./helpers/fake-google";
import { createPgliteWalletStore } from "./helpers/pglite-store";

const EMAIL = "wallet@projet.iam.gserviceaccount.com";
const keys = createServiceAccountKeys();
let db: PGlite;
let store: WalletStore;
let certs: TestCerts;
let google: Awaited<ReturnType<typeof startFakeGoogle>>;
let googleDeps: GoogleDeps;
let appleConfig: ReturnType<typeof getAppleConfig>;

beforeAll(async () => {
  db = await createTestDb();
  store = createPgliteWalletStore(db);
  certs = createTestCerts();
  appleConfig = getAppleConfig(appleTestEnv(certs));
  google = await startFakeGoogle({ email: EMAIL, publicKey: keys.publicKey });
});
afterAll(async () => {
  certs.cleanup();
  await google.close();
  await db.close();
});
beforeEach(() => {
  google.reset();
  googleDeps = {
    api: createWalletApi({ getToken: createTokenProvider({ email: EMAIL, privateKey: keys.privateKey, tokenUrl: google.tokenUrl }), baseUrl: google.apiUrl, timeoutMs: 3000 }),
    config: { issuerId: "3388000000022000000", serviceAccountEmail: EMAIL, privateKey: keys.privateKey, appUrl: "https://fidelite.test" },
    qrSecret: "p".repeat(48),
    store,
  };
});

/** Un programme avec `apple` cartes Apple (un jeton chacune) et `google` cartes Google (déjà créées chez Google). */
async function program(apple: number, googleCards: number) {
  const shop = await createShop(db, { stampsRequired: 5 });
  const tokens: string[] = [];
  const serials: string[] = [];
  for (let i = 0; i < apple; i++) {
    const { serialNumber } = await store.createCard({ programId: shop.programId, firstName: `A${i}` });
    const token = (await store.passData(serialNumber))!.card.auth_token;
    const push = `aa${i.toString(16).padStart(2, "0")}${randomBytes(30).toString("hex")}`; // unique par carte
    await store.register(serialNumber, token, `iphone-${i}`, push);
    tokens.push(push);
  }
  for (let i = 0; i < googleCards; i++) {
    const { serialNumber } = await store.createCard({ programId: shop.programId, firstName: `G${i}` });
    await createSaveLink(serialNumber, googleDeps);
    serials.push(serialNumber);
  }
  google.reset();
  return { shop, tokens, serials };
}

describe("mise à jour d'Apple (signal à tous les iPhone du programme)", () => {
  it("envoie le signal à chaque iPhone et oublie ceux qui n'existent plus", async () => {
    const p = await program(3, 0);
    const sent: string[][] = [];
    const sender = async (tokens: string[], o: PushOptions): Promise<PushResult[]> => {
      sent.push(tokens);
      expect(o.passTypeId).toBe("pass.test.fidelite");
      return tokens.map((token) => ({ token, status: token === p.tokens[1] ? 410 : 200, invalid: token === p.tokens[1] }));
    };
    const res = await propagateProgram(p.shop.programId, { store, apple: { config: appleConfig, sender }, log: () => {} });
    expect(res.apple).toEqual({ tokens: 3, sent: 2, removed: 1 });
    expect(sent.flat().sort()).toEqual([...p.tokens].sort());
    expect((await store.programPushTokens(p.shop.programId, 10)).sort()).toEqual([p.tokens[0], p.tokens[2]].sort());
  });

  it("n'envoie rien aux iPhone d'un autre programme", async () => {
    const mine = await program(1, 0);
    const other = await program(2, 0);
    let seen: string[] = [];
    await propagateProgram(mine.shop.programId, { store, apple: { config: appleConfig, sender: async (t) => { seen = t; return t.map((token) => ({ token, status: 200, invalid: false })); } } });
    expect(seen).toEqual(mine.tokens);
    expect(seen.some((t) => other.tokens.includes(t))).toBe(false);
  });

  it("découpe en paquets de 500 au maximum", async () => {
    const p = await program(0, 0);
    const { serialNumber } = await store.createCard({ programId: p.shop.programId, firstName: "X" });
    const token = (await store.passData(serialNumber))!.card.auth_token;
    for (let i = 0; i < 7; i++) await store.register(serialNumber, token, `dev-${i}`, `bb${i.toString(16).padStart(2, "0")}`.padEnd(64, "0"));
    const batches: number[] = [];
    await propagateProgram(p.shop.programId, { store, apple: { config: appleConfig, sender: async (t) => (batches.push(t.length), t.map((token) => ({ token, status: 200, invalid: false }))) } });
    expect(batches).toEqual([7]);
  });

  it("une panne d'Apple ne lève jamais d'erreur", async () => {
    const p = await program(1, 0);
    const logs: string[] = [];
    const res = await propagateProgram(p.shop.programId, { store, apple: { config: appleConfig, sender: async () => { throw new Error("APNs injoignable"); } }, log: (m) => void logs.push(m) });
    expect(res.apple).toBeNull();
    expect(logs.some((l) => l.includes("Apple"))).toBe(true);
  });

  it("limite le nombre de cartes traitées et le signale", async () => {
    const p = await program(5, 0);
    let count = 0;
    const res = await propagateProgram(p.shop.programId, { store, limit: 3, log: () => {}, apple: { config: appleConfig, sender: async (t) => ((count = t.length), t.map((token) => ({ token, status: 200, invalid: false }))) } });
    expect(count).toBe(3);
    expect(res.truncated).toBe(true);
  });
});

describe("mise à jour de Google (classe et cartes)", () => {
  it("met à jour la classe et chaque carte Google, sans envoyer de notification", async () => {
    const p = await program(0, 3);
    await db.query("update public.merchants set brand_color = '#00AA00' where id = $1", [p.shop.merchantId]);
    await db.query("update public.loyalty_programs set reward_label = 'Un thé offert' where id = $1", [p.shop.programId]);

    const res = await propagateProgram(p.shop.programId, { store, google: googleDeps, log: () => {} });

    expect(res.google).toEqual({ cards: 3, patched: 3, failed: 0, classUpdated: true });
    expect(google.classes.get(`3388000000022000000.${p.shop.programId}`)?.hexBackgroundColor).toBe("#00AA00");
    for (const serial of p.serials) {
      const obj = google.objects.get(`3388000000022000000.${serial}`)!;
      expect(obj.textModulesData[0].body).toBe("Un thé offert");
      expect(obj.messages).toHaveLength(0); // aucune notification pour un simple changement d'apparence
    }
  });

  it("ne touche pas les cartes qui ne sont pas dans Google Wallet", async () => {
    const p = await program(2, 1);
    const res = await propagateProgram(p.shop.programId, { store, google: googleDeps, log: () => {} });
    expect(res.google?.cards).toBe(1);
  });

  it("Google en panne : résumé avec les échecs, aucune erreur levée", async () => {
    const p = await program(0, 2);
    google.fail(/PATCH \/loyaltyObject/, 500, undefined, 2);
    google.fail(/POST \/loyaltyClass/, 500);
    const res = await propagateProgram(p.shop.programId, { store, google: googleDeps, log: () => {} });
    expect(res.google).toMatchObject({ cards: 2, classUpdated: false });
    expect(res.google!.failed).toBe(2);
  });
});

describe("ensemble", () => {
  it("sans Apple ni Google configurés : rien à faire, aucune erreur", async () => {
    const p = await program(1, 1);
    expect(await propagateProgram(p.shop.programId, { store })).toEqual({ apple: null, google: null, truncated: false });
  });

  it("plusieurs programmes à la suite", async () => {
    const a = await program(1, 0);
    const b = await program(1, 0);
    const seen: string[][] = [];
    const sender = async (t: string[]) => (seen.push(t), t.map((token) => ({ token, status: 200, invalid: false })));
    const out = await propagatePrograms([a.shop.programId, b.shop.programId], { store, apple: { config: appleConfig, sender } });
    expect(out).toHaveLength(2);
    expect(seen).toEqual([a.tokens, b.tokens]);
  });
});
