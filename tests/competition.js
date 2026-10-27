// Compétition en ligne avec un faux Supabase : recherche d'adversaire, pendule partagée, chute au temps,
// Elo et classement ; puis invitation d'un ami et recherches lancées en même temps.
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const out = (n) => path.join(__dirname, n);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const store = { docs: {}, emails: {} }, pages = new Set(), errors = [], R = {};
  const device = async () => {
    const ctx = await b.newContext({ viewport: { width: 1000, height: 720 }, reducedMotion: 'reduce' });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase/, (r) => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, 'fakesupabase.js'), 'utf8') }));
    await ctx.exposeBinding('fsbCall', async (src, op) => {
      if (op.k === 'get') return JSON.parse(JSON.stringify(store[op.n]));
      if (op.k === 'put') { store[op.n] = op.v; return true; }
      if (op.k === 'bc') { for (const p of pages) if (p !== src.page && !p.isClosed()) p.evaluate((m) => window.__fsbRecv && window.__fsbRecv(m), op.m).catch(() => {}); return true; }
    });
    return ctx;
  };
  const open = async (u) => {
    const ctx = await device(), p = await ctx.newPage(); pages.add(p);
    p.on('pageerror', (e) => errors.push(u + ': ' + e.message));
    await p.goto(`http://localhost:8765/tests/web/index.html?u=${u}`, { waitUntil: 'commit' });
    await p.waitForFunction(() => window.__dbg, null, { timeout: 90000 }); await p.waitForTimeout(1500); await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    return p;
  };
  const shot = (P, n) => P.screenshot({ path: out(n), timeout: 120000 });
  const account = async (P, name) => { await P.click('#accChip'); await P.waitForTimeout(500); await P.fill('#acPseudo', name); await P.click('#acSave'); await P.waitForTimeout(600); await P.click('#acBack'); await P.waitForTimeout(300); };
  const st = (p) => p.evaluate(() => { const G = __dbg.G; return G && G.online ? { side: G.online.side, turn: G.turn, n: G.moveCount, over: G.over, reason: G.reason, winner: G.winner, comp: !!G.comp, left: G.comp && G.comp.left.map(Math.round), pieces: G.pieces.map((x) => `${x.on ? 1 : 0}${x.r},${x.c}`).join(' ') } : null; });
  const playOne = (p) => p.evaluate(() => { const G = __dbg.G; const mine = G.pieces.filter((x) => x.on && x.p === G.turn); for (const pc of mine.sort(() => Math.random() - 0.5)) { const ms = __dbg.computeMoveSet(pc); const d = ms.dests.find((d) => d.kind === 'exit') || ms.dests[Math.floor(Math.random() * ms.dests.length)]; if (d) { __dbg.selected = pc.id; __dbg.moveSet = ms; __dbg.play(d); return true; } } return false; });
  const idle = async (A, B) => { for (let w = 0; w < 80 && (await A.evaluate(() => __dbg.busy) || await B.evaluate(() => __dbg.busy)); w++) await A.waitForTimeout(150); };

  const A = await open('A'), B = await open('B');
  await account(A, 'Léa'); await account(B, 'Tom');
  // 1. Léa cherche (cadence 5 min + 3 s) ; Tom cherche 4 s plus tard → même partie
  await A.click('#hComp'); await A.waitForTimeout(500); await A.click('[data-clock="5+3"]'); await shot(A, 'C-comp.png');
  await A.click('#cMatch'); await A.waitForTimeout(2500); await shot(A, 'C-search.png');
  R.ticket = Object.values(store.docs).filter((d) => d.data.mm === 'open').map((d) => [d.data.comp.clock, !!d.data.seen]);
  await A.click('#onBack'); await A.waitForTimeout(500); R.pill = await A.evaluate(() => !document.querySelector('#mmPill').hidden); await shot(A, 'C-pill.png');
  await B.waitForTimeout(1500);
  await B.click('#hComp'); await B.waitForTimeout(400); await B.click('#cMatch');
  await A.waitForTimeout(6000);
  R.start = [await st(A), await st(B)].map((x) => x && [x.side, x.turn, x.comp, x.left]);
  R.pillAfter = await A.evaluate(() => !document.querySelector('#mmPill').hidden);
  R.tag = await A.evaluate(() => document.querySelector('#onlineText').textContent);
  await shot(B, 'C-gameB.png');
  // 2. quelques coups : les pendules (hors joueur au trait) doivent être identiques des deux côtés
  let mism = 0, clockDiff = 0;
  for (let i = 0; i < 6; i++) {
    await idle(A, B);
    const sa = await st(A); if (!sa || sa.over) break;
    await A.waitForTimeout(700 + Math.random() * 900);
    await playOne(sa.turn === sa.side ? A : B);
    await A.waitForTimeout(1800); await idle(A, B);
    const [x, y] = [await st(A), await st(B)];
    if (!x || !y || x.pieces !== y.pieces || x.turn !== y.turn) mism++;
    else { const k = 2 - x.turn; clockDiff = Math.max(clockDiff, Math.abs(x.left[k] - y.left[k])); }
  }
  R.moves = [(await st(A)).n, mism, clockDiff];
  // 3. chute au temps : le joueur au trait n'a plus que 1,5 s
  const s3 = await st(A), onTurn = s3.turn === s3.side ? A : B;
  await onTurn.evaluate(() => { const c = __dbg.G.comp; c.left[__dbg.G.turn - 1] = 1500; c.mark = 1500; });
  await A.waitForTimeout(6000);
  R.timeout = [await st(A), await st(B)].map((x) => [x.over, x.reason, x.winner]);
  R.elo = await Promise.all([A, B].map((p) => p.evaluate(() => { const a = __dbg.ACC.data; return [a.pseudo, a.elo, a.rated, a.rw, a.rl, (document.querySelector('#endElo') || {}).textContent]; })));
  await A.waitForTimeout(2500); await shot(A, 'C-endA.png');
  // 4. classement Elo
  await A.evaluate(() => __dbg.goHome()); await A.waitForTimeout(600);
  await A.click('#hBoard'); await A.waitForTimeout(1200); await shot(A, 'C-board.png');
  R.board = await A.$$eval('.ac-board li', (x) => x.map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
  await A.click('#acBack'); await A.waitForTimeout(300);
  // 5. inviter un ami en compétition
  await B.evaluate(() => __dbg.goHome()); await B.waitForTimeout(400);
  await A.click('#hComp'); await A.waitForTimeout(400); await A.click('#cInvite'); await A.waitForTimeout(1500); await shot(A, 'C-invite.png');
  const code = (await A.textContent('.on-code')).trim();
  R.invite = await A.evaluate(() => [document.querySelector('.on-comp') && document.querySelector('.on-comp').textContent, document.querySelector('#onTitle').textContent]);
  await B.click('#hOnline'); await B.waitForTimeout(800); await B.fill('#onJoinCode', code); await B.click('#onJoin');
  await A.waitForTimeout(4000);
  R.inviteGame = [await st(A), await st(B)].map((x) => x && [x.comp, x.left]);
  // 6. recherches lancées en même temps → elles se retrouvent
  for (const P of [A, B]) { await P.evaluate(() => __dbg.goHome()); }
  await A.waitForTimeout(500);
  await Promise.all([A, B].map(async (P) => { await P.click('#hComp'); await P.waitForTimeout(300); await P.click('#cMatch'); }));
  await A.waitForTimeout(16000);
  R.together = [await st(A), await st(B)].map((x) => x && [x.side, x.comp]);
  R.openTickets = Object.values(store.docs).filter((d) => d.data.mm === 'open').length;
  // 7. annuler une recherche efface le ticket
  await A.evaluate(() => __dbg.goHome()); await A.waitForTimeout(400);
  await A.click('#hComp'); await A.waitForTimeout(300); await A.click('#cMatch'); await A.waitForTimeout(2500);
  const before = Object.values(store.docs).filter((d) => d.data.mm === 'open').length;
  await A.click('#mmCancel'); await A.waitForTimeout(800);
  R.cancel = [before, Object.values(store.docs).filter((d) => d.data.mm === 'open').length, await A.evaluate(() => !document.querySelector('#start').hidden)];
  console.log(JSON.stringify({ ...R, errors }, null, 1));
  await b.close();
})();
