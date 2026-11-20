import { describe, expect, it } from "vitest";
import { parseLoyaltyError } from "./errors";

describe("messages d'erreur pour l'employé", () => {
  it("traduit chaque refus de la base avec le bon code HTTP", () => {
    const expected: Record<string, number> = {
      not_authenticated: 401,
      card_not_found: 404,
      program_inactive: 422,
      card_full: 409,
      card_not_full: 409,
      nothing_to_undo: 409,
      undo_expired: 409,
    };
    for (const [code, status] of Object.entries(expected)) {
      const err = parseLoyaltyError({ message: code });
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err.message.length).toBeGreaterThan(10);
      expect(err.message).not.toContain(code); // jamais de code technique à l'écran
    }
  });

  it("double scan : annonce le temps restant en secondes puis en minutes", () => {
    const short = parseLoyaltyError({ message: "double_scan", details: "45" });
    expect(short).toMatchObject({ code: "double_scan", status: 409, retryAfterSeconds: 45 });
    expect(short.message).toContain("45 s");

    const long = parseLoyaltyError({ message: "double_scan", details: "361" });
    expect(long.retryAfterSeconds).toBe(361);
    expect(long.message).toContain("7 min"); // arrondi au-dessus, jamais « 6 min » alors qu'il en reste 6 et 1 s
  });

  it("double scan sans durée exploitable : message sans chiffre", () => {
    for (const details of [undefined, null, "", "abc", "-3", "0"]) {
      const err = parseLoyaltyError({ message: "double_scan", details });
      expect(err.code).toBe("double_scan");
      expect(err.retryAfterSeconds).toBeUndefined();
      expect(err.message).not.toMatch(/\d/);
    }
  });

  it("accepte aussi le champ « detail » (écrit au singulier par Postgres)", () => {
    expect(parseLoyaltyError({ message: "double_scan", detail: "90" }).retryAfterSeconds).toBe(90);
  });

  it("erreur inconnue : message générique, sans détail technique", () => {
    const err = parseLoyaltyError({ message: 'insert or update on table "cards" violates foreign key constraint' });
    expect(err).toMatchObject({ code: "unknown", status: 500 });
    expect(err.message).not.toMatch(/cards|constraint|insert/);
    expect(parseLoyaltyError(null).code).toBe("unknown");
    expect(parseLoyaltyError(undefined).code).toBe("unknown");
  });

  it("ne se laisse pas tromper par un message qui ressemble à un code (ex. « constructor »)", () => {
    for (const message of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(parseLoyaltyError({ message }).code).toBe("unknown");
    }
  });
});
