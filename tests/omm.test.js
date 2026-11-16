// tools/omm.mjs — CelesTrak's OMM CSV written out as the element text the app
// reads, with Alpha-5 catalogue numbers above 99,999.  A wrong column here is a
// satellite in the wrong place, so the output is checked three independent ways:
// against the orbit library's own reading of each line, against the numbers in
// the CSV, and by round-tripping every real element set in the committed snapshot.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as satellite from 'satellite.js';
import { ommCsvToTle, ommToTle, parseOmmCsv, epochField, expField, REQUIRED_COLUMNS } from '../tools/omm.mjs';
import { alpha5ToNumber, numberToAlpha5, parseTLEs, ALPHA5_MAX } from '../src/catalog-parse.js';
import { validateSnapshot, LINE1, LINE2 } from '../tools/tle-snapshot.mjs';

// A real answer from CelesTrak (GROUP=last-30-days&FORMAT=csv, 15 Nov 2026):
// 205 objects, every one with a six-digit catalogue number.
const SAMPLE = readFileSync(new URL('./fixtures/omm-last-30-days.csv', import.meta.url), 'utf8');
const rows = parseOmmCsv(SAMPLE);
const SNAPSHOT = readFileSync(new URL('../public/fallback/active.tle', import.meta.url), 'utf8');
const TAU = 2 * Math.PI, DEG = Math.PI / 180;
const checksumOk = (line) => {
  let sum = 0;
  for (const ch of line.slice(0, 68)) sum += ch === '-' ? 1 : (ch >= '0' && ch <= '9' ? Number(ch) : 0);
  return String(sum % 10) === line[68];
};

describe('Alpha-5 catalogue numbers', () => {
  it('reads plain numbers exactly as before', () => {
    expect(alpha5ToNumber('25544')).toBe(25544);
    expect(alpha5ToNumber('00005')).toBe(5);
    expect(alpha5ToNumber('    5')).toBe(5);
  });
  it('reads and writes numbers above 99,999', () => {
    expect(numberToAlpha5(100000)).toBe('A0000');
    expect(numberToAlpha5(101400)).toBe('A1400');
    expect(numberToAlpha5(182931)).toBe('J2931');     // I is skipped: H=17, J=18
    expect(numberToAlpha5(ALPHA5_MAX)).toBe('Z9999');
    expect(alpha5ToNumber('A0000')).toBe(100000);
    expect(alpha5ToNumber('Z9999')).toBe(339999);
  });
  it('round-trips every number it can write', () => {
    for (let n = 0; n <= ALPHA5_MAX; n += 37) expect(alpha5ToNumber(numberToAlpha5(n))).toBe(n);
    for (const n of [99999, 100000, 109999, 110000, 179999, 180000, 239999, 240000, 339999]) expect(alpha5ToNumber(numberToAlpha5(n))).toBe(n);
  });
  it('refuses what it cannot represent, instead of writing a wrong number', () => {
    expect(numberToAlpha5(340000)).toBeNull();
    expect(numberToAlpha5(-1)).toBeNull();
    expect(numberToAlpha5(1.5)).toBeNull();
    for (const bad of ['I0000', 'O0000', 'a0000', 'A000', 'A00000', 'AB000', '']) expect(alpha5ToNumber(bad)).toBeNaN();
  });
});

