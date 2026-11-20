// Couleurs de la carte : le commerçant choisit UNE couleur (fond) ; la couleur du texte est
// calculée pour rester lisible, quelle que soit la couleur choisie.

export type Rgb = readonly [number, number, number];

export const FALLBACK_BRAND_COLOR = "#1F2937";

export function parseHexColor(hex: string): Rgb | null {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

export const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
export const toRgbCss = ([r, g, b]: Rgb) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

/** Luminance relative (WCAG 2). */
export function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Rgb = [255, 255, 255];
// Noir pur : avec un gris foncé, certaines couleurs moyennes (ex. #6666FF) tombent sous un contraste de 4,5.
const BLACK: Rgb = [0, 0, 0];

export type CardColors = { background: Rgb; foreground: Rgb; label: Rgb };

/** Fond = couleur du commerce (ou gris foncé si invalide) ; texte = blanc ou noir, le plus lisible. */
export function cardColors(brandColor: string): CardColors {
  const background = parseHexColor(brandColor) ?? (parseHexColor(FALLBACK_BRAND_COLOR) as Rgb);
  const foreground = contrastRatio(background, WHITE) >= contrastRatio(background, BLACK) ? WHITE : BLACK;
  // Étiquettes : le texte légèrement estompé vers le fond, mais seulement tant qu'il reste lisible
  // (contraste ≥ 4,5) ; sinon, le texte plein.
  let label: Rgb = foreground;
  for (const keep of [0.7, 0.8, 0.9]) {
    const mixed = foreground.map((c, i) => c * keep + background[i] * (1 - keep)) as unknown as Rgb;
    if (contrastRatio(background, mixed) >= 4.5) {
      label = mixed;
      break;
    }
  }
  return { background, foreground, label };
}
