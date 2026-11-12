// The close-approach maths (tca.js), checked against a brute-force reference on
// real satellites.  The fixture is frozen from the bundled CelesTrak catalog:
// the ISS against 98 objects whose altitude band overlaps it — every one that
// passes within 25 km in the 24 h window, the 40 nearest misses, and 40 that
// never come close.
//
// The reference shares nothing with the code under test but SGP4 itself: its
// own sampler (satellite.propagate with a Date, not the minutes-since-epoch
// shortcut), a dense 5 s grid over the whole window with no gates, and a
// refinement of EVERY local minimum to 2 ms.  At 5 s the worst excursion a
// 15 km/s crossing can hide is ~40 km, so every local minimum under 150 km is
// refined — nothing inside 25 km can slip through.
import { describe, it, expect, beforeAll } from 'vitest';
import * as satellite from 'satellite.js';
import { readFileSync } from 'node:fs';
import { findTca, targetTrack, screenCandidate, pairDistM } from '../src/tca.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/tca-screen.json', import.meta.url), 'utf8'));
const rec = (s) => satellite.twoline2satrec(s.l1, s.l2);
const HORIZON = fx.horizonHours * 3.6e6;
const REPORT_KM = 25;

const pos = (r, ms) => {
  const p = satellite.propagate(r, new Date(ms))?.position;
  return p && !Number.isNaN(p.x) ? p : null;
};
const distKm = (a, b, ms) => {
  const p = pos(a, ms), q = pos(b, ms);
  return p && q ? Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) : Infinity;
};
// Global closest approach of a pair over the window, by brute force.
function bruteTca(a, b, startMs, horizonMs, step = 5000) {
  const n = Math.floor(horizonMs / step);
  const d = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) d[k] = distKm(a, b, startMs + k * step);
  let floor = Infinity;
  for (let k = 0; k <= n; k++) floor = Math.min(floor, d[k]);
  let best = null;
  for (let k = 0; k <= n; k++) {
    if (d[k] > Math.max(150, floor + 150)) continue;
    if ((k > 0 && d[k - 1] < d[k]) || (k < n && d[k + 1] < d[k])) continue;   // local minima only
    let lo = Math.max(startMs, startMs + (k - 1) * step), hi = Math.min(startMs + horizonMs, startMs + (k + 1) * step);
    while (hi - lo > 2) {
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (distKm(a, b, m1) < distKm(a, b, m2)) hi = m2; else lo = m1;
    }
    const t = (lo + hi) / 2, km = distKm(a, b, t);
    if (!best || km < best.km) best = { t, km };
  }
  return best;
}

const iss = rec(fx.target);
let ref;      // norad → brute-force { t, km } over the full window
let screened; // norad → screenCandidate result at the 25 km setting

beforeAll(() => {
  ref = new Map(); screened = new Map();
  const track = targetTrack(iss, fx.startMs, HORIZON);
  for (const c of fx.candidates) {
    const r = rec(c);
    ref.set(c.norad, bruteTca(r, iss, fx.startMs, HORIZON));
    screened.set(c.norad, screenCandidate(r, track, REPORT_KM * 1000));
  }
}, 120_000);