describe('the real CelesTrak sample', () => {
  const out = ommCsvToTle(SAMPLE);
  const sets = parseTLEs(out.text);

  it('is what the app could not see before: every object has a six-digit number', () => {
    expect(rows.length).toBe(205);
    expect(rows.every((r) => Number(r.NORAD_CAT_ID) >= 100000)).toBe(true);
  });
  it('converts every object, dropping none', () => {
    expect(out.count).toBe(205);
    expect(out.sixDigit).toBe(205);
    expect(out.dropped).toBe(0);
  });
  it('writes column-exact, checksummed lines', () => {
    const lines = out.text.trimEnd().split('\n');
    expect(lines.length).toBe(205 * 3);
    for (let i = 0; i < lines.length; i += 3) {
      const [l1, l2] = [lines[i + 1], lines[i + 2]];
      expect(l1.length).toBe(69); expect(l2.length).toBe(69);
      expect(LINE1.test(l1) && LINE2.test(l2)).toBe(true);
      expect(l1.slice(2, 7)).toBe(l2.slice(2, 7));
      expect(checksumOk(l1) && checksumOk(l2), lines[i]).toBe(true);
      for (const c of [1, 8, 17, 32, 43, 52, 61, 63]) expect(l1[c], `line 1 col ${c + 1}`).toBe(' ');
      for (const c of [1, 7, 16, 25, 33, 42, 51]) expect(l2[c], `line 2 col ${c + 1}`).toBe(' ');
    }
  });
  it('gives the app the right number, name and launch year for each', () => {
    expect(sets.length).toBe(205);
    rows.forEach((r, i) => {
      expect(sets[i].norad).toBe(Number(r.NORAD_CAT_ID));
      expect(sets[i].name).toBe(r.OBJECT_NAME);
      expect(sets[i].launchYear).toBe(Number(r.OBJECT_ID.slice(0, 4)));
    });
  });
  it('means the same orbit to the SGP4 library as the numbers in the CSV', () => {
    rows.forEach((r, i) => {
      const rec = satellite.twoline2satrec(sets[i].l1, sets[i].l2);
      expect(rec.error).toBe(0);
      // Mean motion: the library converts it to its internal "un-Kozai" form on
      // load (a shift of about one part in 10⁴), so check the text field itself to
      // full precision and the library's value to within that shift.
      expect(Math.abs(Number(sets[i].l2.slice(52, 63)) - Number(r.MEAN_MOTION))).toBeLessThan(1e-8);
      expect(Math.abs(rec.no * 1440 / TAU - Number(r.MEAN_MOTION))).toBeLessThan(Number(r.MEAN_MOTION) * 2e-3);
      expect(Math.abs(rec.ecco - Number(r.ECCENTRICITY))).toBeLessThanOrEqual(5.1e-8);   // 7 places in the text format
      expect(Math.abs(rec.inclo / DEG - Number(r.INCLINATION))).toBeLessThan(1e-9);
      expect(Math.abs(rec.nodeo / DEG - Number(r.RA_OF_ASC_NODE))).toBeLessThan(1e-9);
      expect(Math.abs(rec.argpo / DEG - Number(r.ARG_OF_PERICENTER))).toBeLessThan(1e-9);
      expect(Math.abs(rec.mo / DEG - Number(r.MEAN_ANOMALY))).toBeLessThan(1e-9);
      const b = Number(r.BSTAR);
      expect(Math.abs(rec.bstar - b)).toBeLessThanOrEqual(Math.abs(b) * 6e-5 + 1e-12);    // 5 significant digits
      // the epoch, to within the text format's resolution (1e-8 day ≈ 1 ms)
      const iso = r.EPOCH, ms = Date.parse(`${iso.slice(0, 23)}Z`) + Number(iso.slice(23).padEnd(3, '0')) / 1000;
      const jd = ms / 86_400_000 + 2440587.5;
      expect(Math.abs((rec.jdsatepoch + (rec.jdsatepochF ?? 0)) - jd)).toBeLessThan(2e-8);
    });
  });
  it('puts each one in a real orbit when propagated', () => {
    const when = new Date(Date.UTC(2026, 10, 15, 12));
    let ok = 0;
    for (const s of sets) {
      const pv = satellite.propagate(satellite.twoline2satrec(s.l1, s.l2), when);
      if (!pv.position) continue;                                  // a few fresh deployments are already decaying
      const r = Math.hypot(pv.position.x, pv.position.y, pv.position.z);
      expect(r).toBeGreaterThan(6378 + 100);
      expect(r).toBeLessThan(6378 + 45000);
      ok++;
    }
    expect(ok).toBeGreaterThan(190);
  });
  it('passes the same gate as any element text (apart from being only 205 objects)', () => {
    const { problems } = validateSnapshot(out.text, { now: Date.UTC(2026, 10, 15, 22), fresh: true });
    // (…and apart from a month of launches being one part rocket stages and debris)
    expect(problems.filter((p) => !/expected 8,000|named as debris/.test(p))).toEqual([]);
  });
});

