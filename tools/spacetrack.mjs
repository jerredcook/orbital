// spacetrack.mjs — the whole unclassified catalogue, from Space-Track.
//
// CelesTrak publishes one bulk list: active satellites.  Everything else in
// orbit — dead satellites, spent rocket stages, debris — it serves only one
// object or one launch at a time.  Space-Track (US Space Command / 18 SDS, the
// source CelesTrak itself draws on) gives the lot in one request: about 32,700
// objects in November 2026, with owner, launch date and launch site for each.
//
// Terms (space-track.org/documentation, read 15 Nov 2026):
//   • Redistribution: "USSPACECOM has provided express blanket approval for
//     transfer/redistribution of basic SSA data … conditioned on appropriate
//     citation."  Basic SSA data = TLEs, OMMs, SATCAT, decay data.  The app and
//     README credit Space-Track.
//   • Rate: element data at most once an hour, not at the top or bottom of the
//     hour.  This is asked for at most every 3½ hours, at :23 (deploy.yml).
//   • It needs an account.  The login lives in repository secrets
//     (SPACETRACK_USER / SPACETRACK_PASSWORD); without them — a fork, a laptop —
//     the fetch uses CelesTrak alone, as before.
//
// What makes a satellite "active" is still CelesTrak's judgement: its active
// list is curated, and Space-Track has no such flag.  So the split is
//   active.tle        objects on CelesTrak's active list (asked for once a day)
//   inactive.tle      other payloads — dead satellites
//   rocketbodies.tle  spent stages
//   debris.tle        fragments, and objects not yet identified
//
// This module is the pure part; the three requests are in tools/fetch-data.mjs.

import { parseOmmCsv, ommToTle } from './omm.mjs';
import { alpha5ToNumber } from '../src/catalog-parse.js';
import { LINE1, LINE2 } from './tle-snapshot.mjs';

/** Every object in orbit (no decay date) with elements from the last 10 days — one request. */
export const GP_QUERY = '/basicspacedata/query/class/gp/decay_date/null-val/epoch/%3Enow-10/orderby/norad_cat_id/format/csv';

export const parseGpCsv = (text) => parseOmmCsv(text);

const TYPE_CODE = { PAYLOAD: 'PAY', 'ROCKET BODY': 'R/B', DEBRIS: 'DEB' };   // the codes CelesTrak's SATCAT uses, which the app already reads

// Space-Track's own element lines when they are well formed (they are the
// authoritative text, Alpha-5 numbers included); otherwise written from the OMM fields.
function linesOf(row, norad) {
  const [l1, l2] = [row.TLE_LINE1 ?? '', row.TLE_LINE2 ?? ''];
  if (l1.length === 69 && l2.length === 69 && LINE1.test(l1) && LINE2.test(l2)
    && alpha5ToNumber(l1.slice(2, 7)) === norad && alpha5ToNumber(l2.slice(2, 7)) === norad) return [l1, l2];
  const r = ommToTle(row);
  return r.lines ? [r.lines[1], r.lines[2]] : null;
}

/**
 * Split the catalogue into the four element files and one details list.
 *
 *   rows         parsed GP rows (parseGpCsv)
 *   activeIds    Set of catalogue numbers on CelesTrak's active list
 *   activeNames  Map number → CelesTrak's name for it (kept, so nothing is renamed)
 *   activeSets   Map number → [name, l1, l2] from CelesTrak, for any active object
 *                Space-Track did not return (elements older than 10 days, say)
 *   activeListAt when that active list was fetched.  It is renewed about once a
 *                day (and may be older if CelesTrak is unreachable), so a
 *                payload launched since shortly before then — which the list
 *                could not have had — is taken to be active rather than
 *                filed as dead until the next list says otherwise
 */
