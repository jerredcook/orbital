// smoke-phone.mjs — the phone pass.  smoke.mjs proves the features work in a
// desktop window with a mouse; this proves a person holding a phone can reach
// and use them.  It runs an emulated Android phone (412×915, touch, coarse
// pointer) and uses REAL touch input only — hit-tested taps, and finger drags /
// pinches injected as raw touch events — never element.click().  It asserts:
//   • layout: nothing spills off-screen, the controls don't overlap, and the
//     panels leave the globe usable (portrait, then landscape);
//   • touch: drag rotates, pinch zooms, a tap on a dot selects it;
//   • every phone-specific path: the ☰ drawer, tap-to-place ground station,
//     the compact "following" strip, the right-hand legend drawer.
//
//   npm run dev                  # terminal 1
//   PORT=5173 npm run smoke:phone # terminal 2      (SMOKE_URL=… for a build)
import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = process.env.PORT || '5173';
const URL = process.env.SMOKE_URL || `http://localhost:${PORT}/`;
const W = 412, H = 915;   // a current mid-size Android phone, in CSS pixels
let VW = W, VH = H;        // the screen as currently held (swapped for landscape)

const b = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-swiftshader', '--no-sandbox', '--use-gl=angle', '--enable-gpu', '--disable-dev-shm-usage'],
});
const ctx = await b.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
});
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
const pageErrors = []; const consoleErrors = [];
p.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });

const R = {};
const check = (name, cond) => { R[name] = cond ? 'PASS' : 'FAIL'; if (process.env.SMOKE_TRACE) process.stderr.write(`[${R[name]}] ${name}\n`); };

// ---- helpers ----
// Where an element is on screen, and whether it is really shown.
const rect = (sel) => p.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  return {
    x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height,
    shown: !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
  };
}, sel);
// Measured against the SCREEN, not window.innerWidth: when content spills past
// the right edge, mobile Chrome quietly widens innerWidth to contain it, which
// would make an overflowing page look like it fits.
const fits = (q) => !!q && q.shown && q.x >= -1 && q.y >= -1 && q.r <= VW + 1 && q.b <= VH + 1;
const overlap = (a, c) => !!a && !!c && a.shown && c.shown && a.x < c.r - 1 && c.x < a.r - 1 && a.y < c.b - 1 && c.y < a.b - 1;
const noSideScroll = () => p.evaluate((vw) => document.documentElement.scrollWidth <= vw + 1 && innerWidth <= vw + 1, VW);
const poll = async (fn, ok, tries = 20, gap = 250) => {
  let v;
  for (let i = 0; i < tries; i++) { v = await fn(); if (ok(v)) return v; await sleep(gap); }
  return v;
};
const O = (fn) => p.evaluate(fn);

// Raw fingers.  One-finger drag and two-finger pinch, as the browser receives
// them from a touchscreen (Cesium listens to these, not to mouse events).
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: pts.map(([x, y], id) => ({ x: Math.round(x), y: Math.round(y), id })),
});
async function drag([x0, y0], [x1, y1], steps = 14) {
  await touch('touchStart', [[x0, y0]]);
  for (let i = 1; i <= steps; i++) { await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]]); await sleep(16); }
  await touch('touchEnd', []);
}
async function pinch([cx, cy], gap0, gap1, steps = 14) {
  await touch('touchStart', [[cx - gap0 / 2, cy], [cx + gap0 / 2, cy]]);
  for (let i = 1; i <= steps; i++) {
    const g = gap0 + (gap1 - gap0) * i / steps;
    await touch('touchMove', [[cx - g / 2, cy], [cx + g / 2, cy]]); await sleep(16);
  }
  await touch('touchEnd', []);
}
const camera = () => O(() => {
  const c = window.__orbital.viewer.camera.positionCartographic;
  return { lon: c.longitude, lat: c.latitude, h: c.height };
});

