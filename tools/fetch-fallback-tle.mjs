// fetch-fallback-tle.mjs — refresh the satellite snapshot committed with the code.
//
// public/fallback/active.tle is CelesTrak's active-satellite list, saved in the
// repository.  It is what a laptop build, a fork and the test suites are built
// from (tools/prepare-data.mjs), what the image tools use, and the app's last
// resort if its data/ folder cannot be read.
//
// It is copied from the LIVE SITE's own data/active.tle — which the deploy
// refreshes from CelesTrak every four hours (tools/fetch-data.mjs) — so this
// makes no request to CelesTrak at all.  Run every Monday by
// .github/workflows/refresh-snapshot.yml.
//
// The result is validated first (tools/tle-snapshot.mjs): an error page, a
// partial file or stale data writes nothing and exits non-zero, leaving the
// previous snapshot in place.
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
const URL_ACTIVE = `${(process.env.ORBITAL_SITE_BASE || 'https://jerredcook.github.io/orbital').replace(/\/$/, '')}/data/active.tle?t=${Date.now()}`;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 120_000);
let text;
try {
  const res = await fetch(URL_ACTIVE, {
    signal: controller.signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  text = await res.text();
} catch (err) {
  console.error(`the live site's data/active.tle could not be read (${err.message}) — keeping the existing snapshot`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}

const { problems, count, medianEpochMs } = validateSnapshot(text);
if (problems.length) {
  console.error('refusing to replace the snapshot — what the live site returned failed validation:');
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, text.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'));
console.log(`wrote ${count.toLocaleString()} active satellites, dated ${new Date(medianEpochMs).toISOString().slice(0, 10)} → ${OUT}`);