// Every real element set in the committed snapshot, taken apart by column and
// put back together through the converter, must come back the same — which is
// what proves the column layout and number formats.
//
// "The same" allows for the two things sources legitimately write differently
// (the snapshot is replaced every week from the live site, whose lines are
// mostly Space-Track's own; before that they were CelesTrak's):
//   • a zero drag or second-derivative term: " 00000+0" (CelesTrak, and this
//     converter) or " 00000-0" (Space-Track);
//   • a catalogue number under 10000: zero-padded or space-padded.
// Neither changes the orbit.  Both change line 1's checksum digit, so that
// digit is compared by rule (it must be right for the line it is on) rather
// than by equality.  When the first weekly refresh brought Space-Track's
// spelling in, a byte-for-byte version of this test failed and blocked every
// deploy for half a day.
describe('round trip of the committed snapshot', () => {
  const expo = (f) => Number(`${f[0] === '-' ? '-' : ''}0.${f.slice(1, 6)}e${f.slice(6, 8)}`);
  const toRow = (name, l1, l2) => {
    const yy = Number(l1.slice(18, 20)), day = Number(l1.slice(20, 32)), year = yy < 57 ? 2000 + yy : 1900 + yy;
    const whole = Math.floor(day), us = Math.round((day - whole) * 86_400_000_000);
    const t = new Date(Date.UTC(year, 0, whole) + Math.floor(us / 1000));
    const des = l1.slice(9, 17).trim(), dy = Number(des.slice(0, 2));
    return {
      OBJECT_NAME: name.trim(), OBJECT_ID: des ? `${dy < 57 ? 20 : 19}${des.slice(0, 2)}-${des.slice(2, 5)}${des.slice(5)}` : '',
      EPOCH: `${t.toISOString().slice(0, 19)}.${String(us % 1_000_000).padStart(6, '0')}`,
      MEAN_MOTION: l2.slice(52, 63), ECCENTRICITY: `0.${l2.slice(26, 33)}`, INCLINATION: l2.slice(8, 16), RA_OF_ASC_NODE: l2.slice(17, 25),
      ARG_OF_PERICENTER: l2.slice(34, 42), MEAN_ANOMALY: l2.slice(43, 51), EPHEMERIS_TYPE: l1[62], CLASSIFICATION_TYPE: l1[7],
      NORAD_CAT_ID: String(alpha5ToNumber(l1.slice(2, 7))), ELEMENT_SET_NO: l1.slice(64, 68), REV_AT_EPOCH: l2.slice(63, 68),
      BSTAR: String(expo(l1.slice(53, 61))), MEAN_MOTION_DOT: l1.slice(33, 43).replace(' ', ''), MEAN_MOTION_DDOT: String(expo(l1.slice(44, 52))),
    };
  };
  // One spelling for the two equivalent ones, and no checksum digit.
  const zero = (f) => (/^[ +-]00000[+-]0$/.test(f) ? ' 00000+0' : f);
  const norm1 = (l) => `1 ${numberToAlpha5(alpha5ToNumber(l.slice(2, 7)))}${l.slice(7, 44)}${zero(l.slice(44, 52))} ${zero(l.slice(53, 61))}${l.slice(61, 68)}`;
  const norm2 = (l) => `2 ${numberToAlpha5(alpha5ToNumber(l.slice(2, 7)))}${l.slice(7, 68)}`;

  it('reproduces every line, column for column', () => {
    const lines = SNAPSHOT.split('\n').filter(Boolean);
    let same = 0, exact = 0, badChecksum = 0; const firstDiff = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
      const [l1, l2] = [lines[i + 1], lines[i + 2]];
      const r = ommToTle(toRow(lines[i], l1, l2));
      if (r.lines && norm1(r.lines[1]) === norm1(l1) && norm2(r.lines[2]) === norm2(l2)) same++;
      else if (firstDiff.length < 3) firstDiff.push({ want: [l1, l2], have: r.lines?.slice(1) ?? r.why });
      if (r.lines && r.lines[1] === l1 && r.lines[2] === l2) exact++;
      if (r.lines && !(checksumOk(r.lines[1]) && checksumOk(r.lines[2]))) badChecksum++;
      // …and the source's own checksums are right too, so the comparison above is against sound lines.
      if (!(checksumOk(l1) && checksumOk(l2))) badChecksum++;
    }
    expect(firstDiff).toEqual([]);
    expect(same).toBeGreaterThan(8000);
    expect(same).toBe(lines.length / 3);
    expect(badChecksum).toBe(0);
    expect(exact).toBeGreaterThan(0);   // lines with no zero term come back byte for byte, checksum included
  });
  it('treats the two spellings of zero as the same, and nothing else', () => {
    const a = '1 00900U 64063C   26319.86678133  .00000625  00000-0  62499-3 0  9997';
    const b = '1 00900U 64063C   26319.86678133  .00000625  00000+0  62499-3 0  9996';
    expect(norm1(a)).toBe(norm1(b));
    expect(norm1(a)).not.toBe(norm1(a.replace('62499-3', '62499-4')));        // a different drag term is a different line
    expect(norm1(a)).not.toBe(norm1(a.replace('.00000625', '.00000626')));
    expect(norm1('1     5U 58002B   26319.39760256  .00000394  00000-0  52060-3 0  9991')).toBe(norm1('1 00005U 58002B   26319.39760256  .00000394  00000+0  52060-3 0  9990'));
    expect(norm2('2     5  34.2424 207.5955 1839390 100.3592 280.8433 10.86101342459723')).toBe(norm2('2 00005  34.2424 207.5955 1839390 100.3592 280.8433 10.86101342459723'));
  });
});

