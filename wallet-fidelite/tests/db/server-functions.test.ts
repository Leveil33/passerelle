/* eslint-disable @typescript-eslint/no-explicit-any -- tests : on lit du JSON sans le typer en détail */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAnon,
  asServer,
  asUser,
  createCard,
  createShop,
  createTestDb,
  expectDbError,
  stamp,
} from "./helpers";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

/** Appelle une fonction comme le serveur (service_role) et renvoie la 1re colonne de la 1re ligne. */
async function server<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
  const res = await asServer(db, () => db.query(sql, params));
  return Object.values(res.rows[0] as object)[0] as T;
}
async function serverRows<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await asServer(db, () => db.query<T>(sql, params))).rows;
}

const cardUpdatedAt = async (cardId: string) =>
  (await db.query<{ t: string }>("select updated_at::text as t from public.cards where id = $1", [cardId])).rows[0].t;
const cardInfo = async (cardId: string) =>
  (await db.query<{ serial_number: string; auth_token: string; platform: string | null }>(
    "select serial_number, auth_token, platform from public.cards where id = $1",
    [cardId],
  )).rows[0];

describe("droits : réservé au serveur", () => {
  const calls: [string, unknown[]][] = [
    ["select public.rate_limit_hit('k', 60, 5)", []],
    ["select public.create_card('00000000-0000-4000-8000-000000000000', 'x')", []],
    ["select public.loyalty_pass_data('abc')", []],
    ["select public.apple_register_device('s', 't', 'd', 'p')", []],
    ["select public.apple_unregister_device('s', 't', 'd')", []],
    ["select * from public.apple_updated_serials('d')", []],
    ["select * from public.apple_push_targets('s')", []],
    ["select public.apple_forget_push_token('p')", []],
  ];

  it("un visiteur sans compte ne peut appeler aucune de ces fonctions", async () => {
    for (const [sql, params] of calls) {
      const err = await expectDbError(() => asAnon(db, () => db.query(sql, params)));
      expect(err.message, sql).toMatch(/permission denied/i);
    }
  });

  it("un employé ou un propriétaire connecté non plus (même pas pour lire les données d'une carte)", async () => {
    const shop = await createShop(db);
    for (const who of [shop.staffUserId, shop.ownerUserId]) {
      for (const [sql, params] of calls) {
        const err = await expectDbError(() => asUser(db, who, () => db.query(sql, params)));
        expect(err.message, sql).toMatch(/permission denied/i);
      }
    }
  });

  it("le schéma interne et la table des compteurs sont invisibles pour les employés", async () => {
    const shop = await createShop(db);
    const err = await expectDbError(() =>
      asUser(db, shop.ownerUserId, () => db.query("select * from private.rate_limits")),
    );
    expect(err.message).toMatch(/permission denied/i);
  });
});

describe("limitation du nombre de requêtes", () => {
  const hit = (key: string, windowSeconds = 60, max = 3) =>
    server<boolean>("select public.rate_limit_hit($1, $2, $3)", [key, windowSeconds, max]);

  it("autorise jusqu'au maximum, puis refuse", async () => {
    const key = `test:${Math.random()}`;
    expect([await hit(key), await hit(key), await hit(key)]).toEqual([true, true, true]);
    expect(await hit(key)).toBe(false);
    expect(await hit(key)).toBe(false);
  });

  it("chaque clé a son propre compteur", async () => {
    const a = `a:${Math.random()}`;
    const b = `b:${Math.random()}`;
    for (let i = 0; i < 4; i++) await hit(a, 60, 3);
    expect(await hit(a, 60, 3)).toBe(false);
    expect(await hit(b, 60, 3)).toBe(true);
  });

  it("repart à zéro quand la fenêtre est écoulée", async () => {
    const key = `window:${Math.random()}`;
    for (let i = 0; i < 4; i++) await hit(key, 60, 3);
    expect(await hit(key, 60, 3)).toBe(false);

    await db.query("update private.rate_limits set window_start = window_start - interval '61 seconds' where key = $1", [key]);
    expect(await hit(key, 60, 3)).toBe(true);
  });

  it("refuse des paramètres absurdes", async () => {
    for (const args of [
      ["", 60, 3],
      ["k", 0, 3],
      ["k", 60, 0],
      ["k", 999999, 3],
      ["x".repeat(201), 60, 3],
    ] as const) {
      const err = await expectDbError(() => hit(args[0], args[1], args[2]));
      expect(err.message, JSON.stringify(args)).toBe("invalid_rate_limit_arguments");
    }
  });
});

