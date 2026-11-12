// The small pure helpers: HTML escaping (the XSS guard), share-link parsing
// and writing, and the SATCAT owner / launch-site decoders.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { esc } from '../src/esc.js';
import { decodeOwner, decodeSite, OWNERS, LAUNCH_SITES } from '../src/decode.js';
import { readHash, writeHash } from '../src/deeplink.js';

describe('esc', () => {
  it('neutralises markup in an external name', () => {
    expect(esc('<img src=x onerror="pwn()">')).toBe('&lt;img src=x onerror=&quot;pwn()&quot;&gt;');
    expect(esc(`O'NEILL & CO`)).toBe('O&#39;NEILL &amp; CO');
  });
  it('turns null, undefined and numbers into safe strings', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(25544)).toBe('25544');
  });
});

describe('decodeOwner / decodeSite', () => {
  it('expands known codes', () => {
    const [owner] = Object.keys(OWNERS), [site] = Object.keys(LAUNCH_SITES);
    expect(decodeOwner(owner)).toBe(OWNERS[owner]);
    expect(decodeSite(site)).toBe(LAUNCH_SITES[site]);
  });
  it('passes an unknown code through and labels a missing one', () => {
    expect(decodeOwner('ZZZZ')).toBe('ZZZZ');
    expect(decodeSite('')).toBe('Unknown');
    expect(decodeOwner(undefined)).toBe('Unknown');
  });
});

describe('deeplink', () => {
  let loc, replaced;
  beforeEach(() => {
    loc = { hash: '', pathname: '/orbital/', search: '' };
    replaced = [];
    vi.stubGlobal('location', loc);
    vi.stubGlobal('history', { replaceState: (_s, _t, url) => { replaced.push(url); loc.hash = url.startsWith('#') ? url : ''; } });
  });
  afterEach(() => vi.unstubAllGlobals());
  const read = (hash) => { loc.hash = hash; return readHash(); };

  it('reads every kind of shared link', () => {
    expect(read('')).toBeNull();
    expect(read('#sat=25544')).toEqual({ sat: '25544' });
    expect(read('#body=Jupiter')).toEqual({ body: 'Jupiter' });
    expect(read('#moon=Europa')).toEqual({ moon: 'Europa' });
    expect(read('#probe=Juno')).toEqual({ probe: 'Juno' });
    expect(read('#group=starlink')).toEqual({ group: 'starlink' });
    expect(read('#luna')).toEqual({ luna: true });
    expect(read('#system')).toEqual({ system: true });
    expect(read('#guide')).toEqual({ guide: true });
    expect(read('#tour')).toEqual({ tour: true });
    expect(read('#missions')).toEqual({ missions: true });
    expect(read('#catalog')).toEqual({ catalog: true });
    expect(read('#jwst')).toEqual({ show: 'jwst' });
  });

  it('decodes escaped names and ignores junk instead of throwing', () => {
    expect(read('#body=Pluto%20%26%20Charon')).toEqual({ body: 'Pluto & Charon' });
    expect(read('#body=%E0%A4%A')).toBeNull();     // malformed %-encoding
    expect(read('#sat=')).toBeNull();
    expect(read('#nonsense=1')).toBeNull();
  });

  it('writes a view and reads the same view back', () => {
    for (const state of [{ sat: 25544 }, { body: 'Saturn' }, { moon: 'Titan' }, { probe: 'Juno' }, { luna: true }, { system: true }, { show: 'jwst' }, { group: 'gps' }]) {
      writeHash(state);
      const back = readHash();
      const [k, v] = Object.entries(state)[0];
      expect(back).toEqual({ [k]: typeof v === 'number' ? String(v) : v });
    }
  });

  it('clears the hash for the plain Earth view, and skips a no-op write', () => {
    writeHash({ sat: 25544 });
    writeHash(null);
    expect(replaced.at(-1)).toBe('/orbital/');
    const n = replaced.length;
    writeHash(null);
    expect(replaced.length).toBe(n);
  });
});
