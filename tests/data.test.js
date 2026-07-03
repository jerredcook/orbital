// TLE parsing + orbit-regime classification (pure functions from data.js).
import { describe, it, expect } from 'vitest';
import { parseTLEs, classifyRegime, tleEpochMs } from '../src/data.js';

const ISS = `ISS (ZARYA)
1 25544U 98067A   26001.50000000  .00016717  00000-0  10270-3 0  9002
2 25544  51.6400 208.9163 0006317  69.9862 290.2600 15.54225995 12406`;

describe('parseTLEs', () => {
  it('parses a 3LE block with name, ids and launch year', () => {
    const out = parseTLEs(ISS);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('ISS (ZARYA)');
    expect(out[0].norad).toBe(25544);
    expect(out[0].launchYear).toBe(1998);
    expect(out[0].l2.startsWith('2 25544')).toBe(true);
  });
  it('skips malformed entries without derailing', () => {
    const out = parseTLEs(`garbage line\n${ISS}\ntrailing junk`);
    expect(out).toHaveLength(1);
  });
});

describe('tleEpochMs', () => {
  it('parses the epoch (year pivot + fractional day-of-year)', () => {
    // ISS TLE above: epoch 26001.50000000 → 2026 day 1.5 → 2026-01-01T12:00Z
    const l1 = ISS.split('\n')[1];
    expect(tleEpochMs(l1)).toBe(Date.UTC(2026, 0, 1) + 0.5 * 86400000);
  });
  it('applies the 1957 two-digit-year pivot', () => {
    const y99 = '1 00005U 58002B   99001.00000000  .0 0  0 0';
    const y01 = '1 00005U 58002B   01001.00000000  .0 0  0 0';
    expect(tleEpochMs(y99)).toBe(Date.UTC(1999, 0, 1));
    expect(tleEpochMs(y01)).toBe(Date.UTC(2001, 0, 1));
  });
});

describe('classifyRegime', () => {
  it('classifies by SATCAT period when present', () => {
    expect(classifyRegime({ period: 92.9, apogee: 421, perigee: 415 }, null)).toBe('LEO');
    expect(classifyRegime({ period: 1436, apogee: 35795, perigee: 35779 }, null)).toBe('GEO');
    expect(classifyRegime({ period: 718, apogee: 39100, perigee: 1000 }, null)).toBe('HEO');   // Molniya-like
  });
  it('falls back to TLE mean motion when SATCAT is missing', () => {
    expect(classifyRegime(null, 15.54)).toBe('LEO');     // ISS: 1440/15.54 ≈ 93 min
    expect(classifyRegime(null, 1.0027)).toBe('GEO');    // geosynchronous
  });
});
