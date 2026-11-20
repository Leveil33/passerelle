/* eslint-disable @typescript-eslint/no-explicit-any -- tests : on lit du JSON sans le typer en détail */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asServer, asUser, createCard, createShop, createTestDb, expectDbError } from "./helpers";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function server<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
  const res = await asServer(db, () => db.query(sql, params));
  return Object.values(res.rows[0] as object)[0] as T;
}
async function newCard() {
  const shop = await createShop(db);
  const { cardId } = await createCard(db, shop.programId);
  const row = (await db.query<{ serial_number: string }>("select serial_number from public.cards where id = $1", [cardId])).rows[0];
  return { shop, cardId, serial: row.serial_number };
}
const claim = (serial: string, kind: string) => server<boolean>("select public.google_claim_notification($1, $2)", [serial, kind]);
const mark = (serial: string, id: string) => server<string>("select public.google_mark_card($1, $2)", [serial, id]);
const cardRow = async (cardId: string) =>
  (await db.query<{ google_object_id: string | null; platform: string | null; updated_at: string }>(
    "select google_object_id, platform, updated_at::text as updated_at from public.cards where id = $1", [cardId])).rows[0];

describe("droits : réservé au serveur", () => {
  const calls = [
    "select public.google_claim_notification('s', 'stamp')",
    "select public.google_mark_card('s', 'o')",
    "select public.loyalty_class_data('00000000-0000-4000-8000-000000000000')",
  ];
  it("ni un visiteur, ni un employé, ni un propriétaire ne peuvent les appeler", async () => {
    const shop = await createShop(db);
    for (const sql of calls) {
      expect((await expectDbError(() => asAnon(db, () => db.query(sql)))).message, sql).toMatch(/permission denied/i);
      for (const who of [shop.staffUserId, shop.ownerUserId]) {
        expect((await expectDbError(() => asUser(db, who, () => db.query(sql)))).message, sql).toMatch(/permission denied/i);
      }
    }
  });
});

describe("budget de notifications Google (3 par 24 h au maximum)", () => {
  it("2 notifications de tampon, puis refus", async () => {
    const c = await newCard();
    expect([await claim(c.serial, "stamp"), await claim(c.serial, "stamp"), await claim(c.serial, "stamp")]).toEqual([true, true, false]);
  });

  it("la récompense garde sa place : acceptée après 2 tampons, refusée ensuite", async () => {
    const c = await newCard();
    await claim(c.serial, "stamp");
    await claim(c.serial, "stamp");
    expect(await claim(c.serial, "reward")).toBe(true);
    expect(await claim(c.serial, "reward")).toBe(false);
    expect(await claim(c.serial, "stamp")).toBe(false);
  });

  it("jamais plus de 3 au total, quel que soit le mélange", async () => {
    const c = await newCard();
    const results = [];
    for (const kind of ["reward", "reward", "reward", "reward", "stamp"]) results.push(await claim(c.serial, kind));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it("le budget se libère quand 24 h se sont écoulées", async () => {
    const c = await newCard();
    await claim(c.serial, "stamp");
    await claim(c.serial, "stamp");
    expect(await claim(c.serial, "stamp")).toBe(false);
    await db.query("update private.google_notifications set sent_at = sent_at - interval '25 hours' where card_id = $1", [c.cardId]);
    expect(await claim(c.serial, "stamp")).toBe(true);
  });

  it("chaque carte a son propre budget", async () => {
    const a = await newCard();
    const b = await newCard();
    await claim(a.serial, "stamp");
    await claim(a.serial, "stamp");
    expect(await claim(a.serial, "stamp")).toBe(false);
    expect(await claim(b.serial, "stamp")).toBe(true);
  });

  it("carte inconnue : refus ; type inconnu : erreur ; la carte n'est pas marquée modifiée", async () => {
    const c = await newCard();
    const before = (await cardRow(c.cardId)).updated_at;
    expect(await claim("inconnue", "stamp")).toBe(false);
    for (const kind of ["autre", ""]) {
      expect((await expectDbError(() => claim(c.serial, kind))).message).toBe("invalid_kind");
    }
    await claim(c.serial, "stamp");
    expect((await cardRow(c.cardId)).updated_at).toBe(before);
  });
});

describe("mémoriser la carte Google", () => {
  it("enregistre l'identifiant et la plateforme, sans marquer la carte modifiée", async () => {
    const c = await newCard();
    const before = (await cardRow(c.cardId)).updated_at;
    expect(await mark(c.serial, "issuer.abc")).toBe("ok");
    expect(await cardRow(c.cardId)).toMatchObject({ google_object_id: "issuer.abc", platform: "google", updated_at: before });
  });

  it("devient « both » si la carte est déjà dans Apple Wallet, et reste idempotent", async () => {
    const c = await newCard();
    await db.query("update public.cards set platform = 'apple' where id = $1", [c.cardId]);
    expect(await mark(c.serial, "issuer.def")).toBe("ok");
    expect(await mark(c.serial, "issuer.def")).toBe("ok");
    expect(await cardRow(c.cardId)).toMatchObject({ platform: "both", google_object_id: "issuer.def" });
  });

  it("refuse un autre identifiant pour la même carte, ou un identifiant déjà pris par une autre carte", async () => {
    const a = await newCard();
    const b = await newCard();
    await mark(a.serial, "issuer.a");
    expect(await mark(a.serial, "issuer.autre")).toBe("conflict");
    expect(await mark(b.serial, "issuer.a")).toBe("conflict");
    expect((await cardRow(b.cardId)).google_object_id).toBeNull();
  });

  it("répond not_found / invalid pour des entrées absurdes", async () => {
    const c = await newCard();
    expect(await mark("inconnue", "x")).toBe("not_found");
    expect(await mark(c.serial, "")).toBe("invalid");
    expect(await mark(c.serial, "x".repeat(201))).toBe("invalid");
  });
});

describe("description d'un programme pour Google", () => {
  it("renvoie programme, commerce et adresses (10 au plus, les plus anciennes d'abord)", async () => {
    const shop = await createShop(db, { name: "Café du Port", stampsRequired: 8 });
    for (let i = 1; i <= 12; i++) {
      await db.query(
        "insert into public.locations (merchant_id, label, latitude, longitude, created_at) values ($1, $2, 48.85, 2.35, now() + ($3 * interval '1 second'))",
        [shop.merchantId, `Boutique ${i}`, i],
      );
    }
    const data = await server<any>("select public.loyalty_class_data($1)", [shop.programId]);
    expect(data.program).toMatchObject({ id: shop.programId, name: "Carte café", stamps_required: 8, stamp_icon: "star", is_active: true });
    expect(data.merchant).toMatchObject({ id: shop.merchantId, name: "Café du Port", brand_color: "#1F2937" });
    expect(data.locations).toHaveLength(10);
    expect(data.locations[0].label).toBe("Boutique 1");
    expect(data.locations[9].label).toBe("Boutique 10");
    expect(data).not.toHaveProperty("card"); // aucune donnée de carte ni de secret
  });

  it("renvoie null pour un programme inconnu", async () => {
    expect(await server("select public.loyalty_class_data('00000000-0000-4000-8000-000000000000')")).toBeNull();
  });
});
