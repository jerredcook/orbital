// tca.js — the pure close-approach maths behind tca.worker.js: no worker, no
// messages, no timers, so it can be unit-tested against a brute-force reference
// (tests/tca.test.js).  The worker owns the protocol and the time-slicing; the
// searching all lives here.
//
// Both searches use the same three stages, validated against a brute-force
// reference in tests/tca.test.js.
//
// Screening (one target vs thousands of candidates) can't afford 30 s
// everywhere.  Three stages per candidate: 120 s coarse grid against
// precomputed target positions; where the pair dips under 1,150 km, a 15 s
// fine scan; then ternary refinement on fine minima under 300 km.  The gate
// must cover the worst excursion a 120 s gap can hide: retrograde-geometry
// encounters (e.g. GTO/Molniya perigees at LEO altitude) close at 17–18 km/s,
// ~1,080 km in the 60 s half-gap — a tighter gate silently drops those.

import * as satellite from 'satellite.js';
import { eciKm as eciAt } from './astro.js';   // shared fast SGP4 sampler (minutes-since-epoch trick)

export const COARSE_MS = 120_000, FINE_MS = 15_000;
export const COARSE_GATE_M = 1_150_000, REFINE_GATE_M = 300_000;

// Separation in metres at absolute time tMs (NaN if either propagation fails).
export function pairDistM(recA, recB, tMs) {
  const a = eciAt(recA, tMs), b = eciAt(recB, tMs);
  if (!a || !b) return NaN;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 1000;
}

// Distance is frame-invariant under the shared ECI→ECF rotation, so compare
// raw ECI positions and skip the GMST transform entirely.
function distAt(recA, recB, ms) {
  const date = new Date(ms);
  const a = satellite.propagate(recA, date)?.position;
  const b = satellite.propagate(recB, date)?.position;
  if (!a || !b || Number.isNaN(a.x) || Number.isNaN(b.x)) return NaN;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 1000; // km → m
}

// Fallback for pairs that never come within the refine gate: a 30 s grid over
// the horizon, then ternary refinement around the best sample.  Only sound
// where the distance curve is smooth on a 30 s scale — true for far-apart
// pairs, NOT for a fast crossing (see findTca).
function coarseTca(recA, recB, startMs, horizonMs) {
  const stepMs = 30_000;
  let bestT = NaN, bestD = Infinity;
  const n = Math.floor(horizonMs / stepMs);
  for (let k = 0; k <= n; k++) {
    const t = startMs + k * stepMs;
    const d = distAt(recA, recB, t);
    if (d < bestD) { bestD = d; bestT = t; }
  }
  if (!Number.isFinite(bestD)) return null;

  let lo = Math.max(startMs, bestT - stepMs);
  let hi = Math.min(startMs + horizonMs, bestT + stepMs);
  while (hi - lo > 100) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (distAt(recA, recB, m1) < distAt(recA, recB, m2)) hi = m2;
    else lo = m1;
  }
  const tcaMs = (lo + hi) / 2;
  return { tcaMs, missM: distAt(recA, recB, tcaMs) };
}

// Closest approach of one known pair over [startMs, startMs + horizonMs]:
// { tcaMs, missM }, or null if the pair never propagates.
//
// Runs the screening search on the pair.  It used to be the 30 s grid alone,
// which is wrong for exactly the pairs the live list surfaces most: two craft
// crossing at 10+ km/s are within a few km for well under a second, so a 30 s
// sample lands anywhere on a ±150 km excursion and the "best sample" is often
// a different, wider encounter (measured: 5 of 24 already-close cases off by
// 4–36 km).  The screen's 15 s fine scan + refinement finds the true minimum,
// and is ~4× cheaper since it only looks closely where the pair is near.
export function findTca(recA, recB, startMs, horizonMs) {
  return screenCandidate(recB, targetTrack(recA, startMs, horizonMs), Infinity)
    ?? coarseTca(recA, recB, startMs, horizonMs);
}

// ------------------------------------------------------------- screening ----

// The target's ECI position (km) on the coarse grid, computed once and shared
// by every candidate.  NaN where propagation failed.
export function targetTrack(target, startMs, horizonMs) {
  const nT = Math.floor(horizonMs / COARSE_MS);
  const tpos = new Float64Array((nT + 1) * 3).fill(NaN);
  for (let k = 0; k <= nT; k++) {
    const p = eciAt(target, startMs + k * COARSE_MS);
    if (p) { tpos[k * 3] = p.x; tpos[k * 3 + 1] = p.y; tpos[k * 3 + 2] = p.z; }
  }
  return { target, startMs, horizonMs, nT, tpos };
}

function refineRegion(rec, track, kStart, kEnd, reportM) {
  const { target, startMs, horizonMs, nT } = track;
  const t0 = startMs + Math.max(0, kStart - 1) * COARSE_MS;
  const t1 = startMs + Math.min(nT, kEnd) * COARSE_MS;
  let bestT = NaN, bestD = Infinity;
  for (let t = t0; t <= t1; t += FINE_MS) {
    const d = pairDistM(rec, target, t);
    if (d < bestD) { bestD = d; bestT = t; }
  }
  if (!(bestD < REFINE_GATE_M)) return null;
  let lo = Math.max(startMs, bestT - FINE_MS);
  let hi = Math.min(startMs + horizonMs, bestT + FINE_MS);
  while (hi - lo > 100) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (pairDistM(rec, target, m1) < pairDistM(rec, target, m2)) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2, d = pairDistM(rec, target, t);
  return d < reportM ? { tcaMs: t, missM: d } : null;
}

// One candidate against a precomputed target track: its closest pass inside
// reportM over the horizon as { tcaMs, missM }, or null if it never comes that
// close.
export function screenCandidate(rec, track, reportM) {
  const { startMs, nT, tpos } = track;
  const gate2 = (COARSE_GATE_M / 1000) ** 2; // compare in km² against raw ECI
  let best = null;
  let inRegion = false, regionStart = 0;
  for (let k = 0; k <= nT; k++) {
    const tx = tpos[k * 3];
    let close = false;
    if (!Number.isNaN(tx)) {
      const p = eciAt(rec, startMs + k * COARSE_MS);
      if (p) {
        const dx = p.x - tx, dy = p.y - tpos[k * 3 + 1], dz = p.z - tpos[k * 3 + 2];
        close = dx * dx + dy * dy + dz * dz < gate2;
      }
    }
    if (close && !inRegion) { inRegion = true; regionStart = k; }
    if (inRegion && (!close || k === nT)) {
      inRegion = false;
      const hit = refineRegion(rec, track, regionStart, k, reportM);
      if (hit && (!best || hit.missM < best.missM)) best = hit;
    }
  }
  return best;
}
