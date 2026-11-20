import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ageEvents,
  asUser,
  cardRow,
  createCard,
  createShop,
  createTestDb,
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

/** Un commerce de `n` cases, une carte, et l'employé qui tamponne. */
async function setup(opts: { stampsRequired?: number; doubleScanMinutes?: number } = {}) {
  const shop = await createShop(db, opts);
  const { cardId } = await createCard(db, shop.programId);
  return { shop, cardId, staff: shop.staffUserId };
}

/** Tamponne `n` fois en laissant passer le délai anti double scan entre chaque tampon. */
async function stampTimes(staff: string, cardId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await stamp(db, staff, cardId);
    await ageEvents(db, cardId, 60);
  }
}

describe("ajout d'un tampon", () => {
  it("passe de 0 à 1 et renvoie l'état de la carte", async () => {
    const { cardId, staff } = await setup({ stampsRequired: 5 });
    const res = await stamp(db, staff, cardId);

    expect(res).toMatchObject({
      card_id: cardId,
      stamps: 1,
      stamps_required: 5,
      rewards_earned: 0,
      reward_available: false,
    });
    expect(await cardRow(db, cardId)).toEqual({ stamps: 1, rewards_earned: 0 });
  });

  it("écrit une ligne dans le journal, au nom de l'employé", async () => {
    const { shop, cardId, staff } = await setup();
    await stamp(db, staff, cardId);

    expect(await events(db, cardId)).toEqual([
      { type: "stamp", stamps_before: 0, stamps_after: 1, merchant_user_id: shop.staffMemberId },
    ]);
  });

  it("le propriétaire peut aussi tamponner", async () => {
    const { shop, cardId } = await setup();
    const res = await stamp(db, shop.ownerUserId, cardId);
    expect(res.stamps).toBe(1);
  });

  it("met à jour updated_at de la carte (pour que les Wallets la rafraîchissent)", async () => {
    const { cardId, staff } = await setup();
    const before = await db.query<{ t: string }>("select updated_at::text as t from public.cards where id = $1", [cardId]);
    await stamp(db, staff, cardId);
    const after = await db.query<{ t: string }>("select updated_at::text as t from public.cards where id = $1", [cardId]);
    expect(after.rows[0].t > before.rows[0].t).toBe(true);
  });
});

describe("carte pleine", () => {
  it("signale la récompense disponible au dernier tampon", async () => {
    const { cardId, staff } = await setup({ stampsRequired: 3 });
    await stampTimes(staff, cardId, 2);
    const last = await stamp(db, staff, cardId);

    expect(last).toMatchObject({ stamps: 3, stamps_required: 3, reward_available: true });
  });

  it("refuse un tampon de plus (card_full) sans rien modifier", async () => {
    const { cardId, staff } = await setup({ stampsRequired: 2 });
    await stampTimes(staff, cardId, 2);
    const before = await events(db, cardId);

    const err = await expectDbError(() => stamp(db, staff, cardId));

    expect(err).toMatchObject({ message: "card_full", code: "PT409" });
    expect(await cardRow(db, cardId)).toEqual({ stamps: 2, rewards_earned: 0 });
    expect(await events(db, cardId)).toEqual(before);
  });
});

