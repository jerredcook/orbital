// data.js — catalog acquisition.
//
// The satellite data comes from THIS SITE, not from CelesTrak: the deploy
// fetches CelesTrak's lists every four hours and publishes them beside the app
// as data/active.tle, inactive.tle, rocketbodies.tle, debris.tle, satcat.json and meta.json
// (tools/fetch-data.mjs, tools/satellite-data.mjs).  A browser never contacts
// CelesTrak.  Until 0.4.0 every visitor downloaded ~9 MB straight from it —
// impolite to a free service that firewalls heavy clients, and for one visitor
// in four the download never arrived in time.
//
// What a browser does:
//   • keeps the last data it downloaded (Cache Storage) with its stamp;
//   • on every page load, and every 30 minutes after that, asks for meta.json
//     — a few hundred bytes — and downloads the lists again only when the
//     stamp has changed.  So a reload always shows the latest data;
//   • draws its saved copy first (loadCatalogLocal) so a returning visitor
//     never waits on the network at all.

import { track } from './analytics.js';
import { mergeGroups, withMeta } from './catalog-parse.js';

export * from './catalog-parse.js';

const DATA_URL = `${import.meta.env.BASE_URL}data/`;
// The snapshot committed with the code (refreshed weekly) — the last resort if
// data/ cannot be read and nothing is saved, so the sky is never empty.
const FALLBACK_ACTIVE = `${import.meta.env.BASE_URL}fallback/active.tle`;

/** How often a browser asks the site whether there is newer data. */
export const CHECK_EVERY_MS = 30 * 60 * 1000;
const MIN_OBJECTS = 500;   // fewer than this is not a catalog — a truncated or corrupt copy

// ---- what this device has saved ----
// The bodies (~4 MB) live in the Cache Storage API — localStorage's ~5 MB quota
// silently rejects them — and a small localStorage record says which data they
// are and when the site was last asked for newer.
const DATA_CACHE = 'orbital-data-v2';
const STATE_KEY = 'orbital.data';
// (inactive.tle and rocketbodies.tle arrived in 0.5.0; a copy saved before then has neither, and reads as none)
const ELEMENTS = [['active', 'SAT'], ['inactive', 'DEAD'], ['rocketbodies', 'RB'], ['debris', 'DEB']];   // file → kind, in merge order
const BODIES = [...ELEMENTS.map(([k]) => k), 'satcat'];
const bodyUrl = (key) => `/__data/${key}`;

function readState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    return s && typeof s.stamp === 'string' && Number.isFinite(s.t) ? s : null;
  } catch { return null; }
}
function writeState(state) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* private mode / quota */ }
}
async function savedBodies() {
  try {
    const c = await caches.open(DATA_CACHE);
    const got = await Promise.all(BODIES.map(async (k) => {
      const hit = await c.match(bodyUrl(k));
      return hit ? hit.text() : null;
    }));
    const saved = Object.fromEntries(BODIES.map((k, i) => [k, got[i] ?? (k === 'satcat' ? '[]' : '')]));
    return saved.active ? saved : null;
  } catch { return null; }   // private mode / no Cache API
}
// What this PAGE downloaded, whether or not it could be saved: in a private
// window (no Cache Storage) nothing persists, and without this the app would
// download the lists again on every half-hourly check.
let shown = null;   // { stamp, t, fetchedAt }
async function saveBodies(bodies, state) {
  shown = { stamp: state.stamp, t: state.t, fetchedAt: state.fetchedAt ?? null };
  try {
    const c = await caches.open(DATA_CACHE);
    await Promise.all(BODIES.map((k) => c.put(bodyUrl(k), new Response(bodies[k]))));
    writeState(state);
  } catch { /* private mode / no Cache API — nothing saved, the next load downloads again */ }
}

