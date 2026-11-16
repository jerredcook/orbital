// "What is this satellite?" — tools/about-data.mjs (gathering and merging) and
// src/about-format.js (what the app shows).  The text comes from Wikidata and
// GCAT, which anyone can edit or which are one person's estimates, so the
// tests care about two things: honest wording, and never trusting the input.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildAbout, checkAbout, creditFrom, creditsIn, imagesWanted, parseCsv, parseGcat, parseWikidata, vagueDate } from '../tools/about-data.mjs';
import { decodeAbout, factsText, purposeText, sentence, commonsImageUrl, commonsPageUrl, wikipediaUrl } from '../src/about-format.js';

// Real rows: GCAT's payload catalogue and a Wikidata query result, 15–16 Nov 2026.
const GCAT = readFileSync(new URL('./fixtures/gcat-psatcat-sample.tsv', import.meta.url), 'utf8');
const WIKIDATA = readFileSync(new URL('./fixtures/wikidata-sample.csv', import.meta.url), 'utf8');
const SAMPLE = readFileSync(new URL('../tools/data/about-sample.json', import.meta.url), 'utf8');
const gcat = parseGcat(GCAT), wikidata = parseWikidata(WIKIDATA);

describe('GCAT: what a satellite was for, and when it stopped', () => {
  it('reads purpose, note and end of operations by catalogue number', () => {
    expect(gcat.get(27386)).toEqual({ purpose: 'IMG-R', note: 'SAR, Altimeter, radiometer', ended: '8 Apr 2012', failed: false });
    expect(gcat.get(5)).toMatchObject({ purpose: 'TECH', ended: 'Mar 1964' });
    expect(gcat.get(25544)).toMatchObject({ purpose: 'SS', ended: null });       // still operating: no end date
    expect(gcat.get(13).failed).toBe(true);                                       // Discoverer 1
  });
  it('reads its vague dates, keeping the vagueness', () => {
    expect(vagueDate('2012 Apr  8')).toBe('8 Apr 2012');
    expect(vagueDate('2012 Apr')).toBe('Apr 2012');
    expect(vagueDate('1964')).toBe('1964');
    expect(vagueDate('2024 Jul 24?')).toBe('about 24 Jul 2024');
    for (const none of ['*', '-', '', undefined, 'soon', '2012 Foo 3']) expect(vagueDate(none)).toBeNull();
  });
  it('refuses a file that is not the catalogue', () => {
    expect(() => parseGcat('<html>404</html>')).toThrow(/not the GCAT payload catalogue/);
    expect(parseGcat(`${GCAT.split('\n')[0]}\nL1234\tx\n`).size).toBe(0);         // only S-numbers are US catalogue numbers
  });
});

describe('Wikidata: description, photo, article', () => {
  it('reads an entry by catalogue number, zero-padded or not', () => {
    expect(wikidata.get(20580)).toMatchObject({ label: 'Hubble Space Telescope', wiki: 'Hubble_Space_Telescope', image: 'Hubble 2009 close-up.jpg' });
    expect(wikidata.get(5).label).toBe('Vanguard 1');                              // "00005" in the source
    expect(wikidata.get(5).retired).toBe('1 May 1964');
  });
  it('when two entries share a number, the ISS wins over its first module', () => {
    expect(WIKIDATA.split('\n').filter((l) => l.startsWith('25544,')).length).toBeGreaterThan(1);
    expect(wikidata.get(25544).label).toBe('International Space Station');
  });
  it('skips entries with a placeholder instead of a number', () => {
    expect([...wikidata.keys()].every((n) => Number.isInteger(n) && n > 0)).toBe(true);
  });
  it('keeps photos, not diagrams or animations; drops descriptions that say nothing', () => {
    const csv = 'scn,label,desc,image,wiki,retired\n'
      + '1,A,satellite,http://commons.wikimedia.org/wiki/Special:FilePath/Logo.svg,,\n'
      + '2,B,Artificial satellite,http://commons.wikimedia.org/wiki/Special:FilePath/Spin.gif,,\n'
      + '3,C,weather satellite,http://commons.wikimedia.org/wiki/Special:FilePath/A%20real%20photo.JPG,https://en.wikipedia.org/wiki/C_(satellite),\n';
    const w = parseWikidata(csv);
    expect(w.get(1)).toMatchObject({ image: '', desc: '' });
    expect(w.get(2)).toMatchObject({ image: '', desc: '' });
    expect(w.get(3)).toMatchObject({ image: 'A real photo.JPG', desc: 'weather satellite', wiki: 'C_(satellite)' });
  });
  it('handles quoted fields with commas and line breaks', () => {
    expect(parseCsv('a,b\n"x, y","line\nbreak"\n')).toEqual([['a', 'b'], ['x, y', 'line\nbreak']]);
  });
  it('refuses a result that is not the query result', () => {
    expect(() => parseWikidata('error,message\n500,timeout\n')).toThrow(/not the Wikidata result/);
  });
});

