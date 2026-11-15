// satellite-data.mjs — the satellite data the site serves from its own address.
//
// Until 0.4.0 every visitor's browser downloaded the lists straight from
// CelesTrak: about 9 MB per new visitor, from a free service run by one person,
// which rate-limits and then firewalls heavy clients — and for one visitor in
// four the download never arrived.  Now the build fetches them (a few requests
// every four hours, from one place: tools/fetch-data.mjs) and publishes them
// with the site as four files under data/:
//
//   active.tle    CelesTrak's active-satellite list — fetched as OMM CSV and written out
//                 as element text (tools/omm.mjs), so objects numbered above 99,999 are in it
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
import { validateSnapshot, parseSnapshot, LINE1, LINE2 } from './tle-snapshot.mjs';

export const FILES = { active: 'active.tle', inactive: 'inactive.tle', rocketbodies: 'rocketbodies.tle', debris: 'debris.tle', satcat: 'satcat.json', meta: 'meta.json' };
/** The element files, in the order the app merges them (first occurrence of a number wins). */
export const ELEMENT_FILES = ['active', 'inactive', 'rocketbodies', 'debris'];
const HOUR = 3_600_000;

/** Unix line endings and exactly one trailing newline ('' stays ''). */
export const tidy = (text) => {
  const t = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return t ? `${t}\n` : '';
};

/** A short hash of the three data files — what meta.json calls the stamp. */
export function stampOf({ active, inactive = '', rocketbodies = '', debris, satcat }) {
  const h = createHash('sha256').update(active).update('\0').update(debris).update('\0').update(satcat);
  // (inactive.tle and rocketbodies.tle arrived in 0.5.0; a set without them hashes as it always did)
  if (inactive || rocketbodies) h.update('\0').update(inactive).update('\0').update(rocketbodies);
  return h.digest('hex').slice(0, 16);
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
export function assemble({ active, inactive = '', rocketbodies = '', debris = '', satcat = '[]', fetchedAt, satcatFetchedAt = null, activeListAt = null, catalogueAt = null, source }) {
  const files = { active: tidy(active), inactive: tidy(inactive), rocketbodies: tidy(rocketbodies), debris: tidy(debris), satcat: String(satcat) };
  const { medianEpochMs } = validateSnapshot(files.active, { fresh: false });
  const meta = {
    stamp: stampOf(files),
    fetchedAt: Math.round(fetchedAt),   // when the element sets were fetched (ms)
    satcatFetchedAt,           // when the catalog details were (from CelesTrak they change slowly, so less often)
    activeListAt,              // when CelesTrak's active list — which decides what counts as active — was fetched
    catalogueAt,               // when Space-Track's whole catalogue (dead satellites, rocket bodies, debris) was last fetched
    source,                    // 'space-track' (everything in orbit), 'celestrak' (active + three debris clouds), or 'snapshot'
    epoch: Number.isFinite(medianEpochMs) ? Math.round(medianEpochMs) : null,   // the element sets' own median date
    counts: {
      active: countSets(files.active), inactive: countSets(files.inactive), rocketbodies: countSets(files.rocketbodies),
      debris: countSets(files.debris), details: Math.max(0, satcatRows(files.satcat)),
      // objects catalogued since July 2026, numbered above 99,999 (written in Alpha-5)
      sixDigit: parseSnapshot(files.active + files.inactive + files.rocketbodies + files.debris).sets.filter((s) => /^1 [A-Z]/.test(s.l1)).length,
    },
  };
  return { ...files, meta: `${JSON.stringify(meta, null, 1)}\n` };
}

/**
 * Is this a set of files we are willing to publish?  Returns a list of
 * problems (empty = fine).  `fresh` also requires the element sets to be
 * current — true for something just fetched, false for something being
 * carried forward or built from the committed snapshot.
 */
export function checkBundle({ active, inactive = '', rocketbodies = '', debris, satcat, meta }, { now = Date.now(), fresh = false } = {}) {
  const problems = [...validateSnapshot(active, { now, fresh }).problems];
  // The other lists may legitimately be empty (a source hiccup, or a build
  // from CelesTrak alone — the app just shows none), but what is there has to
  // be element sets.
  for (const [label, text] of [['inactive', inactive], ['rocket bodies', rocketbodies], ['debris', debris]]) {
    const d = parseSnapshot(text);
    if (d.leftover) problems.push(`${label}: line count is not a multiple of three`);
    if (d.sets.length > 100_000) problems.push(`${label}: ${d.sets.length} objects is implausible`);
    const bad = d.sets.filter((s) => !LINE1.test(s.l1) || !LINE2.test(s.l2) || s.l1.length < 60 || s.l2.length < 60).length;
    if (bad) problems.push(`${label}: ${bad} element sets are malformed`);
  }
  if (satcatRows(satcat) < 0) problems.push('catalog details are not a JSON list of [number, object] rows');
  let m = null;
  try { m = JSON.parse(meta); } catch { /* reported below */ }
  if (!m || typeof m !== 'object') problems.push('meta.json is not a JSON object');
  else {
    if (m.stamp !== stampOf({ active, inactive, rocketbodies, debris, satcat })) problems.push('meta.json stamp does not match the files beside it');
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
 *
 * `holdUntil`: CelesTrak answered an earlier request with an error, so it is not
 * to be asked again before this time (see holdAfterFailure).  `otherSource`:
 * Space-Track is available, so a fetch is still worth making during a hold.
 */
export function plan({ liveFetchedAt = null, now = Date.now(), maxAgeMs = 3.5 * HOUR, allowCelestrak = true, holdUntil = null, otherSource = false }) {
  const haveLive = Number.isFinite(liveFetchedAt);
  if (haveLive && now - liveFetchedAt < maxAgeMs) return 'reuse';
  // A hold stops CelesTrak being asked; with another source (Space-Track) there is still something to fetch.
  if (allowCelestrak && (otherSource || !onHold({ holdUntil, now }))) return 'fetch';
  return haveLive ? 'carry' : 'none';
}

// CelesTrak's usage policy (celestrak.org/usage-policy.php): software "should
// immediately stop querying when it receives any non-HTTP 200 responses and
// report the results to a human for investigation.  Repeatedly ignoring them
// will end up sending your IP address to the firewall."  So one failed answer
// ends that run's requests, fails the run (GitHub emails the owner), and
// nothing asks CelesTrak again for a day.
export const HOLD_MS = 24 * HOUR;
export const onHold = ({ holdUntil = null, now = Date.now() }) => Number.isFinite(holdUntil) && now < holdUntil;
export const holdAfterFailure = ({ now = Date.now(), reason = '' }) => ({ until: now + HOLD_MS, at: now, reason: String(reason).slice(0, 200) });

// CelesTrak's active list only decides WHICH satellites count as active (the
// orbits come from Space-Track), and that changes slowly — so it is asked for
// about once a day, not at every four-hourly refresh.  In between, the list the
// site already has is used.
export const activeListIsDue = ({ activeListAt = null, now = Date.now(), maxAgeMs = 20 * HOUR }) =>
  !Number.isFinite(activeListAt) || now - activeListAt >= maxAgeMs;

/** Catalog details are refetched about once a day; in between, yesterday's are carried forward. */
export const satcatIsDue = ({ satcatFetchedAt = null, now = Date.now(), maxAgeMs = 20 * HOUR }) =>
  !Number.isFinite(satcatFetchedAt) || now - satcatFetchedAt >= maxAgeMs;
