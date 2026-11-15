// omm.mjs — CelesTrak's OMM (CSV) element data, turned into the three-line
// element text the app reads.
//
// Why: catalogue numbers passed 99,999 on 11 July 2026.  The TLE text format has
// five characters for the number, and CelesTrak leaves newer objects out of
// its TLE-format answers altogether — so by November 2026 the app was missing
// about 1,400 objects, including four months of launches.  CelesTrak's OMM
// formats (CSV, JSON, XML) carry every object.
//
// The app's orbit code reads TLE lines (satellite.js 5), so rather than change
// every consumer at once, the build fetches CSV and writes element text itself,
// with "Alpha-5" numbers above 99,999 (src/catalog-parse.js) — the convention
// Space-Track uses for the same purpose.  SGP4 never uses the number, and the
// app decodes it for display.  The lines are column-exact and checksummed.
//
// Precision: for the newest objects the CSV carries a digit or two more than
// the text format holds (eccentricity to 8 places, drag term to 8 digits).
// Those are rounded to the format — the same precision every other object has
// always had.
//
// Pure — unit-tested against a real CelesTrak sample (tests/fixtures).

import { numberToAlpha5 } from '../src/catalog-parse.js';

export const REQUIRED_COLUMNS = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'NORAD_CAT_ID', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];

/** Minimal CSV row parser that honors quoted fields. */
function splitCSV(line) {
  if (!line.includes('"')) return line.split(',');
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

/** Parse OMM CSV into row objects keyed by the header's column names.  Throws if it is not OMM CSV. */
export function parseOmmCsv(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('empty');
  const header = splitCSV(lines[0]).map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`not OMM CSV — missing column${missing.length > 1 ? 's' : ''} ${missing.slice(0, 4).join(', ')}`);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCSV(lines[i]);
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = (f[c] ?? '').trim();
    rows.push(row);
  }
  return rows;
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// "2026-11-15T01:53:05.184672" → { yy: '26', day: '319.07853223' } (day of year, 1-based, UTC).
export function epochField(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(String(iso));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const micro = Number((m[7] ?? '').padEnd(6, '0').slice(0, 6));
  const doy = Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
  let day = doy + (h * 3_600_000_000 + mi * 60_000_000 + s * 1_000_000 + micro) / 86_400_000_000;
  const cap = (isLeap(y) ? 367 : 366) - 1e-8;      // never round up into a day the year does not have
  if (day > cap) day = cap;
  return { yy: String(y % 100).padStart(2, '0'), day: day.toFixed(8).padStart(12, '0') };
}

// ±.NNNNNNNN — the first derivative of mean motion (already halved, as the text format stores it).
function dotField(v) {
  const a = Math.min(Math.abs(v), 0.99999999);
  return (v < 0 ? '-' : ' ') + a.toFixed(8).slice(1);
}
// ±NNNNN±N — a decimal point is assumed before the five digits: 0.NNNNN × 10^±N.
export function expField(v) {
  if (!Number.isFinite(v) || v === 0) return ' 00000+0';
  const a = Math.abs(v);
  let e = Math.floor(Math.log10(a)) + 1;
  let m = Math.round((a / 10 ** e) * 1e5);
  if (m >= 100000) { m = 10000; e += 1; }
  if (m < 10000) { m *= 10; e -= 1; }             // guard against log10 landing a hair low
  if (e < -9) return ' 00000+0';                   // smaller than the format can say: zero
  if (e > 9) { m = 99999; e = 9; }
  return `${v < 0 ? '-' : ' '}${String(m).padStart(5, '0')}${e < 0 ? '-' : '+'}${Math.abs(e)}`;
}
const fixed = (v, width, places) => v.toFixed(places).padStart(width, ' ');
const checksum = (line) => {
  let sum = 0;
  for (const ch of line) sum += ch === '-' ? 1 : (ch >= '0' && ch <= '9' ? Number(ch) : 0);
  return String(sum % 10);
};
// "2026-237A" → "26237A  " (launch year, launch number, piece) — blank when there is none.
function designatorField(id) {
  const m = /^(\d{4})-(\d{3})([A-Z]{1,3})$/.exec(String(id ?? '').trim());
  return m ? `${m[1].slice(2)}${m[2]}${m[3].padEnd(3, ' ')}` : '        ';
}

