// tca.worker.js — close-approach search, off both the main thread and the
// position-tick worker.
//
// Protocol:
//   main → worker  { type: 'tca', startIso, horizonHours,
//                    pairs: [{ key, l1a, l2a, l1b, l2b }] }
//   worker → main  { type: 'tca-results',
//                    results: [{ key, tcaMs, missM }] }
//
//   main → worker  { type: 'screen', startIso, horizonHours, reportKm,
//                    targetL1, targetL2, candidates: [{ i, l1, l2 }] }
//   worker → main  { type: 'screen-progress', done, total,
//                    found: [{ i, tcaMs, missM }] }        (incremental)
//   worker → main  { type: 'screen-done' }
//   main → worker  { type: 'screen-cancel' }
//
// TCA search for a known pair: coarse 30 s grid over the horizon, then
// ternary refinement around the best sample.  Honest caveat — a 30 s grid
// can miss the true minimum of a fast-crossing encounter (closest-approach
// window ≪ 1 s), but those candidates come from the live view, which
// surfaces co-moving pairs; for those the distance curve is smooth.
//
// Screening (one target vs thousands of candidates) can't afford 30 s
// everywhere.  Three stages per candidate: 120 s coarse grid against
// precomputed target positions; where the pair dips under 1,150 km, a 15 s
// fine scan; then ternary refinement on fine minima under 300 km.  The gate
// must cover the worst excursion a 120 s gap can hide: retrograde-geometry
// encounters (e.g. GTO/Molniya perigees at LEO altitude) close at 17–18 km/s,
// ~1,080 km in the 60 s half-gap — a tighter gate silently drops those.
// Screening runs in ~200 ms time slices via setTimeout so cancel messages and
// TCA batches interleave cleanly.

import * as satellite from 'satellite.js';
import { eciKm as eciAt } from './astro.js';   // shared fast SGP4 sampler (minutes-since-epoch trick)

function pairDistM(recA, recB, tMs) {
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

function findTca(recA, recB, startMs, horizonMs) {
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

// ------------------------------------------------------------- screening ----

let activeScreen = null;

function startScreen(msg) {
  const run = { cancelled: false, gen: msg.gen };
  activeScreen = run;

  const startMs = new Date(msg.startIso).getTime();
  const horizonMs = msg.horizonHours * 3.6e6;
  const COARSE_MS = 120_000, FINE_MS = 15_000;
  const COARSE_GATE_M = 1_150_000, REFINE_GATE_M = 300_000;
  const reportM = msg.reportKm * 1000;

  const target = satellite.twoline2satrec(msg.targetL1, msg.targetL2);
  const nT = Math.floor(horizonMs / COARSE_MS);
  const tpos = new Float64Array((nT + 1) * 3).fill(NaN);
  for (let k = 0; k <= nT; k++) {
    const p = eciAt(target, startMs + k * COARSE_MS);
    if (p) { tpos[k * 3] = p.x; tpos[k * 3 + 1] = p.y; tpos[k * 3 + 2] = p.z; }
  }

  const gate2 = (COARSE_GATE_M / 1000) ** 2; // compare in km² against raw ECI
  const candidates = msg.candidates;
  const total = candidates.length;
  const found = [];
  let idx = 0;

  function refineRegion(rec, kStart, kEnd) {
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

  function processCandidate(c) {
    const rec = satellite.twoline2satrec(c.l1, c.l2);
    if (rec.error !== 0) return;
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
        const hit = refineRegion(rec, regionStart, k);
        if (hit && (!best || hit.missM < best.missM)) best = hit;
      }
    }
    if (best) found.push({ i: c.i, ...best });
  }

  function chunk() {
    if (run.cancelled || activeScreen !== run) return;
    const sliceStart = Date.now();
    while (idx < total && Date.now() - sliceStart < 200) {
      processCandidate(candidates[idx++]);
    }
    self.postMessage({ type: 'screen-progress', done: idx, total, found: found.splice(0), gen: run.gen });
    if (idx < total) setTimeout(chunk, 0);
    else self.postMessage({ type: 'screen-done', gen: run.gen });
  }
  chunk();
}

// -------------------------------------------------------------- messages ----

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'screen') { startScreen(msg); return; }
  if (msg.type === 'screen-cancel') {
    if (activeScreen) activeScreen.cancelled = true;
    return;
  }

  if (msg.type !== 'tca') return;
  const startMs = new Date(msg.startIso).getTime();
  const horizonMs = msg.horizonHours * 3.6e6;
  const results = [];
  for (const p of msg.pairs) {
    const recA = satellite.twoline2satrec(p.l1a, p.l2a);
    const recB = satellite.twoline2satrec(p.l1b, p.l2b);
    const hit = findTca(recA, recB, startMs, horizonMs);
    if (hit) results.push({ key: p.key, ...hit });
    else results.push({ key: p.key, tcaMs: null, missM: null });
  }
  self.postMessage({ type: 'tca-results', results, gen: msg.gen });
};
