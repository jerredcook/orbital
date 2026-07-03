// orbit.js — small shared orbital-geometry helpers used by the conjunction
// screener and the ground-station pass prefilter.  Pure.

import { tleMeanMotion, tleEccentricity } from './data.js';

// [perigee, apogee] altitude band in km — SATCAT when present, else derived
// from the TLE's mean motion and eccentricity.
export function altBandOf(sat) {
  const m = sat.meta;
  if (m?.apogee != null && m?.perigee != null) return [m.perigee, m.apogee];
  const ecc = tleEccentricity(sat.l2) || 0;
  const revsPerDay = tleMeanMotion(sat.l2);
  if (!revsPerDay) return [0, Infinity];
  const a = Math.cbrt(398600.4418 / ((revsPerDay * 2 * Math.PI / 86400) ** 2));
  return [a * (1 - ecc) - 6371, a * (1 + ecc) - 6371];
}
