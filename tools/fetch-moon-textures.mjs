// fetch-moon-textures.mjs — download equirectangular surface maps for the major
// moons into public/textures/moons/, downscaled to 2k-wide JPG (via macOS sips).
//
//   node tools/fetch-moon-textures.mjs
//
// Sources (all derived from public-domain NASA/JPL/USGS spacecraft imagery —
// Voyager, Galileo, Cassini, Clementine — but compiled by their authors for
// PERSONAL, NON-COMMERCIAL use; credit them in-app and in the README):
//   • our Moon — Solar System Scope (CC BY 4.0), like the planet maps
//   • Galilean + Saturnian + Uranian + Triton — Steve Albers (stevealbers.net)
//   • Callisto — Björn Jónsson (bjj.mmedia.is)
// Titan (permanent haze), the Martian moons and the small irregular moons have
// no useful global map and stay as flat-tinted spheres in the app.
//
// Re-running skips files already present.

import { mkdir, writeFile, rm, access, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'textures', 'moons');
const MAXW = 2048;
const A = 'http://stevealbers.net/albers/sos';

const SRC = {
  moon: 'https://www.solarsystemscope.com/textures/download/2k_moon.jpg',
  io: `${A}/jupiter/io/io_rgb_cyl.jpg`,
  europa: `${A}/jupiter/europa/europa_rgb_cyl_juno.png`,
  ganymede: `${A}/jupiter/ganymede/ganymede_4k.jpg`,
  callisto: 'https://bjj.mmedia.is/data/callisto/callisto.jpg',
  mimas: `${A}/saturn/mimas/mimas_rgb_cyl_www.jpg`,
  enceladus: `${A}/saturn/enceladus/enceladus_rgb_cyl_www.jpg`,
  tethys: `${A}/saturn/tethys/tethys_rgb_cyl_www.jpg`,
  dione: `${A}/saturn/dione/dione_rgb_cyl_www.jpg`,
  rhea: `${A}/saturn/rhea/rhea_rgb_cyl_www.jpg`,
  iapetus: `${A}/saturn/iapetus/iapetus_rgb_cyl_www.jpg`,
  miranda: `${A}/uranus/miranda/miranda_rgb_cyl_www.jpg`,
  ariel: `${A}/uranus/ariel/ariel_rgb_cyl_www.jpg`,
  umbriel: `${A}/uranus/umbriel/umbriel_rgb_cyl_www.jpg`,
  titania: `${A}/uranus/titania/titania_rgb_cyl_www.jpg`,
  oberon: `${A}/uranus/oberon/oberon_rgb_cyl_www.jpg`,
  triton: `${A}/neptune/triton/triton_rgb_cyl_www.jpg`,
};

const exists = (p) => access(p).then(() => true, () => false);
const widthOf = (f) =>
  parseInt(execFileSync('sips', ['-g', 'pixelWidth', f]).toString().match(/pixelWidth:\s*(\d+)/)?.[1] || '0', 10);

await mkdir(OUT, { recursive: true });

for (const [name, url] of Object.entries(SRC)) {
  const dest = join(OUT, `${name}.jpg`);
  if (await exists(dest)) { console.log(`skip  ${name} (present)`); continue; }
  process.stdout.write(`get   ${name} … `);
  let res;
  try { res = await fetch(url); } catch (e) { console.log(`FAILED ${e.message}`); continue; }
  if (!res.ok) { console.log(`FAILED ${res.status}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = join(tmpdir(), `moontex_${name}.${url.toLowerCase().endsWith('.png') ? 'png' : 'jpg'}`);
  await writeFile(tmp, buf);
  const w = widthOf(tmp);
  const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82'];
  if (w > MAXW) args.push('-Z', String(MAXW));      // don't upscale the low-res Voyager maps
  args.push(tmp, '--out', dest);
  execFileSync('sips', args, { stdio: 'ignore' });
  await rm(tmp).catch(() => {});
  console.log(`${((await stat(dest)).size / 1024 | 0)} KB  (src ${w}px → ${Math.min(w, MAXW)}px)`);
}

console.log('done →', OUT);