describe("récompense et remise à 0", () => {
  it("refuse tant que la carte n'est pas pleine (card_not_full)", async () => {
    const { cardId, staff } = await setup({ stampsRequired: 3 });
    await stampTimes(staff, cardId, 2);

    const err = await expectDbError(() => redeem(db, staff, cardId));

    expect(err).toMatchObject({ message: "card_not_full", code: "PT409" });
    expect(await cardRow(db, cardId)).toEqual({ stamps: 2, rewards_earned: 0 });
  });

  it("remet les tampons à 0 et compte une récompense de plus", async () => {
    const { cardId, staff } = await setup({ stampsRequired: 3 });
    await stampTimes(staff, cardId, 3);

    const res = await redeem(db, staff, cardId);

    expect(res).toMatchObject({ stamps: 0, rewards_earned: 1, reward_available: false });
    expect(await cardRow(db, cardId)).toEqual({ stamps: 0, rewards_earned: 1 });
  });

  it("journalise la récompense (avant = nombre de cases, après = 0)", async () => {
    const { shop, cardId, staff } = await setup({ stampsRequired: 2 });
    await stampTimes(staff, cardId, 2);
    await redeem(db, staff, cardId);

    const log = await events(db, cardId);
    expect(log.at(-1)).toEqual({
      type: "reward_redeemed",
      stamps_before: 2,
      stamps_after: 0,
      merchant_user_id: shop.staffMemberId,
    });
  });

  it("ne peut pas être validée deux fois de suite", async () => {
    const { cardId, staff } = await setup({ stampsRequired: 2 });
    await stampTimes(staff, cardId, 2);
    await redeem(db, staff, cardId);

    const err = await expectDbError(() => redeem(db, staff, cardId));
    expect(err.message).toBe("card_not_full");
    expect((await cardRow(db, cardId)).rewards_earned).toBe(1);
  });

  it("permet de tamponner tout de suite après la récompense, et de refaire un cycle complet", async () => {
    const { cardId, staff } = await setup({ stampsRequired: 2 });
    await stampTimes(staff, cardId, 2);
    await redeem(db, staff, cardId);

    // Aucun délai à attendre : le dernier événement est une récompense, pas un tampon.
    const first = await stamp(db, staff, cardId);
    expect(first.stamps).toBe(1);

    await ageEvents(db, cardId, 60);
    await stamp(db, staff, cardId);
    const second = await redeem(db, staff, cardId);
    expect(second).toMatchObject({ stamps: 0, rewards_earned: 2 });
  });

  it("reste possible même si le programme est désactivé entre-temps", async () => {
    const { shop, cardId, staff } = await setup({ stampsRequired: 2 });
    await stampTimes(staff, cardId, 2);
    await db.query("update public.loyalty_programs set is_active = false where id = $1", [shop.programId]);

    const res = await redeem(db, staff, cardId);
    expect(res.rewards_earned).toBe(1);
  });

  it("valide aussi une carte qui a plus de tampons que de cases (programme raccourci après coup)", async () => {
    const { shop, cardId, staff } = await setup({ stampsRequired: 4 });
    await stampTimes(staff, cardId, 4);
    await db.query("update public.loyalty_programs set stamps_required = 3 where id = $1", [shop.programId]);

    const res = await redeem(db, staff, cardId);
    expect(res).toMatchObject({ stamps: 0, rewards_earned: 1 });
  });
});

describe("anti double scan", () => {
  it("refuse un 2e tampon dans le délai, et dit combien de secondes attendre", async () => {
    const { cardId, staff } = await setup({ doubleScanMinutes: 10 });
    await stamp(db, staff, cardId);
    await ageEvents(db, cardId, 4); // le tampon date de 4 minutes

    const err = await expectDbError(() => stamp(db, staff, cardId));

    expect(err).toMatchObject({ message: "double_scan", code: "PT409" });
    const secondsLeft = Number(err.detail);
    // Il reste environ 6 minutes (360 s).
    expect(secondsLeft).toBeGreaterThan(350);
    expect(secondsLeft).toBeLessThanOrEqual(360);
    expect((await cardRow(db, cardId)).stamps).toBe(1);
    expect(await events(db, cardId)).toHaveLength(1);
  });

  it("accepte à nouveau une fois le délai écoulé", async () => {
    const { cardId, staff } = await setup({ doubleScanMinutes: 10 });
    await stamp(db, staff, cardId);
    await ageEvents(db, cardId, 11);

    const res = await stamp(db, staff, cardId);
    expect(res.stamps).toBe(2);
  });

  it("s'applique aussi si c'est un autre employé qui rescanne", async () => {
    const { shop, cardId, staff } = await setup();
    await stamp(db, staff, cardId);

    const err = await expectDbError(() => stamp(db, shop.ownerUserId, cardId));
    expect(err.message).toBe("double_scan");
  });

  it("le délai est réglable par programme (30 min : 20 min après, c'est encore refusé)", async () => {
    const { cardId, staff } = await setup({ doubleScanMinutes: 30 });
    await stamp(db, staff, cardId);
    await ageEvents(db, cardId, 20);

    const err = await expectDbError(() => stamp(db, staff, cardId));
    expect(err.message).toBe("double_scan");
  });

  it("peut être désactivé avec un délai de 0", async () => {
    const { cardId, staff } = await setup({ doubleScanMinutes: 0 });
    await stamp(db, staff, cardId);
    const res = await stamp(db, staff, cardId);
    expect(res.stamps).toBe(2);
  });

  it("ne bloque pas les autres cartes", async () => {
    const { shop, cardId, staff } = await setup();
    const other = await createCard(db, shop.programId, "Hugo");
    await stamp(db, staff, cardId);

    const res = await stamp(db, staff, other.cardId);
    expect(res.stamps).toBe(1);
  });
});

