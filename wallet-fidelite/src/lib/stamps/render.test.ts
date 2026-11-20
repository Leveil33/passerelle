import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { STAMP_ICON_KEYS, STAMP_ICONS, isStampIconKey } from "./icons";
import { STRIP_SIZE, renderPassIcon, renderStrip, stripLayout } from "./render";

const WHITE = [255, 255, 255] as const;
const NAVY = [31, 41, 55] as const;

describe("bibliothèque d'icônes", () => {
  it("propose 16 icônes, toutes avec un dessin SVG", () => {
    expect(STAMP_ICON_KEYS).toHaveLength(16);
    for (const key of STAMP_ICON_KEYS) {
      expect(STAMP_ICONS[key], key).toMatch(/^<(path|circle|rect|line|polyline|ellipse|polygon)/);
      expect(key).toMatch(/^[a-z0-9-]{1,40}$/); // même règle que la base de données
    }
  });

  it("reconnaît uniquement les vrais noms (pas « constructor », pas « custom »)", () => {
    expect(isStampIconKey("coffee")).toBe(true);
    for (const bad of ["custom", "constructor", "__proto__", "toString", "", "COFFEE", 42, null, undefined]) {
      expect(isStampIconKey(bad), String(bad)).toBe(false);
    }
  });
});

describe("disposition des tampons sur le bandeau", () => {
  it("10 tampons : 2 lignes de 5", () => {
    expect(stripLayout(10)).toMatchObject({ rows: 2, cols: 5 });
  });

  it("5 tampons : une seule ligne, cases de taille plafonnée", () => {
    const l = stripLayout(5);
    expect(l).toMatchObject({ rows: 1, cols: 5 });
    expect(l.cell).toBeLessThanOrEqual(64);
  });

  it("rien ne déborde du bandeau, de 1 à 50 tampons", () => {
    for (let n = 1; n <= 50; n++) {
      const { rows, cols, cell } = stripLayout(n);
      expect(cols * cell, `largeur pour ${n}`).toBeLessThanOrEqual(STRIP_SIZE.width - 20 + 1e-6);
      expect(rows * cell, `hauteur pour ${n}`).toBeLessThanOrEqual(STRIP_SIZE.height - 16 + 1e-6);
      expect(rows * cols).toBeGreaterThanOrEqual(n);
      expect(cell).toBeGreaterThan(8); // lisible, même à 50 cases
    }
  });
});

describe("images fabriquées", () => {
  it("le bandeau a la bonne taille aux 3 résolutions, avec un fond transparent", async () => {
    for (const scale of [1, 2, 3] as const) {
      const png = await renderStrip({ stampsRequired: 10, stamps: 3, foreground: WHITE, icon: "coffee" }, scale);
      const meta = await sharp(png).metadata();
      expect(meta).toMatchObject({ format: "png", width: 375 * scale, height: 123 * scale, hasAlpha: true });
      const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      expect(data[3], "coin haut-gauche transparent").toBe(0);
    }
  });

  it("deux états différents donnent deux images différentes (0 tampon, 3 tampons, carte pleine)", async () => {
    const make = (stamps: number) => renderStrip({ stampsRequired: 10, stamps, foreground: WHITE, icon: "heart" }, 2);
    const [a, b, c] = await Promise.all([make(0), make(3), make(10)]);
    expect(a.equals(b)).toBe(false);
    expect(b.equals(c)).toBe(false);
    expect(a.equals(c)).toBe(false);
  });

  it("le même état donne exactement la même image (stable)", async () => {
    const make = () => renderStrip({ stampsRequired: 8, stamps: 5, foreground: WHITE, icon: "star" }, 1);
    expect((await make()).equals(await make())).toBe(true);
  });

  it("des valeurs absurdes ne cassent rien (tampons négatifs, en trop, icône inconnue)", async () => {
    for (const opts of [
      { stampsRequired: 10, stamps: -5, icon: "star" },
      { stampsRequired: 10, stamps: 99, icon: "star" },
      { stampsRequired: 10, stamps: 3, icon: "custom" },
      { stampsRequired: 10, stamps: 3, icon: "<script>alert(1)</script>" },
      { stampsRequired: 1, stamps: 0, icon: "star" },
      { stampsRequired: 50, stamps: 49, icon: "gift" },
    ]) {
      const png = await renderStrip({ ...opts, foreground: WHITE }, 1);
      expect((await sharp(png).metadata()).width, JSON.stringify(opts)).toBe(375);
    }
  });

  it("chacune des 16 icônes se dessine", async () => {
    for (const icon of STAMP_ICON_KEYS) {
      const png = await renderStrip({ stampsRequired: 4, stamps: 2, foreground: WHITE, icon }, 1);
      const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      expect(data.some((v, i) => i % 4 === 3 && v > 0), icon).toBe(true); // au moins un pixel visible
    }
  });

  it("l'icône de la carte fait 29, 58 et 87 pixels, sur la couleur du commerce", async () => {
    for (const [scale, px] of [[1, 29], [2, 58], [3, 87]] as const) {
      const png = await renderPassIcon({ background: NAVY, foreground: WHITE, icon: "coffee" }, scale);
      const meta = await sharp(png).metadata();
      expect([meta.width, meta.height]).toEqual([px, px]);
      const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      expect([data[0], data[1], data[2]]).toEqual([...NAVY]); // coin = couleur de fond
    }
  });
});
