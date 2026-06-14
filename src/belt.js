// belt.js — the main asteroid belt as a Kepler-propagated GPU point cloud.
//
// ~3,200 are real: the largest numbered main-belt asteroids (H < 12.5) with
// osculating elements straight from JPL's Small-Body Database (see
// tools/fetch-asteroids.mjs → public/asteroids.json).  The rest are procedural
// fill drawn from the belt's real statistics — a semi-major-axis spread with the
// Kirkwood resonance gaps cut out, Rayleigh eccentricity and inclination — so
// the swarm reads as a real belt at a glance, gaps and all.
//
// Every asteroid is one orbit: solve Kepler each tick, place it heliocentric,
// then run it through the same readable⟷true scale map the planets use.  All of
// them draw in a single GL call via the (bounding-radius-generalised) SatSwarm.

import { Color } from 'cesium';
import { SatSwarm } from './swarm.js';
import { scenePosition } from './scale.js';
import { centuriesSinceJ2000, AU_METERS } from './ephemeris.js';

const BASE = import.meta.env.BASE_URL;
const DEG = Math.PI / 180;
const J2000_JD = 2451545.0;
const TOTAL = 14000;                 // real subset + procedural fill
const COLOR = Color.fromCssColorString('#CDB78F');
const TROJAN_COLOR = Color.fromCssColorString('#8FB0A8');   // cooler tint: a distinct population
const POINT_SIZE = 2.0;
const FAMILY_POINT_SIZE = 2.6;       // a touch larger so the coloured rings read over the belt haze
const BOUNDING_RADIUS = 1.0e12;      // covers belt (~3 AU) and Trojans (~5.2 AU) in both scale modes

// Kirkwood gaps (mean-motion resonances with Jupiter), in AU — procedural
// asteroids are rejected near these so the gaps actually show.
const GAPS = [2.06, 2.50, 2.82, 2.96, 3.27];
const GAP_HW = 0.018;                 // half-width of each cleared gap (AU)

// Rayleigh sample (for eccentricity / inclination spreads).
const rayleigh = (sigma) => sigma * Math.sqrt(-2 * Math.log(1 - Math.random()));

function proceduralElement() {
  // Reject-sample the semi-major axis out of the Kirkwood gaps.
  let a;
  do { a = 2.08 + Math.random() * (3.28 - 2.08); }
  while (GAPS.some((g) => Math.abs(a - g) < GAP_HW) && Math.random() < 0.92);
  const e = Math.min(rayleigh(0.072), 0.35);
  const i = Math.min(rayleigh(7.0), 35);
  return [a, e, i, Math.random() * 360, Math.random() * 360, Math.random() * 360];
}

// Pre-bake the per-asteroid constants used every tick: mean motion, and the six
// coefficients of the orbital-plane → ecliptic rotation (i, Ω, ω are fixed).
function bake(elements, epochJD) {
  const n = elements.length;
  const a = new Float64Array(n), e = new Float64Array(n);
  const M0 = new Float64Array(n), nDay = new Float64Array(n);
  const c = [0, 1, 2, 3, 4, 5].map(() => new Float64Array(n));  // r11,r12,r21,r22,r31,r32
  for (let k = 0; k < n; k++) {
    const [ak, ek, ik, om, w, ma] = elements[k];
    a[k] = ak; e[k] = ek;
    M0[k] = ma * DEG;
    nDay[k] = (2 * Math.PI) / (Math.pow(ak, 1.5) * 365.25);     // rad/day
    const cO = Math.cos(om * DEG), sO = Math.sin(om * DEG);
    const cw = Math.cos(w * DEG), sw = Math.sin(w * DEG);
    const ci = Math.cos(ik * DEG), si = Math.sin(ik * DEG);
    c[0][k] = cw * cO - sw * sO * ci; c[1][k] = -sw * cO - cw * sO * ci;
    c[2][k] = cw * sO + sw * cO * ci; c[3][k] = -sw * sO + cw * cO * ci;
    c[4][k] = sw * si;                c[5][k] = cw * si;
  }
  return { n, a, e, M0, nDay, c, epochJD };
}

