// Launch-timeline pacing (scrubber.js), shared by the timeline's ▶ and capture
// mode: the year shown at each moment of a run, and the way back.
import { describe, it, expect } from 'vitest';
import { yearAt } from '../src/clip.js';
import { yearAt as sharedYearAt, progressAt } from '../src/scrubber.js';

describe('progressAt', () => {
  const END = 2026;
  it('capture mode and the timeline use the very same pacing', () => {
    expect(yearAt).toBe(sharedYearAt);
  });
  it('is 0 at the start and 1 at the end', () => {
    expect(progressAt(1950, END)).toBe(0);
    expect(progressAt(1957, END)).toBe(0);
    expect(progressAt(END, END)).toBe(1);
    expect(progressAt(END + 5, END)).toBe(1);
  });
  it('undoes yearAt for every year, so pausing and resuming never jumps', () => {
    for (let y = 1957; y <= END; y++) {
      const back = Math.floor(yearAt(progressAt(y, END), END) + 1e-9);
      expect(back, String(y)).toBe(y);
    }
  });
  it('only ever moves forward', () => {
    let prev = 0;
    for (let y = 1957; y <= END; y++) {
      const p = progressAt(y, END);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

describe('yearAt', () => {
  const END = 2026;
  it('starts at 1957 and ends on the final year', () => {
    expect(yearAt(-0.2, END)).toBe(1957);
    expect(yearAt(0, END)).toBe(1957);
    expect(yearAt(1, END)).toBe(END);
    expect(yearAt(1.5, END)).toBe(END);
  });
  it('never runs backwards and never skips past the end', () => {
    let prev = 1957;
    for (let i = 0; i <= 1000; i++) {
      const y = yearAt(i / 1000, END);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(y).toBeLessThanOrEqual(END);
      prev = y;
    }
  });
  it('spends about a third of the clip on the Starlink years', () => {
    expect(yearAt(0.68, END)).toBeCloseTo(2019, 0);
    expect(Math.floor(yearAt(0.30, END))).toBe(1990);
  });
  it('shows every single year along the way', () => {
    const seen = new Set();
    for (let i = 0; i <= 2400; i++) seen.add(Math.floor(yearAt(i / 2400, END)));   // 60 fps × 40 s
    for (let y = 1957; y <= END; y++) expect(seen.has(y), String(y)).toBe(true);
  });
});
