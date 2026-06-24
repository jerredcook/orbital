// ephemeris.js — heliocentric positions of the eight planets.
//
// Cesium ships no planetary ephemeris (Simon1994PlanetaryPositions only does the
// Sun and Moon), so we hand-roll JPL's low-precision Keplerian elements — the
// "Approximate Positions of the Planets" tables (Standish & Williams), good to
// roughly an arcminute over 1800–2050.  Each planet carries J2000 elements plus
// per-century rates; we advance them to the sample time, solve Kepler's
// equation, and build a heliocentric position.
//
// Frame: we return positions in the **heliocentric ecliptic J2000** frame (the
// orbital plane of Earth), NOT equatorial.  That keeps the solar system a clean
// flat disc in the scene's XY plane, which is what you want for an overview.
// (Rotate by the 23.4392° obliquity about +X if you ever need equatorial.)  The
// scene is self-contained, so the absolute frame is a free choice; ecliptic is
// the legible one and sidesteps the obliquity-sign bug class entirely.

import { Cartesian3, JulianDate, Math as CMath } from 'cesium';

export const AU_METERS = 1.495978707e11;
const J2000 = JulianDate.fromIso8601('2000-01-01T12:00:00Z');
const DEG = CMath.RADIANS_PER_DEGREE;

// JPL Keplerian elements, valid 1800 AD – 2050 AD.  Per planet:
//   a   semi-major axis            AU,        AU/century
//   e   eccentricity               -,         /century
//   I   inclination                deg,       deg/century
//   L   mean longitude             deg,       deg/century
//   wbar longitude of perihelion   deg,       deg/century
//   Om  longitude of ascending node deg,      deg/century
// Source: https://ssd.jpl.nasa.gov/planets/approx_pos.html  (Table 1)
const ELEMENTS = {
  Mercury: {
    a: [0.38709927, 0.00000037], e: [0.20563593, 0.00001906],
    I: [7.00497902, -0.00594749], L: [252.25032350, 149472.67411175],
    wbar: [77.45779628, 0.16047689], Om: [48.33076593, -0.12534081],
  },
  Venus: {
    a: [0.72333566, 0.00000390], e: [0.00677672, -0.00004107],
    I: [3.39467605, -0.00078890], L: [181.97909950, 58517.81538729],
    wbar: [131.60246718, 0.00268329], Om: [76.67984255, -0.27769418],
  },
  Earth: {
    a: [1.00000261, 0.00000562], e: [0.01671123, -0.00004392],
    I: [-0.00001531, -0.01294668], L: [100.46457166, 35999.37244981],
    wbar: [102.93768193, 0.32327364], Om: [0.0, 0.0],
  },
  Mars: {
    a: [1.52371034, 0.00001847], e: [0.09339410, 0.00007882],
    I: [1.84969142, -0.00813131], L: [-4.55343205, 19140.30268499],
    wbar: [-23.94362959, 0.44441088], Om: [49.55953891, -0.29257343],
  },
  Jupiter: {
    a: [5.20288700, -0.00011607], e: [0.04838624, -0.00013253],
    I: [1.30439695, -0.00183714], L: [34.39644051, 3034.74612775],
    wbar: [14.72847983, 0.21252668], Om: [100.47390909, 0.20469106],
  },
  Saturn: {
    a: [9.53667594, -0.00125060], e: [0.05386179, -0.00050991],
    I: [2.48599187, 0.00193609], L: [49.95424423, 1222.49362201],
    wbar: [92.59887831, -0.41897216], Om: [113.66242448, -0.28867794],
  },
  Uranus: {
    a: [19.18916464, -0.00196176], e: [0.04725744, -0.00004397],
    I: [0.77263783, -0.00242939], L: [313.23810451, 428.48202785],
    wbar: [170.95427630, 0.40805281], Om: [74.01692503, 0.04240589],
  },
  Neptune: {
    a: [30.06992276, 0.00026291], e: [0.00859048, 0.00005105],
    I: [1.77004347, 0.00035372], L: [-55.12002969, 218.45945325],
    wbar: [44.96476227, -0.32241464], Om: [131.78422574, -0.00508664],
  },
};

// Physical/visual data per body.  radius in meters (equatorial), tilt in degrees
// (obliquity to its orbit), day = sidereal rotation period in hours (sign = spin
// sense; Venus/Uranus are retrograde), color is the orbit-line / label tint.
// Texture file lives in /textures/planets/.  The Sun is included for rendering
// even though it has no orbit.
export const BODIES = {
  Sun:     { radius: 6.9634e8,  tilt: 7.25,   day: 609.12,  color: '#FFD27A', texture: 'sun.jpg' },
  Mercury: { radius: 2.4397e6,  tilt: 0.034,  day: 1407.6,  color: '#B7A582', texture: 'mercury.jpg' },
  Venus:   { radius: 6.0518e6,  tilt: 177.36, day: -5832.5, color: '#D9B38C', texture: 'venus.jpg' },
  Earth:   { radius: 6.3710e6,  tilt: 23.44,  day: 23.934,  color: '#5E9BD6', texture: 'earth.jpg' },
  Mars:    { radius: 3.3895e6,  tilt: 25.19,  day: 24.623,  color: '#E27B58', texture: 'mars.jpg' },
  Jupiter: { radius: 6.9911e7,  tilt: 3.13,   day: 9.925,   color: '#D9A066', texture: 'jupiter.jpg' },
  Saturn:  { radius: 5.8232e7,  tilt: 26.73,  day: 10.656,  color: '#E0C988', texture: 'saturn.jpg' },
  Uranus:  { radius: 2.5362e7,  tilt: 97.77,  day: -17.24,  color: '#9FD8E0', texture: 'uranus.jpg' },
  Neptune: { radius: 2.4622e7,  tilt: 28.32,  day: 16.11,   color: '#5B7BE0', texture: 'neptune.jpg' },
};

