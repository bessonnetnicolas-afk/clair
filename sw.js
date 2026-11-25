/* =========================================================
   Service worker — fonctionnement hors ligne
   - Coquille de l'appli : en cache à l'installation
   - Images Open Food Facts : mises en cache à la volée
   - API Open Food Facts : jamais en cache ici (gérée par IndexedDB dans app.js)
   ========================================================= */
const CACHE = 'clair-v1';      // ← change ce numéro à chaque mise à jour des fichiers
const IMG_CACHE = 'clair-img';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'];

/* ----- Installation : mise en cache de la coquille ----- */
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

/* ----- Activation : suppression des anciens caches ----- */
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== IMG_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* ----- Requêtes ----- */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Fichiers de l'appli : cache d'abord, réseau sinon
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
    return;
  }

  // Images produits : cache d'abord, puis enregistrement
  if (url.hostname.startsWith('images.openfoodfacts')) {
    e.respondWith(caches.open(IMG_CACHE).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      c.put(e.request, res.clone());
      return res;
    }));
  }
});
