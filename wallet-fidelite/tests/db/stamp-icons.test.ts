import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asServer, asUser, createShop, createTestDb, expectDbError } from "./helpers";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

const program = async (id: string) =>
  (
    await db.query<{ stamp_icon: string; stamp_icon_url: string | null }>(
      "select stamp_icon, stamp_icon_url from public.loyalty_programs where id = $1",
      [id],
    )
  ).rows[0];

describe("tampon du programme (bibliothèque ou image importée)", () => {
  it("par défaut : l'étoile de la bibliothèque, sans image importée", async () => {
    const shop = await createShop(db);
    expect(await program(shop.programId)).toEqual({ stamp_icon: "star", stamp_icon_url: null });
  });

  it("le propriétaire choisit une icône de la bibliothèque ; l'employé ne peut pas", async () => {
    const shop = await createShop(db);

    await asUser(db, shop.ownerUserId, () =>
      db.query("update public.loyalty_programs set stamp_icon = 'coffee' where id = $1", [shop.programId]),
    );
    expect((await program(shop.programId)).stamp_icon).toBe("coffee");

    const res = await asUser(db, shop.staffUserId, () =>
      db.query("update public.loyalty_programs set stamp_icon = 'heart' where id = $1", [shop.programId]),
    );
    expect(res.affectedRows).toBe(0);
    expect((await program(shop.programId)).stamp_icon).toBe("coffee");
  });

  it("un propriétaire ne peut pas changer le tampon d'un autre commerce", async () => {
    const a = await createShop(db);
    const b = await createShop(db);
    const res = await asUser(db, a.ownerUserId, () =>
      db.query("update public.loyalty_programs set stamp_icon = 'heart' where id = $1", [b.programId]),
    );
    expect(res.affectedRows).toBe(0);
    expect((await program(b.programId)).stamp_icon).toBe("star");
  });

  it("le commerçant ne peut PAS écrire l'adresse de l'image importée (le serveur seul le fait)", async () => {
    const shop = await createShop(db);
    const err = await expectDbError(() =>
      asUser(db, shop.ownerUserId, () =>
        db.query("update public.loyalty_programs set stamp_icon_url = 'https://interne.exemple/enorme.png' where id = $1", [
          shop.programId,
        ]),
      ),
    );
    expect(err.message).toMatch(/permission denied/i);
    expect((await program(shop.programId)).stamp_icon_url).toBeNull();
  });

  it("il ne peut pas non plus la glisser à la création d'un programme", async () => {
    const shop = await createShop(db);
    const err = await expectDbError(() =>
      asUser(db, shop.ownerUserId, () =>
        db.query(
          `insert into public.loyalty_programs (merchant_id, name, stamps_required, reward_label, stamp_icon_url)
           values ($1, 'Autre', 5, 'cadeau', 'https://interne.exemple/x.png')`,
          [shop.merchantId],
        ),
      ),
    );
    expect(err.message).toMatch(/permission denied/i);

    // Mais il peut choisir une icône dès la création.
    await asUser(db, shop.ownerUserId, () =>
      db.query(
        "insert into public.loyalty_programs (merchant_id, name, stamps_required, reward_label, stamp_icon) values ($1, 'Autre', 5, 'cadeau', 'croissant')",
        [shop.merchantId],
      ),
    );
  });

  it("« custom » est refusé tant qu'aucune image n'a été importée", async () => {
    const shop = await createShop(db);
    const err = await expectDbError(() =>
      asUser(db, shop.ownerUserId, () =>
        db.query("update public.loyalty_programs set stamp_icon = 'custom' where id = $1", [shop.programId]),
      ),
    );
    expect(err.message).toMatch(/check constraint/i);
    expect((await program(shop.programId)).stamp_icon).toBe("star");
  });

  it("parcours d'import : le serveur pose l'image, puis le commerçant active « custom » ; il peut revenir à une icône sans perdre l'image", async () => {
    const shop = await createShop(db);

    await asServer(db, () =>
      db.query("update public.loyalty_programs set stamp_icon_url = 'https://stockage.exemple/tampon.png' where id = $1", [
        shop.programId,
      ]),
    );
    await asUser(db, shop.ownerUserId, () =>
      db.query("update public.loyalty_programs set stamp_icon = 'custom' where id = $1", [shop.programId]),
    );
    expect(await program(shop.programId)).toEqual({ stamp_icon: "custom", stamp_icon_url: "https://stockage.exemple/tampon.png" });

    await asUser(db, shop.ownerUserId, () =>
      db.query("update public.loyalty_programs set stamp_icon = 'heart' where id = $1", [shop.programId]),
    );
    expect(await program(shop.programId)).toEqual({ stamp_icon: "heart", stamp_icon_url: "https://stockage.exemple/tampon.png" });
  });

  it("le serveur ne peut pas retirer l'image tant que « custom » est actif", async () => {
    const shop = await createShop(db);
    await asServer(db, () =>
      db.query("update public.loyalty_programs set stamp_icon_url = 'https://stockage.exemple/t.png', stamp_icon = 'custom' where id = $1", [
        shop.programId,
      ]),
    );
    const err = await expectDbError(() =>
      asServer(db, () => db.query("update public.loyalty_programs set stamp_icon_url = null where id = $1", [shop.programId])),
    );
    expect(err.message).toMatch(/check constraint/i);
  });

  it("refuse un nom d'icône invalide et une image en http", async () => {
    const shop = await createShop(db);
    for (const bad of ["Mon Icône!", "", "a".repeat(41), "../etc/passwd", "COFFEE"]) {
      const err = await expectDbError(() =>
        asUser(db, shop.ownerUserId, () =>
          db.query("update public.loyalty_programs set stamp_icon = $2 where id = $1", [shop.programId, bad]),
        ),
      );
      expect(err.message, JSON.stringify(bad)).toMatch(/check constraint/i);
    }
    const http = await expectDbError(() =>
      asServer(db, () =>
        db.query("update public.loyalty_programs set stamp_icon_url = 'http://exemple.fr/t.png' where id = $1", [shop.programId]),
      ),
    );
    expect(http.message).toMatch(/check constraint/i);
  });
});
