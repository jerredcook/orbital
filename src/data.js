// data.js — catalog acquisition.
// TLEs:    CelesTrak "active" group (~11–14k objects), refreshed every few hours.
// SATCAT:  CelesTrak satellite catalog CSV — owner, launch date, launch site, etc.
// Both endpoints send CORS headers, so this works straight from the browser.
// Be polite: CelesTrak rate-limits aggressive clients, so responses are cached.

const gp = (group) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;

// A snapshot bundled with the app (tools/fetch-fallback-tle.mjs).  Last-resort
// source for the main catalog when CelesTrak is unreachable AND there's no warm
// cache — so the sky is never empty.  Base-relative for the GitHub Pages subpath.
const FALLBACK_ACTIVE = `${import.meta.env.BASE_URL}fallback/active.tle`;

// 'active' is everything operational; the debris groups are the three big
// fragmentation events still tracked with public element sets.
const TLE_GROUPS = [
  { cacheKey: 'orbital.tle.active', url: gp('active'), kind: 'SAT', fallback: FALLBACK_ACTIVE },
  { cacheKey: 'orbital.tle.cosmos2251', url: gp('cosmos-2251-debris'), kind: 'DEB' },
  { cacheKey: 'orbital.tle.iridium33', url: gp('iridium-33-debris'), kind: 'DEB' },
  { cacheKey: 'orbital.tle.fengyun1c', url: gp('fengyun-1c-debris'), kind: 'DEB' },
];

const SATCAT_URL = 'https://celestrak.org/pub/satcat.csv';
export const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const SATCAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // metadata changes slowly — a week is fine

// Big bodies (element sets ~2.7 MB, parsed SATCAT ~1.5 MB) live in the Cache
// Storage API: localStorage's ~5 MB quota silently rejected them (Safari/Firefox
// always, Chrome once both were present), so every visit re-downloaded
// everything.  A tiny localStorage stamp keeps the timestamp so the sync
// cacheExpiresInMs() below still works.
const DATA_CACHE = 'orbital-data-v1';
const bodyUrl = (key) => `/__data/${key}`;
async function cachePut(key, body) {
  try {
    const c = await caches.open(DATA_CACHE);
    await c.put(bodyUrl(key), new Response(body));
    localStorage.setItem(key, JSON.stringify({ t: Date.now() }));
  } catch { /* private mode / no Cache API — skip caching */ }
}
async function cacheBody(key) {
  try {
    const c = await caches.open(DATA_CACHE);
    const hit = await c.match(bodyUrl(key));
    return hit ? await hit.text() : null;
  } catch { return null; }
}
function cacheAgeOk(key, ttl) {
  try {
    const s = localStorage.getItem(key);
    if (!s) return false;
    return Date.now() - JSON.parse(s).t < ttl;
  } catch { return false; }
}

/** Milliseconds until the oldest cached element set expires (0 = stale now). */
export function cacheExpiresInMs() {
  let soonest = Infinity;
  for (const g of TLE_GROUPS) {
    try {
      const hit = localStorage.getItem(g.cacheKey);
      if (!hit) return 0;
      const { t } = JSON.parse(hit);
      soonest = Math.min(soonest, t + CACHE_TTL_MS - Date.now());
    } catch { return 0; }
  }
  return Math.max(0, soonest);
}

// Circuit breaker: once a CelesTrak request fails/times out, skip live fetches to
// it for a cooldown so the rest of this load — and subsequent reloads — drop
// straight to cache/fallback instead of eating a 15 s timeout per request.  The
// flag lives in localStorage so a reload during an outage is near-instant; it
// expires on its own, and a successful fetch clears it immediately.
const CELESTRAK_COOLDOWN_MS = 10 * 60 * 1000;
const isCelestrak = (url) => url.includes('celestrak');
function celestrakDown() {
  try { return Number(localStorage.getItem('orbital.celestrak.down') || 0) > Date.now(); } catch { return false; }
}
function markCelestrak(down) {
  try {
    if (down) localStorage.setItem('orbital.celestrak.down', String(Date.now() + CELESTRAK_COOLDOWN_MS));
    else localStorage.removeItem('orbital.celestrak.down');
  } catch { /* ignore */ }
}