// Before 0.4.0 the lists came from CelesTrak and were saved under other names.
// Free that space (about 4 MB) on devices that visited then.
try {
  for (const k of ['orbital.tle.active', 'orbital.tle.cosmos2251', 'orbital.tle.iridium33', 'orbital.tle.fengyun1c',
    'orbital.satcat.parsed', 'orbital.satcat.csv', 'orbital.celestrak.down']) localStorage.removeItem(k);
  globalThis.caches?.delete('orbital-data-v1').catch(() => {});
} catch { /* storage blocked */ }

/** When the data on screen was fetched from its sources (ms), or null if that is not known (the bundled snapshot). */
export function dataFetchedAt() {
  const at = (readState() ?? shown)?.fetchedAt;
  return Number.isFinite(at) ? at : null;
}

/** Milliseconds until the site should next be asked for newer data (0 = now). */
export function cacheExpiresInMs() {
  const s = readState() ?? shown;
  if (!s || s.t > Date.now()) return 0;   // nothing saved, or a clock that has been set back
  return Math.max(0, s.t + CHECK_EVERY_MS - Date.now());
}

// ---- turning the files into the catalog ----
function build(bodies) {
  const { satcat } = bodies;
  const { tles } = mergeGroups(ELEMENTS.map(([file, kind]) => ({ text: bodies[file] ?? '', kind })));
  let details = new Map();
  try {
    const rows = JSON.parse(satcat || '[]');
    if (Array.isArray(rows)) details = new Map(rows);
  } catch { /* no details — owner and launch site are blank, everything else works */ }
  return withMeta(tles, details);
}

// ---- the network ----
class BadData extends Error { constructor(msg) { super(msg); this.name = 'BadData'; } }

// What meta.json last said — among other things, whether there is an about.json.
let lastMeta = null;

// Photos, descriptions and end-of-life dates (tools/about-data.mjs), fetched the
// first time something is selected and kept for the rest of the visit.
// Resolves the { number: record } object, or null when there is none to be had
// (an older site, a laptop build without it, no connection) — the panel then
// simply shows what it always did.
let aboutPromise = null, aboutStamp = null;
export function loadAbout() {
  const stamp = lastMeta?.about?.stamp;
  if (typeof stamp !== 'string' || !/^[0-9a-f]{8,64}$/.test(stamp)) return Promise.resolve(null);
  if (aboutPromise && aboutStamp === stamp) return aboutPromise;
  aboutStamp = stamp;
  aboutPromise = get(`${DATA_URL}about.json?v=${stamp}`, 20000)
    .then((text) => { const d = JSON.parse(text); return d?.v === 1 && d.objects && typeof d.objects === 'object' ? d.objects : null; })
    .catch(() => { aboutPromise = null; return null; });   // try again on the next selection
  return aboutPromise;
}

// Why new data did not arrive, as a bare category for the anonymous counts
// (analytics.js) — no address, status text or message leaves the browser.
//   timeout   it did not finish inside the time allowed (a hung or slow link)
//   http-4xx  the site answered "not found" or refused
//   http-5xx  the site's host is having trouble of its own
//   network   no answer at all: offline, blocked, DNS, a reset connection
//   bad-data  it answered, but not with satellite data (a captive portal's page, a cut-off file)
export function feedFailureKind(err) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'timeout';
  if (err?.name === 'BadData' || err?.name === 'SyntaxError') return 'bad-data';
  const http = /HTTP (\d)\d\d\b/.exec(String(err?.message ?? err ?? ''));
  if (http) return http[1] === '4' ? 'http-4xx' : http[1] === '5' ? 'http-5xx' : 'http-other';
  return 'network';
}

