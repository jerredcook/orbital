// fetch-textures.mjs — download equirectangular surface maps for the
// solar-system view into public/textures/planets/.
//
// Source: Solar System Scope (https://www.solarsystemscope.com/textures/),
// released under CC-BY-4.0 — attribution is shown in-app and in the README.
// These are 2k maps (~0.3–0.5 MB each); plenty for the overview, and they wrap
// cleanly as equirectangular textures on Cesium's EllipsoidGraphics.
//
//   node tools/fetch-textures.mjs
//
// Re-running skips files already present.  Venus uses the (cloud-free) surface
// map so its real geography reads at close range.

import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'textures', 'planets');
const BASE = 'https://www.solarsystemscope.com/textures/download';

const MAP = {
  'sun.jpg': '2k_sun.jpg',
  'mercury.jpg': '2k_mercury.jpg',
  'venus.jpg': '2k_venus_surface.jpg',
  'earth.jpg': '2k_earth_daymap.jpg',
  'mars.jpg': '2k_mars.jpg',
  'jupiter.jpg': '2k_jupiter.jpg',
  'saturn.jpg': '2k_saturn.jpg',
  'uranus.jpg': '2k_uranus.jpg',
  'neptune.jpg': '2k_neptune.jpg',
};

const exists = (p) => access(p).then(() => true, () => false);

await mkdir(OUT, { recursive: true });

for (const [local, remote] of Object.entries(MAP)) {
  const dest = join(OUT, local);
  if (await exists(dest)) { console.log(`skip  ${local} (present)`); continue; }
  process.stdout.write(`get   ${local} … `);
  const res = await fetch(`${BASE}/${remote}`);
  if (!res.ok) { console.log(`FAILED ${res.status}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`${(buf.length / 1024 | 0)} KB`);
}

console.log('done →', OUT);