export function splitCatalogue(rows, { activeIds, activeNames = new Map(), activeSets = new Map(), activeListAt = null, now = Date.now() }) {
  const files = { active: [], inactive: [], rocketbodies: [], debris: [] };
  const details = [];
  const seen = new Set();
  const skipped = [];
  let dropped = 0, duplicates = 0, presumedActive = 0;
  // "Shortly before": three days, the time a new launch can take to be catalogued and listed.
  const since = Number.isFinite(activeListAt) ? Math.min(activeListAt, now) - 3 * 86_400_000 : -Infinity;

  for (const row of rows) {
    const norad = /^\d+$/.test(row.NORAD_CAT_ID ?? '') ? Number(row.NORAD_CAT_ID) : NaN;
    if (seen.has(norad)) { duplicates++; continue; }             // the first row for a number wins
    const lines = Number.isInteger(norad) && norad > 0 ? linesOf(row, norad) : null;
    if (!lines) { dropped++; if (skipped.length < 10) skipped.push(`${row.OBJECT_NAME || '?'} (${row.NORAD_CAT_ID || '?'})`); continue; }
    seen.add(norad);
    const type = row.OBJECT_TYPE ?? '';
    let file;
    if (activeIds.has(norad)) file = 'active';
    else if (type === 'PAYLOAD') {
      const launched = Date.parse(`${row.LAUNCH_DATE}T00:00:00Z`);
      if (Number.isFinite(launched) && launched > since) { file = 'active'; presumedActive++; }
      else file = 'inactive';
    } else if (type === 'ROCKET BODY') file = 'rocketbodies';
    else file = 'debris';
    const name = (activeNames.get(norad) || row.OBJECT_NAME || (row.TLE_LINE0 ?? '').replace(/^0 /, '') || `OBJECT ${norad}`).replace(/\s+/g, ' ').trim();
    files[file].push(`${name}\n${lines[0]}\n${lines[1]}`);
    // Only what the elements cannot say: the app works out period, heights,
    // inclination and the designator from the element lines (catalog-parse.js),
    // which keeps this file a quarter of the size.
    details.push([norad, { owner: row.COUNTRY_CODE || '', launchDate: row.LAUNCH_DATE || '', launchSite: row.SITE || '', type: TYPE_CODE[type] ?? 'UNK' }]);
  }
  // Active objects CelesTrak listed but Space-Track did not return.
  let fromCelestrak = 0;
  for (const [norad, set] of activeSets) {
    if (seen.has(norad)) continue;
    seen.add(norad); fromCelestrak++;
    files.active.push(set.join('\n'));
  }
  const text = (list) => (list.length ? `${list.join('\n')}\n` : '');
  return {
    active: text(files.active), inactive: text(files.inactive), rocketbodies: text(files.rocketbodies), debris: text(files.debris),
    details: JSON.stringify(details),
    counts: { active: files.active.length, inactive: files.inactive.length, rocketbodies: files.rocketbodies.length, debris: files.debris.length },
    dropped, duplicates, skipped, presumedActive, fromCelestrak,
  };
}

/** Is this the catalogue?  Returns problems (empty = fine). */
export function checkCatalogue(rows) {
  const problems = [];
  if (rows.length < 20_000 || rows.length > 200_000) problems.push(`${rows.length} objects (expected 20,000–200,000 for the whole catalogue)`);
  for (const col of ['OBJECT_TYPE', 'COUNTRY_CODE', 'LAUNCH_DATE', 'TLE_LINE1', 'TLE_LINE2']) if (rows.length && !(col in rows[0])) problems.push(`column ${col} is missing`);
  const payloads = rows.filter((r) => r.OBJECT_TYPE === 'PAYLOAD').length;
  if (payloads < 8000) problems.push(`only ${payloads} payloads`);
  const now = Date.now();
  const ages = rows.map((r) => now - Date.parse(`${r.EPOCH}Z`)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ages.length || ages[ages.length >> 1] > 4 * 86_400_000) problems.push('the elements are not current');
  return problems;
}
