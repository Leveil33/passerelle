import http from "node:http";
import type { AddressInfo } from "node:net";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAppleConfig } from "@/lib/apple/config";
import { buildPkPass } from "@/lib/apple/pass";
import { ASSET_PATH_PREFIX, createAssetLoader } from "@/lib/wallet/remote-image";
import { MAX_UPLOAD_BYTES, assetPath, normalizeImage, ImageError } from "@/lib/admin/images";
import { renderHero, renderStrip } from "@/lib/stamps/render";
import type { PassData } from "@/lib/wallet/types";
import { appleTestEnv, createTestCerts, type TestCerts } from "./helpers/certs";

const png = (w: number, h: number, color = { r: 200, g: 30, b: 60, alpha: 1 }) => sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer();
const WHITE = [255, 255, 255] as const;

describe("contrôle des images envoyées par le commerçant", () => {
  it("transforme une image valide en PNG carré propre (logo 660 px, tampon 256 px), fond transparent", async () => {
    for (const [kind, size] of [["logo", 660], ["stamp", 256]] as const) {
      const out = await normalizeImage(await png(300, 150), kind);
      const meta = await sharp(out).metadata();
      expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(["png", size, size, true]);
      const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
      expect(data[3]).toBe(0); // coin transparent (l'image est contenue, pas déformée)
    }
  });

  it("accepte JPEG et WebP", async () => {
    const jpeg = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    const webp = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#336699" } }).webp().toBuffer();
    for (const input of [jpeg, webp]) expect((await sharp(await normalizeImage(input, "logo")).metadata()).format).toBe("png");
  });

  it("supprime les métadonnées (position GPS, appareil…) du fichier d'origine", async () => {
    const withExif = await sharp(await png(200, 200)).jpeg().withExif({ IFD0: { Copyright: "SECRET-COPYRIGHT-123", Software: "Appareil-Privé" } }).toBuffer();
    expect(withExif.includes(Buffer.from("SECRET-COPYRIGHT-123"))).toBe(true);
    const out = await normalizeImage(withExif, "logo");
    expect(out.includes(Buffer.from("SECRET-COPYRIGHT-123"))).toBe(false);
    expect((await sharp(out).metadata()).exif).toBeUndefined();
  });

  it("refuse ce qui n'est pas une image acceptable, avec un message clair", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><script>alert(1)</script><rect width="200" height="200"/></svg>');
    const cases: [string, Buffer, string][] = [
      ["du texte", Buffer.from("ceci n'est pas une image du tout, vraiment pas"), "not_an_image"],
      ["un fichier vide", Buffer.alloc(0), "not_an_image"],
      ["un SVG (peut contenir du code)", svg, "unsupported"],
      ["un GIF", await sharp(await png(100, 100)).gif().toBuffer(), "unsupported"],
      ["une image trop petite", await png(32, 32), "too_small"],
      ["un fichier trop lourd", Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1), "too_large"],
      ["un PNG tronqué", (await png(200, 200)).subarray(0, 60), "not_an_image"],
    ];
    for (const [name, input, code] of cases) {
      const err = await normalizeImage(input, "logo").catch((e) => e);
      expect(err, name).toBeInstanceOf(ImageError);
      expect(err.code, name).toBe(code);
    }
  });

  it("refuse une image « bombe » (petit fichier, 36 millions de pixels)", async () => {
    const bomb = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: "#fff" }, limitInputPixels: false }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(MAX_UPLOAD_BYTES);
    const err = await normalizeImage(bomb, "stamp").catch((e) => e);
    expect(err).toBeInstanceOf(ImageError);
    expect(err.code).toBe("too_big_pixels");
  });

  it("le chemin de rangement dépend du contenu (nouvelle image = nouvelle adresse)", async () => {
    const a = await normalizeImage(await png(200, 200), "logo");
    const b = await normalizeImage(await png(200, 200, { r: 0, g: 0, b: 255, alpha: 1 }), "logo");
    expect(assetPath("logo", "m1", a)).toMatch(/^m1\/logo-[0-9a-f]{12}\.png$/);
    expect(assetPath("logo", "m1", a)).toBe(assetPath("logo", "m1", a));
    expect(assetPath("logo", "m1", a)).not.toBe(assetPath("logo", "m1", b));
  });
});

