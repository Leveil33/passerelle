import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createShop, createTestDb, expectDbError } from "./helpers";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

const merchant = async (id: string) =>
  (await db.query("select name, logo_url, brand_color from public.merchants where id = $1", [id])).rows[0];

describe("personnalisation du commerce (logo, couleur, nom)", () => {
  it("le propriétaire change le logo, la couleur et le nom de son commerce", async () => {
    const shop = await createShop(db, { name: "Avant" });

    await asUser(db, shop.ownerUserId, () =>
      db.query("update public.merchants set name = $2, logo_url = $3, brand_color = $4 where id = $1", [
        shop.merchantId,
        "Après",
        "https://exemple.fr/logo.png",
        "#E11D48",
      ]),
    );

    expect(await merchant(shop.merchantId)).toEqual({
      name: "Après",
      logo_url: "https://exemple.fr/logo.png",
      brand_color: "#E11D48",
    });
  });

  it("un employé ne peut rien changer (aucune ligne touchée)", async () => {
    const shop = await createShop(db, { name: "Intact" });
    const res = await asUser(db, shop.staffUserId, () =>
      db.query("update public.merchants set brand_color = '#000000' where id = $1", [shop.merchantId]),
    );
    expect(res.affectedRows).toBe(0);
    expect((await merchant(shop.merchantId)).brand_color).toBe("#1F2937");
  });

  it("un propriétaire ne peut pas changer l'apparence d'un AUTRE commerce", async () => {
    const a = await createShop(db, { name: "A" });
    const b = await createShop(db, { name: "B" });
    const res = await asUser(db, a.ownerUserId, () =>
      db.query("update public.merchants set brand_color = '#FF0000' where id = $1", [b.merchantId]),
    );
    expect(res.affectedRows).toBe(0);
    expect((await merchant(b.merchantId)).brand_color).toBe("#1F2937");
  });

  it("refuse une couleur invalide et un logo non sécurisé (http)", async () => {
    const shop = await createShop(db);
    for (const sql of [
      "update public.merchants set brand_color = 'rouge' where id = $1",
      "update public.merchants set brand_color = '#FFF' where id = $1",
      "update public.merchants set logo_url = 'http://exemple.fr/logo.png' where id = $1",
    ]) {
      const err = await expectDbError(() => asUser(db, shop.ownerUserId, () => db.query(sql, [shop.merchantId])));
      expect(err.message, sql).toMatch(/check constraint/i);
    }
  });

  it("le propriétaire peut retirer le logo (valeur vide)", async () => {
    const shop = await createShop(db);
    await asUser(db, shop.ownerUserId, async () => {
      await db.query("update public.merchants set logo_url = 'https://exemple.fr/l.png' where id = $1", [shop.merchantId]);
      await db.query("update public.merchants set logo_url = null where id = $1", [shop.merchantId]);
    });
    expect((await merchant(shop.merchantId)).logo_url).toBeNull();
  });

  it("l'identifiant et la date de création du commerce restent intouchables", async () => {
    const shop = await createShop(db);
    for (const sql of [
      "update public.merchants set id = gen_random_uuid() where id = $1",
      "update public.merchants set created_at = now() where id = $1",
    ]) {
      const err = await expectDbError(() => asUser(db, shop.ownerUserId, () => db.query(sql, [shop.merchantId])));
      expect(err.message).toMatch(/permission denied/i);
    }
  });
});
