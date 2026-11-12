// version.js — which build is this, and has a newer one been deployed?
//
// The version (package.json) and build (the commit it was built from) are baked
// in by vite.config.js, which also writes them to version.json beside the app.
// The label is shown at the foot of the welcome card so a bug report can say
// exactly what it was seen on.
//
// A fresh launch always gets the newest deploy (the service worker serves the
// page network-first), so staleness is a long-lived-session problem: an
// installed app resumed from the background days later, or a launch on a flaky
// link that fell back to the cached shell.  For those we re-read version.json
// now and then and, if the build has moved on, offer a refresh — never force one.

/* global __APP_VERSION__, __APP_BUILD__ */
export const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
export const BUILD = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'dev';
export const versionLabel = `v${VERSION} · ${BUILD}`;

// Pure: does this version.json describe a different build from the one running?
// Anything malformed is "no" — a captive portal's HTML or a half-written file
// must never produce a prompt.
export function isDifferentBuild(remote, build = BUILD) {
  if (build === 'dev' || !remote || typeof remote !== 'object') return false;
  if (typeof remote.build !== 'string' || !/^[0-9a-f]{7,40}$/.test(remote.build)) return false;
  return remote.build !== build;
}

const MIN_GAP_MS = 5 * 60_000;          // never ask the server more often than this
const FIRST_CHECK_MS = 30_000;          // catches a launch that fell back to a stale cached shell
const EVERY_MS = 6 * 60 * 60_000;       // a tab left open for days

// Calls onUpdate(remote) at most once, the first time a different build is seen.
export function initUpdateCheck({ onUpdate }) {
  if (BUILD === 'dev') return;           // local dev has no version.json to compare with
  let last = 0, found = false;
  async function check() {
    if (found || document.hidden || Date.now() - last < MIN_GAP_MS) return;
    last = Date.now();
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: 'no-store' });
      if (!res.ok) return;
      const remote = await res.json();
      if (isDifferentBuild(remote)) { found = true; onUpdate(remote); }
    } catch { /* offline, or not JSON — try again later */ }
  }
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('online', check);
}
