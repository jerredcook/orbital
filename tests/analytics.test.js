import { describe, it, expect } from 'vitest';
import { nextVisit, landingKind } from '../src/analytics.js';

const MIN = 60_000, DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 11, 12);

describe('nextVisit', () => {
  it('starts a first visit from nothing or a corrupt record', () => {
    for (const bad of [null, undefined, {}, { n: 'x', first: T0, last: T0 }, { n: 2, first: T0 + DAY, last: T0 }]) {
      expect(nextVisit(bad, T0)).toEqual({ state: { n: 1, first: T0, last: T0 }, events: ['visit/1st'] });
    }
  });

  it('treats a reload inside half an hour as the same visit', () => {
    const r = nextVisit({ n: 1, first: T0, last: T0 }, T0 + 10 * MIN);
    expect(r.events).toEqual([]);
    expect(r.state).toEqual({ n: 1, first: T0, last: T0 + 10 * MIN });
  });

  it('counts a same-day return as a 2nd visit with no back-after', () => {
    const r = nextVisit({ n: 1, first: T0, last: T0 }, T0 + 3 * 60 * MIN);
    expect(r.events).toEqual(['visit/2nd']);
    expect(r.state.n).toBe(2);
    expect(r.state.first).toBe(T0);
  });

  it('buckets the visit number and the span since the first visit', () => {
    const at = (n, days) => nextVisit({ n, first: T0, last: T0 }, T0 + days * DAY).events;
    expect(at(1, 1)).toEqual(['visit/2nd', 'back-after/1-6-days']);
    expect(at(2, 6.9)).toEqual(['visit/3rd-5th', 'back-after/1-6-days']);
    expect(at(4, 7)).toEqual(['visit/3rd-5th', 'back-after/7-29-days']);
    expect(at(5, 29.9)).toEqual(['visit/6th-plus', 'back-after/7-29-days']);
    expect(at(40, 30)).toEqual(['visit/6th-plus', 'back-after/30-days-plus']);
  });
});

describe('landingKind', () => {
  it('names the kind of link someone arrived on', () => {
    expect(landingKind('')).toBe('home');
    expect(landingKind('#')).toBe('home');
    expect(landingKind('#sat=25544')).toBe('sat');
    expect(landingKind('#system')).toBe('system');
    expect(landingKind('#body=Saturn')).toBe('body');
    expect(landingKind('#<script>')).toBe('other');
  });
});
