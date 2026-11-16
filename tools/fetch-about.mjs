// fetch-about.mjs — gather the "about" data (see tools/about-data.mjs) for the
// objects a deploy is about to publish.  Called by tools/fetch-data.mjs about
// once a day; in between, the site's existing about.json is carried forward.
//
// Requests, all identified by User-Agent and none of them heavy:
//   Wikidata query service   one query: every entry with a catalogue number
//   GCAT (planet4589.org)    one file: the payload catalogue, ~5 MB
//   Wikimedia Commons API    author + licence for photos not already credited —
//                            50 per request; ~7 requests the first time, then
//                            only for photos that are new
// Nothing here can fail a deploy: if a source does not answer, the file the
// site already has is kept (or, on the very first day, whatever was gathered
// is published).
//
// (ORBITAL_WIKIDATA_URL / ORBITAL_GCAT_URL / ORBITAL_COMMONS_URL point it at
// stand-ins for tests.)

import { buildAbout, checkAbout, creditFrom, creditsIn, imagesWanted, parseGcat, parseWikidata } from './about-data.mjs';

const WIKIDATA = process.env.ORBITAL_WIKIDATA_URL || 'https://query.wikidata.org/sparql';
const GCAT = process.env.ORBITAL_GCAT_URL || 'https://planet4589.org/space/gcat/tsv/cat/psatcat.tsv';
const COMMONS = process.env.ORBITAL_COMMONS_URL || 'https://commons.wikimedia.org/w/api.php';
const PAUSE_MS = Number(process.env.ORBITAL_FETCH_PAUSE_MS ?? 1500);
const UA = 'orbital (github.com/jerredcook/orbital; hobby satellite tracker; one fetch a day, served to visitors from our own site)';
export const ABOUT_MAX_AGE_MS = 20 * 3_600_000;

// Every entry with a satellite catalogue number (P377): its English label and
// description, one image (P18), the English Wikipedia article, and a
// retirement date (P730) where recorded.
const QUERY = `SELECT ?scn ?label ?desc (SAMPLE(?img) AS ?image) (SAMPLE(?article) AS ?wiki) (SAMPLE(?ret) AS ?retired) WHERE {
  ?item wdt:P377 ?scn .
  OPTIONAL { ?item wdt:P18 ?img }
  OPTIONAL { ?item wdt:P730 ?ret }
  OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "en") }
  OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) = "en") }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
} GROUP BY ?scn ?label ?desc`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, ms, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Author and licence for each file, 50 titles a request.
async function commonsCredits(files, say) {
  const out = new Map();
  for (let i = 0; i < files.length; i += 50) {
    const batch = files.slice(i, i + 50);
    const q = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', prop: 'imageinfo', iiprop: 'extmetadata',
      iiextmetadatafilter: 'Artist|LicenseShortName', titles: batch.map((f) => `File:${f}`).join('|') });
    try {
      const d = JSON.parse(await get(`${COMMONS}?${q}`, 60_000));
      // Commons may normalise a title (underscores, first letter): map its answer back to what was asked.
      const asked = new Map(batch.map((f) => [`File:${f}`, f]));
      for (const n of d.query?.normalized ?? []) if (asked.has(n.from)) asked.set(n.to, asked.get(n.from));
      for (const p of d.query?.pages ?? []) {
        const file = asked.get(p.title);
        const credit = creditFrom(p.imageinfo?.[0]?.extmetadata);
        if (file && credit) out.set(file, credit);
      }
    } catch (err) { say(`photo credits: a request failed (${err.cause?.code ?? err.message}) — those photos are left out today`); }
    if (i + 50 < files.length) await sleep(PAUSE_MS);
  }
  return out;
}

/**
 * Gather today's about data for `norads`.  `previous` is the about.json the
 * site already has (its photo credits are reused).  Resolves
 * { json, count, photos, stamp } or null if neither source answered.
 */
export async function gatherAbout({ norads, previous = null, say = () => {} }) {
  let wikidata = new Map(), gcat = new Map(), got = 0;
  try { wikidata = parseWikidata(await get(`${WIKIDATA}?query=${encodeURIComponent(QUERY)}`, 120_000, { Accept: 'text/csv' })); got++; }
  catch (err) { say(`about: Wikidata did not deliver (${err.cause?.code ?? err.message})`); }
  await sleep(PAUSE_MS);
  try { gcat = parseGcat(await get(GCAT, 180_000)); got++; }
  catch (err) { say(`about: GCAT did not deliver (${err.cause?.code ?? err.message})`); }
  if (!got) return null;
  // With a file already on the site, a day when one source is missing is a day to
  // keep that file: publishing without Wikidata would drop every photo until tomorrow.
  if (previous && got < 2) { say('about: one source is missing today — not replacing the existing file with a poorer one'); return null; }

  const credits = previous ? creditsIn(previous) : new Map();
  const missing = imagesWanted({ wikidata, norads }).filter((f) => !credits.has(f));
  if (missing.length) {
    say(`about: looking up author and licence for ${missing.length} photo${missing.length > 1 ? 's' : ''}`);
    for (const [f, c] of await commonsCredits(missing, say)) credits.set(f, c);
  }
  const about = buildAbout({ gcat, wikidata, credits, norads });
  const problems = checkAbout(about.json);
  if (problems.length) { say(`about: what was built is not usable (${problems[0]})`); return null; }
  say(`about: ${about.count.toLocaleString()} objects described, ${about.photos.toLocaleString()} with a photo (Wikidata ${wikidata.size.toLocaleString()} entries, GCAT ${gcat.size.toLocaleString()})`);
  return about;
}
