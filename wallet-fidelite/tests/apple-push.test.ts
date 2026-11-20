import type { PGlite } from "@electric-sql/pglite";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAppleConfig } from "@/lib/apple/config";
import { notifyCardUpdated } from "@/lib/apple/notify";
import { sendPassUpdatePushes, type PushOptions } from "@/lib/apple/push";
import type { WalletStore } from "@/lib/wallet/store";
import { createShop, createTestDb, createCard } from "./db/helpers";
import { appleTestEnv, createTestCerts, type TestCerts } from "./helpers/certs";
import { createPgliteWalletStore } from "./helpers/pglite-store";

// Jetons de test : le préfixe décide de la réponse du faux serveur Apple.
const tok = (prefix: string, n = 0) => (prefix + n.toString(16).padStart(2, "0")).padEnd(64, "0");
const OK = tok("aa");
const GONE = tok("bb"); //   410 Unregistered
const BAD = tok("cc"); //    400 BadDeviceToken
const REFUSED = tok("dd"); // 403 BadCertificate
const BROKEN = tok("ee"); // 500
const HANG = tok("ff"); //   ne répond jamais

type Seen = { path: string; method: string; topic?: string; pushType?: string; contentType?: string; body: string; clientCertCN?: string };
let certs: TestCerts;
let server: http2.Http2SecureServer;
let host: string;
const seen: Seen[] = [];
const sockets = new Set<import("node:net").Socket>();

