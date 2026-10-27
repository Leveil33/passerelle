/* Passerelle hors de claude.ai : ce fichier remplace ce que claude.ai fournit au jeu (base de données, identité,
   salons en direct) par un projet Supabase. Le jeu appelle toujours claude.use('db' | 'user' | 'room') ; on lui
   donne ici des objets qui ont la même forme.
   - db   : table « docs » (un document JSON par chemin « joueurs/<id> » ou « parties/<CODE> »).
   - user : connexion Supabase ; anonyme d'office, puis e-mail ou Google pour retrouver ses comptes ailleurs.
   - room : canaux Realtime (messages « move » et « emote », présence des joueurs). */
(function () {
  const C = window.PASSERELLE_CONFIG || {};
  const configured = C.supabaseUrl && C.supabaseKey && !/XXXX|COLLE/.test(C.supabaseUrl + C.supabaseKey);
  if (window.claude || !configured || !window.supabase) return;
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const here = location.origin + location.pathname;
  let ME = null;

  // Session : tout le monde est connecté, au moins de façon anonyme, pour avoir un identifiant stable.
  const ready = (async () => {
    let { data: { session } } = await sb.auth.getSession();
    if (!session) { const r = await sb.auth.signInAnonymously(); if (r.error) throw r.error; session = r.data.session; }
    ME = session.user.id;
    return session.user;
  })();
  ready.catch((e) => console.warn('Passerelle : connexion Supabase impossible', e));
  // Une connexion à un autre compte (lien e-mail, Google) change d'identifiant : on recharge pour tout relire.
  sb.auth.onAuthStateChange((ev, s) => {
    if (!ME) return;
    if ((ev === 'SIGNED_IN' && s && s.user.id !== ME) || ev === 'SIGNED_OUT') setTimeout(() => location.reload(), 50);
  });

  // Erreurs Supabase → codes que le jeu sait expliquer.
  function fail(e) {
    const x = new Error((e && e.message) || 'Erreur Supabase');
    const m = String((e && (e.message || e.code)) || '');
    x.code = e && (e.code === '42501' || /row-level security|permission/i.test(m)) ? 'permission_denied'
      : e && (e.status === 429 || /rate limit/i.test(m)) ? 'resource_exhausted'
      : /not_found/.test(m) ? 'not_found' : 'unavailable';
    return x;
  }
  const must = async (q) => { const r = await q; if (r.error) throw fail(r.error); return r.data; };
  const snap = (path, row) => ({ id: path.split('/').pop(), exists: !!row, data: () => (row ? row.data : undefined) });

  function doc(path) {
    return {
      id: path.split('/').pop(),
      async get() { await ready; return snap(path, await must(sb.from('docs').select('path,data').eq('path', path).maybeSingle())); },
      async set(data) { await ready; await must(sb.from('docs').upsert({ path, data, updated_at: new Date().toISOString() })); },
      // Fusion des champs côté serveur, en une fois : deux joueurs qui écrivent en même temps ne s'écrasent pas.
      async update(patch) { await ready; await must(sb.rpc('doc_merge', { p: path, patch })); },
      async delete() { await ready; await must(sb.from('docs').delete().eq('path', path)); },
      onSnapshot(cb, onErr) {
        let ch = null, gone = false;
        ready.then(async () => {
          try { const s = await this.get(); if (!gone) cb(s); } catch (e) { if (onErr) onErr(e); }
          if (gone) return;
          ch = sb.channel('doc:' + path + ':' + Math.random().toString(36).slice(2, 7))
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'docs', filter: 'path=eq.' + path }, (p) => cb(snap(path, p.new)))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'docs', filter: 'path=eq.' + path }, (p) => cb(snap(path, p.new)))
            // Supabase ne filtre pas les suppressions : on trie ici.
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'docs' }, (p) => { if (p.old && p.old.path === path) cb(snap(path, null)); })
            .subscribe();
        });
        return () => { gone = true; if (ch) sb.removeChannel(ch); };
      },
    };
  }
  function collection(name, steps = []) {
    const next = (st) => collection(name, steps.concat([st]));
    return {
      where: (f, op, v) => next(['where', f, op, v]),
      orderBy: (f, dir) => next(['order', f, dir]),
      limit: (n) => next(['limit', n]),
      async get() {
        await ready;
        let q = sb.from('docs').select('path,data').eq('coll', name);
        for (const [k, a, b, c] of steps) {
          if (k === 'where' && b === '==') q = q.eq('data->>' + a, String(c));
          if (k === 'order') q = q.order('data->' + a, { ascending: b !== 'desc' });
          if (k === 'limit') q = q.limit(a);
        }
        const rows = await must(q);
        return { docs: rows.map((r) => snap(r.path, r)), size: rows.length };
      },
    };
  }

  const TOPICS = ['move', 'emote'];
  function join(name) {
    return ready.then(() => new Promise((resolve, reject) => {
      const ch = sb.channel('room:' + name, { config: { broadcast: { self: false }, presence: { key: ME } } });
      const subs = {}, peerCbs = new Set();
      TOPICS.forEach((t) => ch.on('broadcast', { event: t }, (m) => (subs[t] || []).forEach((f) => f({ isMe: false, data: m.payload }))));
      ch.on('presence', { event: 'sync' }, () => peerCbs.forEach((f) => f()));
      const room = {
        emit: (t, data) => ch.send({ type: 'broadcast', event: t, payload: data }).then((r) => { if (r !== 'ok') throw fail({ message: 'envoi ' + r }); }),
        on: (t, f) => { (subs[t] = subs[t] || []).push(f); return () => { subs[t] = subs[t].filter((g) => g !== f); }; },
        onPeers: (f) => { peerCbs.add(f); return () => peerCbs.delete(f); },
        peers: () => Object.keys(ch.presenceState()).map((id) => ({ id, isMe: id === ME, kind: 'viewer' })),
        leave: () => sb.removeChannel(ch),
      };
      let done = false;
      ch.subscribe(async (st) => {
        if (st === 'SUBSCRIBED' && !done) { done = true; await ch.track({ at: Date.now() }).catch(() => {}); resolve(room); }
        if ((st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') && !done) { done = true; reject(fail({ message: st })); }
      });
    }));
  }

  const user = {
    id: () => ready.then((u) => u.id),
    can: () => ready.then(() => true),
    name: () => ready.then((u) => ((u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || '')),
    profiles: async () => ({}),
  };
  const caps = { db: { doc, collection }, user, room: { join } };
  window.claude = { use: (n) => (caps[n] ? ready.then(() => caps[n]) : Promise.reject(new Error('capacité inconnue : ' + n))) };

  // Connexion pour retrouver ses comptes sur un autre appareil. Un seul champ e-mail :
  // - session anonyme + e-mail nouveau → on rattache l'e-mail à ce compte (mêmes données) ;
  // - e-mail déjà connu → on se connecte à ce compte-là (les comptes de cet appareil y sont ajoutés).
  let pending = null;
  window.PASSERELLE_AUTH = {
    google: !!C.google,
    async state() { const u = await ready.then(() => sb.auth.getUser()).then((r) => r.data.user).catch(() => null); return { ok: !!u, anonymous: !u || !!u.is_anonymous, email: (u && u.email) || '' }; },
    async sendCode(email) {
      const u = (await sb.auth.getUser()).data.user;
      if (u && u.is_anonymous) {
        const r = await sb.auth.updateUser({ email }, { emailRedirectTo: here });
        if (!r.error) { pending = { email, type: 'email_change' }; return 'link'; }
        if (!/already|exists|registered/i.test(r.error.message + r.error.code)) throw r.error;
      }
      const r = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: here } });
      if (r.error) throw r.error;
      pending = { email, type: 'email' };
      return 'login';
    },
    async verify(code) {
      if (!pending) throw new Error('Demande d’abord un code.');
      const r = await sb.auth.verifyOtp({ email: pending.email, token: String(code).trim(), type: pending.type });
      if (r.error) throw r.error;
      return pending.type;
    },
    async withGoogle() {
      const u = (await sb.auth.getUser()).data.user;
      const r = u && u.is_anonymous ? await sb.auth.linkIdentity({ provider: 'google', options: { redirectTo: here } }) : { error: true };
      if (r.error) { const o = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: here } }); if (o.error) throw o.error; }
    },
    logout: () => sb.auth.signOut(),
  };
})();