describe('screenCandidate — one target against many', () => {
  it('reports exactly the objects the brute force finds inside 25 km', () => {
    const want = fx.candidates.filter((c) => ref.get(c.norad).km < REPORT_KM).map((c) => c.norad).sort();
    const got = fx.candidates.filter((c) => screened.get(c.norad)).map((c) => c.norad).sort();
    expect(want.length).toBeGreaterThanOrEqual(15);   // the fixture really does contain close passes
    expect(got).toEqual(want);
  });

  it('gets each miss distance right to within 5 m', () => {
    for (const c of fx.candidates) {
      const s = screened.get(c.norad);
      if (s) expect(Math.abs(s.missM - ref.get(c.norad).km * 1000), c.name).toBeLessThan(5);
    }
  });

  it('times each fast crossing to within half a second', () => {
    let crossings = 0;
    for (const c of fx.candidates) {
      const s = screened.get(c.norad), r = ref.get(c.norad);
      if (!s || r.km < 0.5) continue;   // docked craft sit at 0 km all day — no single instant to time
      crossings++;
      expect(Math.abs(s.tcaMs - r.t), c.name).toBeLessThan(500);
    }
    expect(crossings).toBeGreaterThanOrEqual(6);
  });

  it('puts craft docked to the station at zero', () => {
    const docked = fx.candidates.filter((c) => ref.get(c.norad).km < 0.001);
    expect(docked.length).toBeGreaterThanOrEqual(5);
    for (const c of docked) expect(screened.get(c.norad).missM, c.name).toBeLessThan(1);
  });

  it('honours a tighter report distance', () => {
    const track = targetTrack(iss, fx.startMs, HORIZON);
    const want = fx.candidates.filter((c) => ref.get(c.norad).km < 10).map((c) => c.norad).sort();
    const got = fx.candidates.filter((c) => screenCandidate(rec(c), track, 10_000)).map((c) => c.norad).sort();
    expect(got).toEqual(want);
  });
});

describe('findTca — the forecast for one pair', () => {
  // The live list asks about pairs that are ALREADY close: start the clock a
  // moment before each real crossing, as the app would.  The old 30 s grid got
  // five of these wrong by 4–36 km (it latched onto a different, wider pass).
  it('finds the true minimum for pairs caught mid-crossing', () => {
    const crossers = fx.candidates.filter((c) => { const r = ref.get(c.norad); return r.km > 0.5 && r.km < REPORT_KM; });
    let cases = 0;
    for (const c of crossers) {
      const r = rec(c), tca = ref.get(c.norad).t;
      for (const leadMs of [20_000, 1_000]) {
        const startMs = tca - leadMs;
        const truth = bruteTca(r, iss, startMs, HORIZON);
        const got = findTca(iss, r, startMs, HORIZON);
        expect(Math.abs(got.missM - truth.km * 1000), `${c.name} ${leadMs / 1000}s before`).toBeLessThan(5);
        expect(Math.abs(got.tcaMs - truth.t), `${c.name} ${leadMs / 1000}s before`).toBeLessThan(500);
        cases++;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(12);
  }, 120_000);

  it('handles two craft flying in formation (smooth, never far apart)', () => {
    const [a, b] = fx.pairs.comoving.map(rec);   // GRACE-FO 1 & 2, ~200 km apart on one orbit
    const truth = bruteTca(a, b, fx.startMs, HORIZON);
    const got = findTca(a, b, fx.startMs, HORIZON);
    expect(truth.km).toBeLessThan(300);
    expect(Math.abs(got.missM - truth.km * 1000)).toBeLessThan(20);
  }, 60_000);

  it('still answers for a pair that never comes close', () => {
    const [a, b] = fx.pairs.far.map(rec);        // the ISS and a geostationary satellite
    const truth = bruteTca(a, b, fx.startMs, HORIZON);
    const got = findTca(a, b, fx.startMs, HORIZON);
    expect(truth.km).toBeGreaterThan(30_000);
    expect(Math.abs(got.missM / 1000 - truth.km)).toBeLessThan(1);
  }, 60_000);

  it('is symmetric in its two arguments', () => {
    const c = fx.candidates.find((x) => { const r = ref.get(x.norad); return r.km > 0.5 && r.km < REPORT_KM; });
    const startMs = ref.get(c.norad).t - 5000;
    const ab = findTca(iss, rec(c), startMs, HORIZON), ba = findTca(rec(c), iss, startMs, HORIZON);
    expect(Math.abs(ab.missM - ba.missM)).toBeLessThan(5);
  });
});

describe('pairDistM', () => {
  it('agrees with the independent sampler', () => {
    const t = fx.startMs + 3_600_000;
    for (const c of fx.candidates.slice(18, 30)) {
      expect(Math.abs(pairDistM(iss, rec(c), t) - distKm(iss, rec(c), t) * 1000), c.name).toBeLessThan(1);
    }
  });
});
