// fetch-data.mjs — get the satellite data a deploy will publish.
//
// Run by .github/workflows/deploy.yml before every build, and nowhere else: it
// is the ONLY thing that contacts CelesTrak or Space-Track on the app's
// behalf.  Browsers load the result from the site's own data/ folder (see
// tools/satellite-data.mjs).
//
// Two sources (tools/spacetrack.mjs has the why and the terms):
//   Space-Track  everything in orbit — dead satellites, rocket bodies and
//                debris as well as live ones — in one request.  Needs the
//                SPACETRACK_USER / SPACETRACK_PASSWORD secrets.
//   CelesTrak    its curated active list, which decides what counts as
//                "active".  With Space-Track available that is the only thing
//                asked of it: one request, about once a day.  Without Space-Track (no secrets, or
//                it failed) CelesTrak alone supplies the active list, three
//                debris clouds and the catalog file, as it did before 0.5.0.
//
// What it does, in order:
//   1. Reads what the live site is serving now.  If that was fetched less than
//      3½ hours ago it is published again as it is and CelesTrak is not asked —
//      so several code pushes in an afternoon cost CelesTrak nothing.
//   2. Otherwise asks CelesTrak for the active list and the three debris lists
//      (four requests, spaced out) and, about once a day, the catalog CSV.
//      The lists are asked for in OMM CSV — the TLE text format cannot carry
//      catalogue numbers above 99,999, and CelesTrak omits those objects from
//      it — and written out as element text here (tools/omm.mjs).
//      Everything is validated before it is accepted.
//   3. If CelesTrak answers ANY request with something other than the data —
//      an error status, a timeout, a page that is not the list — it asks nothing
//      more, in this run or for the next 24 hours (a "hold", kept in the state
//      file named by ORBITAL_STATE_FILE and carried between runs by the workflow's
//      cache).  That is CelesTrak's rule for automated clients: stop at the
//      first non-200 and tell a human.  The live site's files are carried
//      forward, so a code deploy still goes out with the data it had.
//      (Not being able to CONNECT at all is different: GitHub's runners share
//      addresses with everyone else on GitHub and some are firewalled already.
//      That ends the run's requests but starts no hold — nothing was answered,
//      and the next run comes from another address.)
//   4. If there is nothing live either (the very first run), it writes nothing
//      and the build falls back to the snapshot committed with the code.
//
//   node tools/fetch-data.mjs                 a push: steps 1–4
//   node tools/fetch-data.mjs --scheduled     the 4-hourly refresh: exits 1 when the data has
//                                             gone 12 hours without a refresh.  (A CelesTrak
//                                             error, or two days without Space-Track, sets the
//                                             `attention` output instead: the workflow deploys
//                                             what was fetched and then fails the run.)
//   node tools/fetch-data.mjs --no-celestrak  a pull-request build: never asks CelesTrak
//
// CelesTrak firewalls clients that re-download its big files.  Do not run this
// by hand in a loop, and not at all from a network it has already blocked.
// (ORBITAL_CELESTRAK_BASE / ORBITAL_SITE_BASE point it at stand-ins for tests.)

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABOUT_FILE, ELEMENT_FILES, FILES, activeListIsDue, assemble, checkBundle, holdAfterFailure, onHold, plan, satcatIsDue, satcatJson, tidy } from './satellite-data.mjs';
import { GP_QUERY, checkCatalogue, parseGpCsv, splitCatalogue } from './spacetrack.mjs';
import { ABOUT_MAX_AGE_MS, gatherAbout } from './fetch-about.mjs';
import { checkAbout } from './about-data.mjs';
import { parseTLEs } from '../src/catalog-parse.js';
import { validateSnapshot } from './tle-snapshot.mjs';
import { ommCsvToTle } from './omm.mjs';

