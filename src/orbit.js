// orbit.js — small shared orbital-geometry helpers used by the conjunction
// screener and the ground-station pass prefilter.  Pure.

// [perigee, apogee] altitude band in km — SATCAT when present, else derived
// from the TLE's mean motion and eccentricity.
export function altBandOf(sat) {
  const m = sat.meta;
  if (m?.apogee != null && m?.perigee != null) return [m.perigee, m.apogee];
  const ecc = parseFloat(`0.${sat.l2.slice(26, 33).trim()}`) || 0;
  const revsPerDay = parseFloat(sat.l2.slice(52, 63));
  if (!revsPerDay) return [0, Infinity];
  const a = Math.cbrt(398600.4418 / ((revsPerDay * 2 * Math.PI / 86400) ** 2));
  return [a * (1 - ecc) - 6371, a * (1 + ecc) - 6371];
}
