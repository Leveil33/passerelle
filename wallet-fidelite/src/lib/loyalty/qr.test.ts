import { describe, expect, it } from "vitest";
import { getQrSecret, signQrPayload, verifyQrPayload } from "./qr";

const SECRET = "a".repeat(40);
const OTHER_SECRET = "b".repeat(40);
const SERIAL = "0123456789abcdef0123456789abcdef";
const OTHER_SERIAL = "fedcba9876543210fedcba9876543210";

describe("QR code signé", () => {
  it("un QR fabriqué par nous est reconnu et rend le numéro de série", () => {
    const payload = signQrPayload(SERIAL, SECRET);
    expect(payload).toMatch(/^WL1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{22}$/);
    expect(verifyQrPayload(payload, SECRET)).toBe(SERIAL);
  });

  it("est stable : même carte, même QR", () => {
    expect(signQrPayload(SERIAL, SECRET)).toBe(signQrPayload(SERIAL, SECRET));
  });

  it("deux cartes ont deux signatures différentes", () => {
    expect(signQrPayload(SERIAL, SECRET)).not.toBe(signQrPayload(OTHER_SERIAL, SECRET));
  });

  it("tolère les espaces / retours à la ligne ajoutés par un lecteur de QR", () => {
    expect(verifyQrPayload(`  ${signQrPayload(SERIAL, SECRET)}\n`, SECRET)).toBe(SERIAL);
  });

  it("refuse un numéro de série modifié (signature d'une autre carte)", () => {
    const [prefix, , sig] = signQrPayload(SERIAL, SECRET).split(".");
    expect(verifyQrPayload(`${prefix}.${OTHER_SERIAL}.${sig}`, SECRET)).toBeNull();
  });

  it("refuse une signature modifiée, d'un seul caractère", () => {
    const payload = signQrPayload(SERIAL, SECRET);
    const last = payload.at(-1)!;
    const tampered = payload.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(verifyQrPayload(tampered, SECRET)).toBeNull();
  });

  it("refuse un QR signé avec une autre clé", () => {
    expect(verifyQrPayload(signQrPayload(SERIAL, OTHER_SECRET), SECRET)).toBeNull();
  });

  it("refuse un QR non signé (juste le numéro de série) ou mal formé", () => {
    for (const bad of [
      SERIAL,
      "",
      "   ",
      `WL1.${SERIAL}`,
      `WL1.${SERIAL}.`,
      `WL1..${signQrPayload(SERIAL, SECRET).split(".")[2]}`,
      `WL2.${SERIAL}.${signQrPayload(SERIAL, SECRET).split(".")[2]}`,
      `${signQrPayload(SERIAL, SECRET)}.extra`,
      "https://exemple.fr/?q=WL1",
      "WL1.SERIAL-PAS-HEX.AAAAAAAAAAAAAAAAAAAAAA",
      "'; drop table cards; --",
    ]) {
      expect(verifyQrPayload(bad, SECRET), JSON.stringify(bad)).toBeNull();
    }
  });

  it("refuse une signature écrite autrement (variante base64 qui décoderait pareil)", () => {
    const [prefix, serial, sig] = signQrPayload(SERIAL, SECRET).split(".");
    expect(verifyQrPayload(`${prefix}.${serial}.${sig}==`, SECRET)).toBeNull();
    expect(verifyQrPayload(`${prefix}.${serial}.${sig}A`, SECRET)).toBeNull();
  });

  it("refuse de fonctionner avec une clé absente ou trop courte", () => {
    expect(() => signQrPayload(SERIAL, "")).toThrow(/QR_HMAC_SECRET/);
    expect(() => signQrPayload(SERIAL, "trop-court")).toThrow(/QR_HMAC_SECRET/);
    expect(() => verifyQrPayload("x", "trop-court")).toThrow(/QR_HMAC_SECRET/);
  });

  it("refuse de signer un numéro de série invalide", () => {
    expect(() => signQrPayload("pas-un-serial", SECRET)).toThrow(/Numéro de série invalide/);
    expect(() => signQrPayload(SERIAL.toUpperCase(), SECRET)).toThrow(/Numéro de série invalide/);
  });

  it("getQrSecret lit QR_HMAC_SECRET et signale clairement son absence", () => {
    expect(getQrSecret({ QR_HMAC_SECRET: SECRET })).toBe(SECRET);
    expect(() => getQrSecret({})).toThrow(/QR_HMAC_SECRET/);
    expect(() => getQrSecret({ QR_HMAC_SECRET: "court" })).toThrow(/QR_HMAC_SECRET/);
  });
});