describe("création d'une carte", () => {
  const create = (programId: string, name: string, extra: Record<string, unknown> = {}) =>
    server<{ card_id: string; serial_number: string }>(
      "select public.create_card($1, $2, $3, $4, $5)",
      [programId, name, extra.email ?? null, extra.emailConsent ?? false, extra.marketing ?? false],
    );

  it("crée le client et sa carte, avec un numéro de série et un secret", async () => {
    const shop = await createShop(db);
    const res = await create(shop.programId, "  Camille  ");

    expect(res.serial_number).toMatch(/^[0-9a-f]{32}$/);
    const row = (await db.query<{ first_name: string; stamps: number; email: string | null; marketing: string | null }>(
      `select cu.first_name, c.stamps, cu.email, cu.marketing_consent_at::text as marketing
         from public.cards c join public.customers cu on cu.id = c.customer_id where c.id = $1`,
      [res.card_id],
    )).rows[0];
    expect(row).toEqual({ first_name: "Camille", stamps: 0, email: null, marketing: null });
  });

  it("enregistre les consentements avec leur date, séparément", async () => {
    const shop = await createShop(db);
    const res = await create(shop.programId, "Léo", { email: "leo@example.com", emailConsent: true, marketing: true });
    const row = (await db.query<{ email: string; e: boolean; m: boolean }>(
      `select cu.email, cu.email_consent_at is not null as e, cu.marketing_consent_at is not null as m
         from public.cards c join public.customers cu on cu.id = c.customer_id where c.id = $1`,
      [res.card_id],
    )).rows[0];
    expect(row).toEqual({ email: "leo@example.com", e: true, m: true });
  });

  it("consentement aux offres sans e-mail : possible ; e-mail sans consentement : refusé", async () => {
    const shop = await createShop(db);
    const ok = await create(shop.programId, "Ana", { marketing: true });
    expect(ok.card_id).toBeTruthy();

    const err = await expectDbError(() => create(shop.programId, "Bob", { email: "bob@example.com", emailConsent: false }));
    expect(err.message).toBe("email_requires_consent");
  });

  it("refuse un prénom vide ou trop long, un e-mail invalide, un programme inconnu ou désactivé", async () => {
    const shop = await createShop(db);
    for (const name of ["", "   ", "x".repeat(61)]) {
      expect((await expectDbError(() => create(shop.programId, name))).message, name).toBe("invalid_first_name");
    }
    expect((await expectDbError(() => create(shop.programId, "Zoé", { email: "pas-un-mail", emailConsent: true }))).message).toBe(
      "invalid_email",
    );
    expect((await expectDbError(() => create("00000000-0000-4000-8000-000000000000", "Zoé"))).message).toBe("program_not_found");

    await db.query("update public.loyalty_programs set is_active = false where id = $1", [shop.programId]);
    expect((await expectDbError(() => create(shop.programId, "Zoé"))).message).toBe("program_inactive");
  });

  it("n'écrit rien quand la création est refusée", async () => {
    const shop = await createShop(db);
    const before = (await db.query<{ n: number }>("select count(*)::int as n from public.customers")).rows[0].n;
    await expectDbError(() => create(shop.programId, "Zoé", { email: "pas-un-mail", emailConsent: true }));
    const after = (await db.query<{ n: number }>("select count(*)::int as n from public.customers")).rows[0].n;
    expect(after).toBe(before);
  });
});

