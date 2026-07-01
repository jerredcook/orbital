// soften-map-gaps.mjs — soften the unimaged-region fills in the Charon and
// Ceres maps (run once after fetch-dwarf-textures.mjs).
//
//   node tools/soften-map-gaps.mjs
//
// New Horizons never saw Charon's southern hemisphere (flat dark-grey fill in
// the Albers map — and Pluto's tipped system means the app often views it
// pole-on), and this Ceres map has black polar bands.  Both read as rendering
// bugs on a sphere.  This fills each gap pixel by blending the valid boundary
// colours above/below it in its column, then blurs the filled region
// horizontally — extending real boundary tones, inventing no terrain (the same
// treatment the Pluto map ships with).  Overwrites the JPGs in place; re-run
// after any re-fetch.  Uses headless Chrome (system channel) for the canvas.

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/Users/jerredcook/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.js')); }

const TEXROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'textures');
// [file, gap sample point (fractions of w/h), colour tolerance]
const JOBS = [
  [join(TEXROOT, 'moons', 'charon.jpg'), [0.5, 0.97], 10],
  [join(TEXROOT, 'planets', 'ceres.jpg'), [0.5, 0.995], 26],
];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();

for (const [file, [sx, sy], tol] of JOBS) {
  const b64 = (await readFile(file)).toString('base64');
  const out = await page.evaluate(async ({ b64, sx, sy, tol }) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/jpeg;base64,${b64}`; });
    const w = img.width, h = img.height;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const im = cx.getImageData(0, 0, w, h), d = im.data;
    const at = (x, y) => (y * w + x) * 4;
    // The fill colour, sampled where the map is known to be unimaged.
    const s = at(Math.floor(w * sx), Math.floor(h * sy));
    const fr = d[s], fg = d[s + 1], fb = d[s + 2];
    const isGap = (i) => Math.abs(d[i] - fr) <= tol && Math.abs(d[i + 1] - fg) <= tol && Math.abs(d[i + 2] - fb) <= tol;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isGap(at(x, y))) mask[y * w + x] = 1;
    // Column-wise: blend each gap run between the valid colours at its ends.
    for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h) {
        if (!mask[y * w + x]) { y++; continue; }
        let y1 = y; while (y1 < h && mask[y1 * w + x]) y1++;
        const above = y > 0 ? at(x, y - 1) : (y1 < h ? at(x, y1) : -1);
        const below = y1 < h ? at(x, y1) : above;
        for (let yy = y; yy < y1; yy++) {
          const t = (y1 === y) ? 0 : (yy - y) / (y1 - y);
          const i = at(x, yy);
          d[i] = d[above] * (1 - t) + d[below] * t;
          d[i + 1] = d[above + 1] * (1 - t) + d[below + 1] * t;
          d[i + 2] = d[above + 2] * (1 - t) + d[below + 2] * t;
        }
        y = y1;
      }
    }
    // Horizontal box blur over the gap pixels only (2 passes) to kill streaks.
    const R = 24;
    for (let pass = 0; pass < 2; pass++) {
      const src = Float32Array.from(d);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -R; k <= R; k++) {
          const xx = (x + k + w) % w;   // wrap: it's a cylindrical map
          const i = at(xx, y);
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
        const i = at(x, y);
        d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n;
      }
    }
    // Converge the extreme polar rows to their row-mean.  On a sphere the whole
    // top/bottom row collapses to one point, so any variation there renders as
    // radial streaks or a blotch at the pole; a smooth fade to uniform is the
    // standard equirectangular pole treatment.
    const K = Math.floor(h * 0.07);
    for (const [row0, dir] of [[0, 1], [h - 1, -1]]) {
      for (let k = 0; k < K; k++) {
        const y = row0 + dir * k;
        let r = 0, g = 0, b = 0;
        for (let x = 0; x < w; x++) { const i = at(x, y); r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        r /= w; g /= w; b /= w;
        const t = Math.pow(1 - k / K, 1.5);   // 1 at the pole row → 0 at K rows in
        for (let x = 0; x < w; x++) {
          const i = at(x, y);
          d[i] += (r - d[i]) * t; d[i + 1] += (g - d[i + 1]) * t; d[i + 2] += (b - d[i + 2]) * t;
        }
      }
    }
    cx.putImageData(im, 0, 0);
    return { url: cv.toDataURL('image/jpeg', 0.85), filled: mask.reduce((a, v) => a + v, 0), w, h };
  }, { b64, sx, sy, tol });
  await writeFile(file, Buffer.from(out.url.split(',')[1], 'base64'));
  console.log(`${file.split('/').pop()}: filled ${(100 * out.filled / (out.w * out.h)).toFixed(1)}% of pixels`);
}

await browser.close();
console.log('done');
