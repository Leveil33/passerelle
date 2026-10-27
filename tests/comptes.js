const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const out = (n) => path.join(__dirname, n);
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1000, height: 720 }, reducedMotion: 'reduce' });
  await ctx.addInitScript({ content: fs.readFileSync(path.join(__dirname, 'mockclaude.js'), 'utf8') });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const errors = [];
  const open = async (q) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(q + ': ' + e.message)); await p.goto(`http://localhost:8765/tests/index.html?${q}`, { waitUntil: 'commit' }); await p.waitForTimeout(1800); await p.keyboard.press('Escape'); await p.waitForTimeout(700); return p; };
  const shot = (P, n) => P.screenshot({ path: out(n), timeout: 120000 });
  const A = await open('u=A');
  // ancien format à plat : doit être repris comme premier compte
  await A.evaluate(() => { localStorage.clear(); localStorage.setItem('mockdb:joueurs/A', JSON.stringify({ pseudo: 'Ancien', avatar: 'joie.0', color: '#1f9e6e', played: 2, wins: 1, losses: 1, draws: 0, points: 5, counted: [] })); });
  await A.reload({ waitUntil: 'commit' }); await A.waitForTimeout(1800); await A.keyboard.press('Escape'); await A.waitForTimeout(700);
  const migrated = await A.evaluate(() => [__dbg.ACC.store.accounts.length, __dbg.ACC.data && __dbg.ACC.data.pseudo, __dbg.ACC.data && __dbg.ACC.data.wins]);
  await A.click('#accChip'); await A.waitForTimeout(700); await shot(A, 'AC2-card-legacy.png');
  // ajouter un 2e compte et le personnaliser
  await A.click('[data-add]'); await A.waitForTimeout(500);
  await A.fill('#acPseudo', 'Léa'); await A.click('[data-set="title"][data-v="Roi du bond"]'); await A.fill('#acMotto', 'Toujours plus haut');
  await shot(A, 'AC2-edit-id.png');
  await A.click('[data-tab="face"]'); await A.click('[data-set="av.skin"][data-v="#bfe3ff"]'); await A.click('[data-set="av.eyes"][data-v="stars"]'); await A.click('[data-set="av.mouth"][data-v="grin"]');
  await shot(A, 'AC2-edit-face.png');
  await A.click('[data-tab="style"]'); await A.click('[data-set="av.hat"][data-v="crown"]'); await A.click('[data-set="av.acc"][data-v="glasses"]');
  await shot(A, 'AC2-edit-style.png');
  await A.click('[data-tab="card"]'); await A.click('[data-set="card.bg"][data-v="neon"]'); await A.click('[data-set="card.pat"][data-v="etoiles"]'); await A.click('[data-set="card.frame"][data-v="or"]'); await A.click('[data-set="sig"][data-v="taquin.0"]');
  await shot(A, 'AC2-edit-card.png');
  await A.click('#acSave'); await A.waitForTimeout(600); await shot(A, 'AC2-card.png');
  const afterAdd = await A.evaluate(() => [__dbg.ACC.store.accounts.map((a) => a.pseudo), __dbg.ACC.data.pseudo, __dbg.ACC.data.av, document.querySelector('#accChip').textContent.trim()]);
  // doublon refusé
  await A.click('[data-add]'); await A.fill('#acPseudo', 'léa'); await A.click('#acSave'); await A.waitForTimeout(300);
  const dupErr = await A.evaluate(() => (document.querySelector('.on-err') || {}).textContent);
  await A.click('#acCancel'); await A.waitForTimeout(300);
  // bascule sur Ancien puis retour Léa
  await A.click('.ac-sw:nth-child(1)'); await A.waitForTimeout(300);
  const sw1 = await A.evaluate(() => __dbg.ACC.data.pseudo);
  await A.click('.ac-sw:nth-child(2)'); await A.waitForTimeout(300);
  // B : compte neuf
  const B = await open('u=B');
  await B.click('#accChip'); await B.waitForTimeout(600); await B.fill('#acPseudo', 'Tom'); await B.click('#acDice'); await B.click('#acSave'); await B.waitForTimeout(500);
  await A.click('#acPlay'); await A.waitForTimeout(800);
  await A.click('#onCreate'); await A.waitForTimeout(800);
  const code = (await A.textContent('.on-code')).trim();
  await B.click('#acPlay'); await B.waitForTimeout(800); await B.fill('#onJoinCode', code); await B.click('#onJoin');
  await A.waitForTimeout(4500);
  const party = await A.evaluate(() => { const D = __dbg.ON.data; return [D.n1, D.k1, typeof D.a1, D.n2, typeof D.a2, document.querySelectorAll('#onlineAv .av').length, document.querySelectorAll('.emote-pop, .emote-fly, [class*=emote-show]').length]; });
  await shot(A, 'AC2-online.png');
  for (const P of [A, B]) await P.evaluate(() => { const G = __dbg.G; G.over = true; G.winner = 1; G.scores = [3, 1]; return __dbg.accountRecordOnline(); });
  for (const P of [A, B]) await P.evaluate(() => __dbg.accountRecordOnline());
  const stats = await A.evaluate(() => __dbg.ACC.store.accounts.map((a) => [a.pseudo, a.played, a.wins, a.points]));
  const statsB = await B.evaluate(() => [__dbg.ACC.data.pseudo, __dbg.ACC.data.played, __dbg.ACC.data.losses]);
  await A.evaluate(() => __dbg.goHome()); await A.waitForTimeout(600);
  await A.click('#accChip'); await A.waitForTimeout(500); await A.click('#acBoard'); await A.waitForTimeout(900);
  await shot(A, 'AC2-board.png');
  const board = await A.$$eval('.ac-board li', (x) => x.map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
  // mobile
  await A.setViewportSize({ width: 390, height: 800 }); await A.click('#acBack2'); await A.click('#acEdit'); await A.waitForTimeout(500); await shot(A, 'AC2-mobile-edit.png');
  const hscroll = await A.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  // suppression
  await A.setViewportSize({ width: 1000, height: 720 }); await A.click('#acCancel'); await A.click('#acDelete'); await A.click('#acDelete'); await A.waitForTimeout(400);
  const afterDel = await A.evaluate(() => [__dbg.ACC.store.accounts.map((a) => a.pseudo), __dbg.ACC.data && __dbg.ACC.data.pseudo]);
  console.log(JSON.stringify({ migrated, afterAdd, dupErr, sw1, code, party, stats, statsB, board, hscroll, afterDel, errors }, null, 1));
  await b.close();
})();
