/* eslint-disable @typescript-eslint/no-explicit-any -- tests : JSON non typé */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asServer, asUser, createCard, createShop, createTestDb, createUser, expectDbError, stamp, undo, redeem } from "./helpers";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.close());

async function server<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
  return Object.values((await asServer(db, () => db.query(sql, params))).rows[0] as object)[0] as T;
}
const adminUser = async () => {
  const id = await createUser(db);
  await db.query("insert into public.platform_admins (user_id) values ($1)", [id]);
  return id;
};
const create = (admin: string, owner: string, name = "Café du Port", stamps = 10, reward = "1 café offert") =>
  server<{ merchant_id: string; program_id: string }>("select public.admin_create_merchant($1, $2, $3, $4, $5)", [admin, name, owner, stamps, reward]);

describe("droits : serveur uniquement", () => {
  it("les administrateurs et le journal sont invisibles et inaccessibles pour tout le monde sauf le serveur", async () => {
    const shop = await createShop(db);
    await adminUser();
    for (const table of ["platform_admins", "admin_audit_log"]) {
      expect((await expectDbError(() => asAnon(db, () => db.query(`select * from public.${table}`)))).message).toMatch(/permission denied/i);
      for (const who of [shop.staffUserId, shop.ownerUserId]) {
        expect((await expectDbError(() => asUser(db, who, () => db.query(`select * from public.${table}`)))).message, table).toMatch(/permission denied/i);
        expect((await expectDbError(() => asUser(db, who, () => db.query(`insert into public.${table} (${table === "platform_admins" ? "user_id" : "action"}) values ($1)`, [table === "platform_admins" ? who : "x"])))).message).toMatch(/permission denied/i);
      }
    }
  });

  it("personne d'autre que le serveur ne peut appeler les fonctions d'administration", async () => {
    const shop = await createShop(db);
    const calls: [string, (user: string) => unknown[]][] = [
      ["select public.is_platform_admin($1)", (u) => [u]],
      ["select public.admin_create_merchant($1, 'X', $1, 10, 'R')", (u) => [u]],
      ["select * from public.program_push_targets($1)", () => [shop.programId]],
      ["select * from public.program_google_serials($1)", () => [shop.programId]],
    ];
    for (const who of [shop.staffUserId, shop.ownerUserId]) {
      for (const [sql, params] of calls) {
        expect((await expectDbError(() => asUser(db, who, () => db.query(sql, params(who))))).message, sql).toMatch(/permission denied/i);
      }
    }
    for (const [sql, params] of calls) {
      expect((await expectDbError(() => asAnon(db, () => db.query(sql, params(shop.ownerUserId))))).message, sql).toMatch(/permission denied/i);
    }
  });
});

