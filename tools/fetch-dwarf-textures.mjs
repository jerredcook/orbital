// fetch-dwarf-textures.mjs — download real surface maps for Pluto, Charon and
// Ceres, downscaled to 2k-wide JPG (via macOS sips), same pipeline as
// fetch-moon-textures.mjs.
//
//   node tools/fetch-dwarf-textures.mjs
//
// Sources — Steve Albers (stevealbers.net), compiled from public-domain NASA
// New Horizons / Dawn imagery for PERSONAL, NON-COMMERCIAL use (same terms as
// the moon maps already in the app; credited in-app and in the README):
//   • Pluto — New Horizons colour map (the heart!), 8k → 2k
//   • Charon — New Horizons colour map (Mordor Macula's dark pole)
//   • Ceres — Dawn colour map (Occator's bright spots)
// Pluto and Ceres land in textures/planets/ (they're spheres in the system
// view); Charon in textures/moons/ (it's a moon sphere).
//
// Re-running skips files already present.

import { mkdir, writeFile, rm, access, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'textures');
const MAXW = 2048;
const A = 'http://stevealbers.net/albers/sos';

const SRC = [
  ['pluto', `${A}/pluto/pluto_rgb_cyl_8k.png`, join(ROOT, 'planets')],
  ['charon', `${A}/pluto/charon/charon_rgb_cyl.jpg`, join(ROOT, 'moons')],
  ['ceres', `${A}/asteroids/ceres_rgb_cyl.png`, join(ROOT, 'planets')],
];

const exists = (p) => access(p).then(() => true, () => false);
const widthOf = (f) =>
  parseInt(execFileSync('sips', ['-g', 'pixelWidth', f]).toString().match(/pixelWidth:\s*(\d+)/)?.[1] || '0', 10);

for (const [name, url, outDir] of SRC) {
  await mkdir(outDir, { recursive: true });
  const dest = join(outDir, `${name}.jpg`);
  if (await exists(dest)) { console.log(`skip  ${name} (present)`); continue; }
  process.stdout.write(`get   ${name} … `);
  let res;
  try { res = await fetch(url); } catch (e) { console.log(`FAILED ${e.message}`); continue; }
  if (!res.ok) { console.log(`FAILED ${res.status}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = join(tmpdir(), `dwarftex_${name}.${url.toLowerCase().endsWith('.png') ? 'png' : 'jpg'}`);
  await writeFile(tmp, buf);
  const w = widthOf(tmp);
  const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82'];
  if (w > MAXW) args.push('-Z', String(MAXW));
  args.push(tmp, '--out', dest);
  execFileSync('sips', args, { stdio: 'ignore' });
  await rm(tmp).catch(() => {});
  console.log(`${((await stat(dest)).size / 1024 | 0)} KB  (src ${w}px → ${Math.min(w, MAXW)}px)`);
}

console.log('done');
