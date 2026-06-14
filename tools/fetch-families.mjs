// fetch-families.mjs — bundle the major main-belt asteroid families.
//
// Pulls per-family member lists (proper elements: proper a, e, sin i) from
// NASA PDS's Nesvorny HCM Asteroid Families V2.0 archive and writes a compact
// JSON the solar-system view renders as coloured, tilted rings inside the belt.
//
//   node tools/fetch-families.mjs
//
// An asteroid family is a CLUSTER IN PROPER-ELEMENT SPACE (a, e, sin i), not in
// physical position — its members are spread all around their orbits — so we
// keep each member's real proper a/e/i (which is what defines membership and
// gives the tightest rings) and let the renderer assign a random orbital phase.
// The brightest ~K per family are kept to bound the file.  Public domain
// (NASA PDS; Nesvorny 2024, doi:10.26033/5hyq-6k90; method Nesvorny et al. 2015).

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'families.json');
const BASE = 'https://sbnarchive.psi.edu/pds4/non_mission/ast.nesvorny.families_V2_0/data/families_2015/';
const PER_FAMILY = 600;             // brightest members kept per family (bounds file + tick cost)

// Ordered inner→outer by proper a, so the legend reads across the belt.  Colours
// evoke taxonomy — S warm tan/orange/red, C/X cool blue/teal, V pale cream,
// K red-brown, E pale lavender — all kept distinct from the belt tan (#CDB78F)
// and the Trojans' green-grey (#8FB0A8).  .tab columns are:
//   number  proper_a  proper_e  proper_sinI  H  slopeG  famID  parent  name
const FAMILIES = [
  { file: '003_hungaria.tab',    name: 'Hungaria',     parent: 434,  tax: 'E', color: '#D8D2E0' },
  { file: '402_flora.tab',       name: 'Flora',        parent: 8,    tax: 'S', color: '#D98C5F' },
  { file: '401_vesta.tab',       name: 'Vesta',        parent: 4,    tax: 'V', color: '#F2E6C2' },
  { file: '701_phocaea.tab',     name: 'Phocaea',      parent: 25,   tax: 'S', color: '#A8553A' },
  { file: '405_nysa_polana.tab', name: 'Nysa–Polana',  parent: 44,   tax: 'C', color: '#6E7E8C' },
  { file: '404_massalia.tab',    name: 'Massalia',     parent: 20,   tax: 'S', color: '#CF6A48' },
  { file: '506_maria.tab',       name: 'Maria',        parent: 170,  tax: 'S', color: '#C2853C' },
  { file: '502_eunomia.tab',     name: 'Eunomia',      parent: 15,   tax: 'S', color: '#E0A24E' },
  { file: '505_adeona.tab',      name: 'Adeona',       parent: 145,  tax: 'C', color: '#5C8A86' },
  { file: '516_gefion.tab',      name: 'Gefion',       parent: 1272, tax: 'S', color: '#9C6A38' },
  { file: '605_koronis.tab',     name: 'Koronis',      parent: 158,  tax: 'S', color: '#E8B070' },
  { file: '606_eos.tab',         name: 'Eos',          parent: 221,  tax: 'K', color: '#C98A5E' },
  { file: '602_themis.tab',      name: 'Themis',       parent: 24,   tax: 'C', color: '#5B86A0' },
  { file: '601_hygiea.tab',      name: 'Hygiea',       parent: 10,   tax: 'C', color: '#3F6E78' },
];

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r3 = (x) => Math.round(x * 1e3) / 1e3;
const RAD = 180 / Math.PI;

const members = [];           // [a (AU), e, i (deg), familyIndex]
const meta = [];

for (let fi = 0; fi < FAMILIES.length; fi++) {
  const f = FAMILIES[fi];
  let rows = [];
  try {
    const text = await (await fetch(BASE + f.file)).text();
    for (const line of text.split('\n')) {
      const t = line.trim().split(/\s+/);
      if (t.length < 5) continue;
      const a = +t[1], e = +t[2], sinI = +t[3], H = +t[4];
      if (!(a > 0) || !(e >= 0) || !(sinI >= 0) || Number.isNaN(H)) continue;
      rows.push({ a, e, sinI, H });
    }
  } catch (err) {
    console.warn(`skip ${f.name}: ${err.message}`);
    meta.push({ name: f.name, parent: f.parent, tax: f.tax, color: f.color, count: 0 });
    continue;
  }
  rows.sort((p, q) => p.H - q.H);        // brightest first
  rows = rows.slice(0, PER_FAMILY);
  for (const r of rows) {
    const iDeg = Math.asin(Math.min(1, r.sinI)) * RAD;
    members.push([r4(r.a), r4(r.e), r3(iDeg), fi]);
  }
  meta.push({ name: f.name, parent: f.parent, tax: f.tax, color: f.color, count: rows.length });
  console.log(`${f.name.padEnd(14)} ${String(rows.length).padStart(4)}`);
}

const json = JSON.stringify({ families: meta, members });
await writeFile(OUT, json);
console.log(`\nwrote ${members.length} members across ${meta.length} families (${(json.length / 1024 | 0)} KB) → ${OUT}`);
