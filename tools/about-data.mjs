// about-data.mjs — "what is this satellite?": photos, descriptions and
// end-of-life dates, gathered once a day and served with the site as
// data/about.json.
//
// Two sources, both free to reuse with credit:
//   Wikidata (CC0) — for satellites notable enough to have an entry: a one-line
//     description, a photo on Wikimedia Commons, and the English Wikipedia
//     article.  About 7,500 entries carry a catalogue number; ~1,900 a photo.
//   GCAT, Jonathan McDowell's General Catalog of Artificial Space Objects
//     (CC-BY — "data from GCAT (J. McDowell, planet4589.org/space/gcat)") — for
//     every payload ever launched: what it was for, and when it is believed to
//     have stopped working.
// Photos are other people's work under their own licences, so each carries its
// author and licence (from the Commons API) and links to its page there.
//
// This module is the pure part — parsing, merging, checking.  The requests are
// in tools/fetch-about.mjs.
//
// about.json: { v: 1, objects: { "<catalogue number>": [description, purpose,
//   note, ended, failed, wikipediaTitle, imageFile, imageCredit] } } — trailing
//   empty fields dropped, missing ones 0, only objects with something to say.

import { createHash } from 'node:crypto';

/** Minimal CSV parser honoring quoted fields and embedded newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * GCAT's "vague date" ("2012 Apr  8", "2012 Apr", "1964", "2024 Jul 24?") as
 * display text ("8 Apr 2012", "Apr 2012", "1964", "about 24 Jul 2024"), or
 * null when there is none ("*", "-", "").
 */
export function vagueDate(s) {
  const m = /^(\d{4})(?:\s+([A-Z][a-z]{2})(?:\s+(\d{1,2}))?)?[^?]*(\?)?\s*$/.exec(String(s ?? '').trim());
  if (!m || (m[2] && !MONTHS.includes(m[2]))) return null;
  const text = [m[3] ? String(Number(m[3])) : '', m[2] ?? '', m[1]].filter(Boolean).join(' ');
  return m[4] ? `about ${text}` : text;
}

/** GCAT psatcat.tsv → Map(catalogue number → { purpose, note, ended, failed }). */
export function parseGcat(tsv) {
  const lines = String(tsv ?? '').split(/\r?\n/);
  const head = (lines[0] ?? '').replace(/^#/, '').split('\t').map((h) => h.trim());
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  for (const need of ['JCAT', 'TOp', 'TDate', 'Category', 'Result']) if (!(need in col)) throw new Error(`not the GCAT payload catalogue — no ${need} column`);
  const out = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i] || lines[i].startsWith('#')) continue;
    const f = lines[i].split('\t');
    const id = /^S(\d{1,9})$/.exec((f[col.JCAT] ?? '').trim());   // S-numbers are US catalogue numbers; other prefixes are GCAT's own
    if (!id) continue;
    const clean = (v) => { const t = (v ?? '').trim(); return t === '-' || t === '*' ? '' : t; };
    out.set(Number(id[1]), {
      purpose: clean(f[col.Category]).replace(/[?*]/g, ''),
      note: clean(f[col.Comment]),
      ended: vagueDate(f[col.TOp]) ?? vagueDate(f[col.TDate]),   // regular operations ended, else "dead, dead, dead"
      failed: clean(f[col.Result]) === 'F',
    });
  }
  return out;
}

