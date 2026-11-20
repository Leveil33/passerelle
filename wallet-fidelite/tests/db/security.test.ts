import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAnon,
  asNobody,
  asServer,
  asUser,
  cardRow,
  createCard,
  createShop,
  createTestDb,
  createUser,
  events,
  expectDbError,
  redeem,
  stamp,
  undo,
} from "./helpers";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

/** Deux commerces indépendants, chacun avec sa carte. */
async function twoShops() {
  const a = await createShop(db, { name: "Boulangerie A" });
  const b = await createShop(db, { name: "Café B" });
  const cardA = await createCard(db, a.programId, "Alice");
  const cardB = await createCard(db, b.programId, "Bob");
  return { a, b, cardA, cardB };
}

const select = (sql: string, params: unknown[] = []) => db.query(sql, params);

describe("fonctions de tampon : qui a le droit ?", () => {
  it("un employé d'un AUTRE commerce reçoit « card_not_found » (on ne révèle pas que la carte existe)", async () => {
    const { a, cardB } = await twoShops();

    for (const fn of [stamp, redeem, undo]) {
      const err = await expectDbError(() => fn(db, a.staffUserId, cardB.cardId));
      expect(err).toMatchObject({ message: "card_not_found", code: "PT404" });
    }
    expect(await cardRow(db, cardB.cardId)).toEqual({ stamps: 0, rewards_earned: 0 });
    expect(await events(db, cardB.cardId)).toEqual([]);
  });

  it("un utilisateur connecté qui n'est membre d'aucun commerce (ex. un joueur du jeu) est refusé", async () => {
    const { cardA } = await twoShops();
    const stranger = await createUser(db);

    const err = await expectDbError(() => stamp(db, stranger, cardA.cardId));
    expect(err.message).toBe("card_not_found");
    expect(await events(db, cardA.cardId)).toEqual([]);
  });

  it("un identifiant de carte inexistant donne la même réponse", async () => {
    const { a } = await twoShops();
    const err = await expectDbError(() => stamp(db, a.staffUserId, "00000000-0000-4000-8000-000000000000"));
    expect(err.message).toBe("card_not_found");
  });

  it("sans identité (not_authenticated, PT401)", async () => {
    const { cardA } = await twoShops();
    const err = await expectDbError(() =>
      asNobody(db, () => db.query("select * from public.stamp_card($1)", [cardA.cardId])),
    );
    expect(err).toMatchObject({ message: "not_authenticated", code: "PT401" });
  });

  it("le rôle « anon » (visiteur sans compte) ne peut même pas appeler les fonctions", async () => {
    const { cardA } = await twoShops();
    for (const fn of ["stamp_card", "redeem_reward", "undo_last_stamp"]) {
      const err = await expectDbError(() =>
        asAnon(db, () => db.query(`select * from public.${fn}($1)`, [cardA.cardId])),
      );
      expect(err.message).toMatch(/permission denied/i);
    }
  });

  it("les fonctions internes (schéma private) ne sont pas appelables par un employé", async () => {
    const { a, cardA } = await twoShops();
    const err = await expectDbError(() =>
      asUser(db, a.staffUserId, () => db.query("select private.acting_member($1)", [cardA.cardId])),
    );
    expect(err.message).toMatch(/permission denied/i);
  });
});