describe("téléchargement sécurisé des images", () => {
  let server: http.Server;
  let origin: string;
  let image: Buffer;
  const hits: string[] = [];
  beforeAll(async () => {
    image = await normalizeImage(await png(200, 200), "stamp");
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url?.endsWith("/redirige.png")) { res.writeHead(302, { location: "http://127.0.0.1:1/interne" }); return res.end(); }
      if (req.url?.endsWith("/gros.png")) { res.writeHead(200, { "content-length": String(10_000_000) }); return res.end(Buffer.alloc(10)); }
      if (req.url?.endsWith("/texte.png")) { res.writeHead(200); return res.end("pas un png du tout, juste du texte long"); }
      if (req.url?.endsWith("/absent.png")) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "image/png" });
      res.end(image);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const problems: string[] = [];
  const loader = (over = {}) => createAssetLoader({ allowedOrigin: origin, onProblem: (m) => problems.push(m), ...over });
  const url = (name: string) => `${origin}${ASSET_PATH_PREFIX}m1/${name}`;

  it("télécharge une image de notre dossier, la garde en mémoire (une seule requête)", async () => {
    hits.length = 0;
    const load = loader();
    const a = await load(url("logo-abc.png"));
    const b = await load(url("logo-abc.png"));
    expect(a?.equals(image)).toBe(true);
    expect(b).toBe(a);
    expect(hits).toHaveLength(1);
  });

  it("refuse tout ce qui sort de notre dossier, SANS faire de requête", async () => {
    hits.length = 0;
    const load = loader();
    for (const bad of [
      "http://127.0.0.1:1/x.png", "https://exemple.fr/x.png", `${origin}/autre/chemin.png`, `${origin}/storage/v1/object/public/autre-dossier/x.png`,
      `${origin}${ASSET_PATH_PREFIX}../../secret`, `http://user:mdp@${origin.slice(7)}${ASSET_PATH_PREFIX}x.png`, "pas une adresse", "", null, undefined,
      "file:///etc/passwd", "http://169.254.169.254/latest/meta-data/",
    ]) {
      expect(await load(bad as string), String(bad)).toBeNull();
    }
    expect(hits).toEqual([]);
  });

  it("ne suit jamais une redirection, refuse les fichiers énormes, non-PNG ou absents", async () => {
    for (const name of ["redirige.png", "gros.png", "texte.png", "absent.png"]) {
      expect(await loader()(url(name)), name).toBeNull();
    }
    expect(hits.some((h) => h.includes("interne"))).toBe(false);
  });

  it("un serveur muet n'attend pas indéfiniment", async () => {
    const hang = http.createServer(() => {});
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const o = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
    const started = Date.now();
    expect(await createAssetLoader({ allowedOrigin: o, timeoutMs: 300 })(`${o}${ASSET_PATH_PREFIX}x.png`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
    hang.closeAllConnections();
    await new Promise<void>((r) => hang.close(() => r()));
  });
});

describe("image importée dans les cartes", () => {
  let custom: Buffer;
  beforeAll(async () => { custom = await normalizeImage(await png(200, 200, { r: 255, g: 0, b: 0, alpha: 1 }), "stamp"); });

  it("le bandeau et le visuel utilisent l'image importée à la place de l'icône (rouge visible)", async () => {
    const withIcon = await renderStrip({ stampsRequired: 4, stamps: 4, foreground: WHITE, icon: "star" }, 1);
    const withCustom = await renderStrip({ stampsRequired: 4, stamps: 4, foreground: WHITE, icon: "star", customIcon: custom }, 1);
    expect(withIcon.equals(withCustom)).toBe(false);
    const { data, info } = await sharp(withCustom).raw().toBuffer({ resolveWithObject: true });
    let reddish = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60 && data[i + 3] > 200) reddish++;
    expect(reddish).toBeGreaterThan(500);

    const hero = await renderHero({ stampsRequired: 10, stamps: 3, foreground: WHITE, background: [17, 24, 39], icon: "star", customIcon: custom });
    expect((await sharp(hero).metadata()).width).toBe(1032);
  });

  it("les cases vides montrent l'image estompée, les pleines l'image nette", async () => {
    const full = await renderStrip({ stampsRequired: 2, stamps: 2, foreground: WHITE, icon: "star", customIcon: custom }, 1);
    const empty = await renderStrip({ stampsRequired: 2, stamps: 0, foreground: WHITE, icon: "star", customIcon: custom }, 1);
    expect(full.equals(empty)).toBe(false);
  });

  it("la carte Apple reçoit le logo aux 3 tailles (sans texte du nom) ; sans logo, le nom reste en texte", async () => {
    const certs: TestCerts = createTestCerts();
    try {
      const config = getAppleConfig(appleTestEnv(certs));
      const data: PassData = {
        card: { id: "c", serial_number: "0123456789abcdef0123456789abcdef", auth_token: "t".repeat(64), stamps: 1, rewards_earned: 0, platform: null, updated_at: "2026-11-20T00:00:00.000000Z" },
        customer: { first_name: "Léa" },
        program: { id: "p", name: "Carte", stamps_required: 5, reward_label: "R", proximity_message: "", is_active: true, stamp_icon: "custom", stamp_icon_url: "https://x/y.png" },
        merchant: { id: "m", name: "Café du Port", logo_url: "https://x/logo.png", brand_color: "#1F2937" },
        locations: [],
      };
      const wide = await normalizeImage(await png(400, 100), "logo");
      const withLogo = unzipSync(new Uint8Array(await buildPkPass(data, { config, qrSecret: "s".repeat(48), assets: { logo: wide, stamp: custom } })));
      const pass = JSON.parse(Buffer.from(withLogo["pass.json"]).toString());
      expect(pass.logoText).toBeUndefined();
      for (const [name, h] of [["logo.png", 50], ["logo@2x.png", 100], ["logo@3x.png", 150]] as const) {
        const meta = await sharp(Buffer.from(withLogo[name])).metadata();
        expect(meta.height, name).toBeLessThanOrEqual(h);
        expect(meta.width, name).toBeLessThanOrEqual((h / 50) * 160);
      }
      const without = unzipSync(new Uint8Array(await buildPkPass({ ...data, program: { ...data.program, stamp_icon: "star" } }, { config, qrSecret: "s".repeat(48) })));
      expect(JSON.parse(Buffer.from(without["pass.json"]).toString()).logoText).toBe("Café du Port");
      expect(Object.keys(without)).not.toContain("logo.png");
    } finally {
      certs.cleanup();
    }
  });
});
