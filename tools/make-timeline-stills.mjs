// make-timeline-stills.mjs — still images of the launch timeline, for places
// that take pictures but not video.  Produces one composed image (four globes,
// each showing today's active satellites that had been launched by a given
// year) plus the four panels as separate files.
//
//   npm run build && node scripts/serve-dist.mjs 4173      (in another terminal)
//   node tools/make-timeline-stills.mjs <output-folder> [years]
//   e.g. node tools/make-timeline-stills.mjs ~/Desktop/orbital-stills 2000,2010,2018,2026
//
// It never contacts CelesTrak: the satellites come from the snapshot bundled
// with the app (public/fallback/active.tle — refresh it with
// tools/fetch-fallback-tle.mjs), and the image is dated with that snapshot's
// own date, so it cannot claim to be fresher than it is.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stubCelestrak } from '../scripts/celestrak-stub.mjs';
import { readFileSync } from 'node:fs';
import { validateSnapshot } from './tle-snapshot.mjs';

// The image says "active satellites", so refuse to make it from anything else.
const snap = validateSnapshot(readFileSync(new URL('../public/fallback/active.tle', import.meta.url), 'utf8'), { fresh: false });
if (snap.problems.length && !process.env.ALLOW_BAD_SNAPSHOT) {
  console.error('not making images — the bundled snapshot is not a valid active-satellite list:');
  for (const q of snap.problems) console.error(`  • ${q}`);
  process.exit(1);
}

const SITE = process.env.SMOKE_URL || `http://localhost:${process.env.PORT || '4173'}/orbital/`;
const OUT = resolve(process.argv[2] || 'timeline-stills');
const YEARS = (process.argv[3] || '2000,2010,2018,2026').split(',').map(Number);
const PANEL = 900;   // CSS px, rendered at 2×
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: PANEL, height: PANEL }, deviceScaleFactor: 2 });
await stubCelestrak(p);
await p.goto(`${SITE}?clip`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__orbital?.clip?.state === 'armed', null, { timeout: 90000 });

// A plain stage: no overlay text (the composition adds its own), an evenly lit
// and slightly dimmed Earth so every panel is identical except for the dots.
await p.addStyleTag({ content: '#clip-hud, #tl-era, .cesium-viewer-bottom, #recover-card, #toasts { display: none !important; }' });
const info = await p.evaluate(() => {
  const { viewer, catalog } = window.__orbital;
  viewer.scene.globe.enableLighting = false;
  const layer = viewer.imageryLayers.get(0);
  layer.brightness = 0.55; layer.saturation = 0.8;
  viewer.camera.flyHome(0);
  // Median element-set epoch = the date this picture of the sky is from.
  const epochs = catalog.filter((s) => s.kind !== 'DEB').map((s) => {
    const yy = parseInt(s.l1.slice(18, 20), 10), day = parseFloat(s.l1.slice(20, 32));
    return Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) + (day - 1) * 86_400_000;
  }).filter(Number.isFinite).sort((a, c) => a - c);
  return { epoch: epochs[epochs.length >> 1], thisYear: new Date().getUTCFullYear() };
});
const dataDate = new Date(info.epoch);
const dateLabel = dataDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const settle = () => p.waitForFunction(() => window.__orbital.viewer.scene.globe.tilesLoaded, null, { timeout: 60000 }).catch(() => {});
await settle(); await sleep(2500);

const panels = [];
for (const y of YEARS) {
  const shown = await p.evaluate((year) => window.__orbital.clip.showYear(year), y);
  await sleep(1500); await settle(); await sleep(800);
  const png = await p.screenshot({ type: 'png' });
  const file = join(OUT, `panel-${y}.png`);
  panels.push({ ...shown, png, file });
}
await p.close();

// ---- compose ----
const fmt = (n) => n.toLocaleString('en-US');
const last = panels[panels.length - 1];
const shortDate = dataDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
// The year the data is from is still in progress: say how far it runs.
const countLine = (q) => (q.year >= dataDate.getUTCFullYear()
  ? `${fmt(q.count)} <span>launched · up to ${shortDate}</span>`
  : `${fmt(q.count)} <span>of ${fmt(last.count)} launched</span>`);
