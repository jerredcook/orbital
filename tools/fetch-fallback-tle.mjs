// fetch-fallback-tle.mjs — refresh the satellite snapshot bundled with the app.
//
// public/fallback/active.tle is CelesTrak's active-satellite list, saved.  The
// app shows it when the live feed is unreachable; the test suites and the image
// tools use it INSTEAD of CelesTrak, so they never contact it at all.
//
// This makes ONE request to CelesTrak.  Run it by hand every month or so to
// keep the snapshot from drifting — never in a loop: CelesTrak firewalls
// clients that re-download the big files.
//
// The result is validated first (tools/tle-snapshot.mjs): if CelesTrak answers
// with an error page, a partial file or stale data, nothing is written and the
// script exits non-zero, leaving the previous snapshot in place.
//
//   node tools/fetch-fallback-tle.mjs
//
// (Until November 2026 this pulled from a third-party mirror instead.  That
// mirror's catalog is not the active list — it included thousands of debris
// fragments and rocket bodies, which the app then showed as satellites.)

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSnapshot } from './tle-snapshot.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fallback', 'active.tle');
const URL_ACTIVE = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 60_000);
let text;
try {
  const res = await fetch(URL_ACTIVE, {
    signal: controller.signal,
    headers: { 'User-Agent': 'orbital (github.com/jerredcook/orbital; hobby tracker; monthly snapshot)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  text = await res.text();
} catch (err) {
  console.error(`CelesTrak did not answer (${err.message}) — keeping the existing snapshot`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}

const { problems, count, medianEpochMs } = validateSnapshot(text);
if (problems.length) {
  console.error('refusing to replace the snapshot — what CelesTrak returned failed validation:');
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, text.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'));
console.log(`wrote ${count.toLocaleString()} active satellites, dated ${new Date(medianEpochMs).toISOString().slice(0, 10)} → ${OUT}`);
