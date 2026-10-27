// Cache de l'appli : le jeu s'ouvre hors connexion. Le serveur Supabase n'est jamais mis en cache.
const CACHE = 'passerelle-v7a7160aff6';
const CORE = ['./', 'index.html', 'config.js', 'supabase-adapter.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  // Les musiques se lisent par morceaux (requêtes « Range ») : on laisse le navigateur s'en charger.
  if (req.method !== 'GET' || /supabase\.(co|in)$/.test(url.hostname) || url.pathname.endsWith('.mp3')) return;
  const same = url.origin === location.origin;
  // Pages et réglages : le réseau d'abord (pour recevoir les mises à jour), le cache si on est hors ligne.
  const nav = req.mode === 'navigate';
  if (same && (nav || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/config.js'))) {
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; })
      .catch(() => caches.match(req, { ignoreSearch: nav }).then((r) => r || (nav ? caches.match('index.html') : Response.error()))));
    return;
  }
  // Le reste (scripts, polices, icônes) : le cache d'abord.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return r;
  })));
});
