// The satellite data the site serves from its own address (tools/satellite-data.mjs):
// putting a set of files together, refusing a bad one, and deciding when
// CelesTrak may be asked.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { assemble, checkBundle, plan, satcatIsDue, satcatJson, stampOf, tidy } from '../tools/satellite-data.mjs';
import { mergeGroups, withMeta } from '../src/catalog-parse.js';
import { validateSnapshot } from '../tools/tle-snapshot.mjs';

const ACTIVE = readFileSync(new URL('../public/fallback/active.tle', import.meta.url), 'utf8');
const DEB = 'TESTCLOUD DEB\n1 90001U 93036ZZZ 26318.50000000  .00000100  00000-0  10000-3 0  9990\n2 90001  74.0000 100.0000 0010000  90.0000 270.0000 14.30000000100000\n';
const HOUR = 3_600_000;
// "Now" is two days after the committed snapshot's own date, whenever that is —
// the snapshot is replaced every week, and these tests must not start failing
// on a calendar date.
const NOW = Math.round(validateSnapshot(ACTIVE, { fresh: false }).medianEpochMs) + 48 * HOUR;
const CSV = [
  'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE',
  'ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.9,51.63,420,412',
  '"SOMETHING, ELSE",1990-001A,20436,PAY,+,US,1990-01-01,AFETR,,100.1,98.7,700,690',
  'NOT IN THE LIST,2001-001A,1,PAY,D,US,2001-01-01,AFETR,2002-01-01,90,10,300,290',
  'TESTCLOUD DEB,1993-036ZZZ,90001,DEB,,CIS,1993-06-16,PKMTR,,101,74,800,750',
].join('\n');

describe('assembling the data files', () => {
  const b = assemble({ active: ACTIVE, debris: DEB, satcat: satcatJson(CSV, { active: ACTIVE, debris: DEB }), fetchedAt: NOW, satcatFetchedAt: NOW, source: 'celestrak' });
  const meta = JSON.parse(b.meta);

  it('describes what it holds', () => {
    expect(meta.counts.active).toBeGreaterThan(8000);
    expect(meta.counts.debris).toBe(1);
    expect(meta.source).toBe('celestrak');
    expect(meta.fetchedAt).toBe(NOW);
    expect(meta.stamp).toMatch(/^[0-9a-f]{16}$/);
  });
  it('passes its own check', () => {
    expect(checkBundle(b, { now: NOW })).toEqual([]);
  });
  it('keeps only the catalog rows for objects in the lists, and only the fields the app uses', () => {
    const rows = new Map(JSON.parse(b.satcat));
    expect(rows.has(25544)).toBe(true);
    expect(rows.has(90001)).toBe(true);     // debris objects get details too
    expect(rows.has(1)).toBe(false);        // not in either list
    expect(Object.keys(rows.get(25544)).sort()).toEqual(['apogee', 'inclination', 'intlDes', 'launchDate', 'launchSite', 'owner', 'perigee', 'period', 'type']);
    expect(rows.get(25544).owner).toBe('ISS');
  });
  it('is what the app reads: the same files build the same catalog', () => {
    const { tles } = mergeGroups([{ text: b.active, kind: 'SAT' }, { text: b.debris, kind: 'DEB' }]);
    const list = withMeta(tles, new Map(JSON.parse(b.satcat)));
    expect(list.length).toBe(meta.counts.active + meta.counts.debris);
    expect(list.find((s) => s.norad === 25544).meta.launchSite).toBe('TYMSC');
    expect(list.find((s) => s.norad === 90001).kind).toBe('DEB');
  });
  it('gives the same stamp for the same data, whatever the dates — and a new one when the data changes', () => {
    const later = assemble({ active: ACTIVE, debris: DEB, satcat: b.satcat, fetchedAt: NOW + 5 * HOUR, source: 'celestrak' });
    expect(JSON.parse(later.meta).stamp).toBe(meta.stamp);
    const other = assemble({ active: ACTIVE, debris: '', satcat: b.satcat, fetchedAt: NOW, source: 'celestrak' });
    expect(JSON.parse(other.meta).stamp).not.toBe(meta.stamp);
  });
  it('normalises line endings without touching the content', () => {
    expect(tidy('A\r\nB\r\n\r\n')).toBe('A\nB\n');
    expect(tidy('')).toBe('');
    expect(tidy(null)).toBe('');
  });
});

