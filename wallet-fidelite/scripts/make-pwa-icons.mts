// Fabrique les icônes de l'appli commerçant (public/icons/*.png). À relancer seulement pour changer le dessin :
//   npx tsx scripts/make-pwa-icons.mts
import sharp from "sharp";
import { STAMP_ICONS } from "../src/lib/stamps/icons";

const BACKGROUND = "#111827";
const FOREGROUND = "#FFFFFF";

/** `iconRatio` : part de la largeur occupée par l'icône (les icônes « maskable » gardent une grande marge). */
async function make(file: string, size: number, iconRatio: number) {
  const icon = size * iconRatio;
  const offset = (size - icon) / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${BACKGROUND}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${icon / 24})" fill="none" stroke="${FOREGROUND}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${STAMP_ICONS.star}</g>` +
    `</svg>`;
  await sharp(Buffer.from(svg)).flatten({ background: BACKGROUND }).png({ compressionLevel: 9 }).toFile(`public/icons/${file}`);
}

await make("icon-192.png", 192, 0.6);
await make("icon-512.png", 512, 0.6);
await make("icon-maskable-512.png", 512, 0.42);
await make("apple-touch-icon.png", 180, 0.6);
console.log("Icônes fabriquées dans public/icons/");