// Build a Kepler-propagated point-cloud from a baked element set: one GL draw
// call, re-solved on a throttled wall-clock tick.  Shared by the main belt, the
// Jupiter Trojans and the asteroid families — only the element source, colour
// (uniform `color`, or per-point `colorAt(k)`) and point size differ.
function createKeplerSwarm(viewer, earthClock, { elements, epoch, color, colorAt, pointSize = POINT_SIZE }) {
  const ast = bake(elements, epoch);

  const swarm = new SatSwarm(ast.n, { boundingRadius: BOUNDING_RADIUS });
  for (let k = 0; k < ast.n; k++) swarm.setStyle(k, colorAt ? colorAt(k) : color, pointSize);
  viewer.scene.primitives.add(swarm);

  const buf = new Float64Array(ast.n * 3);
  const scratch = { x: 0, y: 0, z: 0 };
  let lastWall = -1;

  function recompute() {
    const jd = J2000_JD + centuriesSinceJ2000(earthClock.currentTime) * 36525;
    const tDays = jd - ast.epochJD;
    const { a, e, M0, nDay, c } = ast;
    for (let k = 0; k < ast.n; k++) {
      const ek = e[k];
      let M = M0[k] + nDay[k] * tDays;
      M = M - 2 * Math.PI * Math.floor(M / (2 * Math.PI) + 0.5);   // wrap to (-π, π]
      let E = M;
      for (let it = 0; it < 6; it++) E -= (E - ek * Math.sin(E) - M) / (1 - ek * Math.cos(E));
      const xp = a[k] * (Math.cos(E) - ek) * AU_METERS;
      const yp = a[k] * Math.sqrt(1 - ek * ek) * Math.sin(E) * AU_METERS;
      scratch.x = c[0][k] * xp + c[1][k] * yp;
      scratch.y = c[2][k] * xp + c[3][k] * yp;
      scratch.z = c[4][k] * xp + c[5][k] * yp;
      scenePosition(scratch, scratch);
      buf[k * 3] = scratch.x; buf[k * 3 + 1] = scratch.y; buf[k * 3 + 2] = scratch.z;
    }
    swarm.updatePositions(buf);
  }

  recompute();
  return {
    get count() { return ast.n; },
    set show(v) { swarm.show = v; },
    // Throttled to ~8 Hz of wall time — the swarm drifts slowly even under heavy
    // time-warp at this zoom, and tens of thousands of Kepler solves a frame is
    // wasteful.  Hidden (the family toggle) skips the solve + GPU upload entirely;
    // the first tick after re-showing re-places immediately (lastWall is stale).
    tick(nowMs, force) {
      if (!swarm.show) return;
      if (force || lastWall < 0 || nowMs - lastWall > 120) { lastWall = nowMs; recompute(); }
    },
    destroy() { viewer.scene.primitives.remove(swarm); },
  };
}

// The main belt: ~3,200 real largest main-belt asteroids plus procedural fill
// to TOTAL, drawn from the belt's real a/e/i statistics with the Kirkwood gaps.
export async function createBelt(viewer, earthClock) {
  let real = { epoch: J2000_JD, elements: [] };
  try { real = await (await fetch(`${BASE}asteroids.json`)).json(); } catch { /* procedural only */ }

  const elements = real.elements.slice();
  while (elements.length < TOTAL) elements.push(proceduralElement());
  return createKeplerSwarm(viewer, earthClock, { elements, epoch: real.epoch, color: COLOR });
}

// Jupiter's Trojans: the real largest members of the L4 (leading) and L5
// (trailing) clouds.  Their osculating elements already place them ~±60° from
// Jupiter and share its period, so the two clumps form and co-move on their own
// — all real, no procedural fill (see tools/fetch-trojans.mjs).
export async function createTrojans(viewer, earthClock) {
  let real = { epoch: J2000_JD, elements: [] };
  try { real = await (await fetch(`${BASE}trojans.json`)).json(); } catch { return null; }
  if (!real.elements.length) return null;
  return createKeplerSwarm(viewer, earthClock, { elements: real.elements, epoch: real.epoch, color: TROJAN_COLOR });
}

// The major main-belt asteroid families, tinted as their own clusters
// (see tools/fetch-families.mjs → public/families.json).  A family is a cluster
// in PROPER-element space (a, e, sin i), not in physical position, so each
// member carries its real proper a/e/i and gets a random orbital phase here —
// the result is a set of coloured, inclined rings threading the belt, not blobs.
// Returns the swarm controller with `.families` (legend metadata) attached.
export async function createFamilies(viewer, earthClock) {
  let data;
  try { data = await (await fetch(`${BASE}families.json`)).json(); } catch { return null; }
  if (!data?.members?.length || !data?.families?.length) return null;

  const colors = data.families.map((f) => Color.fromCssColorString(f.color));
  const famOf = data.members.map((m) => m[3]);
  const elements = data.members.map(([a, e, i]) => [
    a, e, i, Math.random() * 360, Math.random() * 360, Math.random() * 360,
  ]);

  const ctrl = createKeplerSwarm(viewer, earthClock, {
    elements, epoch: J2000_JD, pointSize: FAMILY_POINT_SIZE,
    colorAt: (k) => colors[famOf[k]] ?? colors[0],   // ?? guards a malformed family index
  });
  ctrl.families = data.families;
  return ctrl;
}
