// data.js — catalog acquisition.
// TLEs:    CelesTrak "active" group (~11–14k objects), refreshed every few hours.
// SATCAT:  CelesTrak satellite catalog CSV — owner, launch date, launch site, etc.
// Both endpoints send CORS headers, so this works straight from the browser.
// Be polite: CelesTrak rate-limits aggressive clients, so responses are cached.

const gp = (group) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;

// 'active' is everything operational; the debris groups are the three big
// fragmentation events still tracked with public element sets.
const TLE_GROUPS = [
  { cacheKey: 'orbital.tle.active', url: gp('active'), kind: 'SAT' },
  { cacheKey: 'orbital.tle.cosmos2251', url: gp('cosmos-2251-debris'), kind: 'DEB' },
  { cacheKey: 'orbital.tle.iridium33', url: gp('iridium-33-debris'), kind: 'DEB' },
  { cacheKey: 'orbital.tle.fengyun1c', url: gp('fengyun-1c-debris'), kind: 'DEB' },
];

const SATCAT_URL = 'https://celestrak.org/pub/satcat.csv';
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

async function cachedFetch(key, url) {
  try {
    const hit = localStorage.getItem(key);
    if (hit) {
      const { t, body } = JSON.parse(hit);
      if (Date.now() - t < CACHE_TTL_MS) return body;
    }
  } catch { /* cache miss or corrupt — fall through */ }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const body = await res.text();
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), body }));
  } catch { /* quota exceeded — fine, just skip caching */ }
  return body;
}

/** Parse a 3-line-element text blob into [{ name, l1, l2, norad }]. */
export function parseTLEs(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length + 1; ) {
    if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      const l1 = lines[i + 1];
      out.push({
        name: lines[i].trim(),
        l1,
        l2: lines[i + 2],
        norad: parseInt(l1.slice(2, 7), 10),
      });
      i += 3;
    } else {
      i += 1;
    }
  }
  return out;
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

/** Classify orbit regime from period (minutes) / eccentricity-ish apsis spread. */
export function classifyRegime(meta, meanMotion) {
  // meanMotion: revs/day from TLE line 2 — fallback when SATCAT has no period.
  const period = meta?.period ?? (meanMotion ? 1440 / meanMotion : null);
  const apo = meta?.apogee, per = meta?.perigee;
  if (apo != null && per != null && apo - per > 10000) return 'HEO';
  if (period == null) return 'LEO';
  if (period < 128) return 'LEO';          // < ~2000 km circular
  if (period > 1300 && period < 1560) return 'GEO';
  if (period >= 1560 || (apo != null && per != null && apo - per > 10000)) return 'HEO';
  return 'MEO';
}

export async function loadCatalog(onStatus) {
  onStatus?.('fetching element sets…');
  const texts = await Promise.all(
    TLE_GROUPS.map((g) => cachedFetch(g.cacheKey, g.url)),
  );

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
  const ids = seen;
  let satcat = new Map();
  try {
    const satcatCsv = await cachedFetch('orbital.satcat', SATCAT_URL);
    satcat = parseSatcat(satcatCsv, ids);
  } catch (e) {
    console.warn('SATCAT unavailable — continuing with TLE-only metadata', e);
  }

  return tles.map((t) => {
    const meta = satcat.get(t.norad) || null;
    const meanMotion = parseFloat(t.l2.slice(52, 63)) || null;
    return { ...t, meta, regime: classifyRegime(meta, meanMotion) };
  });
}
