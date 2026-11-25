// tools/spacetrack.mjs — the whole catalogue from Space-Track, split into
// active satellites (CelesTrak's active list decides), dead satellites, rocket
// bodies and debris.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as satellite from 'satellite.js';
import { parseGpCsv, splitCatalogue, checkCatalogue, GP_QUERY } from '../tools/spacetrack.mjs';
import { assemble, checkBundle, stampOf } from '../tools/satellite-data.mjs';
import { mergeGroups, withMeta, parseTLEs, orbitFromElements } from '../src/catalog-parse.js';

// Eight real rows from Space-Track's GP class (15 Nov 2026): Vanguard 1 (dead
// since 1964), the ISS, Envisat (dead since 2012), Hubble, a satellite with a
// six-digit number, a debris fragment, a rocket body and an unidentified object.
const SAMPLE = readFileSync(new URL('./fixtures/spacetrack-gp-sample.csv', import.meta.url), 'utf8');
const rows = parseGpCsv(SAMPLE);
const NOW = Date.UTC(2026, 10, 15, 22);
const names = (text) => parseTLEs(text).map((s) => s.name);
const ids = (text) => parseTLEs(text).map((s) => s.norad);

describe('the real Space-Track sample', () => {
  it('parses, quoted fields and all', () => {
    expect(rows.length).toBe(8);
    expect(rows.map((r) => r.NORAD_CAT_ID)).toEqual(['5', '25544', '27386', '20580', '101111', '40078', '40002', '81011']);
    expect(rows[0].OBJECT_NAME).toBe('VANGUARD 1');
  });
  it('asks for objects still in orbit, with recent elements, in one request', () => {
    expect(GP_QUERY).toMatch(/class\/gp\/decay_date\/null-val\/epoch\/%3Enow-10\//);
  });
});

describe('splitting the catalogue', () => {
  // CelesTrak's active list has the ISS, Hubble and the new satellite — under its own name for it.
  const activeIds = new Set([25544, 20580, 101111]);
  const activeNames = new Map([[101111, 'PULSAR-01'], [25544, 'ISS (ZARYA)']]);
  const split = splitCatalogue(rows, { activeIds, activeNames, activeListAt: NOW, now: NOW });

  it('files each object where it belongs', () => {
    expect(ids(split.active)).toEqual([25544, 20580, 101111]);
    expect(ids(split.inactive)).toEqual([5, 27386]);            // Vanguard 1 and Envisat: payloads, not on the active list
    expect(ids(split.rocketbodies)).toEqual([40002]);
    expect(ids(split.debris)).toEqual([40078, 81011]);          // the fragment, and the object nobody has identified
    expect(split.counts).toEqual({ active: 3, inactive: 2, rocketbodies: 1, debris: 2 });
    expect(split.dropped).toBe(0);
  });
  it('keeps CelesTrak\'s names for active satellites, and Space-Track\'s for the rest', () => {
    expect(names(split.active)).toEqual(['ISS (ZARYA)', 'HST', 'PULSAR-01']);
    expect(names(split.inactive)).toEqual(['VANGUARD 1', 'ENVISAT']);
    expect(names(split.debris)).toEqual(['FREGAT DEB', 'TBA - TO BE ASSIGNED']);
  });
  it('uses Space-Track\'s own element lines, six-digit numbers included', () => {
    const iss = rows.find((r) => r.NORAD_CAT_ID === '25544'), sets = parseTLEs(split.active);
    expect(sets[0].l1).toBe(iss.TLE_LINE1);
    expect(sets[0].l2).toBe(iss.TLE_LINE2);
    expect(sets[2].l1.startsWith('1 A1111U')).toBe(true);
    expect(sets[2].norad).toBe(101111);
  });
  it('gives orbits the SGP4 library can fly', () => {
    for (const text of [split.active, split.inactive, split.rocketbodies, split.debris]) {
      for (const s of parseTLEs(text)) {
        const pv = satellite.propagate(satellite.twoline2satrec(s.l1, s.l2), new Date(NOW));
        expect(pv.position, s.name).toBeTruthy();
        expect(Math.hypot(pv.position.x, pv.position.y, pv.position.z)).toBeGreaterThan(6478);
      }
    }
  });
  it('records only what the elements cannot say — the app derives the rest', () => {
    const details = new Map(JSON.parse(split.details));
    expect(details.size).toBe(8);
    expect(details.get(25544)).toEqual({ owner: 'CIS', launchDate: '1998-11-20', launchSite: 'TTMTR', type: 'PAY' });
    expect(details.get(40002).type).toBe('R/B');
    expect(details.get(40078).type).toBe('DEB');
    expect(details.get(81011)).toEqual({ owner: '', launchDate: '', launchSite: '', type: 'UNK' });
  });
  it('and what the app derives matches Space-Track\'s own figures', () => {
    for (const r of rows) {
      const o = orbitFromElements(r.TLE_LINE1, r.TLE_LINE2);
      expect(Math.abs(o.period - Number(r.PERIOD))).toBeLessThan(0.002);
      expect(Math.abs(o.apogee - Number(r.APOAPSIS))).toBeLessThan(0.05);
      expect(Math.abs(o.perigee - Number(r.PERIAPSIS))).toBeLessThan(0.05);
      expect(o.inclination).toBeCloseTo(Number(r.INCLINATION), 4);
      expect(o.intlDes).toBe(r.OBJECT_ID === 'UNKNOWN' ? '' : r.OBJECT_ID);
    }
  });
  it('the app builds one catalogue from the four files, each object typed', () => {
    const { tles } = mergeGroups([{ text: split.active, kind: 'SAT' }, { text: split.inactive, kind: 'DEAD' }, { text: split.rocketbodies, kind: 'RB' }, { text: split.debris, kind: 'DEB' }]);
    const list = withMeta(tles, new Map(JSON.parse(split.details)));
    const kind = (n) => list.find((s) => s.norad === n).kind;
    expect([kind(25544), kind(5), kind(27386), kind(40002), kind(40078), kind(81011), kind(101111)]).toEqual(['SAT', 'DEAD', 'DEAD', 'RB', 'DEB', 'DEB', 'SAT']);
    const envisat = list.find((s) => s.norad === 27386);
    expect(envisat.meta.owner).toBe('ESA');
    expect(envisat.meta.intlDes).toBe('2002-009A');
    expect(envisat.meta.period).toBeCloseTo(100.063, 2);
    expect(envisat.regime).toBe('LEO');
    expect(list.find((s) => s.norad === 81011).launchYear).toBeNull();
  });
});

describe('when CelesTrak\'s active list is missing or old', () => {
  it('an object on the active list is active whatever Space-Track calls it', () => {
    const split = splitCatalogue(rows, { activeIds: new Set([81011]), activeListAt: NOW, now: NOW });
    expect(ids(split.active)).toEqual([81011]);
  });
  it('a current list is trusted: a payload not on it, launched weeks ago, is not active', () => {
    const split = splitCatalogue(rows, { activeIds: new Set([25544]), activeListAt: NOW - 3_600_000, now: NOW });
    expect(ids(split.inactive)).toContain(101111);
    expect(split.presumedActive).toBe(0);
  });
  it('a payload launched since shortly before the list was made is presumed active rather than filed as dead', () => {
    // the list predates PULSAR-001's launch (2026-10-20), so it could not have been on it
    const listAt = Date.UTC(2026, 9, 10);
    const split = splitCatalogue(rows, { activeIds: new Set([25544, 20580]), activeListAt: listAt, now: NOW });
    expect(ids(split.active)).toEqual([25544, 20580, 101111]);
    expect(split.presumedActive).toBe(1);
    expect(ids(split.inactive)).toEqual([5, 27386]);            // old dead satellites stay dead
  });
  it('and is marked as presumed, so the app can say so — nothing else is', () => {
    const split = splitCatalogue(rows, { activeIds: new Set([25544, 20580]), activeListAt: Date.UTC(2026, 9, 10), now: NOW });
    const details = new Map(JSON.parse(split.details));
    expect(details.get(101111).presumed).toBe(1);
    expect([...details].filter(([, d]) => 'presumed' in d).map(([n]) => n)).toEqual([101111]);
    // the app carries the mark through to the object it draws
    const drawn = withMeta(parseTLEs(split.active), details);
    expect(drawn.find((s) => s.norad === 101111).meta.presumed).toBe(1);
    expect(drawn.find((s) => s.norad === 25544).meta.presumed).toBeUndefined();
    // once the list has it, the mark goes
    const listed = splitCatalogue(rows, { activeIds: new Set([25544, 20580, 101111]), activeListAt: NOW, now: NOW });
    expect(JSON.parse(listed.details).some(([, d]) => 'presumed' in d)).toBe(false);
  });
  it('that covers the daily cadence: yesterday\'s list and a satellite launched this morning', () => {
    const fresh = rows.map((r) => ({ ...r }));
    fresh[4].LAUNCH_DATE = '2026-11-15';                                 // PULSAR, as if launched today
    const split = splitCatalogue(fresh, { activeIds: new Set([25544, 20580]), activeListAt: NOW - 19 * 3_600_000, now: NOW });
    expect(ids(split.active)).toContain(101111);
    expect(ids(split.inactive)).toEqual([5, 27386]);
  });
  it('an active object Space-Track did not return keeps CelesTrak\'s own elements', () => {
    const extra = ['EXTRA SAT', '1 99998U 20001A   26319.50000000  .00001000  00000-0  10000-4 0  9990', '2 99998  53.0000 100.0000 0001000  90.0000 270.0000 15.05000000100000'];
    const split = splitCatalogue(rows, { activeIds: new Set([25544, 99998]), activeSets: new Map([[99998, extra], [25544, ['ISS (ZARYA)', 'x', 'y']]]), activeListAt: NOW, now: NOW });
    expect(ids(split.active)).toEqual([25544, 99998]);
    expect(split.fromCelestrak).toBe(1);
    expect(parseTLEs(split.active)[0].l1).toBe(rows[1].TLE_LINE1);   // Space-Track's lines win when it has the object
  });
});

describe('what it refuses', () => {
  it('a repeated number: the first row wins and the repeat is counted, not written twice', () => {
    const twice = parseGpCsv(SAMPLE + SAMPLE.split('\n')[2] + '\n');
    const split = splitCatalogue(twice, { activeIds: new Set([25544]), activeListAt: NOW, now: NOW });
    expect(split.duplicates).toBe(1);
    expect(ids(split.active)).toEqual([25544]);
  });
  it('rows with broken element lines are rewritten from the element fields; rows with neither are left out', () => {
    const broken = rows.map((r) => ({ ...r }));
    broken[1].TLE_LINE1 = 'garbage';                                  // the ISS: lines unusable, fields fine
    broken[3].TLE_LINE1 = ''; broken[3].MEAN_MOTION = '';             // Hubble: nothing usable
    broken[5].NORAD_CAT_ID = 'abc';
    const split = splitCatalogue(broken, { activeIds: new Set([25544, 20580]), activeListAt: NOW, now: NOW });
    const iss = parseTLEs(split.active)[0];
    expect(iss.norad).toBe(25544);
    expect(iss.l2.slice(8, 63)).toBe(rows[1].TLE_LINE2.slice(8, 63));   // same orbit, written from the fields
    expect(split.dropped).toBe(2);
    expect(split.skipped.join(' ')).toMatch(/HST \(20580\)/);
  });
  it('an element line for a different object than the row says', () => {
    const wrong = rows.map((r) => ({ ...r }));
    wrong[1].TLE_LINE1 = rows[3].TLE_LINE1; wrong[1].TLE_LINE2 = rows[3].TLE_LINE2;   // the ISS row carrying Hubble's lines
    const iss = parseTLEs(splitCatalogue(wrong, { activeIds: new Set([25544]), activeListAt: NOW, now: NOW }).active)[0];
    expect(iss.norad).toBe(25544);
    expect(iss.l2.slice(8, 16)).toBe(' 51.6322');
  });
  it('an answer that is not the catalogue', () => {
    expect(checkCatalogue(rows).join(' ')).toMatch(/8 objects/);
    expect(() => parseGpCsv('{"error":"You must be logged in"}')).toThrow(/not OMM CSV/);
    expect(() => parseGpCsv('')).toThrow();
  });
});

describe('the published set', () => {
  const split = splitCatalogue(rows, { activeIds: new Set([25544, 20580, 101111]), activeListAt: NOW, now: NOW });
  const ACTIVE = readFileSync(new URL('../public/fallback/active.tle', import.meta.url), 'utf8');
  const bundle = assemble({ active: ACTIVE, inactive: split.inactive, rocketbodies: split.rocketbodies, debris: split.debris, satcat: split.details,
    fetchedAt: NOW, catalogueAt: NOW, activeListAt: NOW, source: 'space-track' });
  const meta = JSON.parse(bundle.meta);
  it('describes all four lists and where they came from', () => {
    expect(meta.source).toBe('space-track');
    expect(meta.counts.inactive).toBe(2); expect(meta.counts.rocketbodies).toBe(1); expect(meta.counts.debris).toBe(2);
    expect(meta.catalogueAt).toBe(NOW);
  });
  it('passes the gate; a changed dead-satellite file does not', () => {
    const now = Math.round(meta.epoch) + 2 * 86_400_000;
    const ok = assemble({ active: ACTIVE, inactive: split.inactive, rocketbodies: split.rocketbodies, debris: split.debris, satcat: split.details, fetchedAt: now, source: 'space-track' });
    expect(checkBundle(ok, { now })).toEqual([]);
    expect(checkBundle({ ...ok, inactive: '' }, { now })).toContain('meta.json stamp does not match the files beside it');
    expect(checkBundle({ ...ok, rocketbodies: 'one\ntwo\n' }, { now }).some((p) => p.startsWith('rocket bodies'))).toBe(true);
  });
  it('a set without the new lists is stamped as it always was', () => {
    const old = { active: ACTIVE, debris: split.debris, satcat: '[]' };
    expect(stampOf(old)).toBe(stampOf({ ...old, inactive: '', rocketbodies: '' }));
    expect(stampOf(old)).not.toBe(stampOf({ ...old, inactive: split.inactive }));
  });
});