describe("annulation du dernier tampon", () => {
  it("retire un tampon et crée un événement « correction »", async () => {
    const { shop, cardId, staff } = await setup();
    await stamp(db, staff, cardId);

    const res = await undo(db, staff, cardId);

    expect(res.stamps).toBe(0);
    expect(await cardRow(db, cardId)).toEqual({ stamps: 0, rewards_earned: 0 });
    expect(await events(db, cardId)).toEqual([
      { type: "stamp", stamps_before: 0, stamps_after: 1, merchant_user_id: shop.staffMemberId },
      { type: "correction", stamps_before: 1, stamps_after: 0, merchant_user_id: shop.staffMemberId },
    ]);
  });

  it("n'annule qu'un seul tampon : une 2e annulation est refusée (nothing_to_undo)", async () => {
    const { cardId, staff } = await setup();
    await stampTimes(staff, cardId, 1);
    await stamp(db, staff, cardId);
    await undo(db, staff, cardId);

    const err = await expectDbError(() => undo(db, staff, cardId));
    expect(err).toMatchObject({ message: "nothing_to_undo", code: "PT409" });
    expect((await cardRow(db, cardId)).stamps).toBe(1);
  });

  it("est refusée sur une carte neuve (nothing_to_undo)", async () => {
    const { cardId, staff } = await setup();
    const err = await expectDbError(() => undo(db, staff, cardId));
    expect(err.message).toBe("nothing_to_undo");
  });

  it("est refusée au-delà de 2 minutes (undo_expired)", async () => {
    const { cardId, staff } = await setup();
    await stamp(db, staff, cardId);
    await ageEvents(db, cardId, 3);

    const err = await expectDbError(() => undo(db, staff, cardId));
    expect(err).toMatchObject({ message: "undo_expired", code: "PT409" });
    expect((await cardRow(db, cardId)).stamps).toBe(1);
  });

  it("est encore possible juste avant 2 minutes", async () => {
    const { cardId, staff } = await setup();
    await stamp(db, staff, cardId);
    await ageEvents(db, cardId, 1.5);

    const res = await undo(db, staff, cardId);
    expect(res.stamps).toBe(0);
  });

  it("permet de retamponner tout de suite après une annulation (pas de blocage anti double scan)", async () => {
    const { cardId, staff } = await setup();
    await stamp(db, staff, cardId);
    await undo(db, staff, cardId);

    const res = await stamp(db, staff, cardId);
    expect(res.stamps).toBe(1);
  });

  it("annule le tampon qui remplissait la carte", async () => {
    const { cardId, staff } = await setup({ stampsRequired: 2 });
    await stampTimes(staff, cardId, 1);
    const full = await stamp(db, staff, cardId);
    expect(full.reward_available).toBe(true);

    const res = await undo(db, staff, cardId);
    expect(res).toMatchObject({ stamps: 1, reward_available: false });
  });

  it("est impossible après la validation de la récompense", async () => {
    const { cardId, staff } = await setup({ stampsRequired: 2 });
    await stampTimes(staff, cardId, 2);
    await redeem(db, staff, cardId);

    const err = await expectDbError(() => undo(db, staff, cardId));
    expect(err.message).toBe("nothing_to_undo");
    expect(await cardRow(db, cardId)).toEqual({ stamps: 0, rewards_earned: 1 });
  });
});

describe("programme désactivé", () => {
  it("refuse de tamponner (program_inactive)", async () => {
    const { shop, cardId, staff } = await setup();
    await db.query("update public.loyalty_programs set is_active = false where id = $1", [shop.programId]);

    const err = await expectDbError(() => stamp(db, staff, cardId));
    expect(err).toMatchObject({ message: "program_inactive", code: "PT422" });
    expect((await cardRow(db, cardId)).stamps).toBe(0);
  });
});

describe("cohérence du journal", () => {
  it("après un parcours complet, chaque ligne enchaîne sur la précédente", async () => {
    const { cardId, staff } = await setup({ stampsRequired: 3 });
    await stampTimes(staff, cardId, 3);
    await redeem(db, staff, cardId);
    await stamp(db, staff, cardId);
    await undo(db, staff, cardId);

    const log = await events(db, cardId);
    expect(log.map((e) => e.type)).toEqual(["stamp", "stamp", "stamp", "reward_redeemed", "stamp", "correction"]);
    for (let i = 1; i < log.length; i++) {
      expect(log[i].stamps_before).toBe(log[i - 1].stamps_after);
    }
    expect(log.at(-1)!.stamps_after).toBe((await cardRow(db, cardId)).stamps);
  });

  it("l'employé peut relire le journal de son commerce", async () => {
    const { cardId, staff } = await setup();
    await stamp(db, staff, cardId);

    const rows = await asUser(db, staff, async () =>
      (await db.query("select type from public.stamp_events where card_id = $1", [cardId])).rows,
    );
    expect(rows).toEqual([{ type: "stamp" }]);
  });
});