describe("créer un commerce (administrateur de la plateforme)", () => {
  it("crée le commerce, son programme pré-rempli et son propriétaire, et le consigne", async () => {
    const admin = await adminUser();
    const owner = await createUser(db);
    const res = await create(admin, owner, "  Boulangerie Léa ", 8, "1 baguette offerte");

    const m = (await db.query<any>("select name, brand_color from public.merchants where id = $1", [res.merchant_id])).rows[0];
    expect(m).toEqual({ name: "Boulangerie Léa", brand_color: "#1F2937" });
    const p = (await db.query<any>("select name, stamps_required, reward_label, is_active, double_scan_delay_minutes, stamp_icon from public.loyalty_programs where id = $1", [res.program_id])).rows[0];
    expect(p).toEqual({ name: "Carte de fidélité", stamps_required: 8, reward_label: "1 baguette offerte", is_active: true, double_scan_delay_minutes: 10, stamp_icon: "star" });
    expect((await db.query<any>("select role from public.merchant_users where merchant_id = $1 and user_id = $2", [res.merchant_id, owner])).rows).toEqual([{ role: "owner" }]);
    const log = (await db.query<any>("select admin_user_id, action, details from public.admin_audit_log where details->>'merchant_id' = $1", [res.merchant_id])).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ admin_user_id: admin, action: "create_merchant" });
    expect(log[0].details.owner_user_id).toBe(owner);
  });

  it("le propriétaire créé peut tout de suite régler son commerce et tamponner (droits réels)", async () => {
    const admin = await adminUser();
    const owner = await createUser(db);
    const res = await create(admin, owner, "Café X", 2);
    await asUser(db, owner, () => db.query("update public.loyalty_programs set reward_label = 'Un thé' where id = $1", [res.program_id]));
    const card = await createCard(db, res.program_id);
    expect((await stamp(db, owner, card.cardId)).stamps).toBe(1);
  });

  it("refuse un appelant qui n'est pas administrateur, sans rien créer", async () => {
    const notAdmin = await createUser(db);
    const owner = await createUser(db);
    const before = (await db.query<{ n: number }>("select count(*)::int as n from public.merchants")).rows[0].n;
    expect((await expectDbError(() => create(notAdmin, owner))).message).toBe("not_platform_admin");
    expect((await expectDbError(() => server("select public.admin_create_merchant(null, 'X', $1, 10, 'R')", [owner]))).message).toBe("not_platform_admin");
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.merchants")).rows[0].n).toBe(before);
  });

  it("refuse des valeurs invalides", async () => {
    const admin = await adminUser();
    const owner = await createUser(db);
    for (const [name, stamps, reward, code] of [
      ["", 10, "R", "invalid_name"], ["   ", 10, "R", "invalid_name"], ["x".repeat(101), 10, "R", "invalid_name"],
      ["Ok", 0, "R", "invalid_stamps"], ["Ok", 51, "R", "invalid_stamps"], ["Ok", 10, "  ", "invalid_reward"],
    ] as const) {
      expect((await expectDbError(() => create(admin, owner, name, stamps, reward))).message, `${name}/${stamps}/${reward}`).toBe(code);
    }
  });

  it("n'écrit rien si un échec survient en cours de route (propriétaire inexistant)", async () => {
    const admin = await adminUser();
    const before = (await db.query<{ n: number }>("select count(*)::int as n from public.merchants")).rows[0].n;
    await expectDbError(() => create(admin, "00000000-0000-4000-8000-000000000000"));
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.merchants")).rows[0].n).toBe(before);
  });
});

describe("un commerce garde toujours un propriétaire", () => {
  it("refuse de retirer le dernier propriétaire, accepte s'il en reste un autre", async () => {
    const shop = await createShop(db);
    const ownerRow = shop.ownerMemberId;
    const err = await expectDbError(() => asUser(db, shop.ownerUserId, () => db.query("delete from public.merchant_users where id = $1", [ownerRow])));
    expect(err.message).toBe("last_owner");

    const second = await createUser(db);
    await asUser(db, shop.ownerUserId, () => db.query("insert into public.merchant_users (merchant_id, user_id, role) values ($1, $2, 'owner')", [shop.merchantId, second]));
    await asUser(db, shop.ownerUserId, () => db.query("delete from public.merchant_users where id = $1", [ownerRow]));
    expect((await db.query<any>("select user_id from public.merchant_users where merchant_id = $1 and role = 'owner'", [shop.merchantId])).rows).toEqual([{ user_id: second }]);
  });

  it("retirer un employé reste possible ; supprimer tout un commerce aussi", async () => {
    const shop = await createShop(db);
    await asUser(db, shop.ownerUserId, () => db.query("delete from public.merchant_users where id = $1", [shop.staffMemberId]));
    await db.query("delete from public.merchants where id = $1", [shop.merchantId]);
    expect((await db.query("select 1 from public.merchant_users where merchant_id = $1", [shop.merchantId])).rows).toHaveLength(0);
  });
});

