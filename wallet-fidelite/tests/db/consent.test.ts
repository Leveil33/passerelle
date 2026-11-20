import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asServer, asUser, createCard, createShop, createTestDb, expectDbError } from "./helpers";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

const consent = async (customerId: string) =>
  (await db.query<{ marketing_consent_at: string | null }>("select marketing_consent_at::text from public.customers where id = $1", [customerId]))
    .rows[0].marketing_consent_at;

describe("consentement aux messages du commerçant", () => {
  it("par défaut : aucun consentement (case jamais cochée d'avance)", async () => {
    const shop = await createShop(db);
    const { customerId } = await createCard(db, shop.programId);
    expect(await consent(customerId)).toBeNull();
  });

  it("le serveur enregistre la date du consentement, puis peut le retirer", async () => {
    const shop = await createShop(db);
    const { customerId } = await createCard(db, shop.programId);

    await asServer(db, () => db.query("update public.customers set marketing_consent_at = now() where id = $1", [customerId]));
    expect(await consent(customerId)).not.toBeNull();

    await asServer(db, () => db.query("update public.customers set marketing_consent_at = null where id = $1", [customerId]));
    expect(await consent(customerId)).toBeNull();
  });

  it("peut être donné sans e-mail (les deux consentements sont indépendants)", async () => {
    const created = await asServer(db, () =>
      db.query<{ id: string; email: string | null }>(
        "insert into public.customers (first_name, marketing_consent_at) values ('Inès', now()) returning id, email",
      ),
    );
    expect(created.rows[0].email).toBeNull();
    expect(await consent(created.rows[0].id)).not.toBeNull();
  });

  it("l'e-mail, lui, exige toujours son propre consentement", async () => {
    const err = await expectDbError(() =>
      asServer(db, () =>
        db.query("insert into public.customers (first_name, email, marketing_consent_at) values ('Tom', 'tom@example.com', now())"),
      ),
    );
    expect(err.message).toMatch(/check constraint/i);
  });

  it("les employés ne peuvent ni lire ni modifier le consentement", async () => {
    const shop = await createShop(db);
    const { customerId } = await createCard(db, shop.programId);

    for (const who of [shop.staffUserId, shop.ownerUserId]) {
      const read = await expectDbError(() =>
        asUser(db, who, () => db.query("select marketing_consent_at from public.customers")),
      );
      expect(read.message).toMatch(/permission denied/i);

      const write = await expectDbError(() =>
        asUser(db, who, () => db.query("update public.customers set marketing_consent_at = now() where id = $1", [customerId])),
      );
      expect(write.message).toMatch(/permission denied/i);
    }
    expect(await consent(customerId)).toBeNull();
  });
});
