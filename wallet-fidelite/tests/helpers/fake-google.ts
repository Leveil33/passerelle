/* eslint-disable @typescript-eslint/no-explicit-any -- faux serveur de test : JSON non typé */
// Faux serveur Google (authentification + API Wallet) pour les tests : il VÉRIFIE ce que reçoit notre code
// (signature du compte de service, jeton, existence des classes et des cartes, doublons, limite de messages).
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export type Req = { method: string; path: string; body: Record<string, any> | null };

export function createServiceAccountKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey, publicKey };
}

/** Vérifie un JWT RS256 et renvoie ses revendications (ou null si la signature est fausse). */
export function verifyJwt(jwt: string, publicKey: string): { header: any; claims: any } | null {
  const [h, c, s] = jwt.split(".");
  if (!h || !c || !s) return null;
  const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(createPublicKey(publicKey), Buffer.from(s, "base64url"));
  return ok ? { header: JSON.parse(Buffer.from(h, "base64url").toString()), claims: JSON.parse(Buffer.from(c, "base64url").toString()) } : null;
}

export async function startFakeGoogle(opts: { email: string; publicKey: string }) {
  const classes = new Map<string, Record<string, any>>();
  const objects = new Map<string, Record<string, any>>();
  const requests: Req[] = [];
  const failures: { match: RegExp; status: number; reason?: string; times: number }[] = [];
  let tokens = 0;
  let baseUrl = "";
  const assertionProblems: string[] = [];

  const reply = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const apiError = (res: http.ServerResponse, status: number, message: string, reason?: string) =>
    reply(res, status, { error: { code: status, message, errors: reason ? [{ reason }] : [] } });

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const method = req.method ?? "GET";

      if (url.pathname === "/token") {
        const form = new URLSearchParams(raw);
        const verified = verifyJwt(form.get("assertion") ?? "", opts.publicKey);
        if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") assertionProblems.push("grant_type");
        if (!verified) {
          assertionProblems.push("signature");
          return reply(res, 400, { error: "invalid_grant" });
        }
        const { claims, header } = verified;
        if (header.alg !== "RS256") assertionProblems.push("alg");
        if (claims.iss !== opts.email) assertionProblems.push("iss");
        if (claims.scope !== "https://www.googleapis.com/auth/wallet_object.issuer") assertionProblems.push("scope");
        if (claims.aud !== `${baseUrl}/token`) assertionProblems.push("aud");
        if (claims.exp - claims.iat > 3600) assertionProblems.push("durée");
        tokens++;
        return reply(res, 200, { access_token: `tok-${tokens}`, expires_in: 3600, token_type: "Bearer" });
      }

      const path = url.pathname.replace("/walletobjects/v1", "");
      let body: Record<string, any> | null = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      requests.push({ method, path, body });

      if (!/^Bearer tok-\d+$/.test(req.headers.authorization ?? "")) return apiError(res, 401, "Unauthorized");
      const idx = failures.findIndex((f) => f.match.test(`${method} ${path}`) && f.times > 0);
      if (idx >= 0) {
        failures[idx].times--;
        return apiError(res, failures[idx].status, "Échec simulé", failures[idx].reason);
      }

      let m: RegExpExecArray | null;
      if (method === "POST" && path === "/loyaltyClass") {
        const id = body?.id as string;
        if (classes.has(id)) return apiError(res, 409, `Wallet Object Class ${id} already exists.`, "alreadyExists");
        classes.set(id, body ?? {});
        return reply(res, 200, body);
      }
      if ((m = /^\/loyaltyClass\/(.+)$/.exec(path)) && method === "PATCH") {
        const id = decodeURIComponent(m[1]);
        if (!classes.has(id)) return apiError(res, 404, "Class not found");
        classes.set(id, { ...classes.get(id), ...body });
        return reply(res, 200, classes.get(id));
      }
      if (method === "POST" && path === "/loyaltyObject") {
        const id = body?.id as string;
        if (!classes.has(body?.classId)) return apiError(res, 404, "Class not found");
        if (objects.has(id)) return apiError(res, 409, `Wallet Object ${id} already exists.`, "alreadyExists");
        objects.set(id, { ...body, messages: [] });
        return reply(res, 200, body);
      }
      if ((m = /^\/loyaltyObject\/([^/]+)\/addMessage$/.exec(path)) && method === "POST") {
        const id = decodeURIComponent(m[1]);
        const obj = objects.get(id);
        if (!obj) return apiError(res, 404, "Object not found");
        if (!body?.message) return apiError(res, 400, "message manquant");
        if (obj.messages.length >= 10) return apiError(res, 400, "Too many messages");
        obj.messages.push(body.message);
        return reply(res, 200, obj);
      }
      if ((m = /^\/loyaltyObject\/([^/]+)$/.exec(path))) {
        const id = decodeURIComponent(m[1]);
        const obj = objects.get(id);
        if (!obj) return apiError(res, 404, "Object not found");
        if (method === "GET") return reply(res, 200, obj);
        if (method === "PATCH") {
          objects.set(id, { ...obj, ...body });
          return reply(res, 200, objects.get(id));
        }
      }
      return apiError(res, 404, "Inconnu");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });

  return {
    baseUrl,
    tokenUrl: `${baseUrl}/token`,
    apiUrl: `${baseUrl}/walletobjects/v1`,
    classes, objects, requests, assertionProblems,
    get tokens() { return tokens; },
    fail: (match: RegExp, status: number, reason?: string, times = 1) => failures.push({ match, status, reason, times }),
    reset: () => { requests.length = 0; failures.length = 0; assertionProblems.length = 0; },
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}