describe("données d'une carte pour le Wallet", () => {
  it("renvoie carte, client, programme, commerce et adresses", async () => {
    const shop = await createShop(db, { name: "Café du Port", stampsRequired: 8 });
    const { cardId } = await createCard(db, shop.programId, "Inès");
    const info = await cardInfo(cardId);

    const data = await server<any>("select public.loyalty_pass_data($1)", [info.serial_number]);

    expect(data.card).toMatchObject({ id: cardId, serial_number: info.serial_number, auth_token: info.auth_token, stamps: 0, rewards_earned: 0 });
    expect(data.customer).toEqual({ first_name: "Inès" });
    expect(data.program).toMatchObject({ name: "Carte café", stamps_required: 8, reward_label: "1 café offert", stamp_icon: "star", is_active: true });
    expect(data.merchant).toMatchObject({ name: "Café du Port", brand_color: "#1F2937", logo_url: null });
    expect(data.locations).toEqual([]);
  });

  it("renvoie null pour un numéro inconnu", async () => {
    expect(await server("select public.loyalty_pass_data('inconnu')")).toBeNull();
  });

  it("limite à 10 adresses (maximum Apple / Google), les plus anciennes d'abord", async () => {
    const shop = await createShop(db);
    const { cardId } = await createCard(db, shop.programId);
    for (let i = 1; i <= 12; i++) {
      await db.query(
        "insert into public.locations (merchant_id, label, latitude, longitude, created_at) values ($1, $2, 48.85, 2.35, now() + ($3 * interval '1 second'))",
        [shop.merchantId, `Boutique ${i}`, i],
      );
    }
    const data = await server<any>("select public.loyalty_pass_data($1)", [(await cardInfo(cardId)).serial_number]);
    expect(data.locations).toHaveLength(10);
    expect(data.locations.map((l: any) => l.label)).toEqual(Array.from({ length: 10 }, (_, i) => `Boutique ${i + 1}`));
  });
});

