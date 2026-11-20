import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signQrPayload } from "@/lib/loyalty/qr";
import { guardPost, handleAction, handleScan, type StaffDeps } from "@/lib/staff/handlers";
import { createSupabaseStaffStore } from "@/lib/staff/supabase-store";
import type { CardAction } from "@/lib/staff/types";
import { StoreError } from "@/lib/wallet/store";
import { createCard, createShop, createTestDb, createUser } from "./db/helpers";
import { createPgliteStaffStore } from "./helpers/pglite-staff-store";

const QR_SECRET = "q".repeat(48);
let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.close());

const post = (body?: unknown, headers: Record<string, string> = {}) =>
  new Request("https://fidelite.test/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? "{}" : typeof body === "string" ? body : JSON.stringify(body),
  });

async function setup(opts: { stampsRequired?: number; delay?: number } = {}) {
  const shop = await createShop(db, { stampsRequired: opts.stampsRequired ?? 3, doubleScanMinutes: opts.delay ?? 10 });
  const { cardId } = await createCard(db, shop.programId, "Léa");
  const serial = (await db.query<{ serial_number: string }>("select serial_number from public.cards where id = $1", [cardId])).rows[0].serial_number;
  return { shop, cardId, serial, code: signQrPayload(serial, QR_SECRET) };
}
const notified: [string, CardAction][] = [];
const depsFor = (userId: string, over: Partial<StaffDeps> = {}): StaffDeps => ({
  staff: createPgliteStaffStore(db, userId),
  qrSecret: QR_SECRET,
  schedule: (work) => void work(),
  notify: async (serial, action) => void notified.push([serial, action]),
  log: () => {},
  ...over,
});
const ageEvents = (cardId: string, minutes: number) =>
  db.query("update public.stamp_events set created_at = created_at - ($2::numeric * interval '1 minute') where card_id = $1", [cardId, minutes]);
const act = (staffId: string, cardId: string, action: string, over: Partial<StaffDeps> = {}) =>
  handleAction(post(), { cardId, action }, depsFor(staffId, over));

describe("protection des adresses de l'appli", () => {
  it("exige du JSON", () => {
    expect(guardPost(new Request("https://f.test/x", { method: "POST", headers: { "content-type": "text/plain" } }))?.status).toBe(415);
    expect(guardPost(new Request("https://f.test/x", { method: "POST" }))?.status).toBe(415);
    expect(guardPost(post())).toBeNull();
  });

  it("refuse une requête venant d'un autre site, accepte celle de notre site", () => {
    const req = (origin: string | null, extra: Record<string, string> = {}) =>
      new Request("https://fidelite.test/x", { method: "POST", headers: { "content-type": "application/json", host: "fidelite.test", ...(origin ? { origin } : {}), ...extra } });
    expect(guardPost(req("https://pirate.example"))?.status).toBe(403);
    expect(guardPost(req("pas-une-adresse"))?.status).toBe(403);
    expect(guardPost(req("https://fidelite.test"))).toBeNull();
    expect(guardPost(req(null))).toBeNull(); // pas d'en-tête Origin : appel direct, le cookie SameSite protège déjà
    expect(guardPost(req("https://autre.vercel.app", { "x-forwarded-host": "autre.vercel.app" }))).toBeNull();
  });
});

