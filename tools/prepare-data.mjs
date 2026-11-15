// prepare-data.mjs — make sure public/data/ exists before a build or dev server.
//
// The site serves its own satellite data from data/ (see tools/satellite-data.mjs).
// On the deploy runner tools/fetch-data.mjs has just put real files there, and
// this leaves them alone.  Anywhere else — a laptop, a fork, a build where the
// fetch found nothing — it builds the same four files from the snapshot
// committed with the code (public/fallback/active.tle), with NO network access,
// so the app and its tests always run the real loading path.
//
//   node tools/prepare-data.mjs        (runs automatically before `npm run dev` / `npm run build`)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES, assemble, checkBundle } from './satellite-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data');
const SNAPSHOT = join(ROOT, 'public', 'fallback', 'active.tle');

const read = (name) => readFile(join(OUT, name), 'utf8').catch(() => null);
const have = { active: await read(FILES.active), debris: await read(FILES.debris), satcat: await read(FILES.satcat), meta: await read(FILES.meta) };

if (have.active != null && have.debris != null && have.satcat != null && have.meta != null) {
  const problems = checkBundle(have);
  let source = '';
  try { source = JSON.parse(have.meta).source; } catch { /* a problem, reported above */ }
  if (!problems.length && source !== 'snapshot') {
    const m = JSON.parse(have.meta);
    console.log(`satellite data: using the fetched files (${m.counts.active.toLocaleString()} active, ${m.counts.debris.toLocaleString()} debris, fetched ${new Date(m.fetchedAt).toISOString()})`);
    process.exit(0);
  }
  if (problems.length) console.warn(`satellite data: the files in public/data/ are not usable (${problems[0]}) — rebuilding from the snapshot`);
}

// From the committed snapshot: no debris lists and no catalog details (the app
// copes with both), dated by the snapshot's own element sets so its age is honest.
const active = await readFile(SNAPSHOT, 'utf8');
const draft = assemble({ active, source: 'snapshot', fetchedAt: 0 });
const epoch = JSON.parse(draft.meta).epoch;
const built = assemble({ active, source: 'snapshot', fetchedAt: epoch ?? 0 });
const problems = checkBundle(built);
if (problems.length) {
  console.error('satellite data: the committed snapshot is not usable:');
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
await mkdir(OUT, { recursive: true });
for (const k of Object.keys(FILES)) await writeFile(join(OUT, FILES[k]), built[k]);
const m = JSON.parse(built.meta);
console.log(`satellite data: built from the committed snapshot (${m.counts.active.toLocaleString()} active, dated ${new Date(m.fetchedAt).toISOString().slice(0, 10)})`);
