// Golden tests: propagate every body class from its committed element sets and
// compare against real JPL Horizons state vectors (tests/fixtures/, fetched
// 2026-07-02).  These are the tests that would have caught the two shipped
// ephemeris bugs (aliased small-moon periods, the comet-eccentricity solver
// divergence) — if elements are refetched or the propagation math changes,
// they must keep agreeing with JPL.
import { describe, it, expect } from 'vitest';
import { Cartesian3 } from 'cesium';
import { eclipticFromElements, hyperbolicFromElements } from '../src/ephemeris.js';
import { MOON_ELEMENTS, MOON_EPOCH_JD } from '../src/moon-elements.js';
import { DWARF_ELEMENTS, DWARF_EPOCH_JD } from '../src/dwarf-elements.js';
import { COMET_ELEMENTS, COMET_EPOCH_JD } from '../src/comet-elements.js';
import { INTERSTELLAR_ELEMENTS, INTERSTELLAR_EPOCH_JD } from '../src/interstellar-elements.js';
import fixtures from './fixtures/horizons-vectors.json';

const J2000 = 2451545.0;
const DEG = Math.PI / 180;
const jdOf = (iso) => 2440587.5 + Date.parse(`${iso}T00:00:00Z`) / 86400000;

// Same propagation the app performs (mean anomaly advanced from the element epoch).
function propagate(kind, body, jd) {
  const days = jd - J2000;
  const out = new Cartesian3();
  if (kind === 'moon') {
    const el = MOON_ELEMENTS[body];
    const M = el.M0 + 360 * (days - (MOON_EPOCH_JD - J2000)) / el.periodDays;
    return eclipticFromElements(el.a, el.e, el.i, el.node, el.peri, M, out);
  }
  if (kind === 'dwarf') {
    const el = DWARF_ELEMENTS[body];
    const M = el.M0 + 360 * (days - (DWARF_EPOCH_JD - J2000)) / el.periodDays;
    return eclipticFromElements(el.a, el.e, el.i, el.node, el.peri, M, out);
  }
  if (kind === 'comet') {
    const el = COMET_ELEMENTS[body];
    const M = el.M0 + 360 * (days - (COMET_EPOCH_JD - J2000)) / el.periodDays;
    return eclipticFromElements(el.a, el.e, el.i, el.node, el.peri, M, out);
  }
  if (kind === 'interstellar') {
    const el = INTERSTELLAR_ELEMENTS[body];
    const M = el.M0 + el.n * (days - (INTERSTELLAR_EPOCH_JD - J2000));
    return hyperbolicFromElements(el.a, el.e, el.i, el.node, el.peri, M, out);
  }
  throw new Error(`unknown kind ${kind}`);
}

// Angular tolerance per class (degrees) — matches the accuracy the app claims.
const TOL = { moon: 3.0, dwarf: 0.1, comet: 0.6, interstellar: 0.1 };

describe('positions agree with JPL Horizons', () => {
  for (const f of fixtures.entries) {
    it(`${f.body} @ ${f.date} within ${TOL[f.kind]}°`, () => {
      const p = propagate(f.kind, f.body, jdOf(f.date));
      const [X, Y, Z] = f.vecM;
      const dot = (p.x * X + p.y * Y + p.z * Z) / (Cartesian3.magnitude(p) * Math.hypot(X, Y, Z));
      const angDeg = Math.acos(Math.min(1, Math.max(-1, dot))) / DEG;
      expect(angDeg).toBeLessThan(TOL[f.kind]);
    });
  }
});