try {
  await p.goto(URL, { waitUntil: 'load', timeout: 30000 });

  // ---------------------------------------------------------------- first run
  // A brand-new visitor: the welcome card must fit the phone and be dismissable
  // by a real tap.
  await p.locator('#welcome').waitFor({ state: 'visible', timeout: 15000 });
  check('phoneEmulated', await O(() => matchMedia('(pointer: coarse)').matches && document.documentElement.clientWidth === 412));
  const card = await rect('.welcome-card');
  R._welcomeCard = card && { w: Math.round(card.w), h: Math.round(card.h) };
  check('welcomeFitsWidth', !!card && card.shown && card.x >= -1 && card.r <= W + 1);
  await p.locator('#welcome-go').tap();          // Playwright scrolls it into view if the card is tall
  await sleep(300);
  check('welcomeDismissesByTap', await O(() => document.getElementById('welcome').hidden));

  await p.waitForFunction(() => window.__orbital?.catalog?.length > 500 && window.__orbital.lastBuf, null, { timeout: 60000 });
  await sleep(1500);

  // ---------------------------------------------------------------- layout
  const bar = {};
  for (const id of ['legend-toggle', 'system-toggle', 'moon-toggle', 'missions-toggle', 'catalog-toggle', 'help-toggle', 'search']) bar[id] = await rect(`#${id}`);
  const ids = Object.keys(bar);
  R._topbar = Object.fromEntries(ids.map((k) => [k, bar[k] && `${Math.round(bar[k].w)}x${Math.round(bar[k].h)}@${Math.round(bar[k].x)}`]));
  check('topbarAllOnScreen', ids.every((k) => fits(bar[k])));
  check('topbarNoOverlap', ids.every((a, i) => ids.slice(i + 1).every((c) => !overlap(bar[a], bar[c]))));
  // A finger needs room: the app's own floor is 34 px for touch controls.
  R._smallTargets = ids.filter((k) => bar[k] && Math.min(bar[k].w, bar[k].h) < 34);
  check('topbarTouchTargets', R._smallTargets.length === 0);
  const timebar = await rect('#timebar');
  check('timebarOnScreen', fits(timebar));
  check('noSideScroll', await noSideScroll());

  // ---------------------------------------------------------------- touch on the globe
  const mid = [W / 2, H / 2];
  const c0 = await camera();
  await drag([W / 2 + 90, H / 2], [W / 2 - 90, H / 2]);
  const c1 = await poll(camera, (c) => Math.abs(c.lon - c0.lon) > 0.02, 12);
  R._dragLonDelta = +(c1.lon - c0.lon).toFixed(3);
  check('dragRotatesGlobe', Math.abs(c1.lon - c0.lon) > 0.02);

  await pinch(mid, 80, 280);                       // fingers apart → zoom in
  const c2 = await poll(camera, (c) => c.h < c1.h * 0.9, 12);
  R._pinchHeights = [Math.round(c1.h / 1000), Math.round(c2.h / 1000)];
  check('pinchZoomsIn', c2.h < c1.h * 0.9);
  await pinch(mid, 280, 80);                       // and back out
  const c3 = await poll(camera, (c) => c.h > c2.h * 1.1, 12);
  check('pinchZoomsOut', c3.h > c2.h * 1.1);
  await sleep(1200);                               // let the zoom inertia settle

  // ---------------------------------------------------------------- tap a dot
  // Find a satellite that is on the near side and clear of the UI, then put a
  // real finger on it.  (Neighbouring dots may win the pick — any selection passes.)
  const spot = await O(() => {
    const { viewer, lastBuf, catalog } = window.__orbital;
    const cam = viewer.camera.positionWC; const cl = Math.hypot(cam.x, cam.y, cam.z);
    let best = null;
    for (let i = 0; i < catalog.length; i++) {
      const x = lastBuf[3 * i], y = lastBuf[3 * i + 1], z = lastBuf[3 * i + 2];
      const l = Math.hypot(x, y, z);
      if (!(l > 6.4e6)) continue;
      if ((x * cam.x + y * cam.y + z * cam.z) / (l * cl) < 0.75) continue;   // well onto the near side
      const w = viewer.scene.cartesianToCanvasCoordinates({ x, y, z });
      if (!w || w.x < 60 || w.x > innerWidth - 60 || w.y < 200 || w.y > innerHeight - 240) continue;
      const d = Math.hypot(w.x - innerWidth / 2, w.y - innerHeight / 2);
      if (!best || d < best.d) best = { x: w.x, y: w.y, d };
    }
    return best;
  });
  R._tapSpot = spot && { x: Math.round(spot.x), y: Math.round(spot.y) };
  if (spot) await p.touchscreen.tap(spot.x, spot.y);
  const tapped = await poll(() => O(() => !!window.__orbital.selected), (v) => v, 12);
  check('tapSelectsSatellite', !!spot && tapped);
  const info1 = await rect('#infopanel');
  check('infoPanelOnScreen', fits(info1));
  check('infoPanelLeavesGlobe', !!info1 && info1.h <= H * 0.5 && !overlap(info1, await rect('#topbar')));
  check('infoPanelClearOfTimebar', !overlap(info1, await rect('#timebar')));
  await p.locator('#info-close').tap();
  await sleep(400);
  check('infoClosesByTap', await O(() => !window.__orbital.selected && document.getElementById('infopanel').hidden));

  // ---------------------------------------------------------------- search by typing
  await p.locator('#search').tap();
  await p.keyboard.type('ISS (ZARYA', { delay: 30 });
  await p.locator('#search-results .result-row').first().waitFor({ state: 'visible', timeout: 5000 });
  check('searchResultsOnScreen', fits(await rect('#search-results')));
  await p.locator('#search-results .result-row', { hasText: 'ZARYA' }).first().tap();
  await sleep(1500);
  const issSel = () => O(() => { const o = window.__orbital; return !!o.selected && o.catalog[o.selected.index]?.norad === 25544; });
  check('searchSelectsByTap', await issSel());

  // Follow: the panel must shrink to a strip so the craft at screen-centre shows.
  await p.locator('#info-track').tap();
  await sleep(1800);
  const strip = await rect('#infopanel');
  R._followStrip = strip && { y: Math.round(strip.y), h: Math.round(strip.h) };
  check('followCompactsPanel', await O(() => document.body.classList.contains('following')) && fits(strip) && strip.y > H / 2 + 40);
  await p.locator('#info-track').tap();            // stop following
  await sleep(600);
  check('followStopsByTap', await O(() => !document.body.classList.contains('following')));
  await p.locator('#info-close').tap();
  await sleep(400);

  // ---------------------------------------------------------------- the ☰ drawer
  await p.locator('#legend-toggle').tap();
  await sleep(500);                                // slide-in transition
  const drawer = await rect('#legend');
  check('drawerOpensOnScreen', await O(() => document.body.classList.contains('legend-open')) && fits(drawer));
  check('drawerLeavesGlobeVisible', !!drawer && drawer.w <= W * 0.87);
  const chip = p.locator('.group-chip[data-id=starlink]');
  await chip.tap();
  await sleep(300);
  check('groupChipByTap', await O(() => window.__orbital.groups.activeId() === 'starlink'));
  await chip.tap();
  await sleep(200);

  // ---------------------------------------------------------------- ground station, placed by a tap
  await p.locator('#toggle-station').tap();
  await sleep(300);
  await p.locator('#pass-setloc').tap();
  await sleep(600);
  check('placingClosesDrawer', await O(() => !document.body.classList.contains('legend-open')));
  check('placingPromptsByToast', /tap the globe/i.test(await O(() => document.getElementById('toasts').textContent)));
  await p.touchscreen.tap(W / 2, H / 2 - 40);
  const placed = await poll(() => O(() => { try { return JSON.parse(localStorage.getItem('orbital.station')); } catch { return null; } }),
    (s) => !!s && Number.isFinite(s.lat), 12);
  R._station = placed && { lat: +placed.lat.toFixed(1), lon: +placed.lon.toFixed(1) };
  check('stationPlacedByTap', !!placed && Number.isFinite(placed.lat) && Number.isFinite(placed.lon));
  await p.locator('#legend-toggle').tap();
  await sleep(500);
  const passes = await poll(() => p.locator('#pass-list > *').count(), (n) => n > 0, 60, 500);   // the worker streams them in
  R._passRows = passes;
  check('passesListed', passes > 0);
  // Measured in one step inside the page: the list is rebuilt as the worker
  // streams more passes in, so a row handle held across calls goes stale.
  const rowInside = await O(() => {
    const row = document.querySelector('#pass-list > *');
    if (!row) return false;
    row.scrollIntoView({ block: 'nearest' });
    const r = row.getBoundingClientRect(); const d = document.getElementById('legend').getBoundingClientRect();
    return r.width > 0 && r.left >= d.left - 1 && r.right <= d.right + 1 && r.top >= d.top - 1 && r.bottom <= d.bottom + 1;
  });
  check('passRowInsideDrawer', rowInside);
  // The drawer's scrim must give the globe back with one tap beside it.
  await p.touchscreen.tap(W - 20, H / 2);
  await sleep(500);
  check('scrimClosesDrawer', await O(() => !document.body.classList.contains('legend-open')));

  // ---------------------------------------------------------------- time bar
  const rate0 = await O(() => document.getElementById('time-rate').textContent);
  await p.locator('#time-faster').tap();
  await sleep(200);
  const rate1 = await O(() => document.getElementById('time-rate').textContent);
  await p.locator('#time-now').tap();
  await sleep(200);
  check('timeWarpByTap', rate1 !== rate0 && await O(() => document.getElementById('time-rate').textContent) === rate0);

  // ---------------------------------------------------------------- missions
  await p.locator('#missions-toggle').tap();
  await p.locator('#missions .mi-card').first().waitFor({ state: 'visible', timeout: 8000 });
  const miCard = await rect('#missions .mi-card');
  check('missionsCardFitsWidth', !!miCard && miCard.x >= -1 && miCard.r <= W + 1);
  check('missionsNoSideScroll', await O(() => { const el = document.getElementById('missions'); return el.scrollWidth <= el.clientWidth + 1; }));
  await drag([W / 2, H * 0.75], [W / 2, H * 0.25]);                     // a real swipe up
  const miTop = await poll(() => O(() => document.getElementById('missions').scrollTop), (t) => t > 100, 12);
  R._missionsSwipeTop = Math.round(miTop);
  check('missionsSwipeScrolls', miTop > 100);
  await p.locator('#missions-close').tap();
  await sleep(400);
  check('missionsClosesByTap', await O(() => document.getElementById('missions').hidden));

  // ---------------------------------------------------------------- catalog
  await p.locator('#catalog-toggle').tap();
  await p.locator('#catalog .cat-row').first().waitFor({ state: 'visible', timeout: 8000 });
  const catRow = await rect('#catalog .cat-row');
  check('catalogRowFitsWidth', !!catRow && catRow.x >= -1 && catRow.r <= W + 1 && catRow.h >= 34);
  check('catalogNoSideScroll', await O(() => { const el = document.getElementById('catalog-scroll'); return el.scrollWidth <= el.clientWidth + 1; }));
  await p.locator('#catalog-q').tap();
  await p.keyboard.type('25544', { delay: 30 });
  await sleep(500);
  await p.locator('#catalog .cat-row').first().tap();
  await sleep(1500);
  check('catalogRowFliesByTap', await O(() => document.getElementById('catalog').hidden) && await issSel());
  await p.locator('#info-close').tap();
  await sleep(400);

  // ---------------------------------------------------------------- solar system
  await p.locator('#system-toggle').tap();
  await poll(() => O(() => window.__orbital.systemView.visible), (v) => v, 20);
  await sleep(1500);
  check('systemOpensByTap', await O(() => window.__orbital.systemView.visible));
  const sysExit = await rect('#system-exit'); const sysScale = await rect('#system-scale'); const sysLegBtn = await rect('#system-legend-toggle');
  check('systemControlsOnScreen', fits(sysExit) && fits(sysScale) && fits(sysLegBtn));
  check('systemControlsNoOverlap', !overlap(sysExit, sysScale) && !overlap(sysExit, sysLegBtn) && !overlap(sysScale, sysLegBtn));
  await p.locator('#system-legend-toggle').tap();
  await sleep(500);
  check('systemLegendDrawerOnScreen', fits(await rect('#system-legend')));
  await p.touchscreen.tap(20, H / 2);              // scrim, left of the right-hand drawer
  await sleep(500);
  check('systemLegendClosesByScrim', await O(() => !document.body.classList.contains('system-legend-open')));
  await O(() => window.__orbital.systemView.focus('Saturn'));
  await sleep(1600);
  const sysPanel = await rect('#system-panel');
  check('bodyPanelOnScreen', fits(sysPanel) && sysPanel.w <= W * 0.7);
  check('bodyPanelClearOfFoot', !overlap(sysPanel, await rect('#timebar')) && !overlap(sysPanel, await rect('#system-attr')));
  await p.locator('#system-panel .card-collapse').tap();
  await sleep(300);
  const collapsed = await rect('#system-panel');
  check('bodyPanelCollapsesByTap', !!collapsed && collapsed.h < sysPanel.h * 0.6);
  check('systemNoSideScroll', await noSideScroll());
  await p.locator('#system-exit').tap();
  await poll(() => O(() => !window.__orbital.systemView.visible), (v) => v, 20);
  check('systemExitsByTap', await O(() => !window.__orbital.systemView.visible));
  await sleep(800);

  // ---------------------------------------------------------------- the Moon
  await p.locator('#moon-toggle').tap();
  await poll(() => O(() => window.__orbital.moonView.visible), (v) => v, 20);
  await sleep(1200);
  check('moonOpensByTap', await O(() => window.__orbital.moonView.visible) && fits(await rect('#moon-exit')));
  await p.locator('#moon-exit').tap();
  await poll(() => O(() => !window.__orbital.moonView.visible), (v) => v, 20);
  check('moonExitsByTap', await O(() => !window.__orbital.moonView.visible));
  await sleep(800);

  // ---------------------------------------------------------------- landscape
  await p.setViewportSize({ width: H, height: W });
  VW = H; VH = W;
  await sleep(1200);
  const lbar = {};
  for (const id of ids) lbar[id] = await rect(`#${id}`);
  // Sideways, the phone is wide enough for the desktop layout: the legend is a
  // fixed panel, so its ☰ button is (rightly) gone — everything else must show.
  const lids = ids.filter((k) => k !== 'legend-toggle');
  check('landscapeTopbarOnScreen', lids.every((k) => fits(lbar[k])) && lids.every((a, i) => lids.slice(i + 1).every((c) => !overlap(lbar[a], lbar[c]))));
  check('landscapeLegendReachable', fits(lbar['legend-toggle']) || fits(await rect('#legend')));
  check('landscapeTimebarOnScreen', fits(await rect('#timebar')) && !overlap(await rect('#timebar'), await rect('#topbar')));
  check('landscapeNoSideScroll', await noSideScroll());
  await p.locator('#help-toggle').tap();
  await sleep(400);
  await p.locator('#welcome-go').tap();            // must be reachable (scrolled to) on a short screen
  await sleep(300);
  check('landscapeWelcomeDismissable', await O(() => document.getElementById('welcome').hidden));

  check('noPageErrors', pageErrors.length === 0);
} catch (e) {
  R._fatal = String(e).slice(0, 400);
} finally {
  await b.close();
}

const fails = Object.entries(R).filter(([, v]) => v === 'FAIL').map(([k]) => k);
console.log(JSON.stringify({ result: (fails.length || R._fatal) ? 'RED' : 'GREEN', fails, R, pageErrors, consoleErrors: consoleErrors.slice(0, 4) }, null, 1));
process.exit((fails.length || R._fatal) ? 1 : 0);
