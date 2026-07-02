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

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const RE_KM = 6378.137, E2 = 0.00669437999014;     // WGS84
const OMEGA_E = 7.2921159e-5;                       // Earth rotation rate, rad/s
const SUN_DARK = Math.sin(-6 * RAD);                // civil twilight: sky dark enough to spot satellites
const SHADOW_R_KM = 6371;                           // mean radius for the cylindrical shadow test

// Low-precision solar direction in ECI (unit vector) — same series main.js uses.
function sunEci(tMs) {
  const n = (tMs - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const g = (357.529 + 0.98560028 * n) * RAD;
  const L = (280.459 + 0.98564736 * n) * RAD;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const eps = 23.439 * RAD;
  return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
}

let activeRun = null;

// Station ECF position (km) and local ENU basis, from geodetic lat/lon/alt.
function stationFrame(latRad, lonRad, altM) {
  const h = altM / 1000;
  const sLat = Math.sin(latRad), cLat = Math.cos(latRad);
  const sLon = Math.sin(lonRad), cLon = Math.cos(lonRad);
  const N = RE_KM / Math.sqrt(1 - E2 * sLat * sLat);
  return {
    pos: [(N + h) * cLat * cLon, (N + h) * cLat * sLon, (N * (1 - E2) + h) * sLat],
    up: [cLat * cLon, cLat * sLon, sLat],
    east: [-sLon, cLon, 0],
    north: [-sLat * cLon, -sLat * sLon, cLat],
  };
}

function eciKm(rec, tMs) {
  const jd = rec.jdsatepoch + (rec.jdsatepochF ?? 0);
  const tsince = (tMs / 86400000 + 2440587.5 - jd) * 1440;
  const p = satellite.sgp4(rec, tsince)?.position;
  return (p && !Number.isNaN(p.x)) ? p : null;
}

// Look-angle of `rec` from the station at absolute time tMs, given gmst there.
// Returns { el, az } in degrees, or null if propagation failed.
function look(rec, tMs, gmst, st) {
  const eci = eciKm(rec, tMs);
  if (!eci) return null;
  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  const x = eci.x * cg + eci.y * sg;       // ECI → ECF (rotate by −gmst about Z)
  const y = -eci.x * sg + eci.y * cg;
  const z = eci.z;
  const dx = x - st.pos[0], dy = y - st.pos[1], dz = z - st.pos[2];
  const rng = Math.hypot(dx, dy, dz);
  if (rng === 0) return null;
  const u = (dx * st.up[0] + dy * st.up[1] + dz * st.up[2]) / rng;
  const el = Math.asin(Math.max(-1, Math.min(1, u))) * DEG;
  const e = dx * st.east[0] + dy * st.east[1] + dz * st.east[2];
  const n = dx * st.north[0] + dy * st.north[1] + dz * st.north[2];
  let az = Math.atan2(e, n) * DEG;
  if (az < 0) az += 360;
  return { el, az };
}

function startPasses(msg) {
  const run = { cancelled: false, gen: msg.gen };
  activeRun = run;

  const { startMs } = msg;
  const horizonMs = msg.horizonHours * 3.6e6;
  const minEl = msg.minElevDeg;
  const STEP = 60_000;
  const st = stationFrame(msg.station.latRad, msg.station.lonRad, msg.station.altM);
  const gmst0 = satellite.gstime(new Date(startMs));
  const gmstAt = (tMs) => gmst0 + OMEGA_E * (tMs - startMs) / 1000;

  const nT = Math.floor(horizonMs / STEP);
  const cosG = new Float64Array(nT + 1), sinG = new Float64Array(nT + 1);
  for (let k = 0; k <= nT; k++) { const g = gmstAt(startMs + k * STEP); cosG[k] = Math.cos(g); sinG[k] = Math.sin(g); }

  const elAt = (rec, tMs) => { const l = look(rec, tMs, gmstAt(tMs), st); return l ? l.el : NaN; };

  // Elevation at grid index k using the precomputed rotation (hot path).
  function elK(rec, k) {
    const eci = eciKm(rec, startMs + k * STEP);
    if (!eci) return NaN;
    const cg = cosG[k], sg = sinG[k];
    const x = eci.x * cg + eci.y * sg, y = -eci.x * sg + eci.y * cg, z = eci.z;
    const dx = x - st.pos[0], dy = y - st.pos[1], dz = z - st.pos[2];
    const rng = Math.hypot(dx, dy, dz);
    return Math.asin(Math.max(-1, Math.min(1, (dx * st.up[0] + dy * st.up[1] + dz * st.up[2]) / rng))) * DEG;
  }

  // Bisect the minEl crossing between a below-horizon time and an above-horizon
  // time → time of el == minEl.  Direction-agnostic: works for a rise (tBelow
  // earlier) and a set (tBelow later), since each step moves the endpoint whose
  // side matches, never relying on the numeric ordering of the two times.
  function crossing(rec, tBelow, tAbove) {
    for (let it = 0; it < 24 && Math.abs(tAbove - tBelow) > 500; it++) {
      const tm = (tBelow + tAbove) / 2;
      if (elAt(rec, tm) >= minEl) tAbove = tm; else tBelow = tm;
    }
    return (tBelow + tAbove) / 2;
  }

  function closeRun(rec, firstK, lastK) {
    // exact rise: below sample (firstK-1) → above sample (firstK)
    const riseMs = firstK > 0 ? crossing(rec, startMs + (firstK - 1) * STEP, startMs + firstK * STEP)
      : startMs;
    // exact set: below sample (lastK+1) → above sample (lastK)
    const setMs = lastK < nT ? crossing(rec, startMs + (lastK + 1) * STEP, startMs + lastK * STEP)
      : startMs + nT * STEP;
    // peak: ternary search across the run window
    let lo = riseMs, hi = setMs;
    while (hi - lo > 1000) {
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (elAt(rec, m1) < elAt(rec, m2)) lo = m1; else hi = m2;
    }
    const peakMs = (lo + hi) / 2;
    const peak = look(rec, peakMs, gmstAt(peakMs), st);
    const rise = look(rec, riseMs, gmstAt(riseMs), st);
    const set = look(rec, setMs, gmstAt(setMs), st);
    return {
      riseMs, peakMs, setMs,
      peakEl: peak ? peak.el : minEl,
      riseAz: rise ? Math.round(rise.az) : null,
      setAz: set ? Math.round(set.az) : null,
      visible: visibleAt(rec, peakMs),
    };
  }

  // Naked-eye test at the pass peak: the satellite in sunlight (outside Earth's
  // cylindrical shadow) while the station sits in civil-twilight-or-darker sky.
  function visibleAt(rec, tMs) {
    const eci = eciKm(rec, tMs);
    if (!eci) return false;
    const s = sunEci(tMs);
    const g = gmstAt(tMs), cg = Math.cos(g), sg = Math.sin(g);
    const sx = s[0] * cg + s[1] * sg, sy = -s[0] * sg + s[1] * cg, sz = s[2];   // sun → ECF
    if (sx * st.up[0] + sy * st.up[1] + sz * st.up[2] >= SUN_DARK) return false;   // observer's sky too bright
    const along = eci.x * s[0] + eci.y * s[1] + eci.z * s[2];
    if (along > 0) return true;                        // sunward of Earth's centre — lit
    const wx = eci.x - along * s[0], wy = eci.y - along * s[1], wz = eci.z - along * s[2];
    return wx * wx + wy * wy + wz * wz > SHADOW_R_KM * SHADOW_R_KM;   // clear of the shadow cylinder
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
      const up = !Number.isNaN(el) && el >= minEl;
      if (up) { if (firstK < 0) firstK = k; lastK = k; }
      // close a run when we drop below the horizon or reach the end
      if (firstK >= 0 && (!up || k === nT)) {
        // Skip a run that spans the whole window — a continuously-visible
        // (geostationary-like) object isn't a discrete pass.
        if (!(firstK === 0 && lastK === nT)) {
          const pass = closeRun(rec, firstK, lastK);
          if (pass.peakEl >= minEl) found.push({ i: c.i, ...pass });
        }
        firstK = -1; lastK = -1;
      }
    }
  }

  function chunk() {
    if (run.cancelled || activeRun !== run) return;
    const sliceStart = Date.now();
    while (idx < total && Date.now() - sliceStart < 200) processCandidate(candidates[idx++]);
    self.postMessage({ type: 'passes-progress', done: idx, total, passes: found.splice(0), gen: run.gen });
    if (idx < total) setTimeout(chunk, 0);
    else self.postMessage({ type: 'passes-done', gen: run.gen });
  }
  chunk();
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'passes') { startPasses(msg); return; }
  if (msg.type === 'passes-cancel' && activeRun) activeRun.cancelled = true;
};
