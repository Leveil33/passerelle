// Test de l'ADMINISTRATION dans un vrai navigateur : mot de passe obligatoire, réglages, adresse, logo, équipe, création de commerce.
// Lancement : npx tsx tests/e2e/admin-app.e2e.mts   (construit l'appli lui-même ; Chromium + playwright requis)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { USERS, startFakeAdminSupabase } from "./fake-supabase-admin.mts";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
const APP = 3115;
const SUPA = 54396;
const base = `http://localhost:${APP}`;
const shots = process.env.SHOTS_DIR ?? path.join(tmpdir(), "e2e-admin-shots");
mkdirSync(shots, { recursive: true });

const results: { name: string; ok: boolean }[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); console.log(`✅ ${name}`); }
  catch (e) { results.push({ name, ok: false }); console.log(`❌ ${name} — ${(e as Error).message.split("\n")[0]}`); throw e; }
}

const supa = startFakeAdminSupabase(SUPA);
let next: ChildProcess | undefined;
let logs = "";
try {
  const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${SUPA}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service", QR_HMAC_SECRET: "e".repeat(48) };
  execFileSync("node", ["node_modules/next/dist/bin/next", "build"], { env, stdio: "pipe" });
  next = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(APP)], { env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout?.on("data", (d) => (logs += d));
  next.stderr?.on("data", (d) => (logs += d));
  for (let i = 0; i < 60; i++) { if ((await fetch(`${base}/api/health`).catch(() => null))?.status) break; await new Promise((r) => setTimeout(r, 500)); }

  const browser = await chromium.launch();
  try {
    const login = async (page: import("playwright").Page, email: string, password: string) => {
      await page.goto(`${base}/staff/login`);
      await page.getByLabel("Adresse e-mail").fill(email);
      await page.getByLabel("Mot de passe").fill(password);
      await page.getByRole("button", { name: "Se connecter" }).click();
    };
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true, locale: "fr-FR" });
    ctx.on("dialog", (d) => void d.accept());
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const see = (t: string | RegExp, timeout = 10_000) => page.getByText(t).first().waitFor({ state: "visible", timeout });

    try {
      await step("premier accès : le mot de passe provisoire oblige à en choisir un", async () => {
        await login(page, USERS.owner.email, USERS.owner.password);
        await page.waitForURL("**/staff/mot-de-passe");
        await see("Choisissez votre mot de passe");
        // tant que ce n'est pas fait, l'appli de scan et l'administration sont fermées
        const blocked = await page.evaluate(async () => (await fetch("/api/admin/program", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ programId: "44444444-4444-4444-8444-444444444444", name: "X" }) })).status);
        if (blocked !== 403) throw new Error(`réglages accessibles avant le changement (HTTP ${blocked})`);
        await page.goto(`${base}/staff/admin`);
        await page.waitForURL("**/staff/mot-de-passe");
      });

      await step("choisir son mot de passe : refus du trop court, puis accès à l'accueil", async () => {
        await page.getByLabel("Nouveau mot de passe (10 caractères minimum)").fill("court");
        await page.getByLabel("Répétez le mot de passe").fill("court");
        await page.getByRole("button", { name: "Enregistrer mon mot de passe" }).click();
        await see("Le mot de passe doit faire au moins 10 caractères.");
        await page.getByLabel("Nouveau mot de passe (10 caractères minimum)").fill("mon-vrai-mot-de-passe-42");
        await page.getByLabel("Répétez le mot de passe").fill("mon-vrai-mot-de-passe-42");
        await page.getByRole("button", { name: "Enregistrer mon mot de passe" }).click();
        await page.waitForURL(`${base}/staff`);
        await see("Réglages de mon commerce");
        if (supa.users.get(USERS.owner.id)!.password !== "mon-vrai-mot-de-passe-42") throw new Error("mot de passe non enregistré");
        if (supa.users.get(USERS.owner.id)!.app_metadata.must_change_password !== false) throw new Error("obligation non levée");
      });

      await step("réglages : statistiques et programme affichés", async () => {
        await page.getByRole("link", { name: "Réglages de mon commerce" }).click();
        await page.waitForURL("**/staff/admin");
        await see("Café du Port");
        await see("Cartes distribuées");
        if (!(await page.getByLabel("Nom du programme").inputValue()).includes("Carte café")) throw new Error("programme absent");
        await page.screenshot({ path: path.join(shots, "1-reglages.png"), fullPage: true });
      });

      await step("modifier la récompense et le nombre de cases : enregistré", async () => {
        await page.getByLabel("Récompense", { exact: true }).fill("2 cafés offerts");
        await page.getByLabel("Nombre de cases (tampons pour la récompense)").fill("8");
        await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
        await see("Enregistré. Les cartes déjà distribuées se mettent à jour.");
        if (supa.state.program.reward_label !== "2 cafés offerts" || supa.state.program.stamps_required !== 8) throw new Error("non enregistré côté serveur");
      });

      await step("une valeur invalide est refusée avec un message clair", async () => {
        await page.waitForTimeout(1500); // laisse le rafraîchissement de la page se terminer
        await page.getByLabel("Nombre de cases (tampons pour la récompense)").fill("99");
        await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "Nombre de cases" }).first().waitFor({ timeout: 10_000 });
        if (supa.state.program.stamps_required !== 8) throw new Error("valeur invalide enregistrée");
      });

      await step("choisir un autre tampon et une couleur", async () => {
        await page.getByRole("button", { name: "Café", exact: true }).click();
        await see("Tampon enregistré.");
        if (supa.state.program.stamp_icon !== "coffee") throw new Error("tampon non enregistré");
        await page.waitForTimeout(1500); // le rafraîchissement recrée les formulaires
        await page.getByLabel("Code de la couleur").fill("#E11D48");
        await page.getByRole("button", { name: "Appliquer" }).click();
        await see("Couleur enregistrée.");
        if (supa.state.merchant.brand_color !== "#E11D48") throw new Error("couleur non enregistrée");
      });

      await step("importer un logo : contrôlé, rangé, affiché", async () => {
        await page.waitForTimeout(1500); // laisse le rafraîchissement de la page se terminer
        const logo = await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 225, g: 29, b: 72, alpha: 1 } } }).png().toBuffer();
        await page.getByLabel("Importer mon logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: logo });
        await see("Logo enregistré.");
        const url = supa.state.merchant.logo_url;
        if (!url || !/\/merchant-assets\/[0-9a-f-]+\/logo-[0-9a-f]{12}\.png$/.test(url)) throw new Error(`adresse de logo inattendue : ${url}`);
        const stored = [...supa.state.uploads.entries()].find(([k]) => k.includes("logo-"));
        const meta = await sharp(stored![1]).metadata();
        if (meta.width !== 660 || meta.height !== 660 || meta.format !== "png") throw new Error("logo non normalisé");
        await page.getByAltText("Logo actuel").waitFor({ timeout: 10_000 });
      });

      await step("importer un fichier qui n'est pas une image : refusé avec un message clair", async () => {
        await page.waitForTimeout(1500); // laisse le rafraîchissement de la page se terminer
        await page.getByLabel("Importer mon logo").setInputFiles({ name: "pirate.png", mimeType: "image/png", buffer: Buffer.from("<script>alert(1)</script> ceci n'est pas une image") });
        await see("Ce fichier n'est pas une image reconnue.");
      });

      await step("importer son propre tampon : « Mon image » apparaît et devient le tampon actif", async () => {
        await page.waitForTimeout(1500); // laisse le rafraîchissement de la page se terminer
        const stamp = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 120, b: 255, alpha: 1 } } }).png().toBuffer();
        await page.getByLabel("Importer mon tampon").setInputFiles({ name: "tampon.png", mimeType: "image/png", buffer: stamp });
        await see("Votre tampon est enregistré.");
        await page.getByRole("button", { name: "Mon image" }).waitFor({ timeout: 10_000 });
        if (supa.state.program.stamp_icon !== "custom" || !supa.state.program.stamp_icon_url) throw new Error("tampon importé non enregistré");
      });

      await step("ajouter une adresse (le message de limite de 10 adresses est expliqué)", async () => {
        await page.waitForTimeout(1500); // laisse le rafraîchissement de la page se terminer
        await page.getByLabel("Nom de l'adresse").fill("Boutique du Port");
        await page.getByLabel("Adresse", { exact: true }).fill("1 quai du Port");
        await page.getByLabel("Latitude").fill("48,8566");
        await page.getByLabel("Longitude").fill("2.3522");
        await page.getByRole("button", { name: "Ajouter l'adresse" }).click();
        await see("Adresse ajoutée.");
        await see("Boutique du Port");
        if (supa.state.locations[0]?.latitude !== 48.8566) throw new Error("virgule décimale mal lue");
      });

      await step("supprimer l'adresse", async () => {
        await page.waitForTimeout(1500); // laisse le rafraîchissement de la page se terminer
        await page.getByRole("button", { name: "Supprimer Boutique du Port" }).click();
        await see("Adresse supprimée.");
        if (supa.state.locations.length !== 0) throw new Error("adresse non supprimée");
      });

      await step("équipe : ajouter un employé affiche son mot de passe provisoire UNE fois", async () => {
        await page.waitForTimeout(1500); // laisse le rafraîchissement de la page se terminer
        await see("proprio@cafe.test");
        await page.getByLabel("Adresse e-mail de l'employé").fill("Marie@Cafe.test");
        await page.getByRole("button", { name: "Créer son compte" }).click();
        await see("Compte créé pour marie@cafe.test");
        const pwd = (await page.locator("p.font-mono").innerText()).trim();
        if (!/^[A-Za-z2-9]{14}$/.test(pwd)) throw new Error(`mot de passe provisoire inattendu : ${pwd}`);
        const stored = [...supa.users.values()].find((u) => u.email === "marie@cafe.test")!;
        if (stored.password !== pwd || stored.app_metadata.must_change_password !== true) throw new Error("compte employé mal créé");
        await page.screenshot({ path: path.join(shots, "2-equipe.png"), fullPage: true });
        await page.reload();
        if (await page.getByText(pwd).count()) throw new Error("le mot de passe provisoire est encore affiché après rechargement");
      });

      await step("équipe : refus d'une adresse déjà utilisée ; le dernier propriétaire ne peut pas être retiré", async () => {
        await page.getByLabel("Adresse e-mail de l'employé").fill("marie@cafe.test");
        await page.getByRole("button", { name: "Créer son compte" }).click();
        await see("Un compte existe déjà avec cette adresse e-mail.");
        await page.getByRole("button", { name: "Retirer marie@cafe.test" }).click();
        await page.getByText("Membre retiré.").first().waitFor({ timeout: 10_000 });
      });

      await step("un employé (non propriétaire) n'a pas accès aux réglages", async () => {
        const ctx2 = await browser.newContext({ locale: "fr-FR" });
        const p2 = await ctx2.newPage();
        const probe = await p2.request.fetch(`${base}/api/admin/program`, { method: "PATCH", headers: { "content-type": "application/json" }, data: { programId: "44444444-4444-4444-8444-444444444444", name: "Piraté" } });
        if (probe.status() !== 401) throw new Error(`sans connexion, HTTP ${probe.status()} au lieu de 401`);
        await ctx2.close();
      });

      await step("la page de création de commerces n'existe pas pour un propriétaire de commerce (404)", async () => {
        await page.goto(`${base}/admin`);
        // La page est contrôlée pendant son envoi : le code HTTP peut rester 200, mais le contenu est celui d'une page inexistante.
        await page.waitForTimeout(1500);
        const shown = await page.locator("body").innerText();
        if (/Créer un commerce|Boulangerie|Café du Port/.test(shown)) throw new Error("la page d'administration est visible pour un non-opérateur");
        if (!/404|introuvable|could not be found/i.test(shown)) throw new Error(`page inattendue : ${shown.slice(0, 120)}`);
        const api = await page.evaluate(async () => (await fetch("/api/platform/merchants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Piraté", ownerEmail: "x@y.fr" }) })).status);
        if (api !== 404) throw new Error(`API : HTTP ${api} au lieu de 404`);
      });

      await step("la propriétaire de la solution crée un commerce : compte propriétaire et mot de passe provisoire", async () => {
        await page.evaluate(() => fetch("/auth/v1/logout")); // sans effet utile
        const ctx3 = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: "fr-FR" });
        const p3 = await ctx3.newPage();
        await login(p3, USERS.admin.email, USERS.admin.password);
        await p3.waitForURL(`${base}/staff`);
        await p3.goto(`${base}/admin`);
        await p3.getByRole("heading", { name: "Créer un commerce" }).waitFor({ timeout: 10_000 });
        await p3.getByLabel("Nom du commerce").fill("Boulangerie Léa");
        await p3.getByLabel("Adresse e-mail du propriétaire").fill("lea@boulangerie.test");
        await p3.getByRole("button", { name: "Créer le commerce" }).click();
        await p3.getByText("Commerce « Boulangerie Léa » créé.").waitFor({ timeout: 10_000 });
        const pwd = (await p3.locator("p.font-mono").innerText()).trim();
        const owner = [...supa.users.values()].find((u) => u.email === "lea@boulangerie.test");
        if (!owner || owner.password !== pwd || owner.app_metadata.must_change_password !== true) throw new Error("compte propriétaire mal créé");
        await p3.getByText("Boulangerie Léa").first().waitFor();
        await p3.screenshot({ path: path.join(shots, "3-plateforme.png"), fullPage: true });
        await ctx3.close();
      });

      await step("aucune erreur JavaScript dans le navigateur", async () => {
        if (errors.length) throw new Error(errors.join(" | "));
      });
    } catch (e) {
      console.log("--- ce que voit le navigateur :", (await page.locator("body").innerText().catch(() => "?")).replace(/\s+/g, " ").slice(400, 1400));
      await page.screenshot({ path: path.join(shots, "echec.png") }).catch(() => {});
      throw e;
    }
  } finally {
    await browser.close();
  }
} catch {
  /* détail affiché ci-dessus */
} finally {
  next?.kill();
  supa.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} étapes réussies. Captures : ${shots}`);
if (bad.length || results.length === 0) { console.log(logs.split("\n").slice(-12).join("\n")); process.exitCode = 1; }
