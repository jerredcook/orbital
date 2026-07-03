// astro.js — small shared astronomy helpers used by the sky chart, the pass
// scans and the showpieces: geodetic constants, a low-precision Sun direction,
// the naked-eye target list, and a compass-point formatter.  All pure.

import * as satellite from 'satellite.js';

export const DEG2RAD = Math.PI / 180;
export const RE_KM = 6378.137;        // Earth equatorial radius (km)
export const EARTH_R = 6.371e6;       // Earth mean radius (m), for the shadow test
export const SUN_DARK = Math.sin(-6 * Math.PI / 180);   // sky dark enough to spot satellites

// The handful bright enough to actually catch the naked eye when sunlit — these
// get a ring + name on the sky chart and a heads-up before a visible pass.
export const NAKED_EYE = new Map([[25544, 'ISS'], [48274, 'Tiangong']]);

// Low-precision Sun direction (unit vector, Earth-fixed frame) — enough to tell
// day from night and which satellites are catching the sunlight.
export function sunEcefDir(date) {
  const n = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;          // days since J2000
  const g = (357.529 + 0.98560028 * n) * DEG2RAD;                            // mean anomaly
  const L = (280.459 + 0.98564736 * n) * DEG2RAD;                            // mean longitude
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG2RAD; // ecliptic longitude
  const eps = 23.439 * DEG2RAD;
  const eci = { x: Math.cos(lam), y: Math.cos(eps) * Math.sin(lam), z: Math.sin(eps) * Math.sin(lam) };
  return satellite.eciToEcf(eci, satellite.gstime(date));
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (az) => COMPASS[Math.round(((az % 360) + 360) % 360 / 45) % 8];

// Is a point (Earth-fixed metres) in sunlight? — sunward of Earth's centre, or
// its offset from the Earth–Sun axis clears the planet's radius (i.e. outside the
// cylindrical shadow).  `sun` is a unit direction in the same ECF frame (see
// sunEcefDir).  Shared by the overhead sky chart and the visible-pass check.
export function isSunlit(x, y, z, sun) {
  const along = x * sun.x + y * sun.y + z * sun.z;
  if (along > 0) return true;                       // sunward of Earth's centre — lit
  const wx = x - along * sun.x, wy = y - along * sun.y, wz = z - along * sun.z;
  return (wx * wx + wy * wy + wz * wz) > EARTH_R * EARTH_R;   // clear of the shadow cylinder
}
