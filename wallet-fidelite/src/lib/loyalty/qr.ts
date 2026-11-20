// Signature des QR codes (anti-fraude).
//
// Le QR code d'une carte contient : WL1.<numéro de série>.<signature>
// La signature (HMAC-SHA256 avec une clé secrète que seul le serveur connaît) prouve que le QR
// a été fabriqué par nous : impossible d'inventer un QR ou de modifier le numéro de série
// sans connaître la clé. Le serveur refuse tout QR non signé ou modifié.
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "WL1";
const SIGNATURE_BYTES = 16; // 128 bits : solide, et QR code plus petit donc plus facile à scanner
const SERIAL_PATTERN = /^[0-9a-f]{32}$/;
const MIN_SECRET_LENGTH = 32;

function assertSecret(secret: string | undefined): asserts secret is string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `QR_HMAC_SECRET manquante ou trop courte (minimum ${MIN_SECRET_LENGTH} caractères). Voir .env.example.`,
    );
  }
}

function signature(serial: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${PREFIX}.${serial}`).digest().subarray(0, SIGNATURE_BYTES);
}

/** Lit la clé secrète depuis l'environnement (erreur claire si elle manque). */
export function getQrSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.QR_HMAC_SECRET;
  assertSecret(secret);
  return secret;
}

/** Texte à encoder dans le QR code de la carte. */
export function signQrPayload(serial: string, secret: string): string {
  assertSecret(secret);
  if (!SERIAL_PATTERN.test(serial)) {
    throw new Error("Numéro de série invalide (32 caractères hexadécimaux attendus).");
  }
  return `${PREFIX}.${serial}.${signature(serial, secret).toString("base64url")}`;
}

/**
 * Vérifie un QR lu par la caméra. Renvoie le numéro de série s'il est authentique,
 * sinon null (format inconnu, signature fausse, numéro modifié, clé différente…).
 */
export function verifyQrPayload(payload: string, secret: string): string | null {
  assertSecret(secret);
  if (typeof payload !== "string") return null;

  const parts = payload.trim().split(".");
  if (parts.length !== 3) return null;
  const [prefix, serial, received] = parts;
  if (prefix !== PREFIX || !SERIAL_PATTERN.test(serial)) return null;

  const receivedBytes = Buffer.from(received, "base64url");
  const expected = signature(serial, secret);
  // Comparaison en temps constant (évite de deviner la signature octet par octet).
  if (receivedBytes.length !== expected.length) return null;
  // base64url tolère des variantes d'écriture : on exige la forme exacte que nous produisons.
  if (receivedBytes.toString("base64url") !== received) return null;
  return timingSafeEqual(receivedBytes, expected) ? serial : null;
}
