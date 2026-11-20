/* eslint-disable @typescript-eslint/no-explicit-any -- tests : on lit du JSON sans le typer en détail */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppleConfigError, getAppUrl, getAppleConfig, getPassTypeId } from "@/lib/apple/config";
import { buildPkPass, passFields } from "@/lib/apple/pass";
import { verifyQrPayload } from "@/lib/loyalty/qr";
import type { PassData } from "@/lib/wallet/types";
import { appleTestEnv, createTestCerts, type TestCerts } from "./helpers/certs";

const QR_SECRET = "s".repeat(48);
let certs: TestCerts;
let config: ReturnType<typeof getAppleConfig>;

beforeAll(() => {
  certs = createTestCerts();
  config = getAppleConfig(appleTestEnv(certs));
});
afterAll(() => certs.cleanup());

const SERIAL = "0123456789abcdef0123456789abcdef";
function data(over: { stamps?: number; required?: number; locations?: number; proximity?: string; color?: string; rewards?: number } = {}): PassData {
  return {
    card: { id: "card-1", serial_number: SERIAL, auth_token: "t".repeat(64), stamps: over.stamps ?? 3, rewards_earned: over.rewards ?? 1, platform: null, updated_at: "2026-11-20T10:00:00.000000Z" },
    customer: { first_name: "Léa" },
    program: { id: "p", name: "Carte café", stamps_required: over.required ?? 10, reward_label: "1 café offert", proximity_message: over.proximity ?? "Un café vous attend !", is_active: true, stamp_icon: "coffee", stamp_icon_url: null },
    merchant: { id: "m", name: "Café du Port", logo_url: null, brand_color: over.color ?? "#1F2937" },
    locations: Array.from({ length: over.locations ?? 2 }, (_, i) => ({ label: `Boutique ${i + 1}`, address: `${i + 1} rue du Port`, latitude: 48.85 + i / 100, longitude: 2.35 })),
  };
}

async function unpack(over?: Parameters<typeof data>[0]) {
  const buf = await buildPkPass(data(over), { config, qrSecret: QR_SECRET });
  const files = unzipSync(new Uint8Array(buf));
  const text = (name: string) => Buffer.from(files[name]).toString("utf8");
  return { buf, files, pass: JSON.parse(text("pass.json")) as Record<string, any>, text };
}

describe("réglages Apple (variables d'environnement)", () => {
  it("lit les variables et décode les certificats", () => {
    expect(config.passTypeId).toBe("pass.test.fidelite");
    expect(config.webServiceURL).toBe("https://fidelite.test/api/apple");
    expect(config.certs.signerCert.toString()).toContain("BEGIN CERTIFICATE");
    expect(config.certs.signerKey.toString()).toMatch(/BEGIN (RSA )?PRIVATE KEY/);
  });

  it("liste les variables manquantes sans afficher de secret", () => {
    const err = (() => { try { getAppleConfig({}); } catch (e) { return e as Error; } })()!;
    expect(err).toBeInstanceOf(AppleConfigError);
    for (const name of ["APPLE_PASS_TYPE_ID", "APPLE_TEAM_ID", "APPLE_SIGNER_CERT_BASE64", "APPLE_SIGNER_KEY_BASE64", "APPLE_WWDR_CERT_BASE64", "NEXT_PUBLIC_APP_URL"]) {
      expect(err.message).toContain(name);
    }
  });

  it("refuse un certificat qui n'est pas du PEM encodé en base64", () => {
    expect(() => getAppleConfig(appleTestEnv(certs, { APPLE_SIGNER_CERT_BASE64: Buffer.from("bonjour").toString("base64") }))).toThrow(/PEM/);
  });

  it("exige https pour l'adresse du site (sauf localhost en développement)", () => {
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "https://fidelite.exemple.fr/" })).toBe("https://fidelite.exemple.fr");
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
    expect(() => getAppUrl({ NEXT_PUBLIC_APP_URL: "http://fidelite.exemple.fr" })).toThrow(/https/);
    expect(() => getAppUrl({ NEXT_PUBLIC_APP_URL: "n'importe quoi" })).toThrow(AppleConfigError);
    expect(() => getAppUrl({})).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it("le Pass Type ID seul suffit aux adresses qui n'ont pas besoin des certificats", () => {
    expect(getPassTypeId({ APPLE_PASS_TYPE_ID: " pass.x " })).toBe("pass.x");
    expect(() => getPassTypeId({})).toThrow(AppleConfigError);
  });
});

