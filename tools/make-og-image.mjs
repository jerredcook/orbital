// make-og-image.mjs — render the link-preview card (public/og.jpg, 1200×630)
// that Reddit / Discord / Slack / iMessage show when someone shares the site.
//
//   npm run dev -- --port 5199      (in another terminal)
//   PORT=5199 node tools/make-og-image.mjs
//
// It loads the live app headlessly, hides the UI, slides the globe to the
// right, lays the wordmark + pitch over the left, and screenshots at 2× so the
// satellite dots stay crisp once downsampled.  macOS only (uses `sips` for the
// JPEG conversion); re-run whenever the look of the globe changes materially.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.PORT || '5173';
const OUT = new URL('../public/og.jpg', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
await p.addInitScript(() => { try { localStorage.setItem('orbital.welcomed', '1'); } catch { /* ignore */ } });
await p.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

// Wait for the catalog (the legend's LEO count fills in), then read the total.
await p.waitForFunction(() => /\d/.test(document.getElementById('count-LEO')?.textContent || ''), null, { timeout: 90_000 });
const total = await p.evaluate(() => ['LEO', 'MEO', 'GEO', 'HEO', 'DEB']
  .reduce((n, c) => n + Number((document.getElementById(`count-${c}`)?.textContent || '0').replace(/\D/g, '')), 0));
const rounded = `${Math.floor(total / 1000).toLocaleString('en-US')},000+`;

await p.addStyleTag({ content: `
  body > *:not(#cesiumContainer):not(#og-card) { display: none !important; }
  .cesium-viewer-bottom { display: none !important; }
  /* A stage larger than the card, shifted right: the globe lands big and off-centre. */
  #cesiumContainer { position: fixed !important; left: 270px !important; top: -150px !important;
    width: 1300px !important; height: 930px !important; }
  #og-card { position: fixed; inset: 0; z-index: 99999; pointer-events: none;
    background: linear-gradient(90deg, rgba(5,7,12,0.96) 0%, rgba(5,7,12,0.88) 34%, rgba(5,7,12,0) 62%);
    font-family: -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #E8EFF8; }
  #og-card .mark { position: absolute; left: 72px; top: 150px; font: 600 30px ui-monospace, Menlo, monospace;
    letter-spacing: 0.42em; color: #7FD4F5; }
  #og-card .pitch { position: absolute; left: 72px; top: 214px; width: 520px; font-size: 62px; font-weight: 700;
    line-height: 1.06; letter-spacing: -0.02em; }
  #og-card .sub { position: absolute; left: 72px; top: 428px; width: 480px; font-size: 25px; line-height: 1.4; color: #A9B8CB; }
  #og-card .credit { position: absolute; right: 18px; bottom: 12px; font-size: 13px; color: rgba(232,239,248,0.55); }
` });
await p.evaluate((n) => {
  const d = document.createElement('div');
  d.id = 'og-card';
  d.innerHTML = `<div class="mark">ORBITAL</div>
    <div class="pitch">Every satellite orbiting Earth, live.</div>
    <div class="sub">${n} tracked objects in 3D — plus the whole solar system to fly through.</div>
    <div class="credit">Imagery: Esri · Orbits: CelesTrak</div>`;
  document.body.appendChild(d);
}, rounded);

await sleep(12_000);   // let Cesium resize to the new stage and the imagery tiles sharpen
const png = join(mkdtempSync(join(tmpdir(), 'orbital-og-')), 'og.png');
await p.screenshot({ path: png });
await b.close();

execFileSync('sips', ['-z', '630', '1200', '-s', 'format', 'jpeg', '-s', 'formatOptions', '86', png, '--out', OUT], { stdio: 'ignore' });
console.log(`${OUT}  ${total} objects  ${(statSync(OUT).size / 1024).toFixed(0)} KB`);
