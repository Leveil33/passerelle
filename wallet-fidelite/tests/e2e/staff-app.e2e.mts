// Test de l'appli commerçant dans un VRAI navigateur (Chromium), avec une fausse caméra qui montre un vrai QR code.
// Lancement : npx tsx tests/e2e/staff-app.e2e.mts   (construit l'appli lui-même ; Chromium + playwright requis)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { signQrPayload } from "../../src/lib/loyalty/qr";
import { CARD_ID, SERIAL, USER, startFakeSupabase } from "./fake-supabase.mts";
import { makeQrVideo } from "./make-qr-video.mts";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");

const APP = 3114;
const SUPA = 54397;
const QR_SECRET = "e".repeat(48);
const base = `http://localhost:${APP}`;
const shots = process.env.SHOTS_DIR ?? path.join(tmpdir(), "e2e-shots");
mkdirSync(shots, { recursive: true });

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✅ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message.split("\n")[0] });
    console.log(`❌ ${name} — ${(e as Error).message.split("\n")[0]}`);
    throw e;
  }
}

const supa = startFakeSupabase(SUPA);
let next: ChildProcess | undefined;
let logs = "";
try {
  const video = path.join(shots, "qr.y4m");
  await makeQrVideo(signQrPayload(SERIAL, QR_SECRET), video);

  // Les adresses « NEXT_PUBLIC_… » sont figées dans l'appli à la construction : on la construit avec les réglages du test.
  const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${SUPA}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service", QR_HMAC_SECRET: QR_SECRET };
  execFileSync("node", ["node_modules/next/dist/bin/next", "build"], { env, stdio: "pipe" });

  next = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(APP)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  next.stdout?.on("data", (d) => (logs += d));
  next.stderr?.on("data", (d) => (logs += d));
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${base}/api/health`).catch(() => null))?.status) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${video}`],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ["camera"], locale: "fr-FR" });
  await context.addInitScript(() => {
    (window as unknown as { __vibrations: unknown[] }).__vibrations = [];
    navigator.vibrate = ((p: unknown) => ((window as unknown as { __vibrations: unknown[] }).__vibrations.push(p), true)) as typeof navigator.vibrate;
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const diagnostics: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => m.type() === "error" && diagnostics.push(`console: ${m.text().slice(0, 200)}`));
  page.on("requestfailed", (r) => diagnostics.push(`requête échouée: ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  const vibrations = () => page.evaluate(() => (window as unknown as { __vibrations: unknown[] }).__vibrations.length);
  const shot = (n: string) => page.screenshot({ path: path.join(shots, `${n}.png`) });
  const expectText = async (text: string | RegExp, timeout = 10_000) => page.getByText(text).first().waitFor({ state: "visible", timeout });

  try {
    await step("sans connexion, /staff renvoie vers la page de connexion", async () => {
      await page.goto(`${base}/staff`);
      await page.waitForURL("**/staff/login");
      await expectText("Connexion");
      await expectText("Mot de passe oublié ou pas encore de compte ?");
    });

    await step("un mauvais mot de passe affiche un message clair", async () => {
      await page.getByLabel("Adresse e-mail").fill(USER.email);
      await page.getByLabel("Mot de passe").fill("mauvais");
      await page.getByRole("button", { name: "Se connecter" }).click();
      await expectText("E-mail ou mot de passe incorrect.");
    });

    await step("le bon mot de passe ouvre l'accueil du commerce", async () => {
      await page.getByLabel("Mot de passe").fill(USER.password);
      await page.getByRole("button", { name: "Se connecter" }).click();
      await page.waitForURL(`${base}/staff`);
      await expectText("Café du Port");
      await expectText("Scanner une carte");
      await shot("1-accueil");
    });

    await step("la page est installable : manifeste, icônes et service worker", async () => {
      const href = await page.locator('link[rel="manifest"]').getAttribute("href");
      const manifest = await (await fetch(`${base}${href}`)).json();
      if (manifest.display !== "standalone" || manifest.start_url !== "/staff" || manifest.lang !== "fr") throw new Error("manifeste inattendu " + JSON.stringify(manifest));
      for (const icon of manifest.icons) if ((await fetch(`${base}${icon.src}`)).status !== 200) throw new Error("icône manquante " + icon.src);
      if (!manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable")) throw new Error("pas d'icône maskable");
      await page.evaluate(() => navigator.serviceWorker.ready);
      const sw = await fetch(`${base}/sw.js`);
      if (!/no-store/.test(sw.headers.get("cache-control") ?? "")) throw new Error("sw.js mis en cache");
    });

    await step("scanner : la caméra lit le QR code et affiche la carte du client", async () => {
      await page.getByRole("link", { name: "Scanner une carte" }).click();
      await page.waitForURL("**/staff/scan");
      await expectText("Léa", 20_000);
      await expectText("0 / 3");
      await shot("2-carte");
    });

    await step("+1 tampon : la carte passe à 1 / 3, le téléphone vibre, l'annulation est proposée", async () => {
      const before = await vibrations();
      await page.getByRole("button", { name: "+ 1 tampon" }).click();
      await expectText("Tampon ajouté à Léa : 1 / 3.");
      await expectText("1 / 3");
      if ((await vibrations()) <= before) throw new Error("aucune vibration");
      await expectText(/Annuler le dernier tampon/);
      await shot("3-tampon");
    });

    await step("anti double scan : le bouton est bloqué avec le temps à attendre", async () => {
      await expectText(/Prochain tampon possible dans 9 min|Prochain tampon possible dans 10 min/);
      if (!(await page.getByRole("button", { name: "+ 1 tampon" }).isDisabled())) throw new Error("bouton actif");
    });

    await step("annuler le dernier tampon : retour à 0 / 3, puis nouveau tampon possible", async () => {
      await page.getByRole("button", { name: /Annuler le dernier tampon/ }).click();
      await expectText("Dernier tampon annulé : 0 / 3.");
      await page.getByRole("button", { name: "+ 1 tampon" }).click();
      await expectText("Tampon ajouté à Léa : 1 / 3.");
    });

    await step("carte pleine : récompense proposée, validation, remise à 0", async () => {
      supa.card.stamps = 3; // la carte devient pleine (comme après d'autres visites)
      supa.events.length = 0;
      await page.getByRole("button", { name: "Scanner une autre carte" }).click();
      await expectText("Récompense disponible : 1 café offert", 20_000);
      await shot("4-recompense");
      await page.getByRole("button", { name: "Valider la récompense" }).click();
      await expectText("Récompense validée pour Léa. La carte repart à 0.");
      await expectText("0 / 3");
      await expectText("1 récompense déjà obtenue");
    });

    await step("sans internet : une page claire s'affiche à la place d'une erreur du navigateur", async () => {
      await context.setOffline(true);
      await page.goto(`${base}/staff`).catch(() => {});
      await expectText("Pas de connexion internet");
      await context.setOffline(false);
    });

    await step("la déconnexion ramène à la page de connexion", async () => {
      await page.goto(`${base}/staff`);
      await page.getByRole("button", { name: "Se déconnecter" }).click();
      await page.waitForURL("**/staff/login");
      await page.goto(`${base}/staff/scan`);
      await page.waitForURL("**/staff/login");
    });

    await step("aucune erreur JavaScript dans le navigateur", async () => {
      if (pageErrors.length) throw new Error(pageErrors.join(" | "));
    });
  } catch (e) {
    console.log("--- ce que voit le navigateur :", (await page.locator("body").innerText().catch(() => "?")).replace(/\s+/g, " ").slice(0, 400));
    console.log(diagnostics.slice(-8).join("\n"));
    await page.screenshot({ path: path.join(shots, "echec.png") }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
} catch {
  /* le détail est affiché ci-dessus */
} finally {
  next?.kill();
  supa.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} étapes réussies. Captures : ${shots}`);
if (/BEGIN (RSA )?PRIVATE|service/.test(logs.replace(/SUPABASE_SERVICE_ROLE_KEY/g, ""))) console.log("⚠️ le journal du serveur contient peut-être un secret");
if (bad.length || results.length === 0) {
  console.log(logs.split("\n").slice(-15).join("\n"));
  process.exitCode = 1;
}
void CARD_ID;
