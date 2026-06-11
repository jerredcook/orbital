// tca.worker.js — time of closest approach (TCA) for candidate pairs.
//
// Protocol:
//   main → worker  { type: 'tca', startIso, horizonHours,
//                    pairs: [{ key, l1a, l2a, l1b, l2b }] }
//   worker → main  { type: 'tca-results',
//                    results: [{ key, tcaMs, missM }] }   (failed pairs omitted)
//
// Separate from the propagator worker so a TCA batch (~50 ms/pair) never
// stalls the 600 ms full-catalog position ticks.
//
// Search: coarse 30 s grid over the horizon, then ternary refinement around
// the best sample.  Honest caveat — a 30 s grid can miss the true minimum of
// a fast-crossing encounter (closest-approach window ≪ 1 s), but candidates
// come from the live view, which surfaces co-moving pairs; for those the
// distance curve is smooth at this scale.

import * as satellite from 'satellite.js';

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

self.onmessage = (e) => {
  const msg = e.data;
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
  self.postMessage({ type: 'tca-results', results });
};