describe("contenu de la carte", () => {
  it("est un storeCard avec l'identité, le service Web et le secret de la carte", async () => {
    const { pass } = await unpack();
    expect(pass).toMatchObject({
      formatVersion: 1,
      passTypeIdentifier: "pass.test.fidelite",
      teamIdentifier: "TEAM123456",
      serialNumber: SERIAL,
      organizationName: "Café du Port",
      logoText: "Café du Port",
      webServiceURL: "https://fidelite.test/api/apple",
      authenticationToken: "t".repeat(64),
      maxDistance: 100,
    });
    expect(pass.storeCard).toBeDefined();
    expect(pass.description).toContain("Carte café");
  });

  it("contient un QR code signé que le serveur sait vérifier", async () => {
    const { pass } = await unpack();
    expect(pass.barcodes).toHaveLength(1);
    expect(pass.barcodes[0]).toMatchObject({ format: "PKBarcodeFormatQR", messageEncoding: "iso-8859-1" });
    expect(verifyQrPayload(pass.barcodes[0].message, QR_SECRET)).toBe(SERIAL);
    expect(verifyQrPayload(pass.barcodes[0].message, "x".repeat(48))).toBeNull();
  });

  it("déclare les adresses avec le message de proximité, 10 au maximum", async () => {
    const { pass } = await unpack({ locations: 2 });
    expect(pass.locations).toEqual([
      { latitude: 48.85, longitude: 2.35, relevantText: "Un café vous attend !" },
      { latitude: 48.86, longitude: 2.35, relevantText: "Un café vous attend !" },
    ]);

    const many = await unpack({ locations: 14 });
    expect(many.pass.locations).toHaveLength(10);
  });

  it("n'écrit aucune adresse si le commerce n'en a pas, et propose un message par défaut sinon", async () => {
    expect((await unpack({ locations: 0 })).pass.locations).toBeUndefined();
    const { pass } = await unpack({ proximity: "   " });
    expect(pass.locations[0].relevantText).toBe("Café du Port est tout près : pense à ta carte !");
  });

  it("reprend la couleur du commerce, avec un texte lisible", async () => {
    const dark = (await unpack({ color: "#1F2937" })).pass;
    expect(dark.backgroundColor).toBe("rgb(31, 41, 55)");
    expect(dark.foregroundColor).toBe("rgb(255, 255, 255)");
    const light = (await unpack({ color: "#FDE68A" })).pass;
    expect(light.backgroundColor).toBe("rgb(253, 230, 138)");
    expect(light.foregroundColor).toBe("rgb(0, 0, 0)");
  });

  it("affiche les tampons, le titulaire et la récompense", async () => {
    const { pass } = await unpack({ stamps: 3, required: 10 });
    const f = pass.storeCard;
    expect(f.headerFields).toEqual([{ key: "stamps", label: "TAMPONS", value: "3 / 10" }]);
    expect(f.secondaryFields.find((x: any) => x.key === "holder").value).toBe("Léa");
    expect(f.auxiliaryFields.find((x: any) => x.key === "reward").value).toBe("1 café offert");
    expect(f.auxiliaryFields.find((x: any) => x.key === "rewards").value).toBe("1");
    expect(f.backFields.find((x: any) => x.key === "shops").value).toContain("1 rue du Port");
  });
});