export const PLANETS = Object.keys(ELEMENTS); // Mercury … Neptune, in order

const norm360 = (d) => ((d % 360) + 360) % 360;

// Julian centuries past J2000 for a Cesium JulianDate.
export function centuriesSinceJ2000(julianDate) {
  return JulianDate.secondsDifference(julianDate, J2000) / 86400 / 36525;
}

// Solve Kepler's equation M = E - e·sinE (all radians) by Newton iteration.
function solveKepler(M, e) {
  let E = M; // good seed for the low eccentricities here (Mercury e≈0.21 worst)
  for (let i = 0; i < 8; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

// Heliocentric ecliptic-J2000 position of one planet, in meters, at time T
// (Julian centuries past J2000).  Reuses an output Cartesian3 if given.
export function planetPosition(name, T, result) {
  const el = ELEMENTS[name];
  const a = el.a[0] + el.a[1] * T;            // AU
  const e = el.e[0] + el.e[1] * T;
  const I = (el.I[0] + el.I[1] * T) * DEG;
  const L = el.L[0] + el.L[1] * T;
  const wbar = el.wbar[0] + el.wbar[1] * T;
  const Om = (el.Om[0] + el.Om[1] * T) * DEG;

  const omega = (wbar - el.Om[0] - el.Om[1] * T) * DEG; // argument of perihelion
  const M = norm360(L - wbar + 180) * DEG - Math.PI;    // mean anomaly in (-π, π]
  const E = solveKepler(M, e);

  // Position in the orbital plane (meters).
  const xp = a * (Math.cos(E) - e) * AU_METERS;
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E) * AU_METERS;

  const cosO = Math.cos(Om), sinO = Math.sin(Om);
  const cosw = Math.cos(omega), sinw = Math.sin(omega);
  const cosI = Math.cos(I), sinI = Math.sin(I);

  // Rotate orbital-plane → heliocentric ecliptic J2000.
  const x = (cosw * cosO - sinw * sinO * cosI) * xp + (-sinw * cosO - cosw * sinO * cosI) * yp;
  const y = (cosw * sinO + sinw * cosO * cosI) * xp + (-sinw * sinO + cosw * cosO * cosI) * yp;
  const z = (sinw * sinI) * xp + (cosw * sinI) * yp;

  result = result || new Cartesian3();
  result.x = x; result.y = y; result.z = z;
  return result;
}

// Position (in the same length unit as `a`) from explicit Keplerian elements, in
// the same ecliptic-J2000 frame planetPosition uses — relative to whatever body
// the elements are centred on.  Angles in degrees; M is the mean anomaly.  Used
// for the moons (real elements, planet-centred; see moon-elements.js).
export function eclipticFromElements(a, e, iDeg, OmDeg, wDeg, Mdeg, result) {
  const i = iDeg * DEG, Om = OmDeg * DEG, w = wDeg * DEG;
  let M = (norm360(Mdeg) * DEG);
  if (M > Math.PI) M -= 2 * Math.PI;                 // seed solveKepler in (-π, π]
  const E = solveKepler(M, e);

  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cosO = Math.cos(Om), sinO = Math.sin(Om);
  const cosw = Math.cos(w), sinw = Math.sin(w);
  const cosI = Math.cos(i), sinI = Math.sin(i);

  result = result || new Cartesian3();
  result.x = (cosw * cosO - sinw * sinO * cosI) * xp + (-sinw * cosO - cosw * sinO * cosI) * yp;
  result.y = (cosw * sinO + sinw * cosO * cosI) * xp + (-sinw * sinO + cosw * cosO * cosI) * yp;
  result.z = (sinw * sinI) * xp + (cosw * sinI) * yp;
  return result;
}

// Orbital period in Julian centuries — the mean longitude advances el.L[1]
// degrees per century, so one full 360° revolution takes this long.
export function orbitalPeriodCenturies(name) {
  return 360 / ELEMENTS[name].L[1];
}

// Sample a planet's orbit as a closed ellipse (heliocentric ecliptic, meters) at
// epoch T, by sweeping the eccentric anomaly a full turn.  Using E directly —
// rather than sampling positions over a 165-year time span — keeps every sample
// inside the elements' valid epoch and yields a geometrically exact ellipse.
export function orbitSamples(name, T, count = 256) {
  const el = ELEMENTS[name];
  const a = el.a[0] + el.a[1] * T;
  const e = el.e[0] + el.e[1] * T;
  const I = (el.I[0] + el.I[1] * T) * DEG;
  const Om = (el.Om[0] + el.Om[1] * T) * DEG;
  const omega = (el.wbar[0] + el.wbar[1] * T) * DEG - Om;

  const cosO = Math.cos(Om), sinO = Math.sin(Om);
  const cosw = Math.cos(omega), sinw = Math.sin(omega);
  const cosI = Math.cos(I), sinI = Math.sin(I);
  const b = a * Math.sqrt(1 - e * e);

  const pts = [];
  for (let k = 0; k <= count; k++) {
    const E = (k / count) * 2 * Math.PI;
    const xp = a * (Math.cos(E) - e) * AU_METERS;
    const yp = b * Math.sin(E) * AU_METERS;
    pts.push(new Cartesian3(
      (cosw * cosO - sinw * sinO * cosI) * xp + (-sinw * cosO - cosw * sinO * cosI) * yp,
      (cosw * sinO + sinw * cosO * cosI) * xp + (-sinw * sinO + cosw * cosO * cosI) * yp,
      (sinw * sinI) * xp + (cosw * sinI) * yp,
    ));
  }
  return pts;
}
