// sw.js — the small service worker that makes Orbital installable as a PWA and
// speeds up repeat launches.  Orbital is inherently online (live TLEs, streamed
// imagery), so we don't pretend to run offline — we just:
//   • serve navigations network-first, so a fresh GitHub Pages deploy always
//     wins on the next launch (the installed app auto-updates);
//   • cache the app's *own* hashed assets stale-while-revalidate, so the second
//     open is fast and light on data;
//   • leave cross-origin requests (map tiles, TLE feeds) untouched.
const CACHE = 'orbital-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // tiles / TLE feeds: straight to network

  if (req.mode === 'navigate') {                      // app shell: network-first → cache fallback
    e.respondWith(
      fetch(req)
        .then((res) => { const c = res.clone(); caches.open(CACHE).then((ca) => ca.put(req, c)); return res; })
        .catch(() => caches.match(req)),
    );
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
