// Faux Supabase pour le test dans un navigateur : connexion, lecture des cartes et fonctions de tampon
// (mêmes règles que la vraie base : anti double scan 10 min, annulation 2 min, carte pleine…).
import http from "node:http";

export const USER = { id: "11111111-1111-4111-8111-111111111111", email: "employe@cafe.test", password: "bon-mot-de-passe" };
const MERCHANT = "22222222-2222-4222-8222-222222222222";
export const CARD_ID = "33333333-3333-4333-8333-333333333333";
export const SERIAL = "0123456789abcdef0123456789abcdef";
const REQUIRED = 3;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", aud: "authenticated", email: USER.email, exp })}.signature`;
const userJson = { id: USER.id, aud: "authenticated", role: "authenticated", email: USER.email, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };

export function startFakeSupabase(port: number) {
  const card = { id: CARD_ID, serial_number: SERIAL, customer_id: "cu1", program_id: "p1", stamps: 0, rewards_earned: 0 };
  const events: { type: string; t: number }[] = [];
  const calls: string[] = [];
  const iso = (t: number) => new Date(t).toISOString().replace("Z", "+00:00");

  const server = http.createServer((req, res) => {
    // Le navigateur appelle Supabase directement (connexion) : comme le vrai Supabase, on autorise ces appels.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, apikey, content-type, x-client-info, x-supabase-api-version, accept-profile, content-profile, prefer");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      const authed = req.headers.authorization?.startsWith("Bearer ey") ?? false;
      calls.push(`${req.method} ${url.pathname}`);

      if (url.pathname === "/auth/v1/token") {
        const body = JSON.parse(raw || "{}");
        if (body.email !== USER.email || body.password !== USER.password) return send(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
        const exp = Math.floor(Date.now() / 1000) + 3600;
        return send(200, { access_token: jwt(exp), token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "refresh-1", user: userJson });
      }
      if (url.pathname === "/auth/v1/user") return authed ? send(200, userJson) : send(401, { code: 401, msg: "invalid JWT" });
      if (url.pathname === "/auth/v1/logout") { res.writeHead(204); return res.end(); }
      if (!authed) return send(401, { message: "JWT manquant" });

      const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "");
      const rpc = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname)?.[1];
      if (rpc) {
        const now = Date.now();
        const last = events.at(-1);
        const refuse = (message: string, details: string | null = null) => send(409, { code: "PT409", message, details, hint: null });
        const result = () => ({ card_id: CARD_ID, stamps: card.stamps, stamps_required: REQUIRED, rewards_earned: card.rewards_earned, reward_available: card.stamps >= REQUIRED, event_id: "e" });
        if (rpc === "stamp_card") {
          if (card.stamps >= REQUIRED) return refuse("card_full");
          if (last?.type === "stamp" && now - last.t < 600_000) return refuse("double_scan", String(Math.ceil((600_000 - (now - last.t)) / 1000)));
          card.stamps++; events.push({ type: "stamp", t: now }); return send(200, result());
        }
        if (rpc === "undo_last_stamp") {
          if (!last || last.type !== "stamp" || card.stamps < 1) return refuse("nothing_to_undo");
          if (now - last.t > 120_000) return refuse("undo_expired");
          card.stamps--; events.push({ type: "correction", t: now }); return send(200, result());
        }
        if (rpc === "redeem_reward") {
          if (card.stamps < REQUIRED) return refuse("card_not_full");
          card.stamps = 0; card.rewards_earned++; events.push({ type: "reward_redeemed", t: now }); return send(200, result());
        }
      }
      switch (url.pathname.replace("/rest/v1/", "")) {
        case "merchant_users": return send(200, eq("user_id") === USER.id ? [{ merchant_id: MERCHANT, role: "staff" }] : []);
        case "merchants": return send(200, [{ id: MERCHANT, name: "Café du Port" }]);
        case "cards": return send(200, eq("serial_number") === SERIAL || eq("id") === CARD_ID ? [card] : []);
        case "customers": return send(200, [{ first_name: "Léa" }]);
        case "loyalty_programs": return send(200, [{ name: "Carte café", stamps_required: REQUIRED, reward_label: "1 café offert", is_active: true, double_scan_delay_minutes: 10 }]);
        case "stamp_events": return send(200, events.length ? [{ type: events.at(-1)!.type, created_at: iso(events.at(-1)!.t) }] : []);
      }
      return send(404, { message: "inconnu" });
    });
  });
  server.listen(port, "127.0.0.1");
  return { card, events, calls, close: () => server.close() };
}
