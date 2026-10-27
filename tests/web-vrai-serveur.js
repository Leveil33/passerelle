const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const out = (n) => path.join(__dirname, n);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  // Chaque joueur = un « appareil » séparé (son propre navigateur) ; seul le faux serveur est partagé.
  const store = { docs: {}, emails: {} }, pages = new Set();
  const device = async () => {
    const ctx = await b.newContext({ viewport: { width: 1000, height: 720 }, reducedMotion: 'reduce' });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await ctx.exposeBinding('fsbCall', async (src, op) => {
      if (op.k === 'get') return JSON.parse(JSON.stringify(store[op.n]));
      if (op.k === 'put') { store[op.n] = op.v; return true; }
      if (op.k === 'bc') { for (const p of pages) if (p !== src.page && !p.isClosed()) p.evaluate((m) => window.__fsbRecv && window.__fsbRecv(m), op.m).catch(() => {}); return true; }
    });
    return ctx;
  };
  const ctxs = {};
  const errors = [], logs = [];
  const BASE = 'http://localhost:8765/tests/web/index.html';
  const open = async (q) => { const k = q.match(/u=(\w)/)[1]; const ctx = ctxs[k] || (ctxs[k] = await device()); const p = await ctx.newPage(); pages.add(p); p.on('pageerror', (e) => errors.push(q + ': ' + e.message)); p.on('console', (m) => { if (!/Failed to load resource|AudioContext/.test(m.text())) logs.push(q + ': ' + m.type() + ' ' + m.text().slice(0, 250)); }); await p.goto(`${BASE}?${q}`, { waitUntil: 'commit' }); await p.waitForFunction(() => window.__dbg, null, { timeout: 90000 }); await p.waitForTimeout(1500); await p.keyboard.press('Escape'); await p.waitForTimeout(500); return p; };
  const shot = (P, n) => P.screenshot({ path: out(n), timeout: 120000 });
  const R = {};
  const A = await open('u=A');
  R.webFlag = await A.evaluate(() => [!!window.PASSERELLE_AUTH, !!window.claude, __dbg.ON.me]);
  await A.click('#accChip'); await A.waitForTimeout(600);
  R.lede = await A.evaluate(() => (document.querySelector('#acBody .lede') || {}).textContent);
  await A.fill('#acPseudo', 'Léa'); await A.click('#acSave'); await A.waitForTimeout(800);

  await A.waitForSelector('#ccMail', { timeout: 15000 }); await shot(A, 'R-cloud.png');
  // partie en ligne par lien d'invitation
  await A.click('#acPlay'); await A.waitForTimeout(800); await A.click('#onCreate'); await A.waitForTimeout(1000);
  const code = (await A.textContent('.on-code')).trim(); R.code = code;
  R.invite = await A.evaluate((c) => document.querySelector('#onInvite') && 'ok', code);
  const B = await open(`u=B&partie=${code}`);
  await A.waitForTimeout(4000);
  const st = (p) => p.evaluate(() => { const G = __dbg.G; return G && G.online ? { side: G.online.side, turn: G.turn, n: G.moveCount, over: G.over, pieces: G.pieces.map((x) => `${x.on ? 1 : 0}${x.r},${x.c}`).join(' ') } : null; });
  R.start = [await st(A), await st(B)].map((x) => x && [x.side, x.turn, x.n]);
  if (!R.start[0] || !R.start[1]) { R.diagB = await B.evaluate(() => [__dbg.ON.me, __dbg.ON.err, __dbg.ON.code, (document.querySelector('#onBody') || {}).textContent.slice(0, 200)]); R.diagA = await A.evaluate(() => [__dbg.ON.me, __dbg.ON.code, JSON.stringify(__dbg.ON.data || {}).slice(0, 200)]); console.log(JSON.stringify({ ...R, errors, logs }, null, 1)); await b.close(); return; }
  R.urlB = await B.evaluate(() => location.search);
  const playOne = (p) => p.evaluate(() => { const G = __dbg.G; const mine = G.pieces.filter((x) => x.on && x.p === G.turn); for (const pc of mine.sort(() => Math.random() - 0.5)) { const ms = __dbg.computeMoveSet(pc); const d = ms.dests.find((d) => d.kind === 'attack') || ms.dests.find((d) => d.kind === 'exit') || ms.dests[Math.floor(Math.random() * ms.dests.length)]; if (d) { __dbg.selected = pc.id; __dbg.moveSet = ms; __dbg.play(d); return true; } } return false; });
  let mism = 0;
  for (let i = 0; i < 8; i++) {
    for (let w = 0; w < 80 && (await A.evaluate(() => __dbg.busy) || await B.evaluate(() => __dbg.busy)); w++) await A.waitForTimeout(150);
    const sa = await st(A); if (!sa || sa.over) break;
    await playOne(sa.turn === sa.side ? A : B);
    await A.waitForTimeout(2600);
    for (let w = 0; w < 80 && (await A.evaluate(() => __dbg.busy) || await B.evaluate(() => __dbg.busy)); w++) await A.waitForTimeout(150);
    const [x, y] = [await st(A), await st(B)];
    if (!x || !y || x.pieces !== y.pieces || x.turn !== y.turn || x.n !== y.n) mism++;
  }
  const [fa, fb] = [await st(A), await st(B)]; R.moves = [fa.n, fb.n, fa.pieces === fb.pieces, mism];
  R.peers = await A.evaluate(() => __dbg.ON.rm && __dbg.ON.rm.peers().length);
  await A.evaluate(() => __dbg.sendEmote('joie.0')); await B.waitForTimeout(800);
  R.emoteOnB = await B.evaluate(() => document.querySelectorAll('.emote-pop.them').length);
  await shot(B, 'W-gameB.png');
  // sécurité : B ne peut pas écrire la fiche de A
  R.hijack = await B.evaluate(async (aid) => { try { await __dbg.ON.db.doc('joueurs/' + aid).set({ accounts: [] }); return 'écrit !'; } catch (e) { return e.code; } }, R.webFlag[2]);
  console.log(JSON.stringify({ ...R, errors, logs: logs.slice(0, 8) }, null, 1));
  await b.close();
})();
