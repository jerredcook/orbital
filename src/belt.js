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
const POINT_SIZE = 2.0;

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

export async function createBelt(viewer, earthClock) {
  let real = { epoch: J2000_JD, elements: [] };
  try { real = await (await fetch(`${BASE}asteroids.json`)).json(); } catch { /* procedural only */ }

  const elements = real.elements.slice();
  while (elements.length < TOTAL) elements.push(proceduralElement());
  const ast = bake(elements, real.epoch);

  const swarm = new SatSwarm(ast.n, { boundingRadius: 1.0e12 });
  for (let k = 0; k < ast.n; k++) swarm.setStyle(k, COLOR, POINT_SIZE);
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
    // Throttled to ~8 Hz of wall time — the belt drifts slowly even under heavy
    // time-warp at this zoom, and 14k Kepler solves a frame is wasteful.
    tick(nowMs, force) {
      if (force || lastWall < 0 || nowMs - lastWall > 120) { lastWall = nowMs; recompute(); }
    },
    destroy() { viewer.scene.primitives.remove(swarm); },
  };
}
