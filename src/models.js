// models.js — which 3D model a catalog object gets, and how the propagated
// state orients it.  Pure: no viewer, no shared app state — modelFor(sat) maps a
// satellite to a glTF URI + scale, orientationFor(pos, vel) builds its attitude.

import { Cartesian3, Matrix3, Quaternion } from 'cesium';

// Base-relative so model URLs resolve under the GitHub Pages subpath (/orbital/)
// as well as at the dev-server root.
export const MODELS = `${import.meta.env.BASE_URL}models/`;

// Spacecraft with real published models (NASA solarsystem.nasa.gov and
// github.com/nasa/NASA-3D-Resources), keyed by NORAD ID — exact IDs because
// catalog names are full of traps (SAOCOM contains "OCO", TERRASAR-X
// contains "TERRA").  GRACE-FO reuses the GRACE bus; Landsat 9 is a
// near-copy of Landsat 8; Sentinel-6B matches 6A.
// Scale maps each model's true rendered extent (accessor bounds pushed
// through the node hierarchy — see the audit in tools/) to the spacecraft's
// real deployed size in meters.  The published GLBs are wildly inconsistent:
// Terra renders 26 km long, TDRS 0.9 m, while ISS (112 m), Chandra (19.5 m)
// and Sentinel-6 (5.1 m) are already true to life.
const REAL_MODELS = new Map([
  [25544, { file: 'iss', scale: 1 }],
  [20580, { file: 'hubble', scale: 1 }],
  [25994, { file: 'terra', scale: 0.00035 }],
  [27424, { file: 'aqua', scale: 0.0385 }],
  [28376, { file: 'aura', scale: 0.34 }],
  [43613, { file: 'icesat2', scale: 1 }],
  [39084, { file: 'landsat8', scale: 1 }],
  [49260, { file: 'landsat8', scale: 1 }],
  [46984, { file: 'sentinel6', scale: 1 }],
  [66514, { file: 'sentinel6', scale: 1 }],
  [40059, { file: 'oco2', scale: 0.23 }],
  [37849, { file: 'suominpp', scale: 1 }],
  [28485, { file: 'swift', scale: 0.143 }],
  [33053, { file: 'fermi', scale: 0.24 }],     // FGRST (GLAST)
  [25867, { file: 'chandra', scale: 1 }],      // CXO
  [43476, { file: 'grace', scale: 1 }],
  [43477, { file: 'grace', scale: 1 }],
  [43435, { file: 'tess', scale: 0.11 }],      // not in 'active' today
  [50463, { file: 'jwst', scale: 0.74 }],      // not in 'active' today
]);

export function modelFor(sat) {
  const real = REAL_MODELS.get(sat.norad);
  if (real) return { uri: `${MODELS}${real.file}.glb`, scale: real.scale };
  if (/^TDRS \d/.test(sat.name)) return { uri: `${MODELS}tdrs.glb`, scale: 19.6 };
  if (sat.kind === 'DEB' || /\bDEB\b/.test(sat.name)) return { uri: `${MODELS}debris.glb`, scale: 1 };
  if (/\bR\/B\b/.test(sat.name)) return { uri: `${MODELS}rocketbody.glb`, scale: 1 };
  if (sat.name.startsWith('STARLINK')) return { uri: `${MODELS}starlink.glb`, scale: 1 };
  // Nav constellations (Galileo keyed off the GALILEO token, not GSAT — that
  // also names ISRO's comms birds; GPS BIIx/BIII and NAVSTAR are the same GPS).
  if (/GALILEO|NAVSTAR|BEIDOU/.test(sat.name) || /^GPS\b/.test(sat.name)) {
    return { uri: `${MODELS}navsat.glb`, scale: 1 };
  }
  // Sentinel EO/SAR (1/2/3/5P); Sentinel-6 has a real model and is caught above.
  if (/^SENTINEL-[1235]/.test(sat.name)) return { uri: `${MODELS}sar.glb`, scale: 1 };
  return { uri: `${MODELS}generic-sat.glb`, scale: 1 };
}

// Orientation from the propagated state: +X along velocity, +Z zenith.
const scrX = new Cartesian3(), scrY = new Cartesian3(), scrZ = new Cartesian3();
const scrM = new Matrix3(), scrQ = new Quaternion();
export function orientationFor(posEcf, velEcf) {
  Cartesian3.normalize(Cartesian3.fromElements(velEcf.x, velEcf.y, velEcf.z, scrX), scrX);
  Cartesian3.normalize(posEcf, scrZ);
  Cartesian3.normalize(Cartesian3.cross(scrZ, scrX, scrY), scrY);
  Cartesian3.cross(scrY, scrZ, scrX);
  Matrix3.fromArray([
    scrX.x, scrX.y, scrX.z,
    scrY.x, scrY.y, scrY.z,
    scrZ.x, scrZ.y, scrZ.z,
  ], 0, scrM); // column-major: columns are the model axes in world space
  return Quaternion.fromRotationMatrix(scrM, scrQ);
}
