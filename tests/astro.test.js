// The shared astronomy/geometry helpers (astro.js) — the math the sky chart and
// both workers now source from one place instead of four copies.
import { describe, it, expect } from 'vitest';
import {
  sunEciUnit, sunEcefDir, isSunlitR, stationFrameKm, lookElAz, compass, DEG2RAD,
} from '../src/astro.js';

describe('sunEciUnit', () => {
  it('is a unit vector with the right declination at the solstices/equinox', () => {
    const decl = (tMs) => Math.asin(sunEciUnit(tMs).z) / DEG2RAD;
    const len = (tMs) => { const s = sunEciUnit(tMs); return Math.hypot(s.x, s.y, s.z); };
    expect(len(Date.UTC(2026, 5, 21))).toBeCloseTo(1, 6);
    expect(decl(Date.UTC(2026, 5, 21))).toBeGreaterThan(23.0);    // June solstice ≈ +23.44°
    expect(decl(Date.UTC(2026, 5, 21))).toBeLessThan(23.9);
    expect(decl(Date.UTC(2026, 11, 21))).toBeLessThan(-23.0);     // December solstice
    expect(Math.abs(decl(Date.UTC(2026, 2, 20)))).toBeLessThan(0.6);   // March equinox
  });
  it('matches the ECF variant in the rotation-invariant z component', () => {
    const d = new Date(Date.UTC(2026, 6, 9, 12));
    expect(sunEcefDir(d).z).toBeCloseTo(sunEciUnit(d.getTime()).z, 12);
  });
});

describe('isSunlitR (cylindrical shadow)', () => {
  const sun = { x: 1, y: 0, z: 0 };
  it('lit on the sunward side', () => expect(isSunlitR(7000, 0, 0, sun, 6371)).toBe(true));
  it('shadowed on the anti-sun axis at LEO altitude', () => expect(isSunlitR(-7000, 0, 0, sun, 6371)).toBe(false));
  it('lit when the offset clears the planet', () => expect(isSunlitR(-7000, 6500, 0, sun, 6371)).toBe(true));
});

describe('stationFrameKm (WGS84)', () => {
  it('equator/prime meridian: position on the a-axis, ENU aligned with the axes', () => {
    const f = stationFrameKm(0, 0, 0);
    expect(f.pos[0]).toBeCloseTo(6378.137, 3);
    expect(f.pos[1]).toBeCloseTo(0, 9);
    expect(f.pos[2]).toBeCloseTo(0, 9);
    expect(f.up).toEqual([1, 0, 0]);
    expect(f.east).toEqual([-0, 1, 0]);
    expect(f.north[2]).toBeCloseTo(1, 12);
  });
  it('north pole: polar radius, up = +Z', () => {
    const f = stationFrameKm(Math.PI / 2, 0, 0);
    expect(f.pos[2]).toBeCloseTo(6356.752, 2);
    expect(f.up[2]).toBeCloseTo(1, 12);
  });
  it('basis is orthonormal at mid-latitude', () => {
    const f = stationFrameKm(45 * DEG2RAD, -70 * DEG2RAD, 0);
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(f.up, f.east)).toBeCloseTo(0, 12);
    expect(dot(f.up, f.north)).toBeCloseTo(0, 12);
    expect(dot(f.east, f.north)).toBeCloseTo(0, 12);
    expect(dot(f.up, f.up)).toBeCloseTo(1, 12);
  });
});

describe('lookElAz', () => {
  const st = stationFrameKm(0, 0, 0);   // equator / prime meridian, km frame
  it('zenith → el 90°', () => {
    const l = lookElAz(st.pos[0] + 400, 0, 0, st);
    expect(l.el).toBeCloseTo(90, 6);
  });
  it('due east on the horizontal → el 0°, az 90°', () => {
    const l = lookElAz(st.pos[0], 100, 0, st);
    expect(l.el).toBeCloseTo(0, 6);
    expect(l.az).toBeCloseTo(90, 6);
  });
  it('due north on the horizontal → az 0°', () => {
    const l = lookElAz(st.pos[0], 0, 100, st);
    expect(l.az).toBeCloseTo(0, 6);
  });
});

describe('compass', () => {
  it('maps azimuths to the eight points, wrapping negatives', () => {
    expect(compass(0)).toBe('N');
    expect(compass(45)).toBe('NE');
    expect(compass(180)).toBe('S');
    expect(compass(-90)).toBe('W');
    expect(compass(359)).toBe('N');
  });
});