describe("service Web Apple : enregistrement des iPhone", () => {
  const register = (serial: string, token: string | null, device = "device-1", push = "push-1") =>
    server<string>("select public.apple_register_device($1, $2, $3, $4)", [serial, token, device, push]);

  async function newCard() {
    const shop = await createShop(db);
    const { cardId } = await createCard(db, shop.programId);
    return { cardId, shop, ...(await cardInfo(cardId)) };
  }

  it("enregistre un iPhone (created), puis le reconnaît (exists) et met à jour son jeton", async () => {
    const c = await newCard();
    expect(await register(c.serial_number, c.auth_token, "dev", "tok-A")).toBe("created");
    expect(await register(c.serial_number, c.auth_token, "dev", "tok-B")).toBe("exists");

    const rows = await serverRows<{ push_token: string }>("select * from public.apple_push_targets($1)", [c.serial_number]);
    expect(rows).toEqual([{ device_library_id: "dev", push_token: "tok-B" }]);
  });

  it("refuse un mauvais secret (unauthorized) sans rien enregistrer", async () => {
    const c = await newCard();
    for (const bad of ["faux", "", null]) {
      expect(await register(c.serial_number, bad as string | null)).toBe(bad === "" ? "unauthorized" : "unauthorized");
    }
    expect(await serverRows("select * from public.apple_push_targets($1)", [c.serial_number])).toEqual([]);
  });

  it("répond not_found pour un numéro inconnu et invalid pour des données vides", async () => {
    const c = await newCard();
    expect(await register("inconnu", "x")).toBe("not_found");
    expect(await register(c.serial_number, c.auth_token, "", "p")).toBe("invalid");
    expect(await register(c.serial_number, c.auth_token, "d", "")).toBe("invalid");
  });

  it("le secret d'une carte ne permet pas d'enregistrer un appareil sur une autre carte", async () => {
    const a = await newCard();
    const b = await newCard();
    expect(await register(b.serial_number, a.auth_token)).toBe("unauthorized");
  });

  it("mémorise la plateforme (apple, ou both si déjà sur Google) sans marquer la carte « modifiée »", async () => {
    const c = await newCard();
    const before = await cardUpdatedAt(c.cardId);
    await register(c.serial_number, c.auth_token);
    expect((await cardInfo(c.cardId)).platform).toBe("apple");
    expect(await cardUpdatedAt(c.cardId)).toBe(before);

    const g = await newCard();
    await db.query("update public.cards set platform = 'google' where id = $1", [g.cardId]);
    await register(g.serial_number, g.auth_token);
    expect((await cardInfo(g.cardId)).platform).toBe("both");
  });

  it("désinscrit un iPhone avec le bon secret seulement", async () => {
    const c = await newCard();
    await register(c.serial_number, c.auth_token, "dev");
    expect(await server<string>("select public.apple_unregister_device($1, $2, $3)", [c.serial_number, "faux", "dev"])).toBe("unauthorized");
    expect(await serverRows("select * from public.apple_push_targets($1)", [c.serial_number])).toHaveLength(1);

    expect(await server<string>("select public.apple_unregister_device($1, $2, $3)", [c.serial_number, c.auth_token, "dev"])).toBe("ok");
    expect(await serverRows("select * from public.apple_push_targets($1)", [c.serial_number])).toEqual([]);
    expect(await server<string>("select public.apple_unregister_device($1, $2, $3)", ["inconnu", "x", "dev"])).toBe("not_found");
  });

  it("oublie un jeton déclaré invalide par Apple", async () => {
    const c = await newCard();
    await register(c.serial_number, c.auth_token, "d1", "mort");
    await register(c.serial_number, c.auth_token, "d2", "vivant");

    expect(await server<number>("select public.apple_forget_push_token('mort')")).toBe(1);
    expect(await server<number>("select public.apple_forget_push_token('mort')")).toBe(0);
    const rows = await serverRows<{ push_token: string }>("select * from public.apple_push_targets($1)", [c.serial_number]);
    expect(rows.map((r) => r.push_token)).toEqual(["vivant"]);
  });
});

describe("service Web Apple : cartes modifiées d'un iPhone", () => {
  const updated = (device: string, since: string | null = null) =>
    serverRows<{ serial_number: string; updated_at: string }>("select * from public.apple_updated_serials($1, $2)", [device, since]);

  it("liste toutes les cartes de l'appareil sans filtre, et seulement celles modifiées depuis un repère sinon", async () => {
    const shop = await createShop(db);
    const device = `dev-${Math.random()}`;
    const c1 = await createCard(db, shop.programId, "A");
    const c2 = await createCard(db, shop.programId, "B");
    const i1 = await cardInfo(c1.cardId);
    const i2 = await cardInfo(c2.cardId);
    await server("select public.apple_register_device($1, $2, $3, 't1')", [i1.serial_number, i1.auth_token, device]);
    await server("select public.apple_register_device($1, $2, $3, 't2')", [i2.serial_number, i2.auth_token, device]);

    const all = await updated(device);
    expect(all.map((r) => r.serial_number).sort()).toEqual([i1.serial_number, i2.serial_number].sort());

    // Repère = date de la plus récente ; rien de plus récent pour l'instant.
    const tag = all.map((r) => r.updated_at).sort().at(-1)!;
    expect(await updated(device, tag)).toEqual([]);

    // Un tampon sur la carte 1 : elle seule réapparaît.
    await stamp(db, shop.staffUserId, c1.cardId);
    const after = await updated(device, tag);
    expect(after.map((r) => r.serial_number)).toEqual([i1.serial_number]);
  });

  it("ne montre jamais les cartes d'un autre appareil", async () => {
    const shop = await createShop(db);
    const { cardId } = await createCard(db, shop.programId);
    const info = await cardInfo(cardId);
    await server("select public.apple_register_device($1, $2, 'mon-iphone', 't')", [info.serial_number, info.auth_token]);
    expect(await updated("autre-iphone")).toEqual([]);
  });
});

