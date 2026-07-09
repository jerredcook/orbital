// passes.worker.js — ground-station pass prediction for the whole catalog.
//
// Given a station (geodetic) and the catalog, find every interval each satellite
// spends above a minimum elevation over the next N hours: its rise, peak (max
// elevation) and set, with rise/set azimuths.  Mirrors the screening worker's
// time-sliced chunking so the main thread and position ticks stay smooth.
//
// Protocol:
//   main → worker  { type: 'passes', startMs, horizonHours, minElevDeg,
//                    station: { latRad, lonRad, altM },
//                    candidates: [{ i, l1, l2 }] }
//   worker → main  { type: 'passes-progress', done, total,
//                    passes: [{ i, riseMs, peakMs, setMs, peakEl, riseAz, setAz }] }
//   worker → main  { type: 'passes-done' }
//   main → worker  { type: 'passes-cancel' }
//
// Coarse 60 s grid to detect each above-horizon run (a LEO pass above 10° lasts
// minutes — several samples), then bisect the minimum-elevation crossings for
// exact rise/set and ternary-refine the peak.  Elevation is the geometric angle
// of the satellite above the station's local horizontal: rotate the SGP4 ECI
// position to ECF (per-step GMST, advanced linearly) and dot against the
// station's local up/east/north.  satellite.sgp4 (minutes-since-epoch) is used
// directly to skip the per-call Date/jday machinery — the same trick that makes
// the screen fast.

import * as satellite from 'satellite.js';
import { SUN_DARK, EARTH_R_KM, sunEciUnit, isSunlitR, eciKm, stationFrameKm, lookElAz } from './astro.js';
import { findWindows } from './passfind.js';

const DEG = 180 / Math.PI;
const OMEGA_E = 7.2921159e-5;                       // Earth rotation rate, rad/s

let activeRun = null;

// Look-angle of `rec` from the station at absolute time tMs, given gmst there.
// Returns { el, az } in degrees, or null if propagation failed.
function look(rec, tMs, gmst, st) {
  const eci = eciKm(rec, tMs);
  if (!eci) return null;
  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  // ECI → ECF (rotate by −gmst about Z), then the shared look-angle math.
  return lookElAz(eci.x * cg + eci.y * sg, -eci.x * sg + eci.y * cg, eci.z, st);
}