describe("statistiques d'un commerce", () => {
  const stats = (userId: string, merchantId: string) => asUser(db, userId, async () => (await db.query<any>("select public.merchant_stats($1) as s", [merchantId])).rows[0].s);
  const backdate = (cardId: string, days: number) => db.query("update public.stamp_events set created_at = created_at - ($2::numeric * interval '1 day') where card_id = $1", [cardId, days]);

  it("compte cartes, tampons du jour (annulations retranchées) et récompenses", async () => {
    const shop = await createShop(db, { stampsRequired: 2 });
    const a = await createCard(db, shop.programId, "A");
    const b = await createCard(db, shop.programId, "B");
    await stamp(db, shop.staffUserId, a.cardId);
    await db.query("update public.stamp_events set created_at = created_at - interval '1 hour' where card_id = $1", [a.cardId]);
    await stamp(db, shop.staffUserId, a.cardId); // carte pleine
    await redeem(db, shop.staffUserId, a.cardId);
    await stamp(db, shop.staffUserId, b.cardId);
    await undo(db, shop.staffUserId, b.cardId); // annulé : ne compte pas

    const s = await stats(shop.staffUserId, shop.merchantId);
    expect(s).toMatchObject({ cards: 2, new_cards_7_days: 2, rewards_redeemed: 1, rewards_redeemed_7_days: 1 });
    expect(s.stamps_7_days).toBe(2);
    expect(s.stamps_today).toBeGreaterThanOrEqual(1); // « aujourd'hui » dépend de l'heure de la journée en France
    expect(s.stamps_today).toBeLessThanOrEqual(2);
  });

  it("les anciens tampons sortent des 7 jours, une carte neuve compte à 0", async () => {
    const shop = await createShop(db);
    const c = await createCard(db, shop.programId);
    await stamp(db, shop.staffUserId, c.cardId);
    await backdate(c.cardId, 10);
    await db.query("update public.cards set created_at = created_at - interval '10 days' where id = $1", [c.cardId]);
    expect(await stats(shop.ownerUserId, shop.merchantId)).toMatchObject({ cards: 1, new_cards_7_days: 0, stamps_today: 0, stamps_7_days: 0, rewards_redeemed: 0 });

    const empty = await createShop(db);
    expect(await stats(empty.ownerUserId, empty.merchantId)).toEqual({ cards: 0, new_cards_7_days: 0, stamps_today: 0, stamps_7_days: 0, rewards_redeemed: 0, rewards_redeemed_7_days: 0 });
  });

  it("ne révèle rien d'un autre commerce, ni aux inconnus, ni aux visiteurs", async () => {
    const a = await createShop(db);
    const b = await createShop(db);
    expect((await expectDbError(() => stats(a.staffUserId, b.merchantId))).message).toBe("forbidden");
    const stranger = await createUser(db);
    expect((await expectDbError(() => stats(stranger, a.merchantId))).message).toBe("forbidden");
    expect((await expectDbError(() => asAnon(db, () => db.query("select public.merchant_stats($1)", [a.merchantId])))).message).toMatch(/permission denied/i);
  });
});

describe("cartes à mettre à jour après un changement", () => {
  it("liste les appareils Apple et les cartes Google d'un programme, jamais ceux d'un autre", async () => {
    const a = await createShop(db);
    const b = await createShop(db);
    const mk = async (programId: string, platform: string | null, token?: string) => {
      const c = await createCard(db, programId);
      if (platform) await db.query("update public.cards set platform = $2 where id = $1", [c.cardId, platform]);
      if (token) await db.query("insert into public.apple_registrations (card_id, device_library_id, push_token) values ($1, $2, $3)", [c.cardId, `d-${token}`, token]);
      return (await db.query<{ serial_number: string }>("select serial_number from public.cards where id = $1", [c.cardId])).rows[0].serial_number;
    };
    const g = await mk(a.programId, "google");
    const both = await mk(a.programId, "both", "tokA");
    await mk(a.programId, "apple", "tokB");
    await mk(a.programId, null);
    await mk(b.programId, "both", "tokOther");

    const tokens = (await asServer(db, () => db.query<any>("select * from public.program_push_targets($1)", [a.programId]))).rows.map((r) => r.push_token);
    expect(tokens.sort()).toEqual(["tokA", "tokB"]);
    const serials = (await asServer(db, () => db.query<any>("select * from public.program_google_serials($1)", [a.programId]))).rows.map((r) => r.serial_number);
    expect(serials.sort()).toEqual([g, both].sort());
  });

  it("respecte la limite demandée", async () => {
    const a = await createShop(db);
    for (let i = 0; i < 3; i++) {
      const c = await createCard(db, a.programId);
      await db.query("update public.cards set platform = 'google' where id = $1", [c.cardId]);
    }
    expect((await asServer(db, () => db.query("select * from public.program_google_serials($1, 2)", [a.programId]))).rows).toHaveLength(2);
  });
});

describe("dossier d'images", () => {
  it("existe, est public en lecture, limité à des PNG de 2 Mo", async () => {
    const b = (await db.query<any>("select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'merchant-assets'")).rows[0];
    expect(b).toEqual({ id: "merchant-assets", public: true, file_size_limit: 2097152, allowed_mime_types: ["image/png"] });
  });
});