describe('photo credits', () => {
  it('author and licence, with any markup removed', () => {
    expect(creditFrom({ Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:X" title="User:X">NASA</a>' }, LicenseShortName: { value: 'Public domain' } })).toBe('NASA · Public domain');
    expect(creditFrom({ Artist: { value: 'Jane &amp; Joe <script>alert(1)</script>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } })).toBe('Jane & Joe alert(1) · CC BY-SA 4.0');
    expect(creditFrom({ LicenseShortName: { value: 'CC0' } })).toBe('CC0');
    expect(creditFrom({})).toBe('');
    expect(creditFrom({ Artist: { value: 'x'.repeat(200) } }).length).toBeLessThanOrEqual(60);
  });
  it('a photo whose credit is unknown is left out, not shown uncredited', () => {
    const a = buildAbout({ gcat, wikidata, credits: new Map([['Hubble 2009 close-up.jpg', 'NASA · Public domain']]), norads: [20580, 27386] });
    const o = JSON.parse(a.json).objects;
    expect(decodeAbout(o[20580]).image).toBe('Hubble 2009 close-up.jpg');
    expect(decodeAbout(o[27386]).image).toBe('');                                  // Envisat's photo: no credit supplied
    expect(decodeAbout(o[27386]).wiki).toBe('Envisat');                            // …but the rest is still there
    expect(a.photos).toBe(1);
  });
  it('yesterday\'s credits are reused, so only new photos are looked up', () => {
    const known = creditsIn(SAMPLE);
    expect(known.get('Hubble 2009 close-up.jpg')).toBe('NASA · Public domain');
    const wanted = imagesWanted({ wikidata, norads: [20580, 27386, 5, 25544] });
    expect(wanted.filter((f) => !known.has(f))).toEqual([]);
  });
});

describe('the merged file', () => {
  const credits = creditsIn(SAMPLE);
  const a = buildAbout({ gcat, wikidata, credits, norads: [25544, 20580, 27386, 5, 44713, 99999] });
  const o = JSON.parse(a.json).objects;
  it('describes only the objects asked for that something is known about', () => {
    expect(Object.keys(o).sort()).toEqual(['20580', '25544', '27386', '44713', '5']);
    expect(a.count).toBe(5);
    expect(checkAbout(a.json)).toEqual([]);
  });
  it('is compact: an object with only a purpose is two short fields', () => {
    expect(o[44713]).toEqual([0, 'COM', 0, '28 Jun 2024']);
  });
  it('has the same stamp for the same content, and a new one when it changes', () => {
    expect(buildAbout({ gcat, wikidata, credits, norads: [25544, 20580, 27386, 5, 44713] }).stamp).toBe(a.stamp);
    expect(buildAbout({ gcat, wikidata, credits, norads: [25544] }).stamp).not.toBe(a.stamp);
  });
  it('the sample a laptop build ships is exactly this', () => {
    expect(JSON.parse(SAMPLE)).toEqual(JSON.parse(a.json));
  });
  it('refuses a malformed file', () => {
    expect(checkAbout('nope')).toEqual(['about.json is not JSON']);
    expect(checkAbout('{"v":2,"objects":{}}')).not.toEqual([]);
    expect(checkAbout('{"v":1,"objects":{"abc":["x"]}}')).not.toEqual([]);
    expect(checkAbout('{"v":1,"objects":{"5":[{"html":"<b>"}]}}')).not.toEqual([]);
    expect(checkAbout('{"v":1,"objects":{"5":[0,0,0,0,0,0,"photo.jpg"]}}')).not.toEqual([]);   // a photo with no credit
  });
});

describe('what the app says', () => {
  const o = JSON.parse(SAMPLE).objects;
  it('purpose codes in plain words', () => {
    expect(purposeText('IMG-R')).toBe('radar imaging');
    expect(purposeText('COM/MET-RO')).toBe('communications and weather sounding by radio occultation');
    expect(purposeText('SIG?')).toBe('signals intelligence');
    expect(purposeText('COM*')).toBe('communications');
    expect(purposeText('NOPE')).toBe('');
    expect(purposeText('')).toBe('');
  });
  it('a dead satellite: what it did and when it is believed to have stopped', () => {
    const envisat = decodeAbout(o[27386]);
    expect(sentence(envisat.desc)).toBe('Former Earth observation satellite of the European Space Agency');
    expect(factsText(envisat, 'DEAD')).toBe('Purpose: radar imaging — SAR, Altimeter, radiometer. Believed to have stopped working: 8 Apr 2012.');
  });
  it('never says a satellite shown as active has stopped working', () => {
    // GCAT gives Starlink-1007 an end date; if the active list still has it, the two disagree — say only the purpose.
    expect(factsText(decodeAbout(o[44713]), 'SAT')).toBe('Purpose: communications.');
    expect(factsText(decodeAbout(o[44713]), 'DEAD')).toBe('Purpose: communications. Believed to have stopped working: 28 Jun 2024.');
  });
  it('says so when a satellite failed early', () => {
    expect(factsText({ purpose: 'TECH', note: '', ended: '', failed: true }, 'DEAD')).toBe('Purpose: technology testing and training. Failed early in its mission.');
  });
  it('builds links only to Wikipedia and Wikimedia Commons, whatever the text', () => {
    expect(wikipediaUrl('Hubble_Space_Telescope')).toBe('https://en.wikipedia.org/wiki/Hubble_Space_Telescope');
    expect(commonsPageUrl('Hubble 2009 close-up.jpg')).toBe('https://commons.wikimedia.org/wiki/File:Hubble_2009_close-up.jpg');
    expect(commonsImageUrl('Hubble 2009 close-up.jpg', 640)).toBe('https://commons.wikimedia.org/wiki/Special:FilePath/Hubble_2009_close-up.jpg?width=640');
    for (const evil of ['javascript:alert(1)', '../../evil.example/x', '"><script>alert(1)</script>', 'x?redirect=https://evil.example', 'a#b/../c']) {
      for (const url of [wikipediaUrl(evil), commonsPageUrl(evil), commonsImageUrl(evil)]) {
        const u = new URL(url);
        expect(['en.wikipedia.org', 'commons.wikimedia.org']).toContain(u.hostname);
        expect(u.protocol).toBe('https:');
        expect(u.pathname.startsWith('/wiki/')).toBe(true);
        expect(url).not.toMatch(/[<>"]/);
      }
    }
  });
  it('reads nothing from something that is not a record', () => {
    for (const bad of [null, undefined, 'x', {}, []]) expect(decodeAbout(bad)).toBeNull();
    expect(decodeAbout([0, 0, 0, 0, 1])).toMatchObject({ desc: '', failed: true, image: '' });
    expect(decodeAbout([{ evil: 1 }, 5, true])).toMatchObject({ desc: '', purpose: '', note: '' });
  });
});
