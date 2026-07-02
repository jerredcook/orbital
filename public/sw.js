// sw.js — the small service worker that makes Orbital installable as a PWA and
// speeds up repeat launches.  Orbital is inherently online (live TLEs, streamed
// imagery), so we don't pretend to run offline — we just:
//   • serve navigations network-first with a 3 s timeout, so a fresh GitHub
//     Pages deploy always wins on the next launch, but a flaky cellular link
//     falls back to the cached shell instead of hanging the installed app;
//   • cache the app's own hashed bundles stale-while-revalidate, so the second
//     open is fast and light on data;
//   • leave models/ and textures/ to the plain HTTP cache — they're large
//     (multi-MB), immutable-ish, and double-storing them bloated phones'
//     Cache Storage without making anything faster;
//   • leave cross-origin requests (map tiles, TLE feeds) untouched.
// Bump the version on strategy changes; activate() drops old app caches but
// spares the orbital-data-* caches data.js owns.
const CACHE = 'orbital-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('orbital-v') && k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

const HEAVY = (path) => path.includes('/models/') || path.includes('/textures/') || path.includes('/fallback/');

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // tiles / TLE feeds: straight to network
  if (url.pathname.startsWith('/__data/')) return;   // data.js's Cache API namespace, not ours
  if (HEAVY(url.pathname)) return;                   // big assets ride the HTTP cache

  if (req.mode === 'navigate') {                      // app shell: network-first (3 s) → cache fallback
    e.respondWith((async () => {
      const cached = caches.match(req);
      try {
        const res = await Promise.race([
          fetch(req),
          new Promise((_, rej) => setTimeout(() => rej(new Error('nav-timeout')), 3000)),
        ]);
        const c = res.clone();
        caches.open(CACHE).then((ca) => ca.put(req, c));
        return res;
      } catch {
        return (await cached) || fetch(req);   // last resort: let the request run to completion
      }
    })());
    return;
  }

  e.respondWith(                                       // hashed assets: stale-while-revalidate
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((hit) => {
        const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      }),
    ),
  );
});