// Every request is bounded: a connection that hangs must not leave the app
// waiting forever.  (The timer covers the body too, not just the headers.)
async function get(url, ms, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The catalog from what this device already has — no network, so it returns in
 * the time it takes to read a file.  Boot draws this first and then asks
 * loadCatalog() for anything newer.  Resolves null on a first visit (or when
 * the saved copy is unusable).
 */
export async function loadCatalogLocal() {
  const saved = await savedBodies();
  if (!saved) return null;
  const list = build(saved);
  return list.length >= MIN_OBJECTS ? list : null;
}

/**
 * The current catalog from the site.
 *
 *   have     the caller is already showing this device's saved copy; if the
 *            site has nothing newer, resolve null instead of rebuilding it.
 *   patient  the visitor is already looking at satellites, so a slow link gets
 *            more time before being given up on.
 *
 * If the site cannot be reached: the saved copy, else the committed snapshot,
 * else it throws.
 */
export async function loadCatalog(onStatus, { patient = false, have = false } = {}) {
  const [saved, state] = [await savedBodies(), readState()];
  try {
    onStatus?.('checking for new satellite data…');
    const meta = JSON.parse(await get(`${DATA_URL}meta.json`, patient ? 15000 : 8000, { cache: 'no-store' }));
    if (!meta || typeof meta.stamp !== 'string' || !/^[0-9a-f]{8,64}$/.test(meta.stamp)) throw new BadData('meta.json has no stamp');
    lastMeta = meta;
    if (have && shown?.stamp === meta.stamp) { shown.t = Date.now(); return null; }   // this page already has it (unsaved: private mode)
    if (saved && state?.stamp === meta.stamp) {
      // Nothing newer.  Note that we asked, so the next 30 minutes ask nothing.
      const same = have ? null : build(saved);
      if (have || same.length >= MIN_OBJECTS) {
        writeState({ ...state, t: Date.now() });
        return same;
      }
    }
    onStatus?.('fetching element sets…');
    // ?v=<stamp>: a browser or CDN cache can never answer with an older file
    // than the one meta.json just described.
    const q = `?v=${meta.stamp}`;
    const limit = patient ? 30000 : 20000;
    let complete = true;
    const optional = (name, fallback) => get(`${DATA_URL}${name}${q}`, limit).catch((err) => {
      console.warn(`${name} unavailable — continuing without it`, err);
      complete = false;
      return fallback;
    });
    // Which files this data set has: one built from CelesTrak alone (a fork, a
    // laptop) has no dead satellites or rocket bodies, and says so in its counts
    // — so nothing asks for files that are not there.
    const has = (k) => (meta.counts?.[k] ?? 0) > 0;
    const [active, inactive, rocketbodies, debris, satcat] = await Promise.all([
      get(`${DATA_URL}active.tle${q}`, limit),
      has('inactive') ? optional('inactive.tle', saved?.inactive ?? '') : '',
      has('rocketbodies') ? optional('rocketbodies.tle', saved?.rocketbodies ?? '') : '',
      optional('debris.tle', saved?.debris ?? ''),
      optional('satcat.json', saved?.satcat ?? '[]'),
    ]);
    const bodies = { active, inactive, rocketbodies, debris, satcat };
    onStatus?.('parsing the catalog…');
    const list = build(bodies);
    if (list.length < MIN_OBJECTS) throw new BadData('the active list is not a catalog');
    // Saved only when all three files arrived: a partial set is shown, but the
    // stamp stays unsaved so the next check fetches the rest.
    if (complete) await saveBodies(bodies, { stamp: meta.stamp, fetchedAt: Number(meta.fetchedAt) || null, t: Date.now() });
    return list;
  } catch (err) {
    track(`degraded/feed-${feedFailureKind(err)}`);
    // Yesterday's elements beat no elements…
    if (saved) {
      const list = build(saved);
      if (list.length >= MIN_OBJECTS) {
        console.warn('new satellite data unavailable — keeping the saved copy', err);
        track('degraded/catalog-stale');
        return have ? null : list;
      }
    }
    // …and the committed snapshot beats an empty sky.  Not saved, so the next
    // load asks the site again.
    try {
      const fb = await fetch(FALLBACK_ACTIVE);
      if (fb.ok) {
        const list = build({ active: await fb.text(), satcat: '[]' });
        if (list.length >= MIN_OBJECTS) {
          console.warn('satellite data unavailable — using the snapshot bundled with the app', err);
          track('degraded/catalog-bundled');
          return list;
        }
      }
    } catch { /* fall through */ }
    throw err;
  }
}
