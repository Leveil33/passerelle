// Faux Supabase pour le test navigateur de l'administration (compte, programme, adresses, équipe, images, plateforme).
// Il ne refait PAS toute la sécurité (testée ailleurs, sur le vrai SQL) : il vérifie que écrans, adresses et connexions s'enchaînent.
import http from "node:http";

export const M = "22222222-2222-4222-8222-222222222222";
export const P = "44444444-4444-4444-8444-444444444444";
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "proprio@cafe.test", password: "provisoire-1234" };
const ADMIN = { id: "55555555-5555-4555-8555-555555555555", email: "admin@plateforme.test", password: "admin-mot-de-passe" };
export const USERS = { owner: OWNER, admin: ADMIN };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub: string, exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "authenticated", aud: "authenticated", exp })}.signature`;
const subOf = (auth?: string) => { try { return JSON.parse(Buffer.from((auth ?? "").split(".")[1] ?? "", "base64url").toString()).sub as string; } catch { return null; } };

export function startFakeAdminSupabase(port: number) {
  const users = new Map<string, { id: string; email: string; password: string; app_metadata: Record<string, unknown> }>([
    [OWNER.id, { ...OWNER, app_metadata: { must_change_password: true } }],
    [ADMIN.id, { ...ADMIN, app_metadata: {} }],
  ]);
  const state = {
    merchant: { id: M, name: "Café du Port", brand_color: "#1F2937", logo_url: null as string | null },
    program: { id: P, name: "Carte café", stamps_required: 10, reward_label: "1 café offert", proximity_message: "", is_active: true, double_scan_delay_minutes: 10, stamp_icon: "star", stamp_icon_url: null as string | null },
    locations: [] as { id: string; label: string; address: string; latitude: number; longitude: number }[],
    members: [{ id: "mem-owner", user_id: OWNER.id, role: "owner" }] as { id: string; user_id: string; role: string }[],
    merchants: [{ id: M, name: "Café du Port", created_at: "2026-11-01T10:00:00+00:00" }] as { id: string; name: string; created_at: string }[],
    uploads: new Map<string, Buffer>(),
    log: [] as string[],
  };
  let seq = 0;
  const userJson = (u: { id: string; email: string; app_metadata: object }) => ({ id: u.id, aud: "authenticated", role: "authenticated", email: u.email, app_metadata: u.app_metadata, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });

  const server = http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, apikey, content-type, x-client-info, x-supabase-api-version, accept-profile, content-profile, prefer, x-upsert, cache-control, range");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
    res.setHeader("access-control-expose-headers", "content-range");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://x");
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
      const text = raw.toString("utf8");
      const json = () => { try { return JSON.parse(text || "{}"); } catch { return {}; } };
      const bearer = (req.headers.authorization ?? "").replace("Bearer ", "");
      const isService = bearer === "service";
      const me = isService ? null : subOf(bearer);
      const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "");
      state.log.push(`${req.method} ${url.pathname}`);

      // ── Authentification
      if (url.pathname === "/auth/v1/token") {
        const b = json();
        const u = [...users.values()].find((x) => x.email === b.email && x.password === b.password);
        if (!u) return send(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
        const exp = Math.floor(Date.now() / 1000) + 3600;
        return send(200, { access_token: jwt(u.id, exp), token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: `r-${u.id}`, user: userJson(u) });
      }
      if (url.pathname === "/auth/v1/user") { const u = me ? users.get(me) : undefined; return u ? send(200, userJson(u)) : send(401, { code: 401, msg: "invalid JWT" }); }
      if (url.pathname === "/auth/v1/logout") { res.writeHead(204); return res.end(); }
      // ── Administration des comptes (clé secrète)
      const adminUser = /^\/auth\/v1\/admin\/users(?:\/([^/]+))?$/.exec(url.pathname);
      if (adminUser) {
        if (!isService) return send(401, { msg: "service_role requis" });
        const id = adminUser[1];
        if (req.method === "POST" && !id) {
          const b = json();
          if ([...users.values()].some((u) => u.email === b.email)) return send(422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
          const u = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, email: b.email, password: b.password, app_metadata: b.app_metadata ?? {} };
          users.set(u.id, u);
          return send(200, userJson(u));
        }
        if (req.method === "GET" && id) { const u = users.get(id); return u ? send(200, userJson(u)) : send(404, { msg: "not found" }); }
        if (req.method === "PUT" && id) {
          const u = users.get(id); if (!u) return send(404, { msg: "not found" });
          const b = json(); if (b.password) u.password = b.password; if (b.app_metadata) Object.assign(u.app_metadata, b.app_metadata);
          return send(200, userJson(u));
        }
        if (req.method === "DELETE" && id) { users.delete(id); return send(200, {}); }
        if (req.method === "GET") return send(200, { users: [...users.values()].map(userJson), aud: "authenticated" });
      }
      // ── Images
      const put = /^\/storage\/v1\/object\/merchant-assets\/(.+)$/.exec(url.pathname);
      if (put && isService) { state.uploads.set(decodeURIComponent(put[1]), raw); return send(200, { Key: `merchant-assets/${put[1]}` }); }
      const pub = /^\/storage\/v1\/object\/public\/merchant-assets\/(.+)$/.exec(url.pathname);
      if (pub) { const f = state.uploads.get(decodeURIComponent(pub[1])); if (!f) return send(404, {}); res.writeHead(200, { "content-type": "image/png" }); return res.end(f); }

      // ── Fonctions SQL
      const rpc = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname)?.[1];
      if (rpc) {
        const b = json();
        if (rpc === "merchant_stats") return me === OWNER.id ? send(200, { cards: 12, new_cards_7_days: 3, stamps_today: 5, stamps_7_days: 20, rewards_redeemed: 2, rewards_redeemed_7_days: 1 }) : send(403, { code: "PT403", message: "forbidden" });
        if (rpc === "is_platform_admin") return send(200, b.p_user_id === ADMIN.id);
        if (rpc === "admin_create_merchant") {
          const m = { id: `99999999-9999-4999-8999-${String(++seq).padStart(12, "0")}`, name: b.p_name, created_at: new Date().toISOString() };
          state.merchants.unshift(m);
          return send(200, { merchant_id: m.id, program_id: `88888888-8888-4888-8888-${String(seq).padStart(12, "0")}` });
        }
        return send(404, { message: "fonction inconnue" });
      }

      // ── Tables (l'employé n'a de droits que s'il est propriétaire ; le serveur a tous les droits)
      const table = url.pathname.replace("/rest/v1/", "");
      const owner = isService || me === OWNER.id;
      const wantsId = url.searchParams.get("select") === "id";
      const rowsOf = (t: string): any[] => t === "merchant_users" ? state.members : t === "merchants" ? [state.merchant] : t === "loyalty_programs" ? [state.program] : t === "locations" ? state.locations : [];
      const filtered = (t: string) => rowsOf(t).filter((r) => (!eq("id") || r.id === eq("id")) && (!eq("merchant_id") || (t === "locations" || t === "merchant_users" ? (r.merchant_id ?? M) === eq("merchant_id") : true)) && (!eq("user_id") || r.user_id === eq("user_id")) && (!eq("role") || r.role === eq("role")));
      if (req.method === "GET" || req.method === "HEAD") {
        if (!me && !isService) return send(401, { message: "JWT manquant" });
        let rows = filtered(table).map((r) => (table === "merchants" ? r : { ...r, merchant_id: M }));
        if (table === "merchant_users" && eq("user_id") && !isService && eq("user_id") !== me) rows = [];
        if (table === "merchants" && url.searchParams.get("id")?.startsWith("in.")) rows = [state.merchant];
        if (req.method === "HEAD") { res.writeHead(200, { "content-range": `*/${rows.length}` }); return res.end(); }
        return send(200, rows, { "content-range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` });
      }
      if (req.method === "PATCH") {
        const rows = owner ? filtered(table) : [];
        for (const r of rows) Object.assign(r, json());
        return send(200, wantsId ? rows.map((r) => ({ id: r.id })) : rows);
      }
      if (req.method === "POST") {
        const b = json();
        if (table === "locations" && owner) { const l = { id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(++seq).padStart(12, "0")}`, label: b.label, address: b.address ?? "", latitude: b.latitude, longitude: b.longitude }; state.locations.push(l); return send(201, wantsId ? [{ id: l.id }] : [l]); }
        if (table === "merchant_users" && isService) { const m = { id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(++seq).padStart(12, "0")}`, user_id: b.user_id, role: b.role }; state.members.push(m); return send(201, []); }
        return send(403, { code: "42501", message: "permission denied" });
      }
      if (req.method === "DELETE") {
        const rows = owner ? filtered(table) : [];
        const list = rowsOf(table);
        for (const r of rows) { if (table === "merchant_users" && r.role === "owner" && state.members.filter((m) => m.role === "owner").length === 1) return send(409, { code: "PT409", message: "last_owner" }); list.splice(list.indexOf(r), 1); }
        return send(200, wantsId ? rows.map((r) => ({ id: r.id })) : rows);
      }
      return send(404, { message: "inconnu" });
    });
  });
  server.listen(port, "127.0.0.1");
  return { state, users, close: () => server.close() };
}
