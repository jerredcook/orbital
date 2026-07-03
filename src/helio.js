// helio.js — pure position/orbit helpers for the solar-system view.  Given a
// stored osculating element set and a time, return real heliocentric positions
// (metres, ecliptic J2000) and sampled orbit paths.  No viewer, no scene state —
// just Kepler propagation off the committed *-elements tables.

import { Cartesian3 } from 'cesium';
import {
  AU_METERS, eclipticFromElements, hyperbolicFromElements, hyperbolaPosFromH,
} from './ephemeris.js';
import { MOON_ELEMENTS, MOON_EPOCH_JD } from './moon-elements.js';
import { DWARF_ELEMENTS, DWARF_EPOCH_JD } from './dwarf-elements.js';
import { COMET_ELEMENTS, COMET_EPOCH_JD } from './comet-elements.js';
import { INTERSTELLAR_ELEMENTS, INTERSTELLAR_EPOCH_JD } from './interstellar-elements.js';

const MOON_EPOCH_REL = MOON_EPOCH_JD - 2451545.0;   // days from J2000 to the moon-element epoch
const DWARF_EPOCH_REL = DWARF_EPOCH_JD - 2451545.0; // …and to the dwarf-planet epoch
const COMET_EPOCH_REL = COMET_EPOCH_JD - 2451545.0; // …and to the comet epoch
const INTERSTELLAR_EPOCH_REL = INTERSTELLAR_EPOCH_JD - 2451545.0;   // …and the interstellar epoch

// Real heliocentric position (metres, ecliptic J2000) from an element set, by
// advancing its mean anomaly from the given element epoch.  Dwarf planets and
// comets are slow/​distant enough that plain single-epoch propagation holds.
export function helioElemPos(el, epochRel, daysSinceJ2000, result) {
  const M = el.M0 + 360 * (daysSinceJ2000 - epochRel) / el.periodDays;
  return eclipticFromElements(el.a, el.e, el.i, el.node, el.peri, M, result);
}
export const dwarfPos = (name, days, result) => helioElemPos(DWARF_ELEMENTS[name], DWARF_EPOCH_REL, days, result);
export const cometPos = (name, days, result) => helioElemPos(COMET_ELEMENTS[name], COMET_EPOCH_REL, days, result);

// An interstellar object's real heliocentric position on its unbound hyperbolic
// path, advancing the (unbounded) mean anomaly at its mean motion.
export function interstellarPos(name, daysSinceJ2000, result) {
  const el = INTERSTELLAR_ELEMENTS[name];
  const M = el.M0 + el.n * (daysSinceJ2000 - INTERSTELLAR_EPOCH_REL);
  return hyperbolicFromElements(el.a, el.e, el.i, el.node, el.peri, M, result);
}

// Sample an open hyperbolic trajectory (metres, ecliptic) by sweeping the
// hyperbolic anomaly H symmetrically about perihelion, out to ~rMax AU on each
// branch — an open arc (incoming + outgoing), not a closed loop.
export function elemHyperbolaSamples(el, rMaxAU = 60, count = 200) {
  const coshHmax = (rMaxAU * AU_METERS / el.a + 1) / el.e;
  const Hmax = Math.acosh(Math.max(1.0001, coshHmax));
  const pts = [];
  for (let k = 0; k <= count; k++) {
    const H = -Hmax + (2 * Hmax) * (k / count);
    pts.push(hyperbolaPosFromH(el.a, el.e, el.i, el.node, el.peri, H, new Cartesian3()));
  }
  return pts;
}

// Sample an orbit as a closed ellipse (heliocentric ecliptic, metres), sweeping
// the eccentric anomaly so the points stay evenly spread even on the very
// eccentric ones (Eris e=0.44, and the near-parabolic comets at e≈0.999).
export function elemOrbitSamples(el, count = 256) {
  const pts = [];
  for (let k = 0; k <= count; k++) {
    const E = (k / count) * 2 * Math.PI;
    const Mdeg = (E - el.e * Math.sin(E)) * 180 / Math.PI;
    pts.push(eclipticFromElements(el.a, el.e, el.i, el.node, el.peri, Mdeg, new Cartesian3()));
  }
  return pts;
}

// Real position of a moon relative to its planet (metres, ecliptic J2000), by
// advancing its mean anomaly from the element epoch and solving Kepler.
export function moonRelPos(name, daysSinceJ2000, result) {
  result = result || new Cartesian3();
  const el = MOON_ELEMENTS[name];
  if (!el) { result.x = result.y = result.z = 0; return result; }   // guard: a moon with no elements
  const M = el.M0 + 360 * (daysSinceJ2000 - MOON_EPOCH_REL) / el.periodDays;
  return eclipticFromElements(el.a, el.e, el.i, el.node, el.peri, M, result);
}
