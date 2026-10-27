// Faux client supabase-js pour les tests : base partagée côté Node (window.fsbCall), donc entre « appareils » séparés.
// Applique en gros les règles de supabase.sql pour vérifier que le jeu n'écrit que ce qu'il a le droit d'écrire.
(function () {
  const U = new URLSearchParams(location.search).get('u') || 'X';
  const SK = 'fsb.sess.' + U, TAB = Math.random().toString(36).slice(2);
  const db = () => window.fsbCall({ k: 'get', n: 'docs' }), save = (d) => window.fsbCall({ k: 'put', n: 'docs', v: d });
  const emails = () => window.fsbCall({ k: 'get', n: 'emails' }), saveEmails = (v) => window.fsbCall({ k: 'put', n: 'emails', v });
  const bc = { postMessage: (m) => window.fsbCall({ k: 'bc', m }) };
  const chans = new Set(), authCbs = [];
  let sess = JSON.parse(localStorage.getItem(SK) || 'null');
  const uid = () => sess && sess.user.id;
  const setSess = (s, ev) => { sess = s; if (s) localStorage.setItem(SK, JSON.stringify(s)); else localStorage.removeItem(SK); authCbs.forEach((f) => f(ev, s)); };
  const denied = () => ({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } });
  const coll = (p) => p.split('/')[0];
  const canWrite = (old, row) => {
    const me = uid(); if (!me) return false;
    const c = coll((old || row).path);
    if (c === 'joueurs') return (old || row).path === 'joueurs/' + me;
    if (!row) return old.owner === me; // suppression
    const okOld = !old || old.owner === me || old.data.p1 === me || old.data.p2 === me || old.data.p1 == null || old.data.p2 == null;
    const okNew = !old ? true : (row.data.p1 === me || row.data.p2 === me);
    return okOld && okNew;
  };
  const notify = (event, row, old) => { const m = { k: 'pg', event, row, old }; bc.postMessage(m); deliver(m); };
  const deliver = (m) => chans.forEach((ch) => ch._pg(m));
  window.__fsbRecv = (m) => { if (m.k === 'pg') deliver(m); else chans.forEach((ch) => ch._bc(m)); };
  const get = (o, k) => (k.startsWith('data->>') ? (o.data[k.slice(7)] == null ? null : String(o.data[k.slice(7)])) : o[k]);
  function from(table) {
    const st = { f: [], lim: 1e9, op: 'select', single: false };
    const q = {
      select() { return q; }, eq(k, v) { st.f.push([k, v]); return q; }, order() { return q; }, limit(n) { st.lim = n; return q; },
      maybeSingle() { st.single = true; return q; },
      upsert(row) { st.op = 'upsert'; st.row = row; return q; }, delete() { st.op = 'delete'; return q; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    async function run() {
      const d = await db();
      if (st.op === 'upsert') {
        const old = d[st.row.path]; const row = { path: st.row.path, coll: coll(st.row.path), data: st.row.data, owner: old ? old.owner : uid() };
        if (!canWrite(old, row)) return denied();
        d[row.path] = row; await save(d); notify(old ? 'UPDATE' : 'INSERT', row); return { data: null, error: null };
      }
      let rows = Object.values(d).filter((o) => st.f.every(([k, v]) => get(o, k) === v));
      if (st.op === 'delete') { for (const o of rows) { if (!canWrite(o, null)) continue; delete d[o.path]; notify('DELETE', null, { path: o.path }); } await save(d); return { data: null, error: null }; }
      rows = rows.slice(0, st.lim).map((o) => ({ path: o.path, data: o.data }));
      return { data: st.single ? rows[0] || null : rows, error: null };
    }
    return q;
  }
  async function rpc(name, { p, patch }) {
    const d = await db(), old = d[p];
    if (!old) return { error: { message: 'not_found' } };
    const row = { ...old, data: { ...old.data, ...patch } };
    if (!canWrite(old, row)) return { error: { message: 'not_found' } };
    d[p] = row; await save(d); notify('UPDATE', row); return { data: null, error: null };
  }
  function channel(name, opts) {
    const pg = [], bcs = [], pres = [], peers = {};
    let key = (opts && opts.config && opts.config.presence && opts.config.presence.key) || TAB, hb = null;
    const ch = {
      on(type, filt, cb) { (type === 'postgres_changes' ? pg : type === 'broadcast' ? bcs : pres).push([filt, cb]); return ch; },
      subscribe(cb) { chans.add(ch); setTimeout(() => cb && cb('SUBSCRIBED'), 30); return ch; },
      send({ event, payload }) { bc.postMessage({ k: 'bc', ch: name, event, payload }); return Promise.resolve('ok'); },
      track() { const beat = () => bc.postMessage({ k: 'pres', ch: name, key, at: Date.now() }); peers[key] = Date.now(); beat(); hb = setInterval(beat, 1000); pres.forEach(([, f]) => f()); return Promise.resolve('ok'); },
      presenceState() { const now = Date.now(); const o = {}; Object.entries(peers).forEach(([k, t]) => { if (k === key || now - t < 3000) o[k] = [{}]; }); return o; },
      _pg(m) { pg.forEach(([f, cb]) => { if (f.event !== m.event) return; if (f.filter) { const v = f.filter.replace(/^path=eq\./, ''); if (!m.row || m.row.path !== v) return; } cb({ eventType: m.event, new: m.row, old: m.old }); }); },
      _bc(m) { if (m.ch !== name) return; if (m.k === 'bc') bcs.forEach(([f, cb]) => { if (f.event === m.event) cb({ event: m.event, payload: m.payload }); }); if (m.k === 'pres') { const first = !peers[m.key]; peers[m.key] = m.at; if (first) pres.forEach(([, f]) => f()); } },
      _close() { clearInterval(hb); chans.delete(ch); },
    };
    return ch;
  }
  let pendingEmail = null;
  const auth = {
    getSession: async () => ({ data: { session: sess } }),
    getUser: async () => ({ data: { user: sess && sess.user } }),
    signInAnonymously: async () => { setSess({ user: { id: 'anon-' + U + '-' + Math.random().toString(36).slice(2, 6), is_anonymous: true } }, 'SIGNED_IN'); return { data: { session: sess }, error: null }; },
    onAuthStateChange: (f) => { authCbs.push(f); return { data: { subscription: { unsubscribe() {} } } }; },
    updateUser: async ({ email }) => { const taken = (await emails())[email]; if (taken) return { error: { message: 'A user with this email address has already been registered', code: 'email_exists' } }; pendingEmail = email; return { data: {}, error: null }; },
    signInWithOtp: async ({ email }) => { pendingEmail = email; return { data: {}, error: null }; },
    verifyOtp: async ({ email, token, type }) => {
      if (token !== '123456') return { error: { message: 'Token has expired or is invalid' } };
      const E = await emails();
      if (type === 'email_change') { E[email] = sess.user.id; await saveEmails(E); setSess({ user: { ...sess.user, email, is_anonymous: false } }, 'USER_UPDATED'); return { data: {}, error: null }; }
      const id = E[email] || 'mail-' + email; E[email] = id; await saveEmails(E);
      setSess({ user: { id, email, is_anonymous: false } }, 'SIGNED_IN'); return { data: {}, error: null };
    },
    signOut: async () => { setSess(null, 'SIGNED_OUT'); return { error: null }; },
    linkIdentity: async () => ({ error: { message: 'no' } }), signInWithOAuth: async () => ({ error: { message: 'no' } }),
  };
  window.supabase = { createClient: () => ({ auth, from, rpc, channel, removeChannel: async (ch) => ch._close() }) };
})();