describe('refusing a bad set of files', () => {
  const good = assemble({ active: ACTIVE, debris: DEB, fetchedAt: NOW, source: 'celestrak' });
  const problemsWith = (change, opts) => checkBundle({ ...good, ...change }, { now: NOW, ...opts });

  it('an error page instead of the active list', () => {
    expect(problemsWith({ active: '<html>rate limited</html>' }).length).toBeGreaterThan(0);
  });
  it('a file changed after the stamp was made', () => {
    expect(problemsWith({ active: `${good.active}EXTRA\n1 00001U\n2 00001\n` }).join(' ')).toMatch(/stamp|malformed/);
    expect(problemsWith({ debris: '' })).toContain('meta.json stamp does not match the files beside it');
  });
  it('debris that is not element sets', () => {
    const bad = assemble({ active: ACTIVE, debris: 'one\ntwo\n', fetchedAt: NOW, source: 'celestrak' });
    expect(checkBundle(bad, { now: NOW }).some((p) => p.startsWith('debris'))).toBe(true);
  });
  it('catalog details that are not the expected JSON', () => {
    const bad = assemble({ active: ACTIVE, satcat: '{"oops":1}', fetchedAt: NOW, source: 'celestrak' });
    expect(checkBundle(bad, { now: NOW }).join(' ')).toMatch(/catalog details/);
  });
  it('a broken or future-dated meta.json', () => {
    expect(problemsWith({ meta: 'not json' })).toContain('meta.json is not a JSON object');
    const future = assemble({ active: ACTIVE, debris: DEB, fetchedAt: NOW + 48 * HOUR, source: 'celestrak' });
    expect(checkBundle(future, { now: NOW }).join(' ')).toMatch(/future/);
  });
  it('old element sets — only when it is supposed to be a fresh fetch', () => {
    const muchLater = NOW + 30 * 24 * HOUR;
    expect(checkBundle(good, { now: muchLater, fresh: false })).toEqual([]);
    expect(checkBundle(good, { now: muchLater, fresh: true }).join(' ')).toMatch(/not current/);
  });
  it('an empty debris file is allowed (the app just shows none)', () => {
    const none = assemble({ active: ACTIVE, fetchedAt: NOW, source: 'snapshot' });
    expect(checkBundle(none, { now: NOW })).toEqual([]);
    expect(stampOf(none)).toBe(JSON.parse(none.meta).stamp);
  });
});

describe('when CelesTrak may be asked', () => {
  it('not while the live site is under 3½ hours old — however the build was started', () => {
    expect(plan({ liveFetchedAt: NOW - 1 * HOUR, now: NOW })).toBe('reuse');
    expect(plan({ liveFetchedAt: NOW - 3.4 * HOUR, now: NOW })).toBe('reuse');
    expect(plan({ liveFetchedAt: NOW - 1 * HOUR, now: NOW, allowCelestrak: false })).toBe('reuse');
  });
  it('once it is older than that', () => {
    expect(plan({ liveFetchedAt: NOW - 3.6 * HOUR, now: NOW })).toBe('fetch');
    expect(plan({ liveFetchedAt: null, now: NOW })).toBe('fetch');
  });
  it('never from a pull-request build', () => {
    expect(plan({ liveFetchedAt: NOW - 30 * HOUR, now: NOW, allowCelestrak: false })).toBe('carry');
    expect(plan({ liveFetchedAt: null, now: NOW, allowCelestrak: false })).toBe('none');
  });
  it('so a day of four-hourly builds plus pushes asks at most about seven times', () => {
    // Builds every 20 minutes for 24 hours (far busier than real life): each
    // fetch makes the live copy fresh, and the next 3½ hours reuse it.
    let live = null, fetches = 0;
    for (let t = NOW; t < NOW + 24 * HOUR; t += HOUR / 3) {
      if (plan({ liveFetchedAt: live, now: t }) === 'fetch') { fetches++; live = t; }
    }
    expect(fetches).toBeLessThanOrEqual(7);
  });
  it('the big catalog file about once a day', () => {
    expect(satcatIsDue({ satcatFetchedAt: null, now: NOW })).toBe(true);
    expect(satcatIsDue({ satcatFetchedAt: NOW - 4 * HOUR, now: NOW })).toBe(false);
    expect(satcatIsDue({ satcatFetchedAt: NOW - 21 * HOUR, now: NOW })).toBe(true);
  });
});