function startPasses(msg) {
  const run = { cancelled: false, gen: msg.gen, scanId: msg.scanId };
  activeRun = run;

  const { startMs } = msg;
  const horizonMs = msg.horizonHours * 3.6e6;
  const minEl = msg.minElevDeg;
  const STEP = 60_000;
  const st = stationFrameKm(msg.station.latRad, msg.station.lonRad, msg.station.altM);
  const gmst0 = satellite.gstime(new Date(startMs));
  const gmstAt = (tMs) => gmst0 + OMEGA_E * (tMs - startMs) / 1000;

  const nT = Math.floor(horizonMs / STEP);
  const cosG = new Float64Array(nT + 1), sinG = new Float64Array(nT + 1);
  for (let k = 0; k <= nT; k++) { const g = gmstAt(startMs + k * STEP); cosG[k] = Math.cos(g); sinG[k] = Math.sin(g); }

  const elAt = (rec, tMs) => { const l = look(rec, tMs, gmstAt(tMs), st); return l ? l.el : NaN; };

  // Elevation at grid index k using the precomputed rotation (HOT path: 1,440
  // steps × thousands of candidates — keeps astro.lookElAz's math inlined).
  function elK(rec, k) {
    const eci = eciKm(rec, startMs + k * STEP);
    if (!eci) return NaN;
    const cg = cosG[k], sg = sinG[k];
    const x = eci.x * cg + eci.y * sg, y = -eci.x * sg + eci.y * cg, z = eci.z;
    const dx = x - st.pos[0], dy = y - st.pos[1], dz = z - st.pos[2];
    const rng = Math.hypot(dx, dy, dz);
    return Math.asin(Math.max(-1, Math.min(1, (dx * st.up[0] + dy * st.up[1] + dz * st.up[2]) / rng))) * DEG;
  }

  // Given an above-HORIZON run (firstK..lastK), return EVERY minimum-elevation
  // pass inside it.  Detecting runs at the geometric horizon (not at minEl) means
  // a short pass that pops above a high filter for less than one 60 s grid step
  // is never straddled and lost (AST-11); the multi-window refinement itself is
  // the pure, unit-tested findWindows in passfind.js (eccentric HEO objects make
  // several apparitions per orbit without ever setting between them).
  function closeRun(rec, firstK, lastK) {
    const runStart = firstK > 0 ? startMs + (firstK - 1) * STEP : startMs;   // last below-horizon sample (or window start)
    const runEnd = lastK < nT ? startMs + (lastK + 1) * STEP : startMs + nT * STEP;
    const wins = findWindows({ elAt: (t) => elAt(rec, t), minEl, runStart, runEnd });
    return wins.map((w) => {
      const rise = look(rec, w.riseMs, gmstAt(w.riseMs), st);
      const set = look(rec, w.setMs, gmstAt(w.setMs), st);
      return {
        riseMs: w.riseMs, peakMs: w.peakMs, setMs: w.setMs,
        peakEl: w.peakEl,
        riseAz: rise ? Math.round(rise.az) : null,
        setAz: set ? Math.round(set.az) : null,
        visible: visibleAt(rec, w.peakMs),
      };
    });
  }

  // Naked-eye test at the pass peak: the satellite in sunlight (outside Earth's
  // cylindrical shadow) while the station sits in civil-twilight-or-darker sky.
  function visibleAt(rec, tMs) {
    const eci = eciKm(rec, tMs);
    if (!eci) return false;
    const s = sunEciUnit(tMs);
    const g = gmstAt(tMs), cg = Math.cos(g), sg = Math.sin(g);
    const sx = s.x * cg + s.y * sg, sy = -s.x * sg + s.y * cg, sz = s.z;   // sun → ECF
    if (sx * st.up[0] + sy * st.up[1] + sz * st.up[2] >= SUN_DARK) return false;   // observer's sky too bright
    return isSunlitR(eci.x, eci.y, eci.z, s, EARTH_R_KM);   // ECI km, vs the shared shadow test
  }

  const candidates = msg.candidates;
  const total = candidates.length;
  const found = [];
  let idx = 0;

  function processCandidate(c) {
    const rec = satellite.twoline2satrec(c.l1, c.l2);
    if (rec.error !== 0) return;
    let firstK = -1, lastK = -1;
    for (let k = 0; k <= nT; k++) {
      const el = elK(rec, k);
      const up = !Number.isNaN(el) && el >= 0;   // above the geometric horizon — the minEl gate is applied per-run in closeRun
      if (up) { if (firstK < 0) firstK = k; lastK = k; }
      // close a run when we drop below the horizon or reach the end
      if (firstK >= 0 && (!up || k === nT)) {
        // Skip a run that spans the whole window — a continuously-visible
        // (geostationary-like) object isn't a discrete pass.
        if (!(firstK === 0 && lastK === nT)) {
          for (const pass of closeRun(rec, firstK, lastK)) found.push({ i: c.i, ...pass });
        }
        firstK = -1; lastK = -1;
      }
    }
  }

  function chunk() {
    if (run.cancelled || activeRun !== run) return;
    const sliceStart = Date.now();
    while (idx < total && Date.now() - sliceStart < 200) processCandidate(candidates[idx++]);
    self.postMessage({ type: 'passes-progress', done: idx, total, passes: found.splice(0), gen: run.gen, scanId: run.scanId });
    if (idx < total) setTimeout(chunk, 0);
    else self.postMessage({ type: 'passes-done', gen: run.gen, scanId: run.scanId });
  }
  chunk();
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'passes') { startPasses(msg); return; }
  if (msg.type === 'passes-cancel' && activeRun) activeRun.cancelled = true;
};