describe("lecture des données par un employé", () => {
  it("voit les cartes de son commerce, pas celles des autres", async () => {
    const { a, cardA, cardB } = await twoShops();

    const rows = await asUser(db, a.staffUserId, async () =>
      (await select("select id from public.cards")).rows as { id: string }[],
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(cardA.cardId);
    expect(ids).not.toContain(cardB.cardId);
  });

  it("peut retrouver une carte par son numéro de série (c'est ce que fait le scan)", async () => {
    const { a, cardA } = await twoShops();
    const serial = (await select("select serial_number from public.cards where id = $1", [cardA.cardId])).rows[0] as {
      serial_number: string;
    };

    const rows = await asUser(db, a.staffUserId, async () =>
      (
        await select(
          `select c.id, c.stamps, cu.first_name, p.reward_label
             from public.cards c
             join public.customers cu on cu.id = c.customer_id
             join public.loyalty_programs p on p.id = c.program_id
            where c.serial_number = $1`,
          [serial.serial_number],
        )
      ).rows,
    );
    expect(rows).toEqual([{ id: cardA.cardId, stamps: 0, first_name: "Alice", reward_label: "1 café offert" }]);
  });

  it("ne peut PAS lire le auth_token Apple (ni avec « select * »)", async () => {
    const { a } = await twoShops();

    const explicit = await expectDbError(() =>
      asUser(db, a.staffUserId, () => select("select auth_token from public.cards")),
    );
    expect(explicit.message).toMatch(/permission denied/i);

    const star = await expectDbError(() => asUser(db, a.staffUserId, () => select("select * from public.cards")));
    expect(star.message).toMatch(/permission denied/i);
  });

  it("ne peut pas lire l'e-mail des clients, seulement le prénom", async () => {
    const { a } = await twoShops();

    const err = await expectDbError(() => asUser(db, a.staffUserId, () => select("select email from public.customers")));
    expect(err.message).toMatch(/permission denied/i);

    const ok = await asUser(db, a.staffUserId, async () => (await select("select first_name from public.customers")).rows);
    expect(ok).toEqual([{ first_name: "Alice" }]); // et pas Bob, client de l'autre commerce
  });

  it("ne voit pas les programmes, adresses, événements ni équipes des autres commerces", async () => {
    const { a, b, cardB } = await twoShops();
    await stamp(db, b.staffUserId, cardB.cardId);
    await db.query(
      "insert into public.locations (merchant_id, label, latitude, longitude) values ($1, 'Rue B', 48.85, 2.35)",
      [b.merchantId],
    );

    await asUser(db, a.staffUserId, async () => {
      const programs = (await select("select merchant_id from public.loyalty_programs")).rows as { merchant_id: string }[];
      expect(programs.map((r) => r.merchant_id)).toEqual([a.merchantId]);
      expect((await select("select 1 from public.stamp_events")).rows).toEqual([]);
      expect((await select("select 1 from public.locations")).rows).toEqual([]);
      const merchants = (await select("select id from public.merchants")).rows as { id: string }[];
      expect(merchants.map((r) => r.id)).toEqual([a.merchantId]);
    });
  });

  it("un employé (non propriétaire) ne voit que sa propre ligne d'équipe", async () => {
    const { a } = await twoShops();
    const rows = await asUser(db, a.staffUserId, async () =>
      (await select("select user_id from public.merchant_users")).rows as { user_id: string }[],
    );
    expect(rows.map((r) => r.user_id)).toEqual([a.staffUserId]);
  });

  it("un propriétaire voit toute son équipe, mais pas celle d'un autre commerce", async () => {
    const { a, b } = await twoShops();
    const rows = await asUser(db, a.ownerUserId, async () =>
      (await select("select user_id from public.merchant_users")).rows as { user_id: string }[],
    );
    expect(rows.map((r) => r.user_id).sort()).toEqual([a.ownerUserId, a.staffUserId].sort());
    expect(rows.map((r) => r.user_id)).not.toContain(b.ownerUserId);
  });
});

describe("aucune écriture directe sur les cartes et le journal", () => {
  it("un employé ne peut pas modifier les tampons à la main", async () => {
    const { a, cardA } = await twoShops();
    for (const sql of [
      "update public.cards set stamps = 99 where id = $1",
      "update public.cards set rewards_earned = 99 where id = $1",
      "delete from public.cards where id = $1",
    ]) {
      const err = await expectDbError(() => asUser(db, a.staffUserId, () => db.query(sql, [cardA.cardId])));
      expect(err.message).toMatch(/permission denied/i);
    }
    expect(await cardRow(db, cardA.cardId)).toEqual({ stamps: 0, rewards_earned: 0 });
  });

  it("un propriétaire non plus", async () => {
    const { a, cardA } = await twoShops();
    const err = await expectDbError(() =>
      asUser(db, a.ownerUserId, () => db.query("update public.cards set stamps = 99 where id = $1", [cardA.cardId])),
    );
    expect(err.message).toMatch(/permission denied/i);
  });

  it("personne ne peut écrire, modifier ou effacer le journal", async () => {
    const { a, cardA } = await twoShops();
    await stamp(db, a.staffUserId, cardA.cardId);
    for (const sql of [
      "insert into public.stamp_events (card_id, type, stamps_before, stamps_after) values ($1, 'stamp', 0, 1)",
      "update public.stamp_events set stamps_after = 0 where card_id = $1",
      "delete from public.stamp_events where card_id = $1",
    ]) {
      const err = await expectDbError(() => asUser(db, a.ownerUserId, () => db.query(sql, [cardA.cardId])));
      expect(err.message).toMatch(/permission denied/i);
    }
    expect(await events(db, cardA.cardId)).toHaveLength(1);
  });

  it("un employé ne peut pas créer de carte ni de client (cela passe par le serveur)", async () => {
    const { a } = await twoShops();
    const err = await expectDbError(() =>
      asUser(db, a.staffUserId, () => db.query("insert into public.customers (first_name) values ('Pirate')")),
    );
    expect(err.message).toMatch(/permission denied/i);
  });
});

describe("visiteurs sans compte (rôle anon)", () => {
  it("n'ont accès à aucune table", async () => {
    await twoShops();
    for (const table of [
      "merchants",
      "merchant_users",
      "loyalty_programs",
      "locations",
      "customers",
      "cards",
      "stamp_events",
      "apple_registrations",
    ]) {
      const err = await expectDbError(() => asAnon(db, () => select(`select 1 from public.${table}`)));
      expect(err.message, table).toMatch(/permission denied/i);
    }
  });
});

describe("table apple_registrations : serveur uniquement", () => {
  it("un employé, même propriétaire, ne peut pas la lire ni y écrire", async () => {
    const { a, cardA } = await twoShops();
    await db.query(
      "insert into public.apple_registrations (card_id, device_library_id, push_token) values ($1, 'dev1', 'tok')",
      [cardA.cardId],
    );
    const read = await expectDbError(() => asUser(db, a.ownerUserId, () => select("select * from public.apple_registrations")));
    expect(read.message).toMatch(/permission denied/i);
    const write = await expectDbError(() =>
      asUser(db, a.ownerUserId, () =>
        db.query("insert into public.apple_registrations (card_id, device_library_id, push_token) values ($1, 'x', 'y')", [
          cardA.cardId,
        ]),
      ),
    );
    expect(write.message).toMatch(/permission denied/i);
  });

  it("le serveur (service_role) peut l'utiliser, ainsi que créer clients et cartes", async () => {
    const { a } = await twoShops();
    await asServer(db, async () => {
      const customer = await db.query<{ id: string }>(
        "insert into public.customers (first_name, email, email_consent_at) values ('Zoé', 'zoe@example.com', now()) returning id",
      );
      const card = await db.query<{ id: string; auth_token: string }>(
        "insert into public.cards (program_id, customer_id) values ($1, $2) returning id, auth_token",
        [a.programId, customer.rows[0].id],
      );
      await db.query("insert into public.apple_registrations (card_id, device_library_id, push_token) values ($1, 'd', 't')", [
        card.rows[0].id,
      ]);
      expect(card.rows[0].auth_token).toHaveLength(64);
    });
  });
});

describe("administration : le propriétaire, pas l'employé", () => {
  it("le propriétaire modifie son programme ; l'employé ne peut pas", async () => {
    const { a } = await twoShops();

    await asUser(db, a.ownerUserId, () =>
      db.query("update public.loyalty_programs set reward_label = '2 cafés offerts', stamps_required = 8 where id = $1", [a.programId]),
    );
    const after = (await select("select reward_label, stamps_required from public.loyalty_programs where id = $1", [a.programId]))
      .rows[0];
    expect(after).toEqual({ reward_label: "2 cafés offerts", stamps_required: 8 });

    // L'employé : la mise à jour n'atteint aucune ligne (la règle RLS la filtre) → rien ne change.
    const res = await asUser(db, a.staffUserId, () =>
      db.query("update public.loyalty_programs set reward_label = 'gratuit pour tous' where id = $1", [a.programId]),
    );
    expect(res.affectedRows).toBe(0);
    const unchanged = (await select("select reward_label from public.loyalty_programs where id = $1", [a.programId])).rows[0];
    expect(unchanged).toEqual({ reward_label: "2 cafés offerts" });
  });

  it("un propriétaire ne peut pas modifier le programme d'un autre commerce", async () => {
    const { a, b } = await twoShops();
    const res = await asUser(db, a.ownerUserId, () =>
      db.query("update public.loyalty_programs set reward_label = 'piraté' where id = $1", [b.programId]),
    );
    expect(res.affectedRows).toBe(0);
  });

  it("on ne peut pas déplacer un programme vers un autre commerce (merchant_id verrouillé)", async () => {
    const { a, b } = await twoShops();
    const err = await expectDbError(() =>
      asUser(db, a.ownerUserId, () =>
        db.query("update public.loyalty_programs set merchant_id = $2 where id = $1", [a.programId, b.merchantId]),
      ),
    );
    expect(err.message).toMatch(/permission denied/i);
  });

  it("le propriétaire gère les adresses de son commerce, pas celles des autres", async () => {
    const { a, b } = await twoShops();
    await asUser(db, a.ownerUserId, () =>
      db.query("insert into public.locations (merchant_id, label, latitude, longitude) values ($1, 'Boutique', 48.8566, 2.3522)", [
        a.merchantId,
      ]),
    );
    const staffInsert = await expectDbError(() =>
      asUser(db, a.staffUserId, () =>
        db.query("insert into public.locations (merchant_id, label, latitude, longitude) values ($1, 'X', 1, 1)", [a.merchantId]),
      ),
    );
    expect(staffInsert.message).toMatch(/row-level security/i);
    const foreignInsert = await expectDbError(() =>
      asUser(db, a.ownerUserId, () =>
        db.query("insert into public.locations (merchant_id, label, latitude, longitude) values ($1, 'X', 1, 1)", [b.merchantId]),
      ),
    );
    expect(foreignInsert.message).toMatch(/row-level security/i);
  });

  it("le propriétaire ajoute et retire un employé ; un employé ne peut pas", async () => {
    const { a, b } = await twoShops();
    const newcomer = await createUser(db);

    await asUser(db, a.ownerUserId, () =>
      db.query("insert into public.merchant_users (merchant_id, user_id, role) values ($1, $2, 'staff')", [a.merchantId, newcomer]),
    );
    // Le nouveau peut tout de suite tamponner dans ce commerce.
    const cardA = await createCard(db, a.programId, "Chloé");
    expect((await stamp(db, newcomer, cardA.cardId)).stamps).toBe(1);

    const staffAdds = await expectDbError(() =>
      asUser(db, a.staffUserId, () =>
        db.query("insert into public.merchant_users (merchant_id, user_id, role) values ($1, $2, 'owner')", [
          a.merchantId,
          a.staffUserId,
        ]),
      ),
    );
    expect(staffAdds.message).toMatch(/row-level security/i);

    const otherShop = await expectDbError(() =>
      asUser(db, a.ownerUserId, () =>
        db.query("insert into public.merchant_users (merchant_id, user_id, role) values ($1, $2, 'staff')", [b.merchantId, newcomer]),
      ),
    );
    expect(otherShop.message).toMatch(/row-level security/i);

    await asUser(db, a.ownerUserId, () =>
      db.query("delete from public.merchant_users where merchant_id = $1 and user_id = $2", [a.merchantId, newcomer]),
    );
    const err = await expectDbError(() => stamp(db, newcomer, cardA.cardId));
    expect(err.message).toBe("card_not_found"); // retiré : plus aucun droit
  });

  it("un employé retiré garde ses tampons dans le journal (merchant_user_id passe à vide)", async () => {
    const { a } = await twoShops();
    const card = await createCard(db, a.programId, "Max");
    await stamp(db, a.staffUserId, card.cardId);

    await db.query("delete from public.merchant_users where user_id = $1", [a.staffUserId]);

    const log = await events(db, card.cardId);
    expect(log).toHaveLength(1);
    expect(log[0].merchant_user_id).toBeNull();
  });
});

describe("règles de validité des données", () => {
  it("refuse un programme à 0 ou 51 cases", async () => {
    const { a } = await twoShops();
    for (const n of [0, 51]) {
      const err = await expectDbError(() =>
        db.query("insert into public.loyalty_programs (merchant_id, name, stamps_required, reward_label) values ($1, 'x', $2, 'y')", [
          a.merchantId,
          n,
        ]),
      );
      expect(err.message).toMatch(/check constraint/i);
    }
  });

  it("refuse des coordonnées GPS impossibles", async () => {
    const { a } = await twoShops();
    for (const [lat, lon] of [
      [91, 0],
      [0, 181],
      [-91, 0],
    ]) {
      const err = await expectDbError(() =>
        db.query("insert into public.locations (merchant_id, label, latitude, longitude) values ($1, 'x', $2, $3)", [
          a.merchantId,
          lat,
          lon,
        ]),
      );
      expect(err.message).toMatch(/check constraint/i);
    }
  });

  it("RGPD : pas d'e-mail enregistré sans consentement", async () => {
    const err = await expectDbError(() =>
      db.query("insert into public.customers (first_name, email) values ('Sam', 'sam@example.com')"),
    );
    expect(err.message).toMatch(/check constraint/i);

    await db.query("insert into public.customers (first_name) values ('Sans e-mail')");
    await db.query("insert into public.customers (first_name, email, email_consent_at) values ('Avec', 'a@b.fr', now())");
  });

  it("refuse une couleur invalide et un logo non https", async () => {
    for (const sql of [
      "insert into public.merchants (name, brand_color) values ('x', 'rouge')",
      "insert into public.merchants (name, logo_url) values ('x', 'http://exemple.fr/logo.png')",
    ]) {
      const err = await expectDbError(() => db.query(sql));
      expect(err.message).toMatch(/check constraint/i);
    }
  });

  it("chaque carte reçoit un numéro de série et un secret uniques et imprévisibles", async () => {
    const { a } = await twoShops();
    const c1 = await createCard(db, a.programId);
    const c2 = await createCard(db, a.programId);
    const rows = (
      await select("select serial_number, auth_token from public.cards where id = any($1::uuid[])", [[c1.cardId, c2.cardId]])
    ).rows as { serial_number: string; auth_token: string }[];

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.serial_number).toMatch(/^[0-9a-f]{32}$/);
      expect(r.auth_token).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(rows.map((r) => r.serial_number)).size).toBe(2);
    expect(new Set(rows.map((r) => r.auth_token)).size).toBe(2);
  });
});