/**
 * One OMM row → [name, line 1, line 2], or null with a reason when the row
 * cannot be written (a number over 339999, an unreadable date or element).
 */
export function ommToTle(row) {
  const norad = /^\d+$/.test(row.NORAD_CAT_ID ?? '') ? Number(row.NORAD_CAT_ID) : NaN;
  const id = norad >= 1 ? numberToAlpha5(norad) : null;
  if (!id) return { lines: null, why: `catalogue number ${row.NORAD_CAT_ID} cannot be written` };
  const epoch = epochField(row.EPOCH);
  if (!epoch) return { lines: null, why: `unreadable epoch ${JSON.stringify(row.EPOCH)}` };
  const n = (k) => Number(row[k]);
  const mm = n('MEAN_MOTION'), ecc = n('ECCENTRICITY'), inc = n('INCLINATION'), raan = n('RA_OF_ASC_NODE'), argp = n('ARG_OF_PERICENTER'), ma = n('MEAN_ANOMALY');
  if (![mm, ecc, inc, raan, argp, ma].every(Number.isFinite) || !(mm > 0 && mm < 100) || !(ecc >= 0 && ecc < 1)
    || inc < 0 || inc > 180 || raan < 0 || raan > 360 || argp < 0 || argp > 360 || ma < 0 || ma > 360) {
    return { lines: null, why: 'elements missing or out of range' };
  }
  const bstar = Number(row.BSTAR || 0), ndot = Number(row.MEAN_MOTION_DOT || 0), nddot = Number(row.MEAN_MOTION_DDOT || 0);
  const cls = /^[A-Z]$/.test(row.CLASSIFICATION_TYPE ?? '') ? row.CLASSIFICATION_TYPE : 'U';
  const ephem = /^\d$/.test(row.EPHEMERIS_TYPE ?? '') ? row.EPHEMERIS_TYPE : '0';
  const elset = String((Number(row.ELEMENT_SET_NO) || 0) % 10000).padStart(4, ' ');
  const rev = String((Number(row.REV_AT_EPOCH) || 0) % 100000).padStart(5, ' ');
  const eccDigits = String(Math.min(Math.round(ecc * 1e7), 9999999)).padStart(7, '0');

  let l1 = `1 ${id}${cls} ${designatorField(row.OBJECT_ID)} ${epoch.yy}${epoch.day} ${dotField(ndot)} ${expField(nddot)} ${expField(bstar)} ${ephem} ${elset}`;
  let l2 = `2 ${id} ${fixed(inc, 8, 4)} ${fixed(raan, 8, 4)} ${eccDigits} ${fixed(argp, 8, 4)} ${fixed(ma, 8, 4)} ${fixed(mm, 11, 8)}${rev}`;
  if (l1.length !== 68 || l2.length !== 68) return { lines: null, why: 'a field did not fit its columns' };
  l1 += checksum(l1); l2 += checksum(l2);
  const name = (row.OBJECT_NAME || `OBJECT ${norad}`).replace(/\s+/g, ' ').trim();
  return { lines: [name, l1, l2], norad };
}

/**
 * OMM CSV → three-line element text.  Returns { text, count, sixDigit, skipped }
 * where `skipped` lists up to ten rows that could not be written, with why.
 */
export function ommCsvToTle(csv) {
  const rows = parseOmmCsv(csv);
  const out = [];
  const skipped = [];
  let sixDigit = 0, dropped = 0;
  for (const row of rows) {
    const r = ommToTle(row);
    if (!r.lines) { dropped++; if (skipped.length < 10) skipped.push(`${row.OBJECT_NAME || '?'} (${row.NORAD_CAT_ID || '?'}): ${r.why}`); continue; }
    if (r.norad >= 100000) sixDigit++;
    out.push(r.lines.join('\n'));
  }
  return { text: out.length ? `${out.join('\n')}\n` : '', count: out.length, sixDigit, dropped, skipped };
}