describe("notifications (changeMessage)", () => {
  const status = (stamps: number, required = 10) => passFields(data({ stamps, required })).secondary[0] as { key: string; value: string; changeMessage: string; label: string };

  it("le même champ « status » porte toujours le message : c'est son changement qui notifie", () => {
    for (const s of [0, 1, 5, 9, 10]) expect(status(s).key).toBe("status");
  });

  it("avant la récompense : « Plus que N tampons avant ta récompense ! »", () => {
    expect(status(3)).toMatchObject({ value: "7", changeMessage: "Plus que %@ tampons avant ta récompense !" });
  });

  it("accorde au singulier quand il ne reste qu'un tampon", () => {
    expect(status(9).changeMessage).toBe("Plus qu'%@ tampon avant ta récompense !");
    expect(status(9).value).toBe("1");
  });

  it("carte pleine : annonce la récompense", () => {
    expect(status(10)).toMatchObject({ value: "1 café offert", label: "RÉCOMPENSE DISPONIBLE", changeMessage: "Récompense disponible : %@ !" });
  });

  it("le texte de la notification est bien formé une fois « %@ » remplacé (jamais de double unité)", () => {
    for (let s = 0; s <= 10; s++) {
      const f = status(s);
      const text = f.changeMessage.replace("%@", f.value);
      expect(text, `état ${s}`).not.toMatch(/tampons? tampons?/);
      expect(text.startsWith("Plus qu") || text.startsWith("Récompense disponible"), text).toBe(true);
    }
  });

  it("un compteur de tampons au-delà du maximum reste cohérent", () => {
    const f = passFields(data({ stamps: 12, required: 10 }));
    expect(f.header[0].value).toBe("10 / 10");
    expect((f.secondary[0] as { label: string }).label).toBe("RÉCOMPENSE DISPONIBLE");
  });
});

describe("paquet .pkpass : intégrité et signature", () => {
  it("contient tous les fichiers attendus, dont les images aux 3 résolutions", async () => {
    const { files } = await unpack();
    for (const name of ["pass.json", "manifest.json", "signature", "icon.png", "icon@2x.png", "icon@3x.png", "strip.png", "strip@2x.png", "strip@3x.png"]) {
      expect(Object.keys(files), name).toContain(name);
    }
  });

  it("les images ont les bonnes tailles", async () => {
    const { files } = await unpack();
    const size = async (n: string) => { const m = await sharp(Buffer.from(files[n])).metadata(); return [m.width, m.height]; };
    expect(await size("icon.png")).toEqual([29, 29]);
    expect(await size("icon@2x.png")).toEqual([58, 58]);
    expect(await size("icon@3x.png")).toEqual([87, 87]);
    expect(await size("strip.png")).toEqual([375, 123]);
    expect(await size("strip@2x.png")).toEqual([750, 246]);
    expect(await size("strip@3x.png")).toEqual([1125, 369]);
  });

  it("le manifeste liste l'empreinte exacte de chaque fichier", async () => {
    const { files, text } = await unpack();
    const manifest = JSON.parse(text("manifest.json")) as Record<string, string>;
    const names = Object.keys(files).filter((n) => !["manifest.json", "signature"].includes(n));
    expect(Object.keys(manifest).sort()).toEqual(names.sort());
    for (const n of names) {
      expect(manifest[n], n).toBe(createHash("sha1").update(files[n]).digest("hex"));
    }
  });

  it("la signature est valide pour ce manifeste (vérifiée par openssl) et casse si on le modifie", async () => {
    const { files, text } = await unpack();
    const dir = mkdtempSync(path.join(tmpdir(), "pkpass-verify-"));
    try {
      writeFileSync(path.join(dir, "signature"), files["signature"]);
      writeFileSync(path.join(dir, "manifest.json"), text("manifest.json"));
      const verify = (manifestFile: string) =>
        execFileSync("openssl", ["smime", "-verify", "-inform", "DER", "-in", "signature", "-content", manifestFile, "-noverify", "-out", "/dev/null"], { cwd: dir, stdio: "pipe" });
      expect(() => verify("manifest.json")).not.toThrow();

      writeFileSync(path.join(dir, "manifest-modifie.json"), text("manifest.json").replace("pass.json", "pass.jsoN"));
      expect(() => verify("manifest-modifie.json")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("la carte change quand les tampons changent (images et champs)", async () => {
    const a = await unpack({ stamps: 3 });
    const b = await unpack({ stamps: 4 });
    expect(Buffer.from(a.files["strip.png"]).equals(Buffer.from(b.files["strip.png"]))).toBe(false);
    expect(a.pass.storeCard.headerFields[0].value).toBe("3 / 10");
    expect(b.pass.storeCard.headerFields[0].value).toBe("4 / 10");
  });
});
