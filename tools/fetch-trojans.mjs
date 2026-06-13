// fetch-trojans.mjs — bundle a real subset of Jupiter's Trojan asteroids.
//
// Pulls the largest Jupiter Trojans (sb-class TJN) brighter than H = 13.5 from
// NASA/JPL's Small-Body Database Query API, with osculating Keplerian elements,
// and writes a compact JSON the solar-system view loads and Kepler-propagates.
// Trojans librate ~±60° from Jupiter in mean longitude (the L4 "Greek" and L5
// "Trojan" clouds), so the real elements already place them in the two swarms —
// no procedural clustering needed, just propagate.
//
//   node tools/fetch-trojans.mjs
//
// Elements per object: [a (AU), e, i (deg), Ω (deg), ω (deg), M (deg)] at a
// common epoch (JPL returns one epoch for the set).  Public domain (NASA/JPL).

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'trojans.json');
const API = 'https://ssd-api.jpl.nasa.gov/sbdb_query.api';
const params = new URLSearchParams({
  fields: 'a,e,i,om,w,ma,epoch',
  'sb-class': 'TJN',
  'sb-cdata': JSON.stringify({ AND: ['H|LT|13.5'] }),
  'full-prec': 'false',
});

const res = await fetch(`${API}?${params}`);
if (!res.ok) { console.error('fetch failed', res.status); process.exit(1); }
const { data } = await res.json();

// Confirm a shared epoch (they're all JPL's standard epoch); keep the modal one.
const epochs = {};
for (const r of data) epochs[r[6]] = (epochs[r[6]] || 0) + 1;
const epoch = Number(Object.entries(epochs).sort((a, b) => b[1] - a[1])[0][0]);

const r3 = (x) => Math.round(Number(x) * 1e3) / 1e3;
const r4 = (x) => Math.round(Number(x) * 1e4) / 1e4;
const elements = data.map((r) => [r4(r[0]), r4(r[1]), r3(r[2]), r3(r[3]), r3(r[4]), r3(r[5])]);

await writeFile(OUT, JSON.stringify({ epoch, count: elements.length, elements }));
console.log(`wrote ${elements.length} Trojans @ epoch ${epoch} (${(JSON.stringify(elements).length / 1024 | 0)} KB) → ${OUT}`);