describe("les cartes existantes suivent les modifications du commerçant", () => {
  async function shopWithCard() {
    const shop = await createShop(db);
    const { cardId } = await createCard(db, shop.programId);
    return { shop, cardId };
  }
  const changed = async (cardId: string, action: () => Promise<unknown>) => {
    const before = await cardUpdatedAt(cardId);
    await action();
    return (await cardUpdatedAt(cardId)) !== before;
  };

  it("un tampon marque la carte comme modifiée", async () => {
    const { shop, cardId } = await shopWithCard();
    expect(await changed(cardId, () => stamp(db, shop.staffUserId, cardId))).toBe(true);
  });

  it("le propriétaire change son programme (récompense, cases, message, tampon, désactivation)", async () => {
    for (const [col, val] of [
      ["reward_label", "'2 cafés offerts'"],
      ["stamps_required", "9"],
      ["proximity_message", "'Un café vous attend !'"],
      ["stamp_icon", "'coffee'"],
      ["name", "'Nouveau nom'"],
      ["is_active", "false"],
    ] as const) {
      const { shop, cardId } = await shopWithCard();
      const moved = await changed(cardId, () =>
        asUser(db, shop.ownerUserId, () => db.query(`update public.loyalty_programs set ${col} = ${val} where id = $1`, [shop.programId])),
      );
      expect(moved, col).toBe(true);
    }
  });

  it("le délai anti double scan, qui n'apparaît pas sur la carte, ne la marque pas modifiée", async () => {
    const { shop, cardId } = await shopWithCard();
    const moved = await changed(cardId, () =>
      asUser(db, shop.ownerUserId, () =>
        db.query("update public.loyalty_programs set double_scan_delay_minutes = 30 where id = $1", [shop.programId]),
      ),
    );
    expect(moved).toBe(false);
  });

  it("le propriétaire change sa couleur ou son nom ; le serveur change le logo", async () => {
    for (const action of [
      (s: { ownerUserId: string; merchantId: string }) =>
        asUser(db, s.ownerUserId, () => db.query("update public.merchants set brand_color = '#E11D48' where id = $1", [s.merchantId])),
      (s: { ownerUserId: string; merchantId: string }) =>
        asUser(db, s.ownerUserId, () => db.query("update public.merchants set name = 'Autre nom' where id = $1", [s.merchantId])),
      (s: { ownerUserId: string; merchantId: string }) =>
        asServer(db, () => db.query("update public.merchants set logo_url = 'https://exemple.fr/l.png' where id = $1", [s.merchantId])),
    ]) {
      const { shop, cardId } = await shopWithCard();
      expect(await changed(cardId, () => action(shop))).toBe(true);
    }
  });

  it("ajouter, déplacer ou supprimer une adresse met à jour les cartes du commerce — et d'aucun autre", async () => {
    const { shop, cardId } = await shopWithCard();
    const other = await shopWithCard();

    expect(
      await changed(cardId, () =>
        asUser(db, shop.ownerUserId, () =>
          db.query("insert into public.locations (merchant_id, label, latitude, longitude) values ($1, 'Boutique', 48.85, 2.35)", [shop.merchantId]),
        ),
      ),
    ).toBe(true);

    expect(
      await changed(cardId, () =>
        asUser(db, shop.ownerUserId, () => db.query("update public.locations set latitude = 45.76 where merchant_id = $1", [shop.merchantId])),
      ),
    ).toBe(true);

    const otherBefore = await cardUpdatedAt(other.cardId);
    expect(
      await changed(cardId, () =>
        asUser(db, shop.ownerUserId, () => db.query("delete from public.locations where merchant_id = $1", [shop.merchantId])),
      ),
    ).toBe(true);
    expect(await cardUpdatedAt(other.cardId)).toBe(otherBefore);
  });
});
