// Faux window.claude pour les tests : base partagée entre onglets (localStorage + BroadcastChannel), salon, identité.
(() => {
  const uid = new URLSearchParams(location.search).get('u') || 'A';
  const NAMES = { A: 'Alice', B: 'Bob', C: 'Chloé' };
  const bc = new BroadcastChannel('mockdb'), listeners = new Map();
  const key = (p) => 'mockdb:' + p;
  const read = (p) => { const v = localStorage.getItem(key(p)); return v ? JSON.parse(v) : null; };
  const snap = (p) => { const d = read(p); return { id: p.split('/').pop(), exists: !!d, data: () => d || undefined, metadata: { fromCache: false, hasPendingWrites: false } }; };
  const notify = (p) => { (listeners.get(p) || []).forEach((f) => setTimeout(() => f(snap(p)), 5)); };
  bc.onmessage = (e) => notify(e.data);
  const write = (p, v) => { if (v === null) localStorage.removeItem(key(p)); else localStorage.setItem(key(p), JSON.stringify(v)); notify(p); bc.postMessage(p); };
  const docRef = (p) => ({ id: p.split('/').pop(), path: p,
    get: async () => snap(p),
    set: async (d) => write(p, JSON.parse(JSON.stringify(d))),
    update: async (d) => { const cur = read(p); if (!cur) throw { code: 'invalid_argument' }; write(p, { ...cur, ...JSON.parse(JSON.stringify(d)) }); },
    delete: async () => write(p, null),
    acquire: async () => ({ acquired: true }),
    onSnapshot: (next) => { const l = listeners.get(p) || []; l.push(next); listeners.set(p, l); setTimeout(() => next(snap(p)), 5); return () => { listeners.set(p, (listeners.get(p) || []).filter((f) => f !== next)); }; },
  });
  const query = (p, filters = []) => ({
    where: (f, op, v) => query(p, filters.concat([[f, v]])), limit: () => query(p, filters), orderBy: () => query(p, filters),
    get: async () => { const docs = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k.startsWith(key(p) + '/')) continue; const dp = k.slice(7); const d = read(dp); if (filters.every(([f, v]) => d[f] === v)) docs.push(snap(dp)); } return { docs, size: docs.length, empty: !docs.length }; },
  });
  const db = { doc: docRef, collection: (p) => ({ ...query(p), path: p, doc: (id) => docRef(p + '/' + id) }) };
  const noid = new URLSearchParams(location.search).has('noid');
  const user = { name: async () => NAMES[uid] || '', id: async () => (noid ? null : uid), can: async () => true, canEdit: async () => true, isOwner: async () => uid === 'A',
    profiles: async (ids) => Object.fromEntries([].concat(ids).filter(Boolean).map((i) => [i, { id: i, name: NAMES[i] || '', isMe: i === uid }])), me: async () => ({ id: uid, name: NAMES[uid] }) };
  const peer = Math.random().toString(36).slice(2);
  const room = { join: async (name) => {
    const ch = new BroadcastChannel('room:' + name), handlers = {}, peers = new Map(), peerH = [];
    const mePeer = { peer, by: uid, isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: {}, updatedAt: Date.now() };
    const firePeers = () => peerH.forEach((h) => h({ peers: [mePeer, ...peers.values()], joined: [], left: [], updated: [] }));
    ch.onmessage = (e) => { const m = e.data; if (m.t === 'hello' || m.t === 'here') { if (!peers.has(m.peer)) { peers.set(m.peer, { peer: m.peer, by: m.by, isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: {}, updatedAt: Date.now() }); firePeers(); } if (m.t === 'hello') ch.postMessage({ t: 'here', peer, by: uid }); } else if (m.t === 'bye') { peers.delete(m.peer); firePeers(); } else if (m.t === 'ev') (handlers[m.topic] || []).forEach((h) => h({ topic: m.topic, data: m.data, peer: m.peer, by: m.by, isMe: false, sameTab: false, kind: 'viewer', guest: false })); };
    ch.postMessage({ t: 'hello', peer, by: uid });
    addEventListener('beforeunload', () => ch.postMessage({ t: 'bye', peer }));
    return { name, emit: async (topic, data) => ch.postMessage({ t: 'ev', topic, data, peer, by: uid }), on: (topic, h) => { (handlers[topic] = handlers[topic] || []).push(h); return () => {}; },
      presence: async () => {}, peers: () => [mePeer, ...peers.values()], onPeers: (h) => { peerH.push(h); setTimeout(firePeers, 5); return () => {}; },
      connected: () => true, onConnection: () => () => {}, leave: async () => { ch.postMessage({ t: 'bye', peer }); ch.close(); } };
  } };
  const caps = { db, user, room };
  window.claude = { use: async (n) => caps[n] || null };
})();
