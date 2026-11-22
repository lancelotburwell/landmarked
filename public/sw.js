// Landmarked service worker: caches the app and Cesium's static files after the
// first visit, plus a bounded cache of map tiles. The build stamps a new id
// on every deploy, which retires old caches.
const BUILD = '__BUILD_ID__';
const APP = `landmarked-app-${BUILD}`;
const TILES = 'landmarked-tiles-v1';
const MAX_TILES = 1500;
const TILE_HOSTS = ['tiles.maps.eox.at'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('landmarked-app-') && k !== APP).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Page: network first so new deploys show up, cache as offline fallback.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(APP).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match(self.registration.scope))),
    );
    return;
  }

  // Same-origin static files (hashed JS/CSS, Cesium Workers/Assets, borders): cache first.
  if (url.origin === self.location.origin) {
    e.respondWith(cacheFirst(APP, req));
    return;
  }

  // Map tiles: cache first, bounded.
  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheFirst(TILES, req, MAX_TILES));
  }
});

async function cacheFirst(name, req, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') {
    cache.put(req, res.clone()).then(() => max && trim(cache, max));
  }
  return res;
}

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}
