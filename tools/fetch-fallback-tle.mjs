// fetch-fallback-tle.mjs — bundle an offline TLE snapshot.
//
// CelesTrak is the live source, but it rate-limits clients that re-fetch the big
// files too often, and when it does the sky goes empty for anyone without a warm
// localStorage cache.  This snapshot — pulled from the CelesTrak-mirroring TLE
// API at tle.ivanstanojevic.me — ships in the app as a last-resort fallback so
// there are always satellites to render.  Regenerate occasionally:
//
//   node tools/fetch-fallback-tle.mjs
//
// Output: public/fallback/active.tle (CelesTrak 3-line format: name / L1 / L2).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fallback', 'active.tle');
const API = 'https://tle.ivanstanojevic.me/api/tle/';
const PAGE = 100;            // the API's max page size
const DELAY = 350;           // ms between requests — this free mirror throttles bursts

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byId = new Map();
const take = (members) => { for (const m of members || []) byId.set(m.satelliteId, m); };

// One page, sequential, with backoff retries when the mirror rate-limits (it
// answers a throttled request with an HTML error page, not JSON).
async function getPage(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${API}?page-size=${PAGE}&page=${page}`);
      const j = await r.json();         // throws on the HTML throttle page
      return j;
    } catch {
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

const first = await getPage(1);
const total = first?.totalItems ?? 0;
const pages = Math.ceil(total / PAGE);
console.log(`mirror reports ${total} objects across ${pages} pages`);
take(first?.member);

for (let page = 2; page <= pages; page++) {
  await sleep(DELAY);
  const j = await getPage(page);
  if (!j) { console.warn(`page ${page} gave up`); continue; }
  take(j.member);
  if (page % 25 === 0) console.log(`  …${byId.size} so far`);
}

const lines = [];
for (const m of byId.values()) {
  if (m.line1 && m.line2) lines.push(m.name.trim(), m.line1, m.line2);
}
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, lines.join('\n') + '\n');
console.log(`wrote ${lines.length / 3 | 0} satellites (${(lines.join('\n').length / 1024 / 1024).toFixed(1)} MB) → ${OUT}`);
