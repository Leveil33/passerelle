// Images envoyées par le commerçant (logo, tampon) : le serveur les contrôle, puis les REFABRIQUE.
// Le fichier d'origine n'est jamais conservé : seul un PNG propre, produit par nous, est rangé.
import { createHash } from "node:crypto";
import sharp, { type Metadata } from "sharp";

export type ImageKind = "logo" | "stamp";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_PIXELS = 25_000_000; // protège contre les images « bombes » (petit fichier, énorme image)
const MIN_SIDE = 64;
const ALLOWED_FORMATS = new Set(["png", "jpeg", "webp"]);

/** Taille finale : le logo (Google le découpe en rond à partir de 660 px) et le tampon (dessiné petit, 256 px suffisent). */
const OUTPUT_SIZE: Record<ImageKind, number> = { logo: 660, stamp: 256 };

export class ImageError extends Error {
  constructor(message: string, readonly code: "too_large" | "not_an_image" | "unsupported" | "too_small" | "too_big_pixels") {
    super(message);
  }
}

/** Vérifie le fichier envoyé et renvoie un PNG carré, sans métadonnées, au fond transparent. */
export async function normalizeImage(input: Buffer, kind: ImageKind): Promise<Buffer> {
  if (input.length > MAX_UPLOAD_BYTES) throw new ImageError("Image trop lourde (2 Mo au maximum).", "too_large");
  if (input.length < 16) throw new ImageError("Ce fichier n'est pas une image.", "not_an_image");

  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (e) {
    const msg = String((e as Error).message);
    if (/pixel limit/i.test(msg)) throw new ImageError("Image trop grande en nombre de pixels.", "too_big_pixels");
    throw new ImageError("Ce fichier n'est pas une image reconnue.", "not_an_image");
  }
  if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) {
    throw new ImageError("Format non accepté : envoyez une image PNG, JPEG ou WebP.", "unsupported");
  }
  if ((meta.width ?? 0) < MIN_SIDE || (meta.height ?? 0) < MIN_SIDE) {
    throw new ImageError(`Image trop petite (au moins ${MIN_SIDE} px de côté).`, "too_small");
  }
  if ((meta.pages ?? 1) > 1) throw new ImageError("Les images animées ne sont pas acceptées.", "unsupported");

  const size = OUTPUT_SIZE[kind];
  try {
    return await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate() // respecte l'orientation de la photo, puis les métadonnées (position GPS comprise) sont supprimées
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    throw new ImageError("Ce fichier n'est pas une image reconnue.", "not_an_image");
  }
}

/** Chemin de rangement : le contenu fait partie du nom, donc une nouvelle image a une nouvelle adresse (cache vidé). */
export function assetPath(kind: ImageKind, ownerId: string, png: Buffer): string {
  return `${ownerId}/${kind}-${createHash("sha1").update(png).digest("hex").slice(0, 12)}.png`;
}
