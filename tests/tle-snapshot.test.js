// tools/tle-snapshot.mjs — the gate on the bundled satellite snapshot — and the
// app-side rule that debris and rocket bodies are never filed as satellites.
import { describe, it, expect } from 'vitest';
import { validateSnapshot, JUNK_NAME, epochMs } from '../tools/tle-snapshot.mjs';
import { isJunkName } from '../src/data.js';
import { readFileSync } from 'node:fs';

const NOW = Date.UTC(2026, 10, 13);
// A well-formed element set for catalog number n, dated day-of-year `doy` of 2026.
const set = (n, name = `SAT-${n}`, doy = 316.5) => {
  const id = String(n).padStart(5, '0');
  return [name,
    `1 ${id}U 20001A   26${doy.toFixed(8).padStart(12, '0')}  .00001000  00000-0  10000-4 0  9990`,
    `2 ${id}  53.0000 100.0000 0001000  90.0000 270.0000 15.05000000100000`].join('\n');
};
const many = (count, name) => Array.from({ length: count }, (_, i) => set(10000 + i, name?.(i))).join('\n') + '\n';
const check = (text, opts) => validateSnapshot(text, { now: NOW, ...opts });

describe('validateSnapshot', () => {
  it('accepts a current, well-formed active list', () => {
    const r = check(many(9000));
    expect(r.problems).toEqual([]);
    expect(r.count).toBe(9000);
  });
  it('rejects what an outage returns: an error page, an empty body, a partial file', () => {
    expect(check('<html><body>403 Forbidden</body></html>').problems).not.toEqual([]);
    expect(check('').problems).not.toEqual([]);
    expect(check(many(300)).problems.join()).toMatch(/expected 8,000/);
    expect(check(many(9000) + 'ORPHAN NAME\n').problems.join()).toMatch(/multiple of three/);
  });
  it('rejects a catalog that is not the active list — debris and rocket bodies', () => {
    const mixed = many(9000, (i) => (i % 5 === 0 ? 'FENGYUN 1C DEB' : i % 7 === 0 ? 'SL-6 R/B(2)' : undefined));
    expect(check(mixed).problems.join()).toMatch(/not the active-satellite list/);
  });
  it('rejects stale element sets, unless only the shape is being checked', () => {
    const old = Array.from({ length: 9000 }, (_, i) => set(10000 + i, undefined, 160)).join('\n') + '\n';
    expect(check(old).problems.join()).toMatch(/not current/);
    expect(check(old, { fresh: false }).problems).toEqual([]);
  });
  it('rejects malformed element sets', () => {
    const broken = many(9000).replace(/^2 10007/m, '2 99999');   // line 2 belongs to another object
    expect(check(broken).problems.join()).toMatch(/malformed/);
  });
  it('accepts the snapshot committed in the repo (shape only — it ages)', () => {
    const committed = readFileSync(new URL('../public/fallback/active.tle', import.meta.url), 'utf8');
    expect(validateSnapshot(committed, { fresh: false }).problems).toEqual([]);
  });
  it('reads the element-set date', () => {
    expect(new Date(epochMs(set(1).split('\n')[1])).toISOString().slice(0, 10)).toBe('2026-11-12');
  });
});

describe('junk names', () => {
  it('recognises fragments and spent stages, and nothing else', () => {
    for (const n of ['FENGYUN 1C DEB', 'COSMOS 2251 DEB', 'IRIDIUM 33 DEB', 'SL-6 R/B(2)', 'IUS R/B(2)', 'CZ-4B R/B']) {
      expect(isJunkName(n), n).toBe(true);
      expect(JUNK_NAME.test(n), n).toBe(true);
    }
    for (const n of ['ISS (ZARYA)', 'STARLINK-1234', 'DEBUT', 'TDRS 5', 'CALSPHERE 1', 'ORBCOMM FM 16', 'RB-1']) {
      expect(isJunkName(n), n).toBe(false);
    }
  });
});
