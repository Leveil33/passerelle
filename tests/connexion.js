// Nouvel appareil (ou nouvelle adresse) : on retrouve son compte avec son e-mail dès l'écran de création.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const store = { docs: {}, emails: {} }, pages = new Set(), errors = [], R = {};
  const open = async (u) => {
    const ctx = await b.newContext({ viewport: { width: 1000, height: 720 }, reducedMotion: 'reduce' });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase/, (r) => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, 'fakesupabase.js'), 'utf8') }));
    await ctx.exposeBinding('fsbCall', async (src, op) => { if (op.k === 'get') return JSON.parse(JSON.stringify(store[op.n])); if (op.k === 'put') { store[op.n] = op.v; return true; } return true; });
    const p = await ctx.newPage(); pages.add(p); p.on('pageerror', (e) => errors.push(u + ': ' + e.message));
    await p.goto(`http://localhost:8765/tests/web/index.html?u=${u}`, { waitUntil: 'commit' });
    await p.waitForFunction(() => window.__dbg, null, { timeout: 90000 }); await p.waitForTimeout(1500); await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    return p;
  };
  // Appareil A : compte « Léa » + e-mail
  const A = await open('A');
  await A.click('#accChip'); await A.waitForTimeout(500); await A.fill('#acPseudo', 'Léa'); await A.click('#acSave'); await A.waitForSelector('#ccMail');
  await A.fill('#ccMail', 'lea@exemple.fr'); await A.click('#ccSend'); await A.waitForSelector('#ccCode'); await A.fill('#ccCode', '123456'); await A.click('#ccOk'); await A.waitForTimeout(600);
  // Appareil D : aucun compte, la case « Tu as déjà un compte ? » est proposée à la création
  const D = await open('D');
  await D.click('#accChip'); await D.waitForTimeout(800);
  R.box = await D.evaluate(() => { const el = document.querySelector('#acCloud.login'); return el && !el.hidden && el.textContent.replace(/\s+/g, ' ').trim().slice(0, 60); });
  await D.screenshot({ path: path.join(__dirname, 'L-login.png'), timeout: 120000 });
  await D.fill('#ccMail', 'lea@exemple.fr'); await D.click('#ccSend'); await D.waitForSelector('#ccCode'); await D.fill('#ccCode', '123456');
  await Promise.all([D.waitForNavigation({ waitUntil: 'commit', timeout: 60000 }), D.click('#ccOk')]);
  await D.waitForFunction(() => window.__dbg, null, { timeout: 90000 }); await D.waitForTimeout(2000);
  R.after = await D.evaluate(() => [__dbg.ACC.store.accounts.map((a) => a.pseudo), document.querySelector('#accChip').textContent.trim()]);
  console.log(JSON.stringify({ ...R, errors })); await b.close();
})();
