// horizons.mjs — shared helpers for the fetch-*-elements tools.  Every one of
// them was re-implementing the same Horizons query, the same $$SOE parse, the
// same field regex, rounding and module-writer; this is that, once.

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AU_M = 1.495978707e11;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round = (n, d) => Number(n.toFixed(d));

// Read a "KEY= value" field from a Horizons element block.  The leading
// word-boundary keeps `A` from matching the A inside `MA`, `PR`, etc.
export const num = (block, key) => {
  const m = block.match(new RegExp(`(?:^|\\s)${key}\\s*=\\s*(-?[\\d.]+E?[+-]?\\d*)`, 'm'));
  return m ? parseFloat(m[1]) : null;
};

// Full text of a Horizons ELEMENTS request (heliocentric by default; pass a
// planet body id as `center` for planet-centred elements).
export async function horizonsElements(command, { center = '10', epoch, refPlane = 'ECLIPTIC' }) {
  const p = new URLSearchParams({
    format: 'text', COMMAND: `'${command}'`, OBJ_DATA: 'NO', MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'ELEMENTS', CENTER: `'500@${center}'`,
    REF_PLANE: refPlane, REF_SYSTEM: 'J2000', TLIST: `'${epoch}'`, OUT_UNITS: 'KM-S',
  });
  return (await (await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${p}`)).text());
}

// The osculating-element block between $$SOE/$$EOE, or null (e.g. a small-body
// disambiguation list came back instead).
export const soeBlock = (txt) => txt.match(/\$\$SOE([\s\S]*?)\$\$EOE/)?.[1] ?? null;

// Standard element set from a block.  a in metres; angles in degrees; periodDays
// from PR; n (mean motion, deg/day) from N (Horizons gives deg/s under KM-S).
export function parseElements(block) {
  const a = num(block, 'A'), e = num(block, 'EC');
  if (a == null || e == null) return null;
  const pr = num(block, 'PR'), n = num(block, 'N');
  return {
    a: a * 1000, e, i: num(block, 'IN'), node: num(block, 'OM'), peri: num(block, 'W'),
    M0: num(block, 'MA'),
    periodDays: pr != null ? pr / 86400 : null,
    n: n != null ? n * 86400 : null,
    epochJd: parseFloat(block.trim().split(/\s+/)[0]),
  };
}

// From a small-body disambiguation list, the record id with the latest epoch-year
// (periodic comets return one record per apparition).
export function pickLatestRecord(txt) {
  const rows = [...txt.matchAll(/^\s*(9\d{7})\s+(-?\d+)\s+/gm)].map((m) => ({ rec: m[1], yr: parseInt(m[2], 10) }));
  if (!rows.length) return null;
  rows.sort((a, b) => b.yr - a.yr);
  return rows[0].rec;
}

export const srcPath = (importMetaUrl, file) => join(dirname(fileURLToPath(importMetaUrl)), '..', 'src', file);

// Write a generated `export const NAME = { … }` module.  `fmt(entry)` renders one
// value literal; `epoch` (optional) adds an `export const <epochConst> = <jd>;`.
export async function writeElementsModule({ dest, header, constName, entries, fmt, epochConst, epochJd }) {
  const body = Object.entries(entries).map(([k, v]) => `  ${JSON.stringify(k)}: ${fmt(v)}`).join(',\n');
  const epochLine = epochConst ? `\nexport const ${epochConst} = ${epochJd};\n` : '';
  await writeFile(dest, `${header}\n${epochLine}\nexport const ${constName} = {\n${body},\n};\n`);
  return Object.keys(entries).length;
}
