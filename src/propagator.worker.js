// propagator.worker.js — runs SGP4 for the whole catalog off the main thread.
//
// Protocol:
//   main → worker  { type: 'init', tles: [{ norad, l1, l2 }] }
//   main → worker  { type: 'propagate', isoTime: '…', conjKm }
//   worker → main  { type: 'ready', count, bad }            after init
//   worker → main  { type: 'positions', isoTime, buf, pairs }
//                   buf layout: [x, y, z, x, y, z, …] in meters, Earth-fixed
//                   (ECF) frame, NaN triple for objects that failed to propagate.
//                   pairs (when conjKm > 0): [[i, j, meters], …] sorted by
//                   distance, capped — every pair of objects currently within
//                   conjKm of each other.

import * as satellite from 'satellite.js';

let satrecs = [];

const MAX_PAIRS = 100;

// Objects closer than this are one physical complex — docked vehicles and
// station modules carry their own NORAD IDs (ISS alone is a dozen entries)
// and would otherwise flood the list with permanent 0.0 km "conjunctions".
const MIN_SEPARATION_M = 250;

// All pairs closer than thresholdM, via a uniform-grid spatial hash with
// cell size = threshold: each object only checks the 27 surrounding cells.
// Hash collisions are harmless — they just add candidates to the exact
// distance check.  O(n + pairs) instead of O(n²).
function findConjunctions(buf, thresholdM) {
  const n = buf.length / 3;
  const cell = thresholdM;
  const t2 = thresholdM * thresholdM;
  const min2 = MIN_SEPARATION_M * MIN_SEPARATION_M;
  const hash = (cx, cy, cz) =>
    ((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) | 0;

  const grid = new Map();
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const x = buf[i * 3];
    if (Number.isNaN(x)) continue;
    const y = buf[i * 3 + 1], z = buf[i * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);

    // Check earlier-inserted objects in this and neighboring cells, so each
    // pair is examined exactly once.
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(hash(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const j of bucket) {
            const ddx = x - buf[j * 3];
            const ddy = y - buf[j * 3 + 1];
            const ddz = z - buf[j * 3 + 2];
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < t2 && d2 > min2) pairs.push([j, i, Math.sqrt(d2)]);
          }
        }

    const k = hash(cx, cy, cz);
    let bucket = grid.get(k);
    if (!bucket) grid.set(k, bucket = []);
    bucket.push(i);
  }
  pairs.sort((a, b) => a[2] - b[2]);
  return pairs.slice(0, MAX_PAIRS);
}

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    satrecs = [];
    let bad = 0;
    for (const t of msg.tles) {
      const rec = satellite.twoline2satrec(t.l1, t.l2);
      if (rec.error !== 0) bad++;
      satrecs.push(rec);
    }
    self.postMessage({ type: 'ready', count: satrecs.length, bad });
    return;
  }

  if (msg.type === 'propagate') {
    const date = new Date(msg.isoTime);
    const gmst = satellite.gstime(date);
    const n = satrecs.length;
    const buf = new Float64Array(n * 3);

    for (let i = 0; i < n; i++) {
      const pv = satellite.propagate(satrecs[i], date);
      const p = pv?.position;
      if (!p || Number.isNaN(p.x)) {
        buf[i * 3] = NaN; buf[i * 3 + 1] = NaN; buf[i * 3 + 2] = NaN;
        continue;
      }
      const ecf = satellite.eciToEcf(p, gmst);
      buf[i * 3] = ecf.x * 1000;       // km → m
      buf[i * 3 + 1] = ecf.y * 1000;
      buf[i * 3 + 2] = ecf.z * 1000;
    }

    const pairs = msg.conjKm > 0 ? findConjunctions(buf, msg.conjKm * 1000) : null;
    self.postMessage({ type: 'positions', isoTime: msg.isoTime, buf, pairs }, [buf.buffer]);
  }
};