describe('the fields', () => {
  it('epoch: day of year with fraction, to 8 places', () => {
    expect(epochField('2026-01-01T00:00:00.000000')).toEqual({ yy: '26', day: '001.00000000' });
    expect(epochField('2026-11-15T01:53:05.184672')).toEqual({ yy: '26', day: '319.07853223' });
    expect(epochField('2024-12-31T12:00:00')).toEqual({ yy: '24', day: '366.50000000' });      // leap year
    expect(epochField('1999-03-01T00:00:00.5')).toEqual({ yy: '99', day: '060.00000579' });
    expect(epochField('2026-12-31T23:59:59.999999').day).toBe('365.99999999');                  // never rounds into day 366
    expect(epochField('yesterday')).toBeNull();
    expect(epochField('2026-13-01T00:00:00')).toBeNull();
  });
  it('drag and second-derivative terms: five digits and a power of ten', () => {
    expect(expField(0)).toBe(' 00000+0');
    expect(expField(0.00017462654)).toBe(' 17463-3');
    expect(expField(-0.000062107867)).toBe('-62108-4');
    expect(expField(-3.4690799)).toBe('-34691+1');
    expect(expField(0.1)).toBe(' 10000+0');
    expect(expField(0.999999)).toBe(' 10000+1');       // rounds up into the next power
    expect(expField(1e-12)).toBe(' 00000+0');          // smaller than the format can say
    expect(expField(NaN)).toBe(' 00000+0');
    for (const v of [1.2345e-5, -9.87654e-3, 4.4e-7, 0.55555]) {
      const f = expField(v), back = Number(`${f[0] === '-' ? '-' : ''}0.${f.slice(1, 6)}e${f.slice(6)}`);
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.abs(v) * 6e-5);
    }
  });
});

describe('what it refuses', () => {
  const good = { ...rows[0] };
  it('a file that is not OMM CSV', () => {
    expect(() => parseOmmCsv('<html>403 Forbidden</html>')).toThrow(/not OMM CSV/);
    expect(() => parseOmmCsv('')).toThrow();
    expect(() => parseOmmCsv(SNAPSHOT.slice(0, 2000))).toThrow(/not OMM CSV/);     // the old text format
    expect(() => parseOmmCsv('No GP data found')).toThrow(/not OMM CSV/);
  });
  it('reads columns by name, so their order and any extras do not matter', () => {
    const cols = Object.keys(good).reverse();
    expect(REQUIRED_COLUMNS.every((c) => cols.includes(c))).toBe(true);
    const csv = `EXTRA,${cols.join(',')}\nx,${cols.map((c) => good[c]).join(',')}\n`;
    expect(ommToTle(parseOmmCsv(csv)[0]).lines).toEqual(ommToTle(good).lines);
  });
  it('handles a quoted name with a comma in it', () => {
    const csv = `${Object.keys(good).join(',')}\n"SAT, THE ""BIG"" ONE",${Object.values(good).slice(1).join(',')}\n`;
    expect(ommCsvToTle(csv).text.split('\n')[0]).toBe('SAT, THE "BIG" ONE');
  });
  it('an object it cannot write is left out and reported — never written wrongly', () => {
    for (const [change, why] of [
      [{ NORAD_CAT_ID: '340000' }, /cannot be written/], [{ NORAD_CAT_ID: '' }, /cannot be written/], [{ EPOCH: 'soon' }, /epoch/],
      [{ MEAN_MOTION: '' }, /out of range/], [{ ECCENTRICITY: '1.2' }, /out of range/], [{ INCLINATION: '181' }, /out of range/], [{ MEAN_MOTION: '0' }, /out of range/],
    ]) {
      const r = ommToTle({ ...good, ...change });
      expect(r.lines).toBeNull();
      expect(r.why).toMatch(why);
    }
    const mixed = `${Object.keys(good).join(',')}\n${Object.values(good).join(',')}\n${Object.values({ ...good, NORAD_CAT_ID: '999999', OBJECT_NAME: 'TOO BIG' }).join(',')}\n`;
    const out = ommCsvToTle(mixed);
    expect(out.count).toBe(1); expect(out.dropped).toBe(1); expect(out.skipped[0]).toMatch(/TOO BIG \(999999\)/);
  });
  it('an object with no designator or name still converts (analyst objects)', () => {
    const r = ommToTle({ ...good, OBJECT_ID: '', OBJECT_NAME: '' });
    expect(r.lines[0]).toBe(`OBJECT ${good.NORAD_CAT_ID}`);
    expect(r.lines[1].slice(9, 17)).toBe('        ');
    expect(parseTLEs(r.lines.join('\n'))[0].launchYear).toBeNull();
  });
});
