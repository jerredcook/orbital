// satellite-data.mjs — the satellite data the site serves from its own address.
//
// Until 0.4.0 every visitor's browser downloaded the lists straight from
// CelesTrak: about 9 MB per new visitor, from a free service run by one person,
// which rate-limits and then firewalls heavy clients — and for one visitor in
// four the download never arrived.  Now the build fetches them (a few requests
// every four hours, from one place: tools/fetch-data.mjs) and publishes them
// with the site as four files under data/:
//
//   active.tle    CelesTrak's active-satellite list, as served
//   debris.tle    the three tracked breakup clouds, joined
//   satcat.json   owner / launch / orbit details for exactly those objects —
//                 the 6.6 MB catalog CSV cut down to the rows and fields used
//   meta.json     { stamp, fetchedAt, … } — the stamp is a hash of the three
//                 files, so a browser can tell "nothing new" from one tiny request
//
// This module is the pure part — assembling and checking a set of files — so
// it is unit-tested and shared by the fetch and the offline fallback
// (tools/prepare-data.mjs).

import { createHash } from 'node:crypto';
import { mergeGroups, parseSatcat } from '../src/catalog-parse.js';
import { validateSnapshot, parseSnapshot } from './tle-snapshot.mjs';

export const FILES = { active: 'active.tle', debris: 'debris.tle', satcat: 'satcat.json', meta: 'meta.json' };
const HOUR = 3_600_000;

/** Unix line endings and exactly one trailing newline ('' stays ''). */
export const tidy = (text) => {
  const t = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return t ? `${t}\n` : '';
};

/** A short hash of the three data files — what meta.json calls the stamp. */
export function stampOf({ active, debris, satcat }) {
  return createHash('sha256').update(active).update('\0').update(debris).update('\0').update(satcat).digest('hex').slice(0, 16);
}

/** The catalog CSV cut down to the objects in these lists: a JSON array of [norad, details]. */
export function satcatJson(csv, { active, debris }) {
  const { seen } = mergeGroups([{ text: active, kind: 'SAT' }, { text: debris, kind: 'DEB' }]);
  return JSON.stringify([...parseSatcat(String(csv), seen)]);
}

const countSets = (text) => parseSnapshot(text).sets.length;
function satcatRows(json) {
  try {
    const rows = JSON.parse(json);
    return Array.isArray(rows) && rows.every((r) => Array.isArray(r) && Number.isInteger(r[0]) && r[1] && typeof r[1] === 'object') ? rows.length : -1;
  } catch { return -1; }
}

/** Put a set of files together.  Returns { active, debris, satcat, meta } as file contents. */
export function assemble({ active, debris = '', satcat = '[]', fetchedAt, satcatFetchedAt = null, source }) {
  const files = { active: tidy(active), debris: tidy(debris), satcat: String(satcat) };
  const { medianEpochMs } = validateSnapshot(files.active, { fresh: false });
  const meta = {
    stamp: stampOf(files),
    fetchedAt: Math.round(fetchedAt),   // when the element sets were fetched from CelesTrak (ms)
    satcatFetchedAt,           // when the catalog details were (they change slowly, so less often)
    source,                    // 'celestrak', or 'snapshot' (the copy committed with the code)
    epoch: Number.isFinite(medianEpochMs) ? Math.round(medianEpochMs) : null,   // the element sets' own median date
    counts: { active: countSets(files.active), debris: countSets(files.debris), details: Math.max(0, satcatRows(files.satcat)) },
  };
  return { ...files, meta: `${JSON.stringify(meta, null, 1)}\n` };
}

/**
 * Is this a set of files we are willing to publish?  Returns a list of
 * problems (empty = fine).  `fresh` also requires the element sets to be
 * current — true for something just fetched, false for something being
 * carried forward or built from the committed snapshot.
 */
export function checkBundle({ active, debris, satcat, meta }, { now = Date.now(), fresh = false } = {}) {
  const problems = [...validateSnapshot(active, { now, fresh }).problems];
  // The debris lists may legitimately be empty (a source hiccup — the app just
  // shows no debris), but what is there has to be element sets.
  const d = parseSnapshot(debris);
  if (d.leftover) problems.push('debris: line count is not a multiple of three');
  if (d.sets.length > 30_000) problems.push(`debris: ${d.sets.length} objects is implausible`);
  const badDeb = d.sets.filter((s) => !/^1 [ \d]{5}/.test(s.l1) || !/^2 [ \d]{5}/.test(s.l2)).length;
  if (badDeb) problems.push(`debris: ${badDeb} element sets are malformed`);
  if (satcatRows(satcat) < 0) problems.push('catalog details are not a JSON list of [number, object] rows');
  let m = null;
  try { m = JSON.parse(meta); } catch { /* reported below */ }
  if (!m || typeof m !== 'object') problems.push('meta.json is not a JSON object');
  else {
    if (m.stamp !== stampOf({ active, debris, satcat })) problems.push('meta.json stamp does not match the files beside it');
    if (!Number.isFinite(m.fetchedAt) || m.fetchedAt > now + HOUR) problems.push('meta.json fetchedAt is missing or in the future');
  }
  return problems;
}

/**
 * What a build should do for its data, given what is live on the site now.
 *   'reuse'  the live files are recent enough — publish them again, ask CelesTrak nothing
 *   'fetch'  get new ones from CelesTrak
 *   'carry'  CelesTrak may not be asked (a pull-request build): publish the live files whatever their age
 *   'none'   nothing live and nothing may be fetched — the build falls back to the committed snapshot
 */
export function plan({ liveFetchedAt = null, now = Date.now(), maxAgeMs = 3.5 * HOUR, allowCelestrak = true }) {
  const haveLive = Number.isFinite(liveFetchedAt);
  if (haveLive && now - liveFetchedAt < maxAgeMs) return 'reuse';
  if (allowCelestrak) return 'fetch';
  return haveLive ? 'carry' : 'none';
}

/** Catalog details are refetched about once a day; in between, yesterday's are carried forward. */
export const satcatIsDue = ({ satcatFetchedAt = null, now = Date.now(), maxAgeMs = 20 * HOUR }) =>
  !Number.isFinite(satcatFetchedAt) || now - satcatFetchedAt >= maxAgeMs;