const PHOTO = /\.(jpe?g|png|webp)$/i;   // not .svg / .gif — those are diagrams, logos and animations
/** Wikidata query result (CSV) → Map(catalogue number → { label, desc, wiki, image, retired }). */
export function parseWikidata(csv, { prefer = PREFERRED } = {}) {
  const rows = parseCsv(String(csv ?? ''));
  const head = rows[0] ?? [];
  const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
  for (const need of ['scn', 'label', 'desc', 'image', 'wiki']) if (!(need in col)) throw new Error(`not the Wikidata result — no ${need} column`);
  const out = new Map();
  const score = (r) => (r.wiki ? 4 : 0) + (r.image ? 2 : 0) + (r.desc ? 1 : 0);
  for (let i = 1; i < rows.length; i++) {
    const f = rows[i];
    const scn = (f[col.scn] ?? '').trim();
    if (!/^\d{1,9}$/.test(scn)) continue;                         // (a few entries have a placeholder instead of a number)
    const norad = Number(scn);
    const file = decodeFile(f[col.image]);
    const wiki = /^https:\/\/en\.wikipedia\.org\/wiki\/(.+)$/.exec((f[col.wiki] ?? '').trim());
    const rec = {
      label: (f[col.label] ?? '').trim(),
      desc: tidyDesc(f[col.desc]),
      wiki: wiki ? safeDecode(wiki[1]) : '',
      image: file && PHOTO.test(file) ? file : '',
      retired: /^\d{4}-\d{2}-\d{2}/.test(f[col.retired] ?? '') ? isoDay(f[col.retired]) : null,
    };
    const have = out.get(norad);
    // Some numbers have two entries (the ISS and its first module share 25544):
    // a named preference wins, else the fuller entry.
    const wins = !have || (prefer[norad] ? rec.label === prefer[norad] : (have.label !== prefer[norad] && score(rec) > score(have)));
    if (wins && !(have && prefer[norad] && have.label === prefer[norad])) out.set(norad, rec);
  }
  return out;
}
const PREFERRED = { 25544: 'International Space Station' };
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
function decodeFile(url) {
  const m = /Special:FilePath\/(.+)$/.exec(String(url ?? '').trim());
  return m ? safeDecode(m[1]).replace(/_/g, ' ') : '';
}
const isoDay = (iso) => { const [y, mo, d] = iso.slice(0, 10).split('-').map(Number); return `${d} ${MONTHS[mo - 1]} ${y}`; };
// A description is shown as a sentence about the object; drop the ones that say nothing.
const EMPTY_DESC = new Set(['', 'satellite', 'artificial satellite', 'spacecraft']);
function tidyDesc(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return EMPTY_DESC.has(t.toLowerCase()) || t.length > 240 ? '' : t;
}

/** "NASA · Public domain" from a Commons extmetadata block, or '' if it gives neither. */
export function creditFrom(ext) {
  const strip = (v) => String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  let artist = strip(ext?.Artist?.value);
  if (artist.length > 60) artist = `${artist.slice(0, 57).trimEnd()}…`;
  const licence = strip(ext?.LicenseShortName?.value);
  return [artist, licence].filter(Boolean).join(' · ');
}

/**
 * Merge the sources into about.json for the objects in `norads`.
 *   credits: Map(image file → credit text); a photo with no credit is left out
 *            (its licence is unknown), not shown uncredited.
 */
export function buildAbout({ gcat = new Map(), wikidata = new Map(), credits = new Map(), norads }) {
  const objects = {};
  let photos = 0;
  for (const n of norads) {
    const g = gcat.get(n), w = wikidata.get(n);
    if (!g && !w) continue;
    const image = w?.image && credits.get(w.image) ? w.image : '';
    const rec = [w?.desc || 0, g?.purpose || 0, g?.note || 0, g?.ended || w?.retired || 0, g?.failed ? 1 : 0, w?.wiki || 0, image || 0, image ? credits.get(image) : 0];
    while (rec.length && !rec[rec.length - 1]) rec.pop();
    if (!rec.length) continue;
    if (image) photos++;
    objects[n] = rec;
  }
  const json = JSON.stringify({ v: 1, objects });
  return { json, count: Object.keys(objects).length, photos, stamp: createHash('sha256').update(json).digest('hex').slice(0, 16) };
}

/** The image files a merged set would show, so their credits can be looked up. */
export function imagesWanted({ wikidata, norads }) {
  const files = new Set();
  for (const n of norads) { const f = wikidata.get(n)?.image; if (f) files.add(f); }
  return [...files];
}
/** Credits already known from a previous about.json: Map(image file → credit). */
export function creditsIn(json) {
  const out = new Map();
  try { for (const r of Object.values(JSON.parse(json).objects ?? {})) if (r[6] && r[7]) out.set(r[6], r[7]); } catch { /* none */ }
  return out;
}

/** Is this an about.json we are willing to publish?  Returns problems (empty = fine). */
export function checkAbout(json) {
  let d;
  try { d = JSON.parse(json); } catch { return ['about.json is not JSON']; }
  if (d?.v !== 1 || !d.objects || typeof d.objects !== 'object') return ['about.json is not in the expected shape'];
  const problems = [];
  let bad = 0;
  for (const [k, r] of Object.entries(d.objects)) {
    if (!/^\d+$/.test(k) || !Array.isArray(r) || r.length < 1 || r.length > 8 || r.some((v) => v !== 0 && v !== 1 && typeof v !== 'string')) bad++;
    else if (r[6] && !r[7]) bad++;                              // a photo with no credit
  }
  if (bad) problems.push(`${bad} entries are malformed`);
  return problems;
}

// (Reading a record back is the app's job: src/about-format.js.)
export { decodeAbout } from '../src/about-format.js';