const LEGEND = [['#5EC8E5', 'low Earth orbit'], ['#C9A0FF', 'medium Earth orbit'], ['#FFD166', 'geostationary'], ['#FF8C66', 'highly elliptical']];
const legend = `<div class="legend">${LEGEND.map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('')}</div>`;
const css = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #05070C; color: #E8EFF8; font-family: -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif; }
  .sheet { width: 1200px; padding: 44px 44px 30px; }
  h1 { margin: 0; font-size: 40px; line-height: 1.12; letter-spacing: -0.02em; font-weight: 700; }
  .sub { margin: 12px 0 14px; font-size: 19px; line-height: 1.45; color: #A9B8CB; max-width: 1020px; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 0 0 22px; font-size: 16px; color: #C9D4E3; }
  .legend i { display: inline-block; width: 11px; height: 11px; border-radius: 50%; margin-right: 8px; }
  .cell::after, .single::after { content: ''; position: absolute; left: 0; bottom: 0; width: 78%; height: 38%; pointer-events: none;
    background: radial-gradient(ellipse at 0% 100%, rgba(5,7,12,0.92) 0%, rgba(5,7,12,0.7) 38%, rgba(5,7,12,0) 72%); }
  .tag { z-index: 1; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .cell { position: relative; border-radius: 14px; overflow: hidden; background: #000; aspect-ratio: 1 / 0.86; }
  .cell img { position: absolute; left: 0; top: 50%; width: 100%; transform: translateY(-50%); display: block; }
  .tag { position: absolute; left: 22px; bottom: 16px; text-shadow: 0 2px 14px #05070C, 0 0 4px #05070C; }
  .year { font-size: 64px; font-weight: 700; line-height: 0.95; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .year small { font-size: 20px; font-weight: 600; letter-spacing: 0; color: #A9B8CB; margin-left: 6px; }
  .n { margin-top: 6px; font: 600 21px ui-monospace, 'SF Mono', Menlo, monospace; color: #7FD4F5; font-variant-numeric: tabular-nums; }
  .n span { color: #A9B8CB; font-weight: 400; }
  .foot { margin-top: 20px; display: flex; justify-content: space-between; gap: 24px; font: 13.5px ui-monospace, 'SF Mono', Menlo, monospace; color: #7E8CA0; }
  .single { width: 900px; height: 900px; position: relative; background: #000; overflow: hidden; }
  .single img { width: 100%; display: block; }
  .single .tag { left: 36px; bottom: 60px; }
  .single .year { font-size: 110px; }
  .single .n { font-size: 26px; }
  .single .cap { position: absolute; left: 36px; right: 36px; top: 30px; font-size: 21px; line-height: 1.35; color: #C9D4E3; text-shadow: 0 2px 10px #05070C; }
  .single .legend { position: absolute; left: 36px; right: 36px; top: 64px; font-size: 14.5px; margin: 0; }
  .single .cap, .single .src, .single .legend { z-index: 1; }
  .single .src { position: absolute; left: 36px; right: 36px; bottom: 22px; font: 12.5px ui-monospace, 'SF Mono', Menlo, monospace; color: #7E8CA0; }
`;
const uri = (png) => `data:image/png;base64,${png.toString('base64')}`;
const tag = (q) => `<div class="tag"><div class="year">${q.year}</div><div class="n">${countLine(q)}</div></div>`;
const source = `Data: CelesTrak active-satellite catalog, ${dateLabel} · Imagery: Esri`;
const sheet = `<style>${css}</style><div class="sheet" id="shot">
  <h1>Today’s active satellites, by the year each was launched</h1>
  <p class="sub">Each dot is one of the ${fmt(last.count)} satellites active as of ${dateLabel}, at its real position. A panel shows only those already launched by the end of that year. Dead satellites and debris are not included.</p>
  ${legend}
  <div class="grid">${panels.map((q) => `<div class="cell"><img src="${uri(q.png)}">${tag(q)}</div>`).join('')}</div>
  <div class="foot"><span>${source}</span><span>jerredcook.github.io/orbital</span></div>
</div>`;
const c = await b.newPage({ viewport: { width: 1200, height: 1400 }, deviceScaleFactor: 2 });
await c.setContent(sheet, { waitUntil: 'load' });
await c.locator('#shot').screenshot({ path: join(OUT, 'active-satellites-by-launch-year.png'), type: 'png' });
for (const q of panels) {
  await c.setViewportSize({ width: 900, height: 900 });
  await c.setContent(`<style>${css}</style><div class="single" id="shot"><img src="${uri(q.png)}">
    <div class="cap">Today’s active satellites that had been launched by the end of ${q.year}</div>${legend}${tag(q)}
    <div class="src">${source} · jerredcook.github.io/orbital</div></div>`, { waitUntil: 'load' });
  await c.locator('#shot').screenshot({ path: q.file, type: 'png' });
}
await b.close();
writeFileSync(join(OUT, 'numbers.json'), `${JSON.stringify({ dataDate: dataDate.toISOString().slice(0, 10), panels: panels.map(({ year, count }) => ({ year, count })) }, null, 1)}\n`);
console.log(JSON.stringify({ out: OUT, dataDate: dataDate.toISOString().slice(0, 10), panels: panels.map(({ year, count }) => ({ year, count })) }));
