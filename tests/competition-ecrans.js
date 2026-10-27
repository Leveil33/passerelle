// Captures : accueil (bouton Classement), écran Compétition sur mobile, recherche d'adversaire.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errs = [];
  for (const [w, h, tag] of [[1000, 720, 'bureau'], [390, 820, 'mobile']]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
    await ctx.addInitScript({ content: fs.readFileSync(path.join(__dirname, 'mockclaude.js'), 'utf8') });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(tag + ': ' + e.message));
    await p.goto('http://localhost:8765/tests/index.html?u=Z', { waitUntil: 'commit' });
    await p.waitForFunction(() => window.__dbg, null, { timeout: 90000 }); await p.waitForTimeout(1500); await p.keyboard.press('Escape'); await p.waitForTimeout(600);
    await p.screenshot({ path: path.join(__dirname, `E-home-${tag}.png`), timeout: 120000 });
    await p.click('#hComp'); await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(__dirname, `E-comp-${tag}.png`), timeout: 120000 });
    await p.click('#cMatch'); await p.waitForTimeout(2500);
    await p.screenshot({ path: path.join(__dirname, `E-search-${tag}.png`), timeout: 120000 });
    console.log(tag, await p.evaluate(() => document.documentElement.scrollWidth > innerWidth ? 'défilement horizontal !' : 'ok'));
    await ctx.close();
  }
  console.log(JSON.stringify(errs)); await b.close();
})();
