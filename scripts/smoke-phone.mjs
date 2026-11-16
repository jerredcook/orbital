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
import { blockCelestrak } from './celestrak-stub.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = process.env.PORT || '5173';
const URL = process.env.SMOKE_URL || `http://localhost:${PORT}/`;
const W = 412, H = 915;   // a current mid-size Android phone, in CSS pixels
let VW = W, VH = H;        // the screen as currently held (swapped for landscape)

const b = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-swiftshader', '--no-sandbox', '--use-gl=angle', '--enable-gpu', '--disable-dev-shm-usage'],
});
const PHONE = {
  viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
};
const ctx = await b.newContext(PHONE);
const celestrakHits = [];
await blockCelestrak(ctx, celestrakHits);   // the app must never contact CelesTrak — see celestrak-stub.mjs
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
const pageErrors = []; const consoleErrors = []; const dataRequests = [];
p.on('request', (r) => { if (r.url().includes('/data/')) dataRequests.push(r.url()); });
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
  // A brand-new visitor sees the GLOBE, not a dialog over it: the starter card
  // (starter.js) is a small strip that fits the phone, covers none of the
  // controls, and blocks nothing — the drag, pinch and tap checks below all run
  // with it still up.
  await p.locator('#starter').waitFor({ state: 'visible', timeout: 15000 });
  check('phoneEmulated', await O(() => matchMedia('(pointer: coarse)').matches && document.documentElement.clientWidth === 412));
  await p.waitForFunction(() => window.__orbital?.feedSettled && window.__orbital.catalog.length > 500 && window.__orbital.lastBuf, null, { timeout: 60000 });
  await sleep(1500);
  const card = await rect('#starter');
  R._starterCard = card && { w: Math.round(card.w), h: Math.round(card.h), y: Math.round(card.y) };
  check('starterFitsScreen', fits(card));
  check('firstVisitShowsTheGlobe', await O(() => document.getElementById('welcome').hidden) && !!card && card.h <= H * 0.35
    && !overlap(card, await rect('#topbar')) && !overlap(card, await rect('#timebar')));
  check('starterTouchTargets', (await Promise.all(['#starter-iss', '#starter-timeline', '#starter-tour', '#starter-close'].map(rect))).every((q) => fits(q) && Math.min(q.w, q.h) >= 34));
  // …and it says how many there are, from the catalog actually loaded.
  const head = await poll(() => O(() => document.getElementById('starter-head').textContent), (t) => /^\d/.test(t), 12);
  const sats = await O(() => window.__orbital.catalog.filter((s) => s.kind === 'SAT').length);
  // (the headline counts ACTIVE satellites only — never the dead ones, rocket bodies or debris also on screen)
  check('starterShowsLiveCount', head.startsWith(`${sats.toLocaleString('en-US')} satellites`) && /^Tap/.test(await O(() => document.getElementById('starter-verb').textContent)));

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
  // The About section on a phone: the photo is a thumbnail beside the text, and
  // the panel — which the checks above measure — must still fit with it in.
  {
    const ok = await O(async () => {
      const o = window.__orbital, nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const objects = await o.loadAbout(); const i = o.catalog.findIndex((s) => s.norad === 20580);
      if (!objects || !objects[20580] || i < 0) return { available: false };
      o.selectByIndex(i); for (let k = 0; k < 20; k++) { await nap(200); if (!document.getElementById('info-about').hidden) break; } await nap(500);
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const panel = r('infopanel'), photo = r('about-photo-link'), box = r('info-about');
      return { available: true, shown: !document.getElementById('info-about').hidden, photoW: photo.width, photoH: photo.height,
        inside: box.left >= panel.left - 1 && box.right <= panel.right + 1, panelH: panel.height, panelBottom: panel.bottom, vh: innerHeight, vw: innerWidth, panelRight: panel.right };
    });
    R._aboutPhone = ok;
    check('aboutFitsThePhonePanel', !ok.available || (ok.shown && ok.photoW > 40 && ok.photoW <= 100 && ok.photoH <= 100 && ok.inside && ok.panelH <= ok.vh * 0.5 && ok.panelBottom <= ok.vh + 1 && ok.panelRight <= ok.vw + 1));
  }
  // Picking a satellite is the starter card's job done: it leaves, for good.
  check('starterLeavesOnceASatelliteIsPicked', await O(() => document.getElementById('starter').hidden && localStorage.getItem('orbital.welcomed') === '1'));
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
  // The data credit sits at the foot of the drawer: scrolling there must bring
  // it fully on screen, with links a finger can hit.
  await O(() => document.getElementById('data-credit').scrollIntoView({ block: 'end' }));
  await sleep(300);
  const creditBox = await rect('#data-credit');
  const creditLinks = await O(() => [...document.querySelectorAll('#data-credit a')].map((a) => { const r = a.getBoundingClientRect(); return { h: r.height, w: r.width, href: a.href }; }));
  check('dataCreditReachableInDrawer', fits(creditBox) && creditLinks.length === 2 && creditLinks.every((l) => l.h >= 30 && l.w >= 30)
    && creditLinks.some((l) => l.href === 'https://celestrak.org/') && creditLinks.some((l) => l.href === 'https://www.space-track.org/'));
  await O(() => { document.getElementById('legend').scrollTop = 0; });
  await sleep(200);
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

  // The recovery card (recover.js) is for real failures; a healthy run must never raise it.
  check('noRecoveryCard', await p.evaluate(() => !document.getElementById('recover-card') && !window.__orbital.events.some((e) => e.startsWith('error/'))));
  // …and must not claim a newer version exists when the server has this very build.
  check('noFalseUpdatePrompt', await p.evaluate(() => !document.querySelector('.toast.update')));
  check('noPageErrors', pageErrors.length === 0);

  // ---- capture mode on a phone: there is no Space key, so a tap starts it.
  {
    const c = await ctx.newPage();
    await c.goto(`${URL}?clip=10`, { waitUntil: 'load', timeout: 30000 });
    await c.waitForFunction(() => /tap to play/.test(document.getElementById('clip-hint')?.textContent || ''), { timeout: 45000 });
    await c.touchscreen.tap(W / 2, Math.round(H / 2));   // a fresh page is portrait again, whatever the suite last rotated to
    let cy = 1957;
    for (let i = 0; i < 30 && cy === 1957; i++) { await sleep(300); cy = await c.evaluate(() => Number(document.getElementById('clip-year').textContent)); }
    check('clipStartsOnTap', cy > 1957);
    await c.close();
  }

  // ---- "Watch 1957 → today" from the starter card: the launch timeline has to
  // work on a phone WITHOUT opening the drawer its controls live in.
  {
    const cx = await b.newContext(PHONE);   // a new visitor again (empty storage)
    await blockCelestrak(cx, celestrakHits);
    const s = await cx.newPage();
    await s.goto(URL, { waitUntil: 'load', timeout: 30000 });
    await s.waitForFunction(() => window.__orbital?.feedSettled && window.__orbital.catalog.length > 500 && window.__orbital.lastBuf, null, { timeout: 60000 });
    const box = (sel) => s.evaluate((q) => {
      const el = document.querySelector(q); if (!el) return null;
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, shown: !el.hidden && cs.display !== 'none' && r.width > 0 && r.height > 0 };
    }, sel);
    const hudYear = () => s.evaluate(() => Number(document.getElementById('tl-hud-year').textContent));
    // Record, inside the page, the first year the readout shows once it appears.
    // (Reading it from here a moment after the tap is a race: on a slow CI
    // runner the replay is already past 1957 by the time the question arrives.)
    await s.evaluate(() => {
      const hud = document.getElementById('tl-hud'), year = document.getElementById('tl-hud-year');
      window.__firstYear = null;
      const note = () => { if (window.__firstYear === null && !hud.hidden) window.__firstYear = Number(year.textContent); };
      new MutationObserver(note).observe(hud, { attributes: true, attributeFilter: ['hidden'] });
      new MutationObserver(note).observe(year, { childList: true, characterData: true, subtree: true });
    });
    await s.locator('#starter-timeline').tap();
    await sleep(600);
    const hud = await box('#tl-hud');
    const on0 = await s.evaluate(() => ({
      starterGone: document.getElementById('starter').hidden, drawerShut: !document.body.classList.contains('legend-open'),
      firstYear: window.__firstYear, year: Number(document.getElementById('tl-hud-year').textContent),
      playing: window.__orbital.timelinePlaying, hash: location.hash,
    }));
    R._timelineShow = on0;
    check('timelineShowStartsFromTheCard', on0.starterGone && on0.drawerShut && on0.playing && on0.firstYear === 1957 && on0.hash === '#timeline');
    check('timelineHudOnScreen', !!hud && hud.shown && hud.x >= -1 && hud.r <= W + 1 && !overlap(hud, await box('#topbar')) && !overlap(hud, await box('#timebar')));
    let y = 1957;
    for (let i = 0; i < 60 && y < 1962; i++) { await sleep(300); y = await hudYear(); }
    check('timelineShowPlays', y >= 1962);
    // Honest label: the number is today's active satellites launched by that year.
    const lab = await s.evaluate(() => {
      const o = window.__orbital, yr = Number(document.getElementById('tl-hud-year').textContent), text = document.getElementById('tl-hud-count').textContent;
      return { text, n: Number(text.split(' ')[0].replace(/\D/g, '')), want: o.catalog.filter((c) => c.kind === 'SAT' && (c.launchYear ?? 9999) <= yr).length };
    });
    check('timelineHudCountsActiveSatellites', /of today’s active satellites$/.test(lab.text) && lab.n === lab.want);
    await s.locator('#tl-hud-play').tap();           // pause…
    await sleep(300);
    const paused = await hudYear();
    await sleep(1500);
    check('timelineHudPauses', await hudYear() === paused && !(await s.evaluate(() => window.__orbital.timelinePlaying)));
    await s.locator('#tl-hud-close').tap();          // …and ✕ returns to today's full sky
    await sleep(500);
    check('timelineHudCloses', await s.evaluate(() => document.getElementById('tl-hud').hidden && !document.getElementById('toggle-timeline').checked && location.hash === ''
      && window.__orbital.swarm && document.getElementById('count-LEO').textContent.replace(/\D/g, '') > 1000));
    await cx.close();
  }

  // ---- a shared #timeline link: straight into the show, no introduction first —
  // and the bare page still introduces itself afterwards, where "Find the Space
  // Station" must do what it says.
  {
    const cx = await b.newContext(PHONE);
    await blockCelestrak(cx, celestrakHits);
    const s = await cx.newPage();
    await s.goto(`${URL}#timeline`, { waitUntil: 'load', timeout: 30000 });
    await s.waitForFunction(() => window.__orbital?.timelinePlaying === true, null, { timeout: 60000 });
    let y = 1957;
    for (let i = 0; i < 60 && y < 1960; i++) { await sleep(300); y = await s.evaluate(() => Number(document.getElementById('tl-hud-year').textContent)); }
    check('timelineLinkPlays', y >= 1960 && await s.evaluate(() => document.getElementById('starter').hidden && document.getElementById('welcome').hidden
      && !document.getElementById('tl-hud').hidden && location.hash === '#timeline'));
    await s.goto(URL.replace(/#.*$/, ''), { waitUntil: 'load', timeout: 30000 });
    await s.reload({ waitUntil: 'load' });           // a hash-only change is not a new load
    await s.waitForFunction(() => window.__orbital?.feedSettled && window.__orbital.catalog.length > 500 && window.__orbital.lastBuf, null, { timeout: 60000 });
    check('barePageStillIntroducesItself', await s.evaluate(() => !document.getElementById('starter').hidden));
    await s.locator('#starter-iss').tap();
    const iss = await (async () => { for (let i = 0; i < 20; i++) { const n = await s.evaluate(() => window.__orbital.selected ? document.getElementById('info-name').textContent : ''); if (n) return n; await sleep(300); } return ''; })();
    check('starterFindsTheSpaceStation', /ISS|ZARYA/i.test(iss) && await s.evaluate(() => document.getElementById('starter').hidden));
    await cx.close();
  }
  // Satellite data comes from the site itself (data/): in this whole run, no
  // page may have asked CelesTrak for anything.
  R._celestrakHits = celestrakHits.slice(0, 3);
  check('neverContactsCelestrak', celestrakHits.length === 0);
  check('dataComesFromTheSite', dataRequests.some((u) => /\/data\/meta\.json/.test(u)) && dataRequests.some((u) => /\/data\/active\.tle\?v=[0-9a-f]+/.test(u)));
} catch (e) {
  R._fatal = String(e).slice(0, 400);
} finally {
  await b.close();
}

const fails = Object.entries(R).filter(([, v]) => v === 'FAIL').map(([k]) => k);
console.log(JSON.stringify({ result: (fails.length || R._fatal) ? 'RED' : 'GREEN', fails, R, pageErrors, consoleErrors: consoleErrors.slice(0, 4) }, null, 1));
process.exit((fails.length || R._fatal) ? 1 : 0);
