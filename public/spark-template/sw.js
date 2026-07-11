// Spark player package service worker — repeat-visit / offline caching for exported packages.
// Registered by player.js ONLY when manifest.player.offline is true (exporter dialog option) or
// forced via ?offline=on. Strategy:
//   - SHELL (index.html, player.js, manifest.json, the folder itself): NETWORK-FIRST — always
//     fresh while online (safe even if a package is re-uploaded in place), cache fallback offline.
//   - DATA (objects/, vendor/, audio, sw-scoped everything else): CACHE-FIRST — the heavy .spz
//     frames and vendored libs download once per device and replay from cache afterwards.
// Cache storage is per-origin and entries are keyed by full URL, so multiple packages on one host
// can safely share the cache name. Range requests (audio streaming) pass through to the network.

const CACHE = 'spark-pkg-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

const SHELL_RE = /(?:^|\/)(index\.html|player\.js|manifest\.json)$/;

const putSafe = (req, res) => {
  // storage quota / opaque failures must never break the response path
  caches.open(CACHE).then((c) => c.put(req, res)).catch(() => {});
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scopePath = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return;
  if (req.headers.has('range')) return;   // let the browser stream ranges directly

  const isShell = SHELL_RE.test(url.pathname) || url.pathname === scopePath;
  if (isShell) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) putSafe(req, res.clone());
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || Response.error()))
    );
  } else {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) putSafe(req, res.clone());
        return res;
      }))
    );
  }
});