const args = new Set(process.argv.slice(2));
const SCHEDULED = args.has('--scheduled');
const ALLOW_CELESTRAK = !args.has('--no-celestrak');
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const CELESTRAK = (process.env.ORBITAL_CELESTRAK_BASE || 'https://celestrak.org').replace(/\/$/, '');
const SITE = (process.env.ORBITAL_SITE_BASE || 'https://jerredcook.github.io/orbital').replace(/\/$/, '');
const SPACETRACK = (process.env.ORBITAL_SPACETRACK_BASE || 'https://www.space-track.org').replace(/\/$/, '');
const PAUSE_MS = Number(process.env.ORBITAL_FETCH_PAUSE_MS ?? 3000);   // between requests to CelesTrak
// What must be remembered from one run to the next, whether or not that run
// deployed anything: a CelesTrak hold, and when Space-Track was last asked.
// One small file, carried in the workflow's Actions cache (newest wins).
const STATE_FILE = process.env.ORBITAL_STATE_FILE || join(dirname(fileURLToPath(import.meta.url)), '..', '.fetch-state.json');
const SPACETRACK_GAP_MS = 61 * 60_000;   // Space-Track: element data at most once an hour
// CelesTrak: one download of a list per update (every two hours) at the very
// most — and, when Space-Track is supplying the orbits and the active list only
// says which satellites are active, about once a day.  Both are counted from the
// last time it was ASKED, deployed or not: a run that fetches and then fails its
// tests must not be followed by another request.
const CELESTRAK_MIN_GAP_MS = 125 * 60_000;
const CELESTRAK_DAILY_GAP_MS = 20 * 3_600_000;
const MAX_AGE_MS = 3.5 * 3_600_000;
const UA = 'orbital (github.com/jerredcook/orbital; hobby tracker; fetched server-side and served to visitors from our own site)';
// What CelesTrak sees: who this is, and how often to expect it — so its operator
// can check the claim against his logs.  (With Space-Track supplying the orbits
// that is the active list, once a day; without it, see fromCelestrak.)
const CELESTRAK_UA = 'orbital (github.com/jerredcook/orbital; hobby tracker; active list about once a day; served to visitors from our own site)';
const gp = (group) => `${CELESTRAK}/NORAD/elements/gp.php?GROUP=${group}&FORMAT=csv`;
const STALE_MS = 12 * 3_600_000;   // a scheduled run fails once the site's data is this old
const DEBRIS_GROUPS = ['cosmos-2251-debris', 'iridium-33-debris', 'fengyun-1c-debris'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, ms, ua = UA) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    let res;
    try { res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': ua } }); }
    catch (err) {
      // fetch() itself rejecting (other than our own time limit) means no HTTP
      // answer ever began: DNS, a refused or timed-out connection, TLS.
      if (err.name !== 'AbortError') { err.noAnswer = true; err.detail = err.cause?.code || err.cause?.message || err.message; }
      throw err;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}
const say = (msg) => console.log(`satellite data: ${msg}`);

// ---- what the live site has now ----
async function readLive() {
  try {
    const bust = `?t=${Date.now()}`;
    const meta = await get(`${SITE}/data/${FILES.meta}${bust}`, 30_000);
    const stamp = JSON.parse(meta).stamp;
    const file = (k) => get(`${SITE}/data/${FILES[k]}?v=${stamp}`, 120_000);
    // (inactive.tle and rocketbodies.tle arrived in 0.5.0 — a site from before then has neither)
    const older = (k) => file(k).catch((err) => { if (/HTTP 404/.test(err.message)) return ''; throw err; });
    const [active, inactive, rocketbodies, debris, satcat] = await Promise.all([file('active'), older('inactive'), older('rocketbodies'), file('debris'), file('satcat')]);
    const bundle = { active, inactive, rocketbodies, debris, satcat, meta };
    const problems = checkBundle(bundle);
    if (problems.length) { say(`the live site's data is not usable (${problems[0]})`); return null; }
    const info = JSON.parse(meta);
    // The photos-and-descriptions file, if the site has one (0.6.0 on).  Optional: without it the app just shows less.
    let about = null;
    if (info.about?.stamp) {
      try { about = await get(`${SITE}/data/${ABOUT_FILE}?v=${info.about.stamp}`, 120_000); if (checkAbout(about).length) about = null; }
      catch { about = null; }
    }
    return { ...bundle, info, about };
  } catch (err) {
    say(`no data on the live site yet (${err.message})`);
    return null;
  }
}

// ---- CelesTrak ----
// One failed request ends it: nothing below asks again in this run.
//   refused      CelesTrak ANSWERED with something other than the data → a hold
//   unreachable  no connection could be made at all → no hold (see the header)
let refused = null, unreachable = null;
async function ask(what, url, ms) {
  if (refused || unreachable) throw new Error(`not asked — an earlier request in this run failed (${refused || unreachable})`);
  try { return await get(url, ms, CELESTRAK_UA); }
  catch (err) {
    if (err.noAnswer) unreachable = `${what}: could not connect (${err.detail})`;
    else refused = `${what}: ${err.name === 'AbortError' ? 'no answer in time' : err.message}`;
    throw err;
  }
}
// OMM CSV → element text.  A 200 that is not OMM CSV, or one we cannot write
// out, counts as CelesTrak not delivering.
function toElements(what, csv) {
  let r;
  try { r = ommCsvToTle(csv); }
  catch (err) { refused = `${what}: answered, but not with OMM CSV (${err.message})`; throw new Error(refused); }
  if (r.dropped > Math.max(5, r.count * 0.01)) {
    refused = `${what}: ${r.dropped} of ${r.count + r.dropped} objects could not be read (${r.skipped[0]})`;
    throw new Error(refused);
  }
  if (r.dropped) say(`${what}: left out ${r.dropped} unreadable object${r.dropped > 1 ? 's' : ''} — ${r.skipped.slice(0, 3).join('; ')}`);
  return r;
}
// CelesTrak's active list: one request.  It is all that is asked of CelesTrak
// when Space-Track supplied the catalogue.
const sinceCelestrak = () => (state.celestrakAt ? Date.now() - state.celestrakAt : Infinity);
async function celestrakActive() {
  state.celestrakAt = Date.now();   // remembered whether or not this run goes on to deploy
  await saveState();
  const act = toElements('active list', await ask('active list', gp('active'), 180_000));
  const active = tidy(act.text);
  say(`CelesTrak active list: ${act.count.toLocaleString()} objects, ${act.sixDigit.toLocaleString()} of them with six-digit catalogue numbers`);
  const { problems } = validateSnapshot(active);   // must be the active list, well formed, and current
  if (problems.length) {
    refused = `active list: answered, but not with the list (${problems[0]})`;
    throw new Error(`the active list failed validation: ${problems.join('; ')}`);
  }
  return active;
}
// CelesTrak alone.  If the site already has Space-Track's catalogue (it just
// could not be refreshed this time), only the active list is renewed and the
// rest is kept as it is — a temporary failure must not shrink the debris back
// to three clouds.  Otherwise (a fork with no login): the active list, three
// debris clouds and the catalog file, as before 0.5.0.
async function fromCelestrak(live) {
  const active = await celestrakActive();
  if (live?.info.catalogueAt) {
    say(`keeping the rest of the catalogue the site has (from Space-Track, ${((Date.now() - live.info.catalogueAt) / 3_600_000).toFixed(1)} h ago)`);
    return assemble({ active, inactive: live.inactive, rocketbodies: live.rocketbodies, debris: live.debris, satcat: live.satcat,
      satcatFetchedAt: live.info.satcatFetchedAt ?? null, catalogueAt: live.info.catalogueAt, fetchedAt: Date.now(), activeListAt: Date.now(), source: 'celestrak' });
  }
  // Debris: three small lists.  If any is missing, keep the debris the site
  // already has rather than publish a partial set.
  const parts = [];
  for (const g of DEBRIS_GROUPS) {
    await sleep(PAUSE_MS);
    try { parts.push(tidy(toElements(`debris list ${g}`, await ask(`debris list ${g}`, gp(g), 60_000)).text)); }
    catch (err) { say(`debris list ${g} unavailable (${err.message})`); break; }
  }
  const debrisOk = parts.length === DEBRIS_GROUPS.length;
  const debris = debrisOk ? parts.join('') : (live?.debris ?? '');
  if (!debrisOk) say(live ? 'keeping the debris lists already on the site' : 'publishing without debris lists');

  // Catalog details: a 6.6 MB file that changes slowly, so about once a day.
  let satcat = live?.satcat ?? '[]';
  let satcatFetchedAt = live?.info.satcatFetchedAt ?? null;
  if (!refused && !unreachable && satcatIsDue({ satcatFetchedAt })) {
    await sleep(PAUSE_MS);
    try {
      const csv = await ask('catalog file', `${CELESTRAK}/pub/satcat.csv`, 180_000);
      const json = satcatJson(csv, { active, debris });
      if (JSON.parse(json).length < 5000) { refused = 'catalog file: answered, but not with the catalog'; throw new Error('fewer than 5,000 matching rows — not the catalog'); }
      satcat = json; satcatFetchedAt = Date.now();
    } catch (err) { say(`catalog details unavailable (${err.message}) — keeping the ones already on the site`); }
  }
  // The active list arrived, so there is fresh data to publish even if a later
  // request failed — but that failure still starts the hold (see main).
  // (dead satellites and rocket bodies come only from Space-Track — keep whatever the site has)
  return assemble({ active, inactive: live?.inactive ?? '', rocketbodies: live?.rocketbodies ?? '', debris, satcat, satcatFetchedAt,
    fetchedAt: Date.now(), activeListAt: Date.now(), source: 'celestrak' });
}

// ---- Space-Track ----
// Three requests: log in, the catalogue, log out.  Resolves the parsed rows, or
// null (having said why) when there is no login or it did not deliver — the
// caller then falls back to CelesTrak alone.  The login is never printed.
let spaceTrackFailed = false;   // asked in this run, and it did not deliver
let spaceTrackTooSoon = false;  // not asked: it was asked less than an hour ago
async function spaceTrackCatalogue() {
  const user = process.env.SPACETRACK_USER, pass = process.env.SPACETRACK_PASSWORD;
  if (!user || !pass) { say('no Space-Track login available to this build — using CelesTrak alone'); return null; }
  // Its limit is one catalogue request an hour — and a run that fetched but then
  // failed its tests leaves the site's data old, so the next run would ask again.
  const since = state.spaceTrackAt ? Date.now() - state.spaceTrackAt : Infinity;
  if (since < SPACETRACK_GAP_MS) {
    say(`Space-Track was asked ${Math.round(since / 60_000)} min ago — its limit is once an hour, so not asking again in this run`);
    spaceTrackTooSoon = true;
    return null;
  }
  state.spaceTrackAt = Date.now();
  await saveState();
  let cookie = '';
  try {
    const login = await fetch(`${SPACETRACK}/ajaxauth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ identity: user, password: pass }), signal: AbortSignal.timeout(60_000),
    });
    const body = await login.text();
    cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    if (!login.ok || !cookie || /failed/i.test(body)) throw new Error(`login was not accepted (HTTP ${login.status})`);
    const res = await fetch(`${SPACETRACK}${GP_QUERY}`, { headers: { Cookie: cookie, 'User-Agent': UA }, signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = parseGpCsv(await res.text());
    const problems = checkCatalogue(rows);
    if (problems.length) throw new Error(`answered, but not with the catalogue (${problems[0]})`);
    return rows;
  } catch (err) {
    spaceTrackFailed = true;
    say(`Space-Track did not deliver (${err.cause?.code ?? err.message}) — using CelesTrak alone this time`);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Space-Track::The catalogue could not be fetched (${err.cause?.code ?? err.message}); dead satellites, rocket bodies and debris were not refreshed.`);
    return null;
  } finally {
    if (cookie) await fetch(`${SPACETRACK}/ajaxauth/logout`, { headers: { Cookie: cookie, 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) }).catch(() => {});
  }
}

// Everything in orbit from Space-Track, with CelesTrak's active list deciding
// which satellites are active.  If CelesTrak cannot be asked (a hold) or does
// not answer, the list the site already has is used instead.
async function fromSpaceTrack(rows, live, { askCelestrak }) {
  let activeText = null, activeListAt = null;
  // (A site from before 0.5.0 has an active list too, but one fetched in the
  // old text format, without the objects numbered above 99,999 — it records no
  // activeListAt, so it counts as due and is replaced at once.)
  const liveListAt = live?.info.activeListAt ?? null;
  // Once a day is enough: the list only says which satellites are active.
  const listDue = activeListIsDue({ activeListAt: liveListAt });
  const due = listDue && sinceCelestrak() >= CELESTRAK_DAILY_GAP_MS;
  if (listDue && !due) say(`CelesTrak was asked ${(sinceCelestrak() / 3_600_000).toFixed(1)} h ago (by a run whose result may not have been published) — not asking again today`);
  if (askCelestrak && due) {
    try { activeText = await celestrakActive(); activeListAt = Date.now(); }
    catch (err) { say(`CelesTrak active list unavailable (${err.detail ?? err.message})`); }
  }
  if (!activeText && live) {
    activeText = live.active;
    activeListAt = liveListAt;
    const age = liveListAt ? `${((Date.now() - liveListAt) / 3_600_000).toFixed(1)} h old` : 'of unknown age';
    say(listDue ? `using the active list the site already has (${age}) to decide what is active`
      : `CelesTrak not asked — the active list the site has is ${age}, and it is renewed once a day`);
  }
  const sets = parseTLEs(activeText ?? '');
  const split = splitCatalogue(rows, {
    activeIds: new Set(sets.map((s) => s.norad)),
    activeNames: new Map(sets.map((s) => [s.norad, s.name])),
    activeSets: new Map(sets.map((s) => [s.norad, [s.name, s.l1, s.l2]])),
    activeListAt,
  });
  say(`Space-Track catalogue: ${rows.length.toLocaleString()} objects → ${split.counts.active.toLocaleString()} active, ${split.counts.inactive.toLocaleString()} inactive satellites, ${split.counts.rocketbodies.toLocaleString()} rocket bodies, ${split.counts.debris.toLocaleString()} debris`
    + (split.fromCelestrak ? `; ${split.fromCelestrak} active object${split.fromCelestrak > 1 ? 's' : ''} only CelesTrak had` : '')
    + (split.presumedActive ? `; ${split.presumedActive} recent launch${split.presumedActive > 1 ? 'es' : ''} presumed active (the active list is old)` : '')
    + (split.duplicates ? `; ${split.duplicates} repeated numbers ignored` : '')
    + (split.dropped ? `; ${split.dropped} unreadable (${split.skipped.slice(0, 3).join(', ')})` : ''));
  return assemble({ active: split.active, inactive: split.inactive, rocketbodies: split.rocketbodies, debris: split.debris, satcat: split.details,
    satcatFetchedAt: Date.now(), catalogueAt: Date.now(), fetchedAt: Date.now(), activeListAt, source: 'space-track' });
}

// ---- state carried between runs ----
const state = { hold: null, spaceTrackAt: null, celestrakAt: null };
async function readState() {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (Number.isFinite(s?.hold?.until)) state.hold = s.hold;
    if (Number.isFinite(s?.spaceTrackAt)) state.spaceTrackAt = s.spaceTrackAt;
    if (Number.isFinite(s?.celestrakAt)) state.celestrakAt = s.celestrakAt;
    // A state file from before celestrakAt was recorded: assume CelesTrak was
    // asked whenever Space-Track last was (the cautious reading — they were asked together).
    else if (Number.isFinite(s?.spaceTrackAt)) state.celestrakAt = s.spaceTrackAt;
  } catch { /* none yet */ }
}
async function saveState() {
  await writeFile(STATE_FILE, `${JSON.stringify(state)}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'state=true\n');   // the workflow saves the file for later runs
}
async function startHold(reason) {
  const hold = holdAfterFailure({ reason });
  state.hold = hold;
  await saveState();
  console.error(`satellite data: CelesTrak failed a request (${reason}).`);
  console.error(`satellite data: per its usage policy nothing will ask it again until ${new Date(hold.until).toISOString()} — a person should look at why before then.`);
}

// ---- photos and descriptions (about.json) ----
// Gathered about once a day for exactly the objects being published; otherwise
// the site's existing file is kept.  Its sources (Wikidata, GCAT, Commons) have
// nothing to do with the element sources' limits, so it is due or not on its own
// clock, whichever way the elements were obtained — only a pull-request build
// never asks.  Returns { json, info } or null (none).
async function aboutFor(bundle, live, { mayFetch }) {
  const have = live?.about ? { json: live.about, info: live.info.about } : null;
  const due = !have || !(Date.now() - (have.info.at ?? 0) < ABOUT_MAX_AGE_MS);
  if (!mayFetch || !due) return have;
  const norads = ELEMENT_FILES.flatMap((k) => parseTLEs(bundle[k] ?? '').map((s) => s.norad));
  let fresh = null;
  try { fresh = await gatherAbout({ norads, previous: have?.json ?? null, say }); }
  catch (err) { say(`about: could not be gathered (${err.message})`); }
  if (!fresh) { if (have) say('about: keeping the file the site already has'); return have; }
  return { json: fresh.json, info: { stamp: fresh.stamp, at: Date.now(), count: fresh.count, photos: fresh.photos } };
}

async function write(bundle, about = null) {
  const problems = checkBundle(bundle);
  if (problems.length) throw new Error(`refusing to write: ${problems.join('; ')}`);
  await mkdir(OUT, { recursive: true });
  // meta.json says whether there is an about.json and which (its own stamp — it
  // changes daily, and must not make every browser download the elements again).
  const metaObj = JSON.parse(bundle.meta);
  delete metaObj.about;
  if (about && !checkAbout(about.json).length) { metaObj.about = about.info; await writeFile(join(OUT, ABOUT_FILE), about.json); }
  bundle = { ...bundle, meta: `${JSON.stringify(metaObj, null, 1)}\n` };
  for (const k of Object.keys(FILES)) await writeFile(join(OUT, FILES[k]), bundle[k]);
  const m = JSON.parse(bundle.meta);
  const ageH = (Date.now() - m.fetchedAt) / 3_600_000;
  say(`wrote ${m.counts.active.toLocaleString()} active + ${(m.counts.inactive ?? 0).toLocaleString()} inactive + ${(m.counts.rocketbodies ?? 0).toLocaleString()} rocket bodies + ${m.counts.debris.toLocaleString()} debris, details for ${m.counts.details.toLocaleString()}; source ${m.source}; fetched ${ageH < 0.05 ? 'just now' : `${ageH.toFixed(1)} h ago`} (stamp ${m.stamp})`);
  return m;
}

// ---- main ----
const live = await readLive();
await readState();
const hold = state.hold;
const holding = onHold({ holdUntil: hold?.until });
if (holding) say(`CelesTrak failed a request at ${new Date(hold.at).toISOString()} (${hold.reason}) — on hold, not asking it again until ${new Date(hold.until).toISOString()}`);
// (--no-celestrak is a pull-request build: nothing outside is asked, Space-Track included.)
const haveSpaceTrack = ALLOW_CELESTRAK && !!(process.env.SPACETRACK_USER && process.env.SPACETRACK_PASSWORD);
const todo = plan({ liveFetchedAt: live?.info.fetchedAt ?? null, maxAgeMs: MAX_AGE_MS, allowCelestrak: ALLOW_CELESTRAK, holdUntil: hold?.until ?? null, otherSource: haveSpaceTrack });
let published = null;

if (todo === 'reuse') {
  say('the live site was refreshed recently — publishing the same data again, nothing fetched');
  published = await write(live, await aboutFor(live, live, { mayFetch: ALLOW_CELESTRAK }));
} else if (todo === 'fetch') {
  try {
    const rows = haveSpaceTrack ? await spaceTrackCatalogue() : null;
    const publish = async (b) => write(b, await aboutFor(b, live, { mayFetch: ALLOW_CELESTRAK }));
    if (rows) published = await publish(await fromSpaceTrack(rows, live, { askCelestrak: !holding }));
    // Too soon to ask Space-Track again: wait for the next run rather than fall back to CelesTrak for an hour's sake.
    else if (spaceTrackTooSoon && live) { say('carrying the live site’s data forward until Space-Track can be asked again'); published = await write(live, await aboutFor(live, live, { mayFetch: ALLOW_CELESTRAK })); }
    // CelesTrak alone — but never inside its two-hour update window.
    else if (!holding && sinceCelestrak() < CELESTRAK_MIN_GAP_MS && live) { say(`CelesTrak was asked ${Math.round(sinceCelestrak() / 60_000)} min ago — its lists update every two hours, so not asking again in this run`); published = await write(live, await aboutFor(live, live, { mayFetch: ALLOW_CELESTRAK })); }
    else if (!holding) published = await publish(await fromCelestrak(live));
    else throw new Error('Space-Track did not deliver and CelesTrak is on hold');
  } catch (err) {
    say(`fetch failed: ${err.detail ?? err.message}`);
    if (live) { say('carrying the live site’s data forward'); published = await write(live, await aboutFor(live, live, { mayFetch: ALLOW_CELESTRAK })); }
  }
} else if (todo === 'carry') {
  say('nothing may be fetched for this build — carrying the live site’s data forward');
  published = await write(live, await aboutFor(live, live, { mayFetch: ALLOW_CELESTRAK }));
}

if (!published) say('nothing fetched and nothing live — the build will use the snapshot committed with the code');
// Things a person should hear about.  Each sets an output; the workflow's last
// job fails the run on it AFTER the deploy, so the site still gets whatever
// fresh data this run did fetch and GitHub emails the owner.
const tell = async (name) => { if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=true\n`); };
if (refused) {
  // CelesTrak answered with an error: stop asking for a day (its policy).  Runs
  // during the hold pass quietly — they ask it nothing.
  await startHold(refused);
  await tell('attention');
}
if (unreachable) say(`CelesTrak could not be reached from this runner (${unreachable}) — no hold; the next run tries from another address`);
// Space-Track has a login that expires and terms that can change.  Say so when
// it has stopped delivering: its catalogue on the site is two days old, or it
// has never delivered and just failed again.  (Data that simply predates
// Space-Track — no catalogueAt, nothing asked in this run — is not a failure.)
const catalogueAge = published?.catalogueAt ? Date.now() - published.catalogueAt : null;
if (haveSpaceTrack && published && (catalogueAge !== null ? catalogueAge > 48 * 3_600_000 : spaceTrackFailed)) {
  console.error(catalogueAge !== null
    ? 'satellite data: Space-Track has not delivered the catalogue for two days — check the account (space-track.org) and the SPACETRACK_ secrets'
    : 'satellite data: Space-Track has never delivered the catalogue and failed again — check the account (space-track.org) and the SPACETRACK_ secrets');
  await tell('attention');
}
// However it got that way, data this old means the refresh is not working.
// Nothing new to publish, so the scheduled run stops here.
if (SCHEDULED && !(published && Date.now() - published.fetchedAt < STALE_MS)) {
  console.error(`satellite data: the site's data ${published ? `is ${((Date.now() - published.fetchedAt) / 3_600_000).toFixed(1)} hours old` : 'could not be refreshed and there is none to carry forward'} — failing this scheduled refresh so it is noticed`);
  process.exit(1);
}
