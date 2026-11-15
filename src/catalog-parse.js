// catalog-parse.js — turning CelesTrak's text into the app's catalog.
//
// Pure functions with no browser, network or build-tool dependencies, so the
// same code runs in three places: the app (data.js), the unit tests, and the
// build step that prepares the satellite data the site serves
// (tools/satellite-data.mjs).

// Catalogue numbers in element-set text.  The format has five characters for
// the number, and the catalogue passed 99,999 on 11 July 2026.  "Alpha-5" is the
// established way to keep going: the first character becomes a letter standing
// for 10–33 (A=10 … Z=33, with I and O left out because they look like 1 and
// 0), so A0000 is 100000 and Z9999 is 339999.  Plain numbers read as before.
const ALPHA5 = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ALPHA5_MAX = 339999;
export function alpha5ToNumber(field) {
  const s = String(field ?? '').trim();
  if (/^\d{1,5}$/.test(s)) return parseInt(s, 10);
  const lead = ALPHA5.indexOf(s[0]);
  if (s.length !== 5 || lead < 0 || !/^\d{4}$/.test(s.slice(1))) return NaN;
  return (lead + 10) * 10000 + parseInt(s.slice(1), 10);
}
/** The five-character field for a catalogue number, or null if it cannot be written (over 339999). */
export function numberToAlpha5(n) {
  if (!Number.isInteger(n) || n < 0 || n > ALPHA5_MAX) return null;
  if (n < 100000) return String(n).padStart(5, '0');
  return ALPHA5[Math.floor(n / 10000) - 10] + String(n % 10000).padStart(4, '0');
}
/** Matches the catalogue-number field of an element-set line (after its "1 " or "2 "). */
export const SATNUM_FIELD = '[ \\dA-HJ-NP-Z][ \\d]{4}';

// A fragment or a spent rocket stage, by CelesTrak's naming ("FENGYUN 1C DEB",
// "SL-6 R/B(2)").  The active list should contain none — but whatever a source
// hands us, junk is filed under Debris, never drawn and counted as a satellite.
export const isJunkName = (name) => /\bDEB\b|\bR\/B/.test(name);

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
        norad: alpha5ToNumber(l1.slice(2, 7)),
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


// Merge element-set texts into one list, first occurrence wins — the active
// list comes first, so anything that somehow appears in both it and a debris
// list keeps its operational classification.
//   groups: [{ text, kind: 'SAT' | 'DEB' }]
export function mergeGroups(groups) {
  const seen = new Set();
  const tles = [];
  for (const g of groups) {
    for (const t of parseTLEs(g.text || '')) {
      if (seen.has(t.norad)) continue;
      seen.add(t.norad);
      tles.push({ ...t, kind: isJunkName(t.name) ? 'DEB' : g.kind });
    }
  }
  return { tles, seen };
}

/** Attach catalog details (a Map by NORAD id) and the orbit regime to each element set. */
export const withMeta = (tles, satcat) => tles.map((t) => {
  const meta = satcat.get(t.norad) || null;
  const meanMotion = tleMeanMotion(t.l2) || null;
  return { ...t, meta, regime: classifyRegime(meta, meanMotion) };
});
