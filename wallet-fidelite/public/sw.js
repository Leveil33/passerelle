// Service worker de l'appli commerçant.
// Il rend l'appli installable et affiche une page claire quand il n'y a pas de réseau.
// Il ne garde JAMAIS en mémoire les pages ni les données (cartes, clients) : tout est toujours demandé au serveur.
const CACHE = "fidelite-hors-ligne-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([OFFLINE_URL, "/icons/icon-192.png"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Seules les navigations (ouverture d'une page) sont concernées ; tout le reste (API, images…) passe tel quel.
  if (request.mode !== "navigate") return;
  event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
});