async function cachedFetch(key, url, fallbackUrl, ttl = CACHE_TTL_MS) {
  let stale = null;
  {
    const body = await cacheBody(key);
    if (body !== null) {
      if (cacheAgeOk(key, ttl)) return body;
      stale = body;   // expired — keep as fallback if the refetch fails
    }
  }

  // Bound the request: a rate-limited CelesTrak doesn't always answer with a
  // quick 403 — it can just hang the connection, which without a timeout would
  // leave the catalog stuck on "fetching…" forever and never reach the stale
  // fallback below.  Give a cold load room to pull ~4 MB, but bail fast when we
  // already have yesterday's elements to fall back on.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), stale !== null ? 8000 : 15000);
  try {
    // Skip the live fetch entirely if CelesTrak is in its post-failure cooldown.
    if (isCelestrak(url) && celestrakDown()) throw new Error('celestrak-cooldown');
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const body = await res.text();
    if (isCelestrak(url)) markCelestrak(false);   // it's back — clear the breaker
    if (ttl > 0) await cachePut(key, body);   // ttl 0 = pass-through (raw SATCAT is cached parsed, not raw)
    return body;
  } catch (err) {
    // Trip the breaker on a real failure (not on a cooldown-skip, which mustn't
    // keep extending it — let it expire so we retry CelesTrak later).
    if (isCelestrak(url) && err.message !== 'celestrak-cooldown') markCelestrak(true);
    // CelesTrak rate-limits (HTTP 403, or a stalled connection) clients that
    // re-fetch the big files too often.  Yesterday's elements beat no elements…
    if (stale !== null) {
      console.warn(`${url} failed — serving stale cache`, err);
      return stale;
    }
    // …and a bundled snapshot beats an empty sky.  Same-origin, so it's reliable
    // even when CelesTrak is down.  Not cached, so the next load still tries live.
    if (fallbackUrl) {
      try {
        const fb = await fetch(fallbackUrl);
        if (fb.ok) {
          console.warn(`${url} failed — using bundled fallback ${fallbackUrl}`, err);
          return await fb.text();
        }
      } catch { /* fall through to throw */ }
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a 3-line-element text blob into [{ name, l1, l2, norad }]. */
export function parseTLEs(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length + 1; ) {
    if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      const l1 = lines[i + 1];
      // International designator (cols 10-11) gives the launch year, 2-digit with
      // a 1957 pivot — so every object carries its launch year with no SATCAT.
      const yy = parseInt(l1.slice(9, 11), 10);
      const launchYear = Number.isNaN(yy) ? null : (yy < 57 ? 2000 + yy : 1900 + yy);
      out.push({
        name: lines[i].trim(),
        l1,
        l2: lines[i + 2],
        norad: parseInt(l1.slice(2, 7), 10),
        launchYear,
      });
      i += 3;
    } else {
      i += 1;
    }
  }
  return out;
}

/** Epoch of a TLE line 1 as ms since the Unix epoch (UTC).  Columns 19–32:
 *  2-digit year (1957 pivot) + fractional day-of-year. */
export function tleEpochMs(l1) {
  const yy = parseInt(l1.slice(18, 20), 10);
  const doy = parseFloat(l1.slice(20, 32));
  if (Number.isNaN(yy) || Number.isNaN(doy)) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return Date.UTC(year, 0, 1) + (doy - 1) * 86400000;
}

/** Median TLE epoch (ms) across a catalog — a robust "how fresh is this data". */
export function medianEpochMs(list) {
  const es = [];
  for (const s of list) { const e = tleEpochMs(s.l1); if (e != null) es.push(e); }
  if (!es.length) return null;
  es.sort((a, b) => a - b);
  return es[es.length >> 1];
}

/** Minimal CSV row parser that honors quoted fields. */
function splitCSV(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Parse SATCAT CSV into a Map keyed by NORAD ID, keeping only IDs we care about.
 * Columns (header names) used: OBJECT_NAME, OBJECT_ID, NORAD_CAT_ID, OWNER,
 * LAUNCH_DATE, LAUNCH_SITE, PERIOD, INCLINATION, APOGEE, PERIGEE, OBJECT_TYPE.
 */
export function parseSatcat(csv, wantedIds) {
  const lines = csv.split(/\r?\n/);
  const header = splitCSV(lines[0]);
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = splitCSV(lines[i]);
    const id = parseInt(f[col.NORAD_CAT_ID], 10);
    if (!wantedIds.has(id)) continue;
    map.set(id, {
      intlDes: f[col.OBJECT_ID] || '',
      owner: f[col.OWNER] || '',
      launchDate: f[col.LAUNCH_DATE] || '',
      launchSite: f[col.LAUNCH_SITE] || '',
      period: parseFloat(f[col.PERIOD]) || null,
      inclination: parseFloat(f[col.INCLINATION]) || null,
      apogee: parseFloat(f[col.APOGEE]) || null,
      perigee: parseFloat(f[col.PERIGEE]) || null,
      type: f[col.OBJECT_TYPE] || '',
    });
  }
  return map;
}

// TLE line-2 fixed-column fields (NORAD 2-line element format).
export const tleMeanMotion = (l2) => parseFloat(l2.slice(52, 63));                  // revs/day
export const tleInclination = (l2) => parseFloat(l2.slice(8, 16));                  // degrees
export const tleEccentricity = (l2) => parseFloat(`0.${l2.slice(26, 33).trim()}`); // leading decimal point implied

/** Classify orbit regime from period (minutes) / eccentricity-ish apsis spread. */
export function classifyRegime(meta, meanMotion) {
  // meanMotion: revs/day from TLE line 2 — fallback when SATCAT has no period.
  const period = meta?.period ?? (meanMotion ? 1440 / meanMotion : null);
  const apo = meta?.apogee, per = meta?.perigee;
  if (apo != null && per != null && apo - per > 10000) return 'HEO';
  if (period == null) return 'LEO';
  if (period < 128) return 'LEO';          // < ~2000 km circular
  if (period > 1300 && period < 1560) return 'GEO';
  if (period >= 1560) return 'HEO';   // the apo−per HEO case is already caught above
  return 'MEO';
}

// SATCAT metadata: the raw CSV is 6.6 MB and only ~15k rows / 9 fields matter,
// so what gets cached is the PARSED subset (~1.5 MB, 7-day TTL — launch dates
// don't churn).  The CSV download, when needed, starts in parallel with the
// element sets instead of after them, so it's off the cold-load critical path.
const SATCAT_KEY = 'orbital.satcat.parsed';
async function loadSatcat(ids, csvPromise) {
  if (cacheAgeOk(SATCAT_KEY, SATCAT_TTL_MS)) {
    const body = await cacheBody(SATCAT_KEY);
    if (body) {
      try { return new Map(JSON.parse(body)); } catch { /* corrupt — refetch */ }
    }
  }
  const csv = await csvPromise;
  if (!csv) {
    const stale = await cacheBody(SATCAT_KEY);   // expired beats absent
    if (stale) { try { return new Map(JSON.parse(stale)); } catch { /* corrupt */ } }
    throw new Error('satcat fetch failed');
  }
  const map = parseSatcat(csv, ids);
  await cachePut(SATCAT_KEY, JSON.stringify([...map]));
  return map;
}

export async function loadCatalog(onStatus) {
  onStatus?.('fetching element sets…');
  // If the parsed SATCAT cache is stale, start the (big) CSV download NOW so it
  // rides alongside the element-set fetches instead of after them.
  const satcatCsvPromise = cacheAgeOk(SATCAT_KEY, SATCAT_TTL_MS)
    ? null
    : cachedFetch('orbital.satcat.csv', SATCAT_URL, null, 0).catch((e) => { console.warn('satcat fetch failed', e); return null; });
  // A group that fails entirely (no cache, fetch refused) is skipped rather
  // than failing the whole load — a partial catalog still renders.
  const texts = await Promise.all(
    TLE_GROUPS.map(async (g) => {
      try {
        return await cachedFetch(g.cacheKey, g.url, g.fallback);
      } catch (err) {
        console.warn(`element-set group unavailable: ${g.url}`, err);
        return '';
      }
    }),
  );
  if (texts.every((t) => !t)) throw new Error('no element sets available');

  // Merge groups, first occurrence wins ('active' is first, so anything that
  // somehow appears in both keeps its operational classification).
  const seen = new Set();
  const tles = [];
  for (let g = 0; g < TLE_GROUPS.length; g++) {
    for (const t of parseTLEs(texts[g])) {
      if (seen.has(t.norad)) continue;
      seen.add(t.norad);
      tles.push({ ...t, kind: TLE_GROUPS[g].kind });
    }
  }

  onStatus?.(`parsing metadata for ${tles.length.toLocaleString()} objects…`);
  let satcat = new Map();
  try {
    satcat = await loadSatcat(seen, satcatCsvPromise);
  } catch (e) {
    console.warn('SATCAT unavailable — continuing with TLE-only metadata', e);
  }

  return tles.map((t) => {
    const meta = satcat.get(t.norad) || null;
    const meanMotion = tleMeanMotion(t.l2) || null;
    return { ...t, meta, regime: classifyRegime(meta, meanMotion) };
  });
}
