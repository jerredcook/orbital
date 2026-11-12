// tools/launch-data.mjs — the gate on the unattended mission-data refresh.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateRecent } from '../tools/launch-data.mjs';

const NOW = Date.UTC(2026, 10, 12, 12);
const DAY = 86_400_000;
const iso = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString();
const launch = (offsetDays, over = {}) => ({
  name: 'Falcon 9 Block 5 | Starlink Group 99-1', date: iso(offsetDays), agency: 'SpaceX', status: 'Success',
  desc: 'A batch of satellites.', img: 'https://example.org/a.jpg', pad: 'Cape Canaveral SFS, FL, USA', ...over,
});
const good = () => ({
  updated: '2026-11-12',
  previous: [launch(-0.5), launch(-1), launch(-2), launch(-3)],
  upcoming: [launch(-0.2, { status: 'Go' }), launch(1), launch(2), launch(5)],
});
const check = (data) => validateRecent(data, { now: NOW });

describe('validateRecent', () => {
  it('accepts a normal result', () => {
    expect(check(good())).toEqual([]);
  });

  it('accepts the file committed in the repo (shape only — it ages)', () => {
    const committed = JSON.parse(readFileSync(new URL('../public/missions/recent.json', import.meta.url), 'utf8'));
    expect(validateRecent(committed, { fresh: false })).toEqual([]);
  });

  it('rejects what an upstream outage tends to return', () => {
    expect(check(null)).not.toEqual([]);
    expect(check([])).not.toEqual([]);
    expect(check({ detail: 'Request was throttled.' })).not.toEqual([]);
    expect(check({ ...good(), previous: [] })).not.toEqual([]);
    expect(check({ ...good(), upcoming: [] })).not.toEqual([]);
    expect(check({ ...good(), upcoming: 'none' })).not.toEqual([]);
  });

  it('rejects a launch with a missing name, a bad date or the wrong types', () => {
    const bad = (over) => check({ ...good(), previous: [launch(-1, over), launch(-2), launch(-3)] });
    expect(bad({ name: '   ' })).not.toEqual([]);
    expect(bad({ date: null })).not.toEqual([]);
    expect(bad({ date: 'soon' })).not.toEqual([]);
    expect(bad({ agency: 42 })).not.toEqual([]);
    expect(bad({ desc: 'x'.repeat(261) })).not.toEqual([]);
    expect(bad({ img: 'http://insecure.example/a.jpg' })).not.toEqual([]);
    expect(bad({ img: 'javascript:alert(1)' })).not.toEqual([]);
    expect(bad({ img: null })).toEqual([]);          // no photo is fine
  });

  it('rejects stale data: nothing flown in a month, or nothing still to come', () => {
    const old = { ...good(), previous: [launch(-40), launch(-41), launch(-42)] };
    expect(check(old).join()).toMatch(/stale/);
    const none = { ...good(), upcoming: [launch(-1), launch(-2), launch(-3)] };
    expect(check(none).join()).toMatch(/stale/);
  });

  it('rejects lists in the wrong place: a future launch under "just flew", an old one under "up next"', () => {
    expect(check({ ...good(), previous: [launch(3), launch(-1), launch(-2)] })).not.toEqual([]);
    expect(check({ ...good(), upcoming: [launch(-20), launch(1), launch(2)] })).not.toEqual([]);
  });

  it('allows a launch that slipped a few days but is still listed as upcoming', () => {
    expect(check({ ...good(), upcoming: [launch(-3), launch(1), launch(2)] })).toEqual([]);
  });

  it('skips the freshness rules when asked', () => {
    const old = { ...good(), previous: [launch(-400), launch(-401), launch(-402)] };
    expect(validateRecent(old, { now: NOW, fresh: false })).toEqual([]);
  });
});