beforeAll(async () => {
  certs = createTestCerts();
  server = http2.createSecureServer({ key: certs.tlsKey, cert: certs.tlsCert, requestCert: true, rejectUnauthorized: false });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  server.on("stream", (stream, headers) => {
    const peer = (stream.session?.socket as TLSSocket | undefined)?.getPeerCertificate?.();
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => (body += c));
    stream.on("end", () => {
      const path = String(headers[":path"]);
      seen.push({
        path,
        method: String(headers[":method"]),
        topic: headers["apns-topic"] as string | undefined,
        pushType: headers["apns-push-type"] as string | undefined,
        contentType: headers["content-type"] as string | undefined,
        body,
        clientCertCN: peer && "subject" in peer ? String((peer.subject as { CN?: string }).CN) : undefined,
      });
      const token = path.split("/").pop()!;
      if (token === HANG) return; // pas de réponse
      const [status, reason] = token === GONE ? [410, "Unregistered"] : token === BAD ? [400, "BadDeviceToken"] : token === REFUSED ? [403, "BadCertificate"] : token === BROKEN ? [500, "InternalServerError"] : [200, undefined];
      stream.respond({ ":status": status, "content-type": "application/json" });
      stream.end(reason ? JSON.stringify({ reason }) : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `https://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  certs.cleanup();
});

const options = (over: Partial<PushOptions> = {}): PushOptions => ({
  passTypeId: "pass.test.fidelite",
  cert: certs.signerCert,
  key: certs.signerKey,
  host,
  ca: certs.tlsCert,
  timeoutMs: 3000,
  ...over,
});

describe("envoi du signal à Apple (APNs)", () => {
  it("envoie un message VIDE au bon jeton, avec le Pass Type ID pour sujet et le certificat de la carte", async () => {
    seen.length = 0;
    const [r] = await sendPassUpdatePushes([OK], options());
    expect(r).toMatchObject({ token: OK, status: 200, invalid: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: `/3/device/${OK}`,
      topic: "pass.test.fidelite",
      contentType: "application/json",
      body: "{}",
    });
    expect(seen[0].pushType).toBeUndefined(); // non précisé par Apple pour les cartes : on ne l'envoie pas
    expect(seen[0].clientCertCN).toContain("Pass Type ID"); // le certificat client a bien été présenté
  });

  it("signale les appareils disparus (410 / BadDeviceToken) pour qu'on les oublie", async () => {
    const results = await sendPassUpdatePushes([OK, GONE, BAD], options());
    const by = Object.fromEntries(results.map((r) => [r.token, r]));
    expect(by[OK]).toMatchObject({ status: 200, invalid: false });
    expect(by[GONE]).toMatchObject({ status: 410, reason: "Unregistered", invalid: true });
    expect(by[BAD]).toMatchObject({ status: 400, reason: "BadDeviceToken", invalid: true });
  });

  it("un refus d'Apple lié à NOTRE certificat ou une panne d'Apple ne fait PAS oublier l'appareil", async () => {
    const results = await sendPassUpdatePushes([REFUSED, BROKEN], options());
    for (const r of results) expect(r.invalid, r.reason).toBe(false);
    expect(results.find((r) => r.token === REFUSED)).toMatchObject({ status: 403, reason: "BadCertificate" });
    expect(results.find((r) => r.token === BROKEN)?.status).toBe(500);
  });

  it("n'envoie rien pour un jeton illisible, et le signale comme invalide", async () => {
    seen.length = 0;
    const results = await sendPassUpdatePushes(["pas-hexadécimal", "../../x", ""], options());
    expect(seen).toHaveLength(0);
    expect(results.every((r) => r.invalid && r.status === 0)).toBe(true);
  });

  it("n'attend pas indéfiniment un serveur muet (délai dépassé), sans bloquer les autres", async () => {
    const started = Date.now();
    const results = await sendPassUpdatePushes([HANG, OK], options({ timeoutMs: 400 }));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(results.find((r) => r.token === HANG)).toMatchObject({ status: 0, invalid: false, error: "délai dépassé" });
    expect(results.find((r) => r.token === OK)?.status).toBe(200);
  });

  it("serveur injoignable : renvoie des erreurs, ne lève rien, n'oublie rien", async () => {
    const results = await sendPassUpdatePushes([OK, tok("aa", 1)], options({ host: "https://localhost:1" }));
    expect(results).toHaveLength(2);
    for (const r of results) expect(r).toMatchObject({ status: 0, invalid: false });
    expect(results[0].error).toBeTruthy();
  });

  it("refuse un serveur dont le certificat n'est pas reconnu (pas de signal envoyé à un imposteur)", async () => {
    seen.length = 0;
    const results = await sendPassUpdatePushes([OK], options({ ca: undefined }));
    expect(results[0]).toMatchObject({ status: 0, invalid: false });
    expect(seen).toHaveLength(0);
  });
});

describe("prévenir les iPhone d'une carte (notifyCardUpdated)", () => {
  let db: PGlite;
  let store: WalletStore;
  const config = () => getAppleConfig(appleTestEnv(certs));

  beforeAll(async () => {
    db = await createTestDb();
    store = createPgliteWalletStore(db);
  });
  afterAll(() => db.close());

  async function cardWithDevices(tokens: string[]) {
    const shop = await createShop(db);
    const { cardId } = await createCard(db, shop.programId);
    const data = (await db.query<{ serial_number: string; auth_token: string }>("select serial_number, auth_token from public.cards where id = $1", [cardId])).rows[0];
    for (const [i, token] of tokens.entries()) {
      expect(await store.register(data.serial_number, data.auth_token, `iphone-${i}`, token)).toBe("created");
    }
    return data.serial_number;
  }

  it("prévient tous les iPhone de la carte et oublie ceux qui n'existent plus", async () => {
    const serial = await cardWithDevices([OK, GONE, tok("aa", 2)]);
    const summary = await notifyCardUpdated(serial, { store, config: config(), host, ca: certs.tlsCert, timeoutMs: 3000 });
    expect(summary).toEqual({ targets: 3, sent: 2, removed: 1, failed: 0 });

    const left = (await store.pushTargets(serial)).map((t) => t.pushToken).sort();
    expect(left).toEqual([OK, tok("aa", 2)].sort());
  });

  it("compte les échecs sans rien oublier quand c'est Apple qui a un problème", async () => {
    const serial = await cardWithDevices([BROKEN, OK]);
    const summary = await notifyCardUpdated(serial, { store, config: config(), host, ca: certs.tlsCert, timeoutMs: 3000 });
    expect(summary).toEqual({ targets: 2, sent: 1, removed: 0, failed: 1 });
    expect(await store.pushTargets(serial)).toHaveLength(2);
  });

  it("ne fait rien (et n'ouvre aucune connexion) si aucun iPhone n'est enregistré", async () => {
    const serial = await cardWithDevices([]);
    let called = false;
    const summary = await notifyCardUpdated(serial, { store, config: config(), sender: async () => { called = true; return []; } });
    expect(summary).toEqual({ targets: 0, sent: 0, removed: 0, failed: 0 });
    expect(called).toBe(false);
  });

  it("transmet le certificat et le Pass Type ID de la configuration", async () => {
    const serial = await cardWithDevices([OK]);
    let received: PushOptions | undefined;
    await notifyCardUpdated(serial, {
      store,
      config: config(),
      host: "https://exemple.invalid",
      sender: async (tokens, opts) => { received = opts; return tokens.map((token) => ({ token, status: 200, invalid: false })); },
    });
    expect(received).toMatchObject({ passTypeId: "pass.test.fidelite", host: "https://exemple.invalid" });
    expect(received!.cert.toString()).toContain("BEGIN CERTIFICATE");
  });
});