describe("scanner une carte (POST /api/scan)", () => {
  it("renvoie l'état de la carte d'un client du commerce de l'employé", async () => {
    const c = await setup({ stampsRequired: 8 });
    const res = await handleScan(post({ code: c.code }), depsFor(c.shop.staffUserId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cardId: c.cardId, firstName: "Léa", programName: "Carte café", stamps: 0, stampsRequired: 8, rewardsEarned: 0,
      rewardLabel: "1 café offert", rewardAvailable: false, programActive: true, undoSecondsLeft: 0, stampBlockedSeconds: 0,
    });
  });

  it("n'expose jamais le secret Apple ni l'e-mail du client", async () => {
    const c = await setup();
    const text = await (await handleScan(post({ code: c.code }), depsFor(c.shop.staffUserId))).text();
    const token = (await db.query<{ auth_token: string }>("select auth_token from public.cards where id = $1", [c.cardId])).rows[0].auth_token;
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/auth_token|email|serial/i);
  });

  it("refuse les requêtes mal formées (400)", async () => {
    const c = await setup();
    for (const body of ["pas du json", {}, { code: 42 }, { code: "" }, { code: "x".repeat(301) }, []]) {
      expect((await handleScan(post(body), depsFor(c.shop.staffUserId))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("refuse un QR qui n'est pas de chez nous : non signé, modifié ou signé avec une autre clé (422)", async () => {
    const c = await setup();
    const [, , sig] = c.code.split(".");
    for (const code of [c.serial, "WL1." + "0".repeat(32) + "." + sig, signQrPayload(c.serial, "x".repeat(48)), "https://exemple.fr", "'; drop table cards;--"]) {
      const res = await handleScan(post({ code }), depsFor(c.shop.staffUserId));
      expect(res.status, code).toBe(422);
      expect((await res.json()).code).toBe("invalid_qr");
    }
  });

  it("répond pareil pour une carte d'un AUTRE commerce et pour une carte inexistante (404)", async () => {
    const mine = await setup();
    const other = await setup();
    const unknown = signQrPayload("0".repeat(32), QR_SECRET);

    const foreign = await handleScan(post({ code: other.code }), depsFor(mine.shop.staffUserId));
    const missing = await handleScan(post({ code: unknown }), depsFor(mine.shop.staffUserId));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  it("un utilisateur connecté qui n'est membre d'aucun commerce ne voit rien", async () => {
    const c = await setup();
    const stranger = await createUser(db);
    expect((await handleScan(post({ code: c.code }), depsFor(stranger))).status).toBe(404);
  });

  it("annonce le délai d'attente et la possibilité d'annuler après un tampon récent", async () => {
    const c = await setup({ delay: 10 });
    await act(c.shop.staffUserId, c.cardId, "stamp");
    await ageEvents(c.cardId, 1); // le tampon date d'une minute
    const state = await (await handleScan(post({ code: c.code }), depsFor(c.shop.staffUserId))).json();
    expect(state.stamps).toBe(1);
    expect(state.undoSecondsLeft).toBeGreaterThan(55);
    expect(state.undoSecondsLeft).toBeLessThanOrEqual(60);
    expect(state.stampBlockedSeconds).toBeGreaterThan(535);
    expect(state.stampBlockedSeconds).toBeLessThanOrEqual(540);
  });

  it("programme désactivé : la carte est visible mais signalée", async () => {
    const c = await setup();
    await db.query("update public.loyalty_programs set is_active = false where id = $1", [c.shop.programId]);
    expect((await (await handleScan(post({ code: c.code }), depsFor(c.shop.staffUserId))).json()).programActive).toBe(false);
  });
});

describe("tamponner, valider la récompense, annuler", () => {
  it("+1 tampon : renvoie la carte à jour, avec 2 minutes pour annuler et le délai anti double scan", async () => {
    const c = await setup({ delay: 10 });
    const res = await act(c.shop.staffUserId, c.cardId, "stamp");
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state).toMatchObject({ cardId: c.cardId, stamps: 1, rewardAvailable: false });
    expect(state.undoSecondsLeft).toBeGreaterThan(115);
    expect(state.undoSecondsLeft).toBeLessThanOrEqual(120);
    expect(state.stampBlockedSeconds).toBeGreaterThan(595);
  });

  it("un 2e tampon trop tôt est refusé avec un message clair et le temps à attendre (409)", async () => {
    const c = await setup({ delay: 10 });
    await act(c.shop.staffUserId, c.cardId, "stamp");
    await ageEvents(c.cardId, 4);
    const res = await act(c.shop.staffUserId, c.cardId, "stamp");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("double_scan");
    expect(body.error).toMatch(/vient déjà d'être tamponnée.*6 min/);
    expect(body.retryAfterSeconds).toBeGreaterThan(350);
  });

  it("parcours complet : tampons jusqu'à la carte pleine, récompense, remise à 0", async () => {
    const c = await setup({ stampsRequired: 2 });
    const staff = c.shop.staffUserId;
    await act(staff, c.cardId, "stamp");
    await ageEvents(c.cardId, 60);
    const full = await (await act(staff, c.cardId, "stamp")).json();
    expect(full).toMatchObject({ stamps: 2, rewardAvailable: true });

    const tooMany = await act(staff, c.cardId, "stamp");
    expect([tooMany.status, (await tooMany.json()).code]).toEqual([409, "card_full"]);

    const redeemed = await (await act(staff, c.cardId, "redeem")).json();
    expect(redeemed).toMatchObject({ stamps: 0, rewardsEarned: 1, rewardAvailable: false, undoSecondsLeft: 0, stampBlockedSeconds: 0 });
  });

  it("récompense refusée tant que la carte n'est pas pleine (409)", async () => {
    const c = await setup();
    const res = await act(c.shop.staffUserId, c.cardId, "redeem");
    expect([res.status, (await res.json()).code]).toEqual([409, "card_not_full"]);
  });

  it("annulation : retire le dernier tampon ; refusée au-delà de 2 minutes", async () => {
    const c = await setup();
    await act(c.shop.staffUserId, c.cardId, "stamp");
    const undone = await (await act(c.shop.staffUserId, c.cardId, "undo")).json();
    expect(undone).toMatchObject({ stamps: 0, undoSecondsLeft: 0, stampBlockedSeconds: 0 });

    await act(c.shop.staffUserId, c.cardId, "stamp");
    await ageEvents(c.cardId, 3);
    const late = await act(c.shop.staffUserId, c.cardId, "undo");
    expect([late.status, (await late.json()).code]).toEqual([409, "undo_expired"]);
  });

  it("programme désactivé : tampon refusé (422), mais la récompense déjà gagnée reste utilisable", async () => {
    const c = await setup({ stampsRequired: 1 });
    await act(c.shop.staffUserId, c.cardId, "stamp"); // carte pleine
    await db.query("update public.loyalty_programs set is_active = false where id = $1", [c.shop.programId]);

    const refused = await act(c.shop.staffUserId, c.cardId, "stamp");
    expect([refused.status, (await refused.json()).code]).toEqual([422, "program_inactive"]);
    expect((await act(c.shop.staffUserId, c.cardId, "redeem")).status).toBe(200);
    const again = await act(c.shop.staffUserId, c.cardId, "stamp");
    expect([again.status, (await again.json()).code]).toEqual([422, "program_inactive"]);
  });

  it("un employé d'un autre commerce ne peut rien faire sur cette carte, et rien n'est modifié (404)", async () => {
    const mine = await setup();
    const other = await setup();
    for (const action of ["stamp", "redeem", "undo"]) {
      const res = await act(other.shop.staffUserId, mine.cardId, action);
      expect([res.status, (await res.json()).code], action).toEqual([404, "card_not_found"]);
    }
    expect((await db.query<{ stamps: number }>("select stamps from public.cards where id = $1", [mine.cardId])).rows[0].stamps).toBe(0);
    expect((await db.query("select 1 from public.stamp_events where card_id = $1", [mine.cardId])).rows).toHaveLength(0);
  });

  it("refuse un identifiant ou une action invalides (404), sans toucher à la base", async () => {
    const c = await setup();
    expect((await act(c.shop.staffUserId, "pas-un-uuid", "stamp")).status).toBe(404);
    expect((await act(c.shop.staffUserId, c.cardId, "supprimer")).status).toBe(404);
    expect((await act(c.shop.staffUserId, c.cardId, "constructor")).status).toBe(404);
  });

  it("le propriétaire peut aussi tamponner", async () => {
    const c = await setup();
    expect((await act(c.shop.ownerUserId, c.cardId, "stamp")).status).toBe(200);
  });

  it("une erreur inattendue ne montre aucun détail technique (500)", async () => {
    const c = await setup();
    const base = createPgliteStaffStore(db, c.shop.staffUserId);
    const res = await act(c.shop.staffUserId, c.cardId, "stamp", {
      staff: { ...base, perform: async () => { throw new StoreError('relation "stamp_events" is locked', "55P03"); } },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/stamp_events|locked|relation/);
    const res2 = await act(c.shop.staffUserId, c.cardId, "stamp", { staff: { ...base, perform: async () => { throw new Error("connexion perdue"); } } });
    expect(res2.status).toBe(500);
  });
});

describe("prévenir les Wallets après un changement", () => {
  it("prévient Apple et Google (via notify) avec le numéro de série et l'action, seulement après une réussite", async () => {
    const c = await setup({ stampsRequired: 2 });
    notified.length = 0;
    await act(c.shop.staffUserId, c.cardId, "stamp");
    await act(c.shop.staffUserId, c.cardId, "stamp"); // trop tôt : refusé, aucune notification
    await act(c.shop.staffUserId, c.cardId, "undo");
    expect(notified).toEqual([[c.serial, "stamp"], [c.serial, "undo"]]);
  });

  it("le travail est planifié après la réponse quand un planificateur est fourni (after)", async () => {
    const c = await setup();
    const queue: (() => Promise<void>)[] = [];
    notified.length = 0;
    const res = await act(c.shop.staffUserId, c.cardId, "stamp", { schedule: (w) => void queue.push(w) });
    expect(res.status).toBe(200);
    expect(notified).toEqual([]); // pas encore : la réponse part d'abord
    expect(queue).toHaveLength(1);
    await queue[0]();
    expect(notified).toEqual([[c.serial, "stamp"]]);
  });

  it("une panne des Wallets ne fait jamais échouer le tampon", async () => {
    const c = await setup();
    const logs: string[] = [];
    const res = await act(c.shop.staffUserId, c.cardId, "stamp", {
      notify: async () => { throw new Error("Apple injoignable"); },
      log: (m) => void logs.push(m),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).stamps).toBe(1);
    expect(logs.some((l) => l.includes("Wallets"))).toBe(true);
  });
});

describe("accès à la vraie base avec la session de l'employé", () => {
  type Rec = { table?: string; select?: string; filters: [string, unknown][]; order?: unknown; limit?: number };
  function fakeClient(reply: (rec: Rec) => { data: unknown; error?: { message: string; code?: string; details?: string } | null }, rpcError?: { message: string; code?: string; details?: string }) {
    const reads: Rec[] = [];
    const rpcs: { fn: string; args: unknown }[] = [];
    const client = {
      from(table: string) {
        const rec: Rec = { table, filters: [] };
        const api = {
          select: (c: string) => ((rec.select = c), api),
          eq: (k: string, v: unknown) => (rec.filters.push([k, v]), api),
          order: (c: string, o: unknown) => ((rec.order = [c, o]), api),
          limit: (n: number) => ((rec.limit = n), api),
          maybeSingle: async () => (reads.push(rec), { error: null, ...reply(rec) }),
        };
        return api;
      },
      rpc: async (fn: string, args: unknown) => (rpcs.push({ fn, args }), { data: null, error: rpcError ?? null }),
    };
    return { reads, rpcs, store: createSupabaseStaffStore(client as never) };
  }

  it("lit les cartes sans colonne sensible (jamais auth_token), une table à la fois", async () => {
    const { reads, store } = fakeClient(() => ({ data: { id: "c" } }));
    await store.cardBySerial("abc");
    await store.cardById("id1");
    expect(reads[0]).toMatchObject({ table: "cards", filters: [["serial_number", "abc"]] });
    expect(reads[1]).toMatchObject({ table: "cards", filters: [["id", "id1"]] });
    for (const r of reads) expect(r.select).not.toMatch(/auth_token|google_object_id/);
  });

  it("lit prénom, programme et dernier événement", async () => {
    const { reads, store } = fakeClient((rec) => ({
      data: rec.table === "customers" ? { first_name: "Léa" } : rec.table === "stamp_events" ? { type: "stamp", created_at: "2026-11-20T10:00:00.4881+00:00" } : { name: "P" },
    }));
    expect(await store.customerName("c1")).toBe("Léa");
    expect(await store.lastEvent("card1")).toEqual({ type: "stamp", createdAt: "2026-11-20T10:00:00.488100Z" });
    await store.program("p1");
    expect(reads.find((r) => r.table === "stamp_events")).toMatchObject({ filters: [["card_id", "card1"]], order: ["created_at", { ascending: false }], limit: 1 });
    expect(reads.find((r) => r.table === "customers")?.select).toBe("first_name"); // pas d'e-mail
  });

  it("renvoie null quand rien n'est trouvé", async () => {
    const { store } = fakeClient(() => ({ data: null }));
    expect(await store.cardBySerial("x")).toBeNull();
    expect(await store.customerName("x")).toBeNull();
    expect(await store.lastEvent("x")).toBeNull();
  });

  it("appelle les bonnes fonctions SQL et transforme un refus en StoreError", async () => {
    const ok = fakeClient(() => ({ data: null }));
    await ok.store.perform("stamp", "c1");
    await ok.store.perform("redeem", "c1");
    await ok.store.perform("undo", "c1");
    expect(ok.rpcs).toEqual([
      { fn: "stamp_card", args: { p_card_id: "c1" } },
      { fn: "redeem_reward", args: { p_card_id: "c1" } },
      { fn: "undo_last_stamp", args: { p_card_id: "c1" } },
    ]);

    const refused = fakeClient(() => ({ data: null }), { message: "double_scan", code: "PT409", details: "420" });
    await expect(refused.store.perform("stamp", "c1")).rejects.toMatchObject({ message: "double_scan", code: "PT409", details: "420" });
  });

  it("une erreur de lecture est signalée (jamais prise pour « introuvable »)", async () => {
    const { store } = fakeClient(() => ({ data: null, error: { message: "JWT expired" } }));
    await expect(store.cardBySerial("x")).rejects.toThrow(/Lecture impossible/);
  });
});
