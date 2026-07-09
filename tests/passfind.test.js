// The pure minimum-elevation window finder (passfind.js) — the algorithm at the
// heart of the pass worker, exercised with synthetic elevation profiles: the
// exact failure modes the reviews caught (multi-hump HEO runs, sub-sample short
// pops) become plain unit tests, no SGP4 or station geometry needed.
import { describe, it, expect } from 'vitest';
import { findWindows, crossing, ternaryPeak } from '../src/passfind.js';

// A triangular hump: peak `pk` degrees at time c, falling `slope` deg per ms.
const hump = (pk, c, slope) => (t) => pk - Math.abs(t - c) * slope;

describe('findWindows', () => {
  it('finds one window for a single hump with exact minEl crossings', () => {
    const elAt = hump(60, 500_000, 1e-4);   // crosses 10° at c ± 500,000 ms
    const [w, ...rest] = findWindows({ elAt, minEl: 10, runStart: -200_000, runEnd: 1_200_000 });
    expect(rest).toHaveLength(0);
    expect(w.peakEl).toBeCloseTo(60, 1);
    expect(Math.abs(w.peakMs - 500_000)).toBeLessThan(5_000);
    expect(Math.abs(w.riseMs - 0)).toBeLessThan(1_500);
    expect(Math.abs(w.setMs - 1_000_000)).toBeLessThan(1_500);
  });

  it('splits a double-hump run into two windows (the Molniya/GTO case)', () => {
    const a = hump(40, 200_000, 2e-4), b = hump(70, 800_000, 2e-4);
    const elAt = (t) => Math.max(a(t), b(t), 2);   // dips to 2° (above horizon, below minEl) between
    const wins = findWindows({ elAt, minEl: 10, runStart: 0, runEnd: 1_000_000 });
    expect(wins).toHaveLength(2);
    expect(wins[0].peakEl).toBeCloseTo(40, 1);
    expect(wins[1].peakEl).toBeCloseTo(70, 1);
    expect(wins[0].setMs).toBeLessThan(wins[1].riseMs);   // genuinely separate windows
  });

  it('recovers a pop shorter than the sub-sample spacing via the fallback', () => {
    // A smooth hump grazing the filter: above 10° only for |t − 500,000| <
    // 4,000 ms (8 s), so every 15 s sub-sample misses the window and only the
    // whole-run ternary can find it.  (Real elevation over a horizon run is a
    // smooth hump like this — the fallback's unimodality assumption.)
    const elAt = hump(10.5, 500_000, 1.25e-4);
    const wins = findWindows({ elAt, minEl: 10, runStart: 0, runEnd: 1_000_000 });
    expect(wins).toHaveLength(1);
    expect(Math.abs(wins[0].peakMs - 500_000)).toBeLessThan(3_000);
    expect(wins[0].peakEl).toBeGreaterThanOrEqual(10);
    expect(wins[0].setMs - wins[0].riseMs).toBeLessThan(12_000);   // the ~8 s window, refined
  });

  it('returns nothing when the run never reaches minEl', () => {
    expect(findWindows({ elAt: hump(8, 500_000, 1e-4), minEl: 10, runStart: 0, runEnd: 1_000_000 })).toHaveLength(0);
  });

  it('tolerates NaN samples (failed propagation) without inventing windows', () => {
    const base = hump(50, 700_000, 1.5e-4);
    const elAt = (t) => (t < 100_000 ? NaN : base(t));
    const wins = findWindows({ elAt, minEl: 10, runStart: 0, runEnd: 1_100_000 });
    expect(wins).toHaveLength(1);
    expect(wins[0].peakEl).toBeCloseTo(50, 1);
  });
});

describe('crossing / ternaryPeak', () => {
  const elAt = hump(60, 500_000, 1e-4);
  it('bisection converges on the minEl crossing from either direction', () => {
    expect(Math.abs(crossing(elAt, 10, -200_000, 500_000) - 0)).toBeLessThan(1_500);        // rise
    expect(Math.abs(crossing(elAt, 10, 1_200_000, 500_000) - 1_000_000)).toBeLessThan(1_500); // set
  });
  it('ternary converges on the peak', () => {
    expect(Math.abs(ternaryPeak(elAt, 0, 1_000_000) - 500_000)).toBeLessThan(2_000);
  });
});
