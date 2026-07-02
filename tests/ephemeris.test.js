// Solver + planet-ephemeris correctness.  The Kepler solver's E=M seed once
// diverged catastrophically at comet eccentricities (thousands of degrees of
// error at e≈0.999) and shipped that way — these sweeps make that impossible
// to reintroduce silently.
import { describe, it, expect } from 'vitest';
import { Cartesian3 } from 'cesium';
import {
  planetPosition, eclipticFromElements, hyperbolicFromElements, AU_METERS, PLANETS,
} from '../src/ephemeris.js';

const DEG = Math.PI / 180;

// Independent reference: bisection on Kepler's equation (slow, unconditionally convergent).
function refKepler(M, e) {
  let lo = -2 * Math.PI, hi = 2 * Math.PI;
  for (let i = 0; i < 200; i++) {
    const E = (lo + hi) / 2;
    if (E - e * Math.sin(E) - M > 0) hi = E; else lo = E;
  }
  return (lo + hi) / 2;
}

describe('elliptic Kepler solver (via eclipticFromElements)', () => {
  it('stays sub-arcsecond across e ∈ [0, 0.9993], M ∈ (−180°, 180°)', () => {
    const out = new Cartesian3();
    for (const e of [0.0, 0.017, 0.21, 0.5, 0.8, 0.847, 0.968, 0.995, 0.9993]) {
      for (let Mdeg = -175; Mdeg <= 175; Mdeg += 5) {
        // recover E from the in-plane position the solver produced
        eclipticFromElements(1, e, 0, 0, 0, Mdeg, out);
        const E = Math.atan2(out.y / Math.sqrt(1 - e * e), out.x + e);
        let M = Mdeg * DEG;
        const Eref = refKepler(M, e);
        // compare positions, not anomalies (same physical point matters)
        const xr = Math.cos(Eref) - e, yr = Math.sqrt(1 - e * e) * Math.sin(Eref);
        const err = Math.hypot(out.x - xr, out.y - yr);
        expect(err, `e=${e} M=${Mdeg}° (E=${(E / DEG).toFixed(2)}°)`).toBeLessThan(1e-8);
      }
    }
  });
});

describe('hyperbolic solver', () => {
  it('satisfies M = e·sinh(H) − H across the interstellar range', () => {
    const out = new Cartesian3();
    for (const e of [1.2, 3.35, 6.14]) {
      for (const Mdeg of [-4000, -500, -20, -1, 1, 20, 500, 4000]) {
        hyperbolicFromElements(1, e, 0, 0, 0, Mdeg, out);
        // recover H from the in-plane point and check Kepler's equation
        const H = Math.asinh(out.y / Math.sqrt(e * e - 1));
        const Mback = (e * Math.sinh(H) - H) / DEG;
        expect(Math.abs(Mback - Mdeg), `e=${e} M=${Mdeg}`).toBeLessThan(1e-6 * Math.max(1, Math.abs(Mdeg)));
        // and the radius matches the conic r = a(e·cosh H − 1)
        const r = Math.hypot(out.x, out.y);
        expect(Math.abs(r - (e * Math.cosh(H) - 1)), 'conic radius').toBeLessThan(1e-9 * Math.max(1, r));
      }
    }
  });
});

describe('planet ephemeris sanity', () => {
  it('Earth orbits at 1 AU in the ecliptic plane', () => {
    const p = new Cartesian3();
    for (const T of [-0.1, 0, 0.26]) {   // ±decades around J2000
      planetPosition('Earth', T, p);
      const r = Cartesian3.magnitude(p) / AU_METERS;
      expect(r).toBeGreaterThan(0.97);
      expect(r).toBeLessThan(1.03);
      expect(Math.abs(p.z) / Cartesian3.magnitude(p)).toBeLessThan(0.01);   // ecliptic frame
    }
  });
  it('every planet returns finite positions across 1900–2050', () => {
    const p = new Cartesian3();
    for (const name of PLANETS) {
      for (let T = -1; T <= 0.5; T += 0.25) {
        planetPosition(name, T, p);
        expect(Number.isFinite(p.x + p.y + p.z), `${name} T=${T}`).toBe(true);
      }
    }
  });
});
