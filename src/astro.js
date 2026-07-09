// astro.js — the canonical shared astronomy/geometry helpers used by the sky
// chart, the pass + conjunction workers, and the showpieces: geodetic constants,
// the low-precision Sun direction (both frames), the cylindrical-shadow sunlit
// test, the WGS84 station frame, look angles, and the fast SGP4 sampler.  All
// pure and worker-importable — these used to live as four independent copies
// (astro.js, both workers, station.js) with independently defined constants.

import * as satellite from 'satellite.js';

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const RE_KM = 6378.137;        // Earth equatorial radius, km (WGS84)
export const E2_WGS84 = 0.00669437999014;   // WGS84 first eccentricity squared
export const EARTH_R = 6.371e6;       // Earth mean radius in METRES, for the shadow test
export const EARTH_R_KM = 6371;       // …and its km twin, for the km-frame workers
export const SUN_DARK = Math.sin(-6 * Math.PI / 180);   // sky dark enough to spot satellites

// The handful bright enough to actually catch the naked eye when sunlit — these
// get a ring + name on the sky chart and a heads-up before a visible pass.
export const NAKED_EYE = new Map([[25544, 'ISS'], [48274, 'Tiangong']]);

// Low-precision solar direction (unit vector) in the INERTIAL frame — good to
// ~arcminutes, plenty to tell day from night and lit from shadowed.
export function sunEciUnit(tMs) {
  const n = (tMs - Date.UTC(2000, 0, 1, 12)) / 86400000;                     // days since J2000
  const g = (357.529 + 0.98560028 * n) * DEG2RAD;                            // mean anomaly
  const L = (280.459 + 0.98564736 * n) * DEG2RAD;                            // mean longitude
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG2RAD; // ecliptic longitude
  const eps = 23.439 * DEG2RAD;
  return { x: Math.cos(lam), y: Math.cos(eps) * Math.sin(lam), z: Math.sin(eps) * Math.sin(lam) };
}

// The same Sun in the Earth-fixed frame (what a ground map needs).
export function sunEcefDir(date) {
  return satellite.eciToEcf(sunEciUnit(date.getTime()), satellite.gstime(date));
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (az) => COMPASS[Math.round(((az % 360) + 360) % 360 / 45) % 8];

// Is a point in sunlight? — sunward of Earth's centre, or its offset from the
// Earth–Sun axis clears the planet (outside the cylindrical shadow).  Unit- and
// frame-agnostic core: `sun` is a unit vector in the SAME frame as x/y/z, and R
// is Earth's radius in the same length units.
export function isSunlitR(x, y, z, sun, R) {
  const along = x * sun.x + y * sun.y + z * sun.z;
  if (along > 0) return true;                       // sunward of Earth's centre — lit
  const wx = x - along * sun.x, wy = y - along * sun.y, wz = z - along * sun.z;
  return (wx * wx + wy * wy + wz * wz) > R * R;     // clear of the shadow cylinder
}
// Metres/ECF convenience used by the sky chart + visible-pass check.
export const isSunlit = (x, y, z, sun) => isSunlitR(x, y, z, sun, EARTH_R);

// satellite.sgp4 wants minutes-since-TLE-epoch; doing the conversion here skips
// the per-call Date/jday machinery of satellite.propagate — it's the difference
// between a full-catalog screen taking seconds and taking a minute.  Returns the
// ECI position in km, or null when propagation fails.
export function eciKm(rec, tMs) {
  const jd = rec.jdsatepoch + (rec.jdsatepochF ?? 0);
  const tsince = (tMs / 86400000 + 2440587.5 - jd) * 1440;
  const p = satellite.sgp4(rec, tsince)?.position;
  return (p && !Number.isNaN(p.x)) ? p : null;
}

// Station ECF position (km) and local ENU basis from geodetic lat/lon/alt (WGS84).
export function stationFrameKm(latRad, lonRad, altM) {
  const h = altM / 1000;
  const sLat = Math.sin(latRad), cLat = Math.cos(latRad);
  const sLon = Math.sin(lonRad), cLon = Math.cos(lonRad);
  const N = RE_KM / Math.sqrt(1 - E2_WGS84 * sLat * sLat);
  return {
    pos: [(N + h) * cLat * cLon, (N + h) * cLat * sLon, (N * (1 - E2_WGS84) + h) * sLat],
    up: [cLat * cLon, cLat * sLon, sLat],
    east: [-sLon, cLon, 0],
    north: [-sLat * cLon, -sLat * sLon, cLat],
  };
}

// Look-angle of an Earth-fixed point from a station frame (same length units as
// the frame).  Returns { el, az } in degrees plus the range, or null at zero
// range.  NOTE: the sky chart's per-satellite loop and the pass worker's grid
// scan keep this math INLINED for speed — this is the canonical reference
// implementation they mirror, used by every non-hot path.
export function lookElAz(x, y, z, st) {
  const dx = x - st.pos[0], dy = y - st.pos[1], dz = z - st.pos[2];
  const rng = Math.hypot(dx, dy, dz);
  if (rng === 0) return null;
  const u = (dx * st.up[0] + dy * st.up[1] + dz * st.up[2]) / rng;
  const el = Math.asin(Math.max(-1, Math.min(1, u))) * RAD2DEG;
  const e = dx * st.east[0] + dy * st.east[1] + dz * st.east[2];
  const n = dx * st.north[0] + dy * st.north[1] + dz * st.north[2];
  let az = Math.atan2(e, n) * RAD2DEG;
  if (az < 0) az += 360;
  return { el, az, rng };
}
