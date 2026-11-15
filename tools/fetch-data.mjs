// fetch-data.mjs — get the satellite data a deploy will publish.
//
// Run by .github/workflows/deploy.yml before every build, and nowhere else: it
// is the ONLY thing that contacts CelesTrak on the app's behalf.  Browsers load
// the result from the site's own data/ folder (see tools/satellite-data.mjs).
//
// What it does, in order:
//   1. Reads what the live site is serving now.  If that was fetched less than
//      3½ hours ago it is published again as it is and CelesTrak is not asked —
//      so several code pushes in an afternoon cost CelesTrak nothing.
//   2. Otherwise asks CelesTrak for the active list and the three debris lists
//      (four requests, spaced out) and, about once a day, the catalog CSV.
//      Everything is validated before it is accepted.
//   3. If CelesTrak does not deliver, the live site's files are carried forward
//      so a code deploy still goes out with the data it had.
//   4. If there is nothing live either (the very first run), it writes nothing
//      and the build falls back to the snapshot committed with the code.
//
//   node tools/fetch-data.mjs                 a push: steps 1–4
//   node tools/fetch-data.mjs --scheduled     the 4-hourly refresh: exits 1 if it ends
//                                             up with data older than 3½ hours, so
//                                             a failed refresh is a visible failure
//   node tools/fetch-data.mjs --no-celestrak  a pull-request build: never asks CelesTrak
//
// CelesTrak firewalls clients that re-download its big files.  Do not run this
// by hand in a loop, and not at all from a network it has already blocked.
// (ORBITAL_CELESTRAK_BASE / ORBITAL_SITE_BASE point it at stand-ins for tests.)

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES, assemble, checkBundle, plan, satcatIsDue, satcatJson, tidy } from './satellite-data.mjs';
import { validateSnapshot } from './tle-snapshot.mjs';

const args = new Set(process.argv.slice(2));
const SCHEDULED = args.has('--scheduled');
const ALLOW_CELESTRAK = !args.has('--no-celestrak');
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const CELESTRAK = (process.env.ORBITAL_CELESTRAK_BASE || 'https://celestrak.org').replace(/\/$/, '');
const SITE = (process.env.ORBITAL_SITE_BASE || 'https://jerredcook.github.io/orbital').replace(/\/$/, '');
const PAUSE_MS = Number(process.env.ORBITAL_FETCH_PAUSE_MS ?? 3000);   // between requests to CelesTrak
const RETRY_MS = Number(process.env.ORBITAL_FETCH_RETRY_MS ?? 90_000);
const MAX_AGE_MS = 3.5 * 3_600_000;
const UA = 'orbital (github.com/jerredcook/orbital; hobby tracker; one fetch per 4 h, served to visitors from our own site)';
const gp = (group) => `${CELESTRAK}/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
const DEBRIS_GROUPS = ['cosmos-2251-debris', 'iridium-33-debris', 'fengyun-1c-debris'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA } });
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
    const [active, debris, satcat] = await Promise.all(['active', 'debris', 'satcat'].map((k) => get(`${SITE}/data/${FILES[k]}?v=${stamp}`, 120_000)));
    const bundle = { active, debris, satcat, meta };
    const problems = checkBundle(bundle);
    if (problems.length) { say(`the live site's data is not usable (${problems[0]})`); return null; }
    return { ...bundle, info: JSON.parse(meta) };
  } catch (err) {
    say(`no data on the live site yet (${err.message})`);
    return null;
  }
}

// ---- CelesTrak ----
async function fetchActive() {
  const text = tidy(await get(gp('active'), 180_000));
  const { problems } = validateSnapshot(text);   // must be the active list, well formed, and current
  if (problems.length) throw new Error(`the active list failed validation: ${problems.join('; ')}`);
  return text;
}
async function fromCelestrak(live) {
  let active;
  try { active = await fetchActive(); }
  catch (err) {
    say(`CelesTrak did not deliver the active list (${err.message}) — one more try in ${Math.round(RETRY_MS / 1000)} s`);
    await sleep(RETRY_MS);
    active = await fetchActive();   // a second failure is the answer
  }
  // Debris: three small lists.  If any is missing, keep the debris the site
  // already has rather than publish a partial set.
  const parts = [];
  let debrisOk = true;
  for (const g of DEBRIS_GROUPS) {
    await sleep(PAUSE_MS);
    try { parts.push(tidy(await get(gp(g), 60_000))); }
    catch (err) { debrisOk = false; say(`debris list ${g} unavailable (${err.message})`); break; }
  }
  const debris = debrisOk ? parts.join('') : (live?.debris ?? '');
  if (!debrisOk) say(live ? 'keeping the debris lists already on the site' : 'publishing without debris lists');

  // Catalog details: a 6.6 MB file that changes slowly, so about once a day.
  let satcat = live?.satcat ?? '[]';
  let satcatFetchedAt = live?.info.satcatFetchedAt ?? null;
  if (satcatIsDue({ satcatFetchedAt })) {
    await sleep(PAUSE_MS);
    try {
      const csv = await get(`${CELESTRAK}/pub/satcat.csv`, 180_000);
      const json = satcatJson(csv, { active, debris });
      if (JSON.parse(json).length < 5000) throw new Error('fewer than 5,000 matching rows — not the catalog');
      satcat = json; satcatFetchedAt = Date.now();
    } catch (err) { say(`catalog details unavailable (${err.message}) — keeping the ones already on the site`); }
  }
  return assemble({ active, debris, satcat, satcatFetchedAt, fetchedAt: Date.now(), source: 'celestrak' });
}

async function write(bundle) {
  const problems = checkBundle(bundle);
  if (problems.length) throw new Error(`refusing to write: ${problems.join('; ')}`);
  await mkdir(OUT, { recursive: true });
  for (const k of Object.keys(FILES)) await writeFile(join(OUT, FILES[k]), bundle[k]);
  const m = JSON.parse(bundle.meta);
  const ageH = (Date.now() - m.fetchedAt) / 3_600_000;
  say(`wrote ${m.counts.active.toLocaleString()} active + ${m.counts.debris.toLocaleString()} debris objects, details for ${m.counts.details.toLocaleString()}; fetched ${ageH < 0.05 ? 'just now' : `${ageH.toFixed(1)} h ago`} (stamp ${m.stamp})`);
  return m;
}

// ---- main ----
const live = await readLive();
const todo = plan({ liveFetchedAt: live?.info.fetchedAt ?? null, maxAgeMs: MAX_AGE_MS, allowCelestrak: ALLOW_CELESTRAK });
let published = null;

if (todo === 'reuse') {
  say('the live site was refreshed recently — publishing the same data again, CelesTrak not contacted');
  published = await write(live);
} else if (todo === 'fetch') {
  try {
    published = await write(await fromCelestrak(live));
  } catch (err) {
    say(`CelesTrak fetch failed: ${err.message}`);
    if (live) { say('carrying the live site’s data forward'); published = await write(live); }
  }
} else if (todo === 'carry') {
  say('not contacting CelesTrak for this build — carrying the live site’s data forward');
  published = await write(live);
}

if (!published) say('nothing fetched and nothing live — the build will use the snapshot committed with the code');
if (SCHEDULED && !(published && Date.now() - published.fetchedAt < MAX_AGE_MS)) {
  console.error('satellite data: the scheduled refresh did not get current data — failing so it is noticed; the site keeps what it has');
  process.exit(1);
}
