import { describe, expect, it } from "vitest";
import { cardColors, contrastRatio, parseHexColor, toHex } from "./colors";
import { isNotModified, lastModifiedFor } from "./http-dates";
import { normalizeTimestamp, parseTag } from "./timestamps";
import { parsePassData } from "./types";

describe("repères de mise à jour", () => {
  it("normalise les horodatages de Postgres (microsecondes, fuseau UTC)", () => {
    expect(normalizeTimestamp("2026-11-20T00:56:09.488123+00:00")).toBe("2026-11-20T00:56:09.488123Z");
    expect(normalizeTimestamp("2026-11-20T00:56:09.4881+00:00")).toBe("2026-11-20T00:56:09.488100Z");
    expect(normalizeTimestamp("2026-11-20T00:56:09+00:00")).toBe("2026-11-20T00:56:09.000000Z");
    expect(normalizeTimestamp("2026-11-20 00:56:09.5+00")).toBe("2026-11-20T00:56:09.500000Z");
    expect(normalizeTimestamp("2026-11-20T00:56:09.488123Z")).toBe("2026-11-20T00:56:09.488123Z");
    expect(normalizeTimestamp("n'importe quoi")).toBeNull();
  });

  it("convertit un autre fuseau sans se tromper d'heure", () => {
    expect(normalizeTimestamp("2026-11-20T02:00:00.000+02:00")).toBe("2026-11-20T00:00:00.000000Z");
  });

  it("n'accepte comme repère que notre format exact", () => {
    expect(parseTag("2026-11-20T00:56:09.488123Z")).toBe("2026-11-20T00:56:09.488123Z");
    for (const bad of [null, undefined, "", "0", "1351981923", "2026-11-20", "2026-11-20T00:56:09Z", "'; drop table cards;--"]) {
      expect(parseTag(bad), String(bad)).toBeNull();
    }
  });
});

describe("Last-Modified / If-Modified-Since", () => {
  const updated = "2026-11-20T12:00:00.400000Z";

  it("n'annonce rien tant que la seconde du changement n'est pas écoulée", () => {
    expect(lastModifiedFor(updated, new Date("2026-11-20T12:00:00.900Z"))).toBeNull();
  });

  it("annonce la seconde suivante une fois écoulée", () => {
    expect(lastModifiedFor(updated, new Date("2026-11-20T12:00:01.000Z"))?.toISOString()).toBe("2026-11-20T12:00:01.000Z");
    expect(lastModifiedFor(updated, new Date("2026-11-20T18:00:00Z"))?.toISOString()).toBe("2026-11-20T12:00:01.000Z");
  });

  it("« rien de neuf » seulement si l'iPhone a déjà la dernière version", () => {
    const header = new Date("2026-11-20T12:00:01Z").toUTCString();
    expect(isNotModified(header, updated)).toBe(true);
    expect(isNotModified(header, "2026-11-20T12:00:01.500000Z")).toBe(false); // changé après la date de l'iPhone
    expect(isNotModified(new Date("2026-11-20T12:00:00.400Z").toUTCString(), updated)).toBe(false); // date égale : on renvoie la carte, par prudence
    expect(isNotModified(null, updated)).toBe(false);
    expect(isNotModified("pas une date", updated)).toBe(false);
  });

  it("scénario du piège : deux changements dans la même seconde ne sont jamais ratés", () => {
    const first = "2026-11-20T12:00:00.100000Z";
    const second = "2026-11-20T12:00:00.800000Z"; // même seconde
    // L'iPhone récupère la carte à 12:00:00.500 (entre les deux) : on n'envoie PAS de Last-Modified.
    expect(lastModifiedFor(first, new Date("2026-11-20T12:00:00.500Z"))).toBeNull();
    // Il récupère à 12:00:05 : Last-Modified = 12:00:01. Un changement ultérieur sera forcément après.
    const lm = lastModifiedFor(second, new Date("2026-11-20T12:00:05Z"))!;
    expect(isNotModified(lm.toUTCString(), second)).toBe(true);
    expect(isNotModified(lm.toUTCString(), "2026-11-20T12:00:06.000000Z")).toBe(false);
  });
});

describe("couleurs de la carte", () => {
  it("lit les couleurs hexadécimales, refuse le reste", () => {
    expect(parseHexColor("#E11D48")).toEqual([225, 29, 72]);
    for (const bad of ["E11D48", "#FFF", "rouge", "", "#GGGGGG"]) expect(parseHexColor(bad), bad).toBeNull();
  });

  it("texte blanc sur fond foncé, texte sombre sur fond clair", () => {
    expect(toHex(cardColors("#1F2937").foreground)).toBe("#ffffff");
    expect(toHex(cardColors("#FDE68A").foreground)).toBe("#000000");
    expect(toHex(cardColors("#FFFFFF").foreground)).toBe("#000000");
    expect(toHex(cardColors("#000000").foreground)).toBe("#ffffff");
  });

  it("le texte est lisible (contraste ≥ 4,5) sur une grille de couleurs, étiquettes comprises", () => {
    for (let r = 0; r <= 255; r += 51)
      for (let g = 0; g <= 255; g += 51)
        for (let b = 0; b <= 255; b += 51) {
          const c = cardColors(toHex([r, g, b]));
          expect(contrastRatio(c.background, c.foreground), `#${r},${g},${b}`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(c.background, c.label), `étiquette #${r},${g},${b}`).toBeGreaterThanOrEqual(4.5);
        }
  });

  it("une couleur invalide retombe sur le gris foncé par défaut", () => {
    expect(toHex(cardColors("pas-une-couleur").background)).toBe("#1f2937");
  });
});

describe("lecture des données d'une carte", () => {
  const valid = {
    card: { id: "c", serial_number: "s", auth_token: "t", stamps: 3, rewards_earned: 1, platform: null, updated_at: "2026-11-20T00:00:00.000000Z" },
    customer: { first_name: "Léa" },
    program: { id: "p", name: "Carte", stamps_required: 10, reward_label: "1 café", proximity_message: "", is_active: true, stamp_icon: "star", stamp_icon_url: null },
    merchant: { id: "m", name: "Café", logo_url: null, brand_color: "#1F2937" },
    locations: [{ label: "A", address: "", latitude: 48.85, longitude: 2.35 }],
  };

  it("accepte des données valides", () => {
    expect(parsePassData(valid).card.stamps).toBe(3);
  });

  it("refuse des données absentes ou mal formées, en disant lequel", () => {
    expect(() => parsePassData(null)).toThrow(/racine/);
    expect(() => parsePassData({ ...valid, card: { ...valid.card, stamps: "3" } })).toThrow(/card\.stamps/);
    expect(() => parsePassData({ ...valid, locations: "x" })).toThrow(/locations/);
    expect(() => parsePassData({ ...valid, locations: [{ label: "A", latitude: "48", longitude: 2 }] })).toThrow(/latitude/);
  });
});
