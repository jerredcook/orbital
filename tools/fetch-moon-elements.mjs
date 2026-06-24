// fetch-moon-elements.mjs — pull real osculating orbital elements for the major
// moons from JPL Horizons, in the heliocentric-ecliptic J2000 frame the planets
// already use, so each moon propagates with the same Kepler solver.
//
//   node tools/fetch-moon-elements.mjs
//
// Elements are osculating at a single recent epoch (2026-01-01 TDB): the mean
// motion (period) dominates the visible position, so the configuration — the
// Galilean dance, Titan's phase, Triton's tilt — stays accurate across the
// current era; node/periapse precession (un-modelled) only nudges near-circular
// low-inclination orbits.  Writes src/moon-elements.js.

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EPOCH_DATE = '2026-01-01';   // TDB; the returned JD is captured below

// NAIF id + parent planet (whose body centre is the reference, 500@<p>99).
const MOONS = [
  ['Moon', 301, 'Earth'],
  ['Phobos', 401, 'Mars'], ['Deimos', 402, 'Mars'],
  ['Amalthea', 505, 'Jupiter'], ['Thebe', 514, 'Jupiter'], ['Io', 501, 'Jupiter'],
  ['Europa', 502, 'Jupiter'], ['Ganymede', 503, 'Jupiter'], ['Callisto', 504, 'Jupiter'],
  ['Himalia', 506, 'Jupiter'],
  ['Mimas', 601, 'Saturn'], ['Enceladus', 602, 'Saturn'], ['Tethys', 603, 'Saturn'],
  ['Dione', 604, 'Saturn'], ['Rhea', 605, 'Saturn'], ['Titan', 606, 'Saturn'],
  ['Hyperion', 607, 'Saturn'], ['Iapetus', 608, 'Saturn'], ['Phoebe', 609, 'Saturn'],
  ['Puck', 715, 'Uranus'], ['Miranda', 705, 'Uranus'], ['Ariel', 701, 'Uranus'],
  ['Umbriel', 702, 'Uranus'], ['Titania', 703, 'Uranus'], ['Oberon', 704, 'Uranus'],
  ['Larissa', 807, 'Neptune'], ['Proteus', 808, 'Neptune'], ['Triton', 801, 'Neptune'],
  ['Nereid', 802, 'Neptune'],
];
const CENTER = { Earth: '399', Mars: '499', Jupiter: '599', Saturn: '699', Uranus: '799', Neptune: '899' };

// Keys are whitespace-separated (" A = …", " MA= …"), so require a boundary
// before the key — otherwise "A" matches the A inside "MA".
const num = (s, key) => {
  const m = s.match(new RegExp(`(?:^|\\s)${key}\\s*=\\s*(-?[\\d.]+E?[+-]?\\d*)`, 'm'));
  return m ? parseFloat(m[1]) : null;
};

async function fetchEls(id, planet, dateStr) {
  const p = new URLSearchParams({
    format: 'text', COMMAND: `'${id}'`, OBJ_DATA: 'NO', MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'ELEMENTS', CENTER: `'500@${CENTER[planet]}'`,
    REF_PLANE: 'ECLIPTIC', REF_SYSTEM: 'J2000', TLIST: `'${dateStr}'`, OUT_UNITS: 'KM-S',
  });
  const txt = await (await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${p}`)).text();
  const block = txt.match(/\$\$SOE([\s\S]*?)\$\$EOE/);
  if (!block) throw new Error(`no element block (${txt.slice(0, 200)})`);
  const b = block[1];
  return {
    epochJd: parseFloat(b.match(/([\d.]+) = A\.D\./)[1]),
    a: num(b, 'A'), e: num(b, 'EC'), i: num(b, 'IN'),
    node: num(b, 'OM'), peri: num(b, 'W'), M0: num(b, 'MA'),
    Posc: num(b, 'PR') / 86400,
  };
}

const norm360 = (d) => ((d % 360) + 360) % 360;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dateAfter = (days) => new Date(Date.UTC(2026, 0, 1) + days * 86400000).toISOString().slice(0, 10);

// Robust mean-longitude period.  The osculating PR is ~0.1% off the true mean
// rate (fatal for fast moons over many orbits), so we measure the *mean longitude*
// (node+peri+M) advance and infer the period from it.  But for fast, strongly-
// precessing inner moons (Amalthea, Thebe) even the osculating estimate mis-rounds
// the integer turn count over a long baseline.  So two steps: a SHORT baseline
// (~25 turns) gives an unambiguous coarse rate; a LONG baseline (~300 turns), with
// turns counted using that *coarse mean* rate, gives the precise rate.
async function meanPeriod(id, planet, e0) {
  const lam0 = norm360(e0.node + e0.peri + e0.M0);
  const sample = async (turns, predictRate) => {
    const days = Math.min(1600, Math.max(6, Math.round(turns * e0.Posc)));
    const e = await fetchEls(id, planet, dateAfter(days));
    await sleep(300);
    const base = e.epochJd - e0.epochJd;
    const frac = norm360(norm360(e.node + e.peri + e.M0) - lam0);
    return (Math.round((predictRate * base - frac) / 360) * 360 + frac) / base;   // deg/day
  };
  const coarse = await sample(25, 360 / e0.Posc);   // few turns: osculating estimate suffices
  const precise = await sample(300, coarse);        // many turns: count with the coarse mean rate
  return 360 / precise;
}

const out = {};
let epoch = null;
for (const [name, id, planet] of MOONS) {
  process.stdout.write(`${name.padEnd(11)} `);
  try {
    const e0 = await fetchEls(id, planet, EPOCH_DATE);
    await sleep(300);
    epoch = e0.epochJd;
    const periodDays = await meanPeriod(id, planet, e0);
    out[name] = { a: e0.a * 1000, e: e0.e, i: e0.i, node: e0.node, peri: e0.peri, M0: e0.M0, periodDays };
    console.log(`a=${e0.a.toFixed(0)}km  P=${periodDays.toFixed(5)}d (osc ${e0.Posc.toFixed(5)})  i=${e0.i.toFixed(2)}°`);
  } catch (err) { console.log(`FAILED ${err.message}`); }
  await new Promise((r) => setTimeout(r, 300));   // be gentle to Horizons
}

const round = (n, d) => Number(n.toFixed(d));
const body = Object.entries(out).map(([n, e]) =>
  `  ${JSON.stringify(n)}: { a: ${round(e.a, 0)}, e: ${round(e.e, 6)}, i: ${round(e.i, 4)}, ` +
  `node: ${round(e.node, 4)}, peri: ${round(e.peri, 4)}, M0: ${round(e.M0, 4)}, periodDays: ${round(e.periodDays, 6)} }`,
).join(',\n');

const file = `// moon-elements.js — GENERATED by tools/fetch-moon-elements.mjs.  Real osculating
// orbital elements (JPL Horizons), heliocentric-ecliptic J2000, planet-centred.
// a in metres; angles in degrees; M0 = mean anomaly at the epoch below.

export const MOON_EPOCH_JD = ${epoch};   // ${EPOCH_DATE} TDB
export const MOON_ELEMENTS = {
${body},
};
`;
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'moon-elements.js');
await writeFile(dest, file);
console.log(`\nwrote ${Object.keys(out).length} moons → ${dest}`);
