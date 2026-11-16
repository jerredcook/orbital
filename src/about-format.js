// about-format.js — reading one record of data/about.json, and the plain words
// for what it holds.  Pure (no browser, no network): the app, the unit tests
// and the build tool (tools/about-data.mjs) all use the same code.
//
// A record is [description, purpose, note, ended, failed, wikipediaTitle,
// imageFile, imageCredit] with trailing empty fields dropped and missing ones 0.

/** One record → { desc, purpose, note, ended, failed, wiki, image, credit }, or null. */
export function decodeAbout(rec) {
  if (!Array.isArray(rec) || !rec.length) return null;
  const s = (i) => (typeof rec[i] === 'string' ? rec[i] : '');
  return { desc: s(0), purpose: s(1), note: s(2), ended: s(3), failed: rec[4] === 1, wiki: s(5), image: s(6), credit: s(7) };
}

// GCAT's purpose categories (planet4589.org/space/gcat/web/cat/pcols.html), in plain words.
const PURPOSE = {
  AST: 'astronomy', BIO: 'biology and life sciences', CAL: 'calibration target', COM: 'communications',
  EDU: 'education', EOSCI: 'Earth science', EW: 'missile early warning', GEOD: 'geodesy',
  IMG: 'optical imaging', 'IMG-R': 'radar imaging', INF: 'support hardware (deployers and structures)',
  MET: 'weather imaging', 'MET-RO': 'weather sounding by radio occultation', MGRAV: 'microgravity experiments',
  MISC: 'miscellaneous', NAV: 'navigation and timing', PLAN: 'deep-space mission', RB: 'rocket stage',
  RV: 're-entry vehicle', SCI: 'science', SIG: 'signals intelligence', SS: 'human spaceflight',
  TARG: 'target for missile-defence or anti-satellite tests', TECH: 'technology testing and training', WEAPON: 'weapon',
};
/** "IMG-R" → "radar imaging"; "COM/MET-RO" → "communications and weather sounding…"; unknown codes are left out. */
export function purposeText(code) {
  const parts = String(code ?? '').split('/').map((c) => PURPOSE[c.replace(/[?*]/g, '').trim()]).filter(Boolean);
  return [...new Set(parts)].join(' and ');
}

const enc = (s) => encodeURIComponent(String(s).replace(/ /g, '_'));
/** A Wikimedia Commons image, scaled to `width` pixels by Commons itself. */
export const commonsImageUrl = (file, width = 640) => `https://commons.wikimedia.org/wiki/Special:FilePath/${enc(file)}?width=${width}`;
/** The image's own page on Commons: author, licence, full size. */
export const commonsPageUrl = (file) => `https://commons.wikimedia.org/wiki/File:${enc(file)}`;
export const wikipediaUrl = (title) => `https://en.wikipedia.org/wiki/${enc(title)}`;

/** First letter capitalised, no trailing full stop — Wikidata descriptions are lower-case fragments. */
export const sentence = (s) => { const t = String(s ?? '').trim().replace(/\.$/, ''); return t ? t[0].toUpperCase() + t.slice(1) : ''; };

/**
 * The facts line for an object.  `kind` is the app's (SAT / DEAD / RB / DEB):
 * an end date is only stated for a satellite the active list says is no longer
 * working — the two sources do not always agree, and "stopped working" beside
 * a satellite shown as active would be a contradiction on screen.
 */
export function factsText(a, kind) {
  const out = [];
  const purpose = purposeText(a.purpose);
  if (purpose) out.push(`Purpose: ${purpose}${a.note ? ` — ${a.note.replace(/\.$/, '')}` : ''}.`);
  else if (a.note) out.push(`${sentence(a.note)}.`);
  if (a.failed) out.push('Failed early in its mission.');
  if (kind === 'DEAD' && a.ended) out.push(`Believed to have stopped working: ${a.ended}.`);
  return out.join(' ');
}
