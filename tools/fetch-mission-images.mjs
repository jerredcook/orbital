// fetch-mission-images.mjs — resolve one archival photo per curated mission from
// the NASA Image and Video Library (images-api.nasa.gov — keyless, public
// domain).  Run ONCE (and re-run only when missions are added); writes stable
// thumbnail URLs to src/mission-images.json, which the Missions view hotlinks
// lazily.  Missions whose search comes up empty simply render without a photo.
//
//   node tools/fetch-mission-images.mjs

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MISSIONS } from '../src/missions-data.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
let hits = 0;

for (const m of MISSIONS) {
  if (!m.q) continue;
  process.stdout.write(`${m.id.padEnd(16)} `);
  try {
    const url = `https://images-api.nasa.gov/search?q=${encodeURIComponent(m.q)}&media_type=image`;
    const res = await fetch(url);
    if (!res.ok) { console.log(`HTTP ${res.status}`); continue; }
    const data = await res.json();
    const item = data?.collection?.items?.[0];
    const thumb = item?.links?.find((l) => l.rel === 'preview')?.href ?? item?.links?.[0]?.href;
    if (!thumb || !/^https:\/\//.test(thumb)) { console.log('— no result'); continue; }
    out[m.id] = { img: thumb, title: item?.data?.[0]?.title ?? '' };
    hits++;
    console.log(`✓ ${(item?.data?.[0]?.title ?? '').slice(0, 60)}`);
  } catch (err) {
    console.log(`FAILED ${err.message}`);
  }
  await sleep(250);   // be polite
}

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mission-images.json');
await writeFile(dest, JSON.stringify(out, null, 1));
console.log(`\n${hits}/${MISSIONS.filter((m) => m.q).length} images → ${dest}`);
