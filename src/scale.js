// scale.js — the readable ⟷ true-scale mapping for the solar-system view.
//
// At true scale a planet is an invisible speck: Earth is 12,700 km across but
// 150 million km from the Sun, and Neptune is 77× farther than Mercury.  Every
// legible orrery cheats, so we route *every* heliocentric position and *every*
// body radius through one switchable mapping:
//
//   • distance — a power law on the radial coordinate (direction preserved, so
//     orbits stay planar closed curves).  p<1 pulls the outer planets in and
//     spreads the inner ones — the classic orrery spacing.
//   • radius   — a sub-linear power law so even Mercury is a visible disc while
//     the Sun stays dominant without engulfing Mercury's orbit (a single linear
//     exaggeration can't do both: 109× Earth's radius, the Sun would).
//
// Flip `setTrueScale(true)` and both collapse to identity — physically honest,
// at which point the planets become the specks they really are.  All tuning
// lives in the constants block; nothing else in the view hard-codes a size.

import { Cartesian3 } from 'cesium';
import { AU_METERS } from './ephemeris.js';

// ---- readable-mode tuning -------------------------------------------------
const R0 = 1.0e9;            // scene radius (m) of a 1 AU orbit → Earth sits here
const DIST_EXP = 0.55;       // <1 compresses the outer system (Neptune ≈ 6×R0)
const RAD_SCALE = 47_350;    // chosen so Earth renders ~2.5e7 m (a clear disc)
const RAD_EXP = 0.40;        // <1 keeps the Sun/Jupiter from dwarfing the rest

let trueScale = false;

export function setTrueScale(on) { trueScale = !!on; }
export function isTrueScale() { return trueScale; }

// Map a real heliocentric position (meters) into scene space.  Readable mode
// warps only the radial coordinate: scene = p̂ · R0·(r/AU)^DIST_EXP.
export function scenePosition(realPos, result) {
  result = result || new Cartesian3();
  if (trueScale) {
    return Cartesian3.clone(realPos, result);
  }
  const r = Cartesian3.magnitude(realPos);
  if (r === 0) { result.x = result.y = result.z = 0; return result; }
  const rScene = R0 * Math.pow(r / AU_METERS, DIST_EXP);
  Cartesian3.multiplyByScalar(realPos, rScene / r, result);
  return result;
}

// Map a real body radius (meters) into the rendered radius.
export function bodyRadius(realRadius) {
  if (trueScale) return realRadius;
  return RAD_SCALE * Math.pow(realRadius, RAD_EXP);
}

// Rough scene-space extent of the whole system in the current mode — used to
// frame the opening camera and to set zoom limits.
export function systemExtent() {
  if (trueScale) return 31 * AU_METERS;       // out past Neptune
  return R0 * Math.pow(31, DIST_EXP);          // Neptune ≈ 30 AU, a little margin
}
