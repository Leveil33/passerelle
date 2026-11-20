// Dessin des images de la carte : le bandeau de tampons (cases pleines / vides) et l'icône.
// Fabriquées par le serveur à chaque état de la carte, à partir de l'icône choisie par le commerçant.
import sharp from "sharp";
import { toHex, type Rgb } from "@/lib/wallet/colors";
import { DEFAULT_STAMP_ICON, STAMP_ICONS, isStampIconKey } from "./icons";

/** Taille du bandeau d'une carte à tampons Apple, en points (×2 et ×3 pour les écrans Retina). */
export const STRIP_SIZE = { width: 375, height: 123 } as const;
export type Scale = 1 | 2 | 3;

// Marges et taille maximale d'une case, pour un bandeau de 375 points de large : elles sont
// proportionnelles à la largeur de l'image (le grand visuel de Google est 2,75 fois plus large).
const PAD_X = 10;
const PAD_Y = 8;
const MAX_CELL = 64;
const MAX_ROWS = 8;

/** Grand visuel d'une carte Google (rapport 1032 : 812) et logo du programme (carré, 660 px minimum). */
export const HERO_SIZE = { width: 1032, height: 812 } as const;
export const PROGRAM_LOGO_SIZE = 660;

export type StripLayout = { rows: number; cols: number; cell: number };

/** Choisit le nombre de lignes qui donne les plus grandes cases (ex. 10 tampons → 2 lignes de 5). */
export function stripLayout(count: number, width: number = STRIP_SIZE.width, height: number = STRIP_SIZE.height): StripLayout {
  const k = width / STRIP_SIZE.width;
  const areaW = width - 2 * PAD_X * k;
  const areaH = height - 2 * PAD_Y * k;
  let best: StripLayout = { rows: 1, cols: Math.max(1, count), cell: 0 };
  for (let rows = 1; rows <= MAX_ROWS; rows++) {
    const cols = Math.ceil(count / rows);
    const cell = Math.min(areaW / cols, areaH / rows);
    if (cell > best.cell + 1e-9) best = { rows, cols, cell };
  }
  return { ...best, cell: Math.min(best.cell, MAX_CELL * k) };
}

/** Contenu SVG de l'icône : celle de la bibliothèque, ou l'étoile par défaut (nom inconnu, « custom »…). */
function iconMarkup(key: string): string {
  return STAMP_ICONS[isStampIconKey(key) ? key : DEFAULT_STAMP_ICON];
}

/** Une icône (grille 24 × 24) centrée en (cx, cy), à la taille `size`. */
function iconAt(key: string, cx: number, cy: number, size: number, color: string, opacity: number): string {
  const s = (size / 24).toFixed(4);
  return (
    `<g transform="translate(${(cx - size / 2).toFixed(2)} ${(cy - size / 2).toFixed(2)}) scale(${s})" ` +
    `fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `${iconMarkup(key)}</g>`
  );
}

export type StripOptions = {
  stampsRequired: number;
  stamps: number;
  foreground: Rgb;
  icon: string;
};

export function stripSvg(
  opts: StripOptions,
  scale: Scale,
  size: { readonly width: number; readonly height: number } = STRIP_SIZE,
  background?: Rgb,
): string {
  const { width, height } = size;
  const k = width / STRIP_SIZE.width;
  const total = Math.max(1, Math.floor(opts.stampsRequired));
  const filled = Math.min(Math.max(0, Math.floor(opts.stamps)), total);
  const fg = toHex(opts.foreground);
  const { rows, cols, cell } = stripLayout(total, width, height);
  const radius = cell * 0.44;
  const iconSize = cell * 0.5;

  const parts: string[] = [];
  for (let i = 0; i < total; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 || (row + 1) * cols > total ? total - row * cols : cols;
    const col = i - row * cols;
    const cx = width / 2 + (col - (inRow - 1) / 2) * cell;
    const cy = height / 2 + (row - (rows - 1) / 2) * cell;
    if (i < filled) {
      parts.push(
        `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" fill="${fg}" fill-opacity="0.2" stroke="${fg}" stroke-opacity="0.9" stroke-width="${(1.5 * k).toFixed(2)}"/>`,
        iconAt(opts.icon, cx, cy, iconSize, fg, 1),
      );
    } else {
      parts.push(
        `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" fill="none" stroke="${fg}" stroke-opacity="0.4" stroke-width="${(1.2 * k).toFixed(2)}" stroke-dasharray="${(3 * k).toFixed(2)} ${(3 * k).toFixed(2)}"/>`,
        iconAt(opts.icon, cx, cy, iconSize, fg, 0.3),
      );
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">` +
    (background ? `<rect width="${width}" height="${height}" fill="${toHex(background)}"/>` : "") +
    parts.join("") +
    `</svg>`
  );
}

/** Bandeau de tampons en PNG (fond transparent : la couleur de la carte apparaît derrière). */
export function renderStrip(opts: StripOptions, scale: Scale): Promise<Buffer> {
  return sharp(Buffer.from(stripSvg(opts, scale))).png({ compressionLevel: 9 }).toBuffer();
}

export type IconOptions = { background: Rgb; foreground: Rgb; icon: string };

/** Icône de la carte (29 × 29 points) : l'icône du tampon sur la couleur du commerce. */
export function renderPassIcon(opts: IconOptions, scale: Scale): Promise<Buffer> {
  const size = 29;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size * scale}" height="${size * scale}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${toHex(opts.background)}"/>` +
    iconAt(opts.icon, size / 2, size / 2, size * 0.6, toHex(opts.foreground), 1) +
    `</svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

/** Grand visuel d'une carte Google : les tampons sur un fond uni de la couleur du commerce. */
export function renderHero(opts: StripOptions & { background: Rgb }): Promise<Buffer> {
  return sharp(Buffer.from(stripSvg(opts, 1, HERO_SIZE, opts.background)))
    .flatten({ background: toHex(opts.background) }) // aucun pixel transparent
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Logo du programme pour Google (carré 660 × 660, que Google découpe en rond avec 15 % de marge) : l'icône
 * du tampon sur la couleur du commerce, bien à l'intérieur de la zone visible.
 */
export function renderProgramLogo(opts: IconOptions): Promise<Buffer> {
  const size = PROGRAM_LOGO_SIZE;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${toHex(opts.background)}"/>` +
    iconAt(opts.icon, size / 2, size / 2, size * 0.42, toHex(opts.foreground), 1) +
    `</svg>`;
  return sharp(Buffer.from(svg)).flatten({ background: toHex(opts.background) }).png({ compressionLevel: 9 }).toBuffer();
}
