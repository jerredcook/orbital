// smoke-failures.mjs — the bad-day pass.  smoke.mjs and smoke-phone.mjs prove
// the app works when everything it depends on works; this breaks those things
// one at a time, in a real browser, and checks the visitor still gets a working
// app or an honest way forward:
//   • the satellite data feed refuses, or hangs without answering;
//   • every data source is gone (then comes back, and Retry works);
//   • the map imagery host is blocked;
//   • the position worker fails to load, crashes mid-flight, or silently stalls;
//   • the pass-scan worker crashes mid-scan;
//   • the device takes the graphics context away;
//   • the network is gone on a later launch (the service worker's job);
//   • saved settings are corrupt, and shared links are malformed or hostile.
//
// Each scenario gets a fresh browser profile.  CelesTrak is never contacted:
// unless a scenario says otherwise it is replaced by a stand-in that serves the
// bundled snapshot, so the run is deterministic and polite.
//
//   npm run dev                      # terminal 1
//   PORT=5173 npm run smoke:failures # terminal 2      (SMOKE_URL=… for a build)
//   ONLY=offline,gpu …               # run just the scenarios whose name matches
import { chromium } from 'playwright-core';
import { CELESTRAK, celestrakOk } from './celestrak-stub.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = process.env.PORT || '5173';
const SITE = process.env.SMOKE_URL || `http://localhost:${PORT}/`;
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);

const b = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-swiftshader', '--no-sandbox', '--use-gl=angle', '--enable-gpu', '--disable-dev-shm-usage'],
});

const R = {};
const notes = {};
const check = (name, cond) => { R[name] = cond ? 'PASS' : 'FAIL'; if (process.env.SMOKE_TRACE) process.stderr.write(`[${R[name]}] ${name}\n`); };

const celestrakRefuses = (route) => route.abort('connectionrefused');

async function scenario(name, { celestrak = celestrakOk, storage = {}, viewport = { width: 1280, height: 800 } } = {}, fn) {
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) return;
  const ctx = await b.newContext({ viewport });
  await ctx.addInitScript((extra) => {
    try {
      if (!sessionStorage.getItem('__seeded')) {   // once per tab, so a reload keeps what the app wrote
        sessionStorage.setItem('__seeded', '1');
        localStorage.setItem('orbital.welcomed', '1');
        for (const k in extra) localStorage.setItem(k, extra[k]);
      }
    } catch { /* ignore */ }
  }, storage);
  await ctx.route(CELESTRAK, celestrak);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  p.on('dialog', (d) => { errs.push(`dialog: ${d.message().slice(0, 80)}`); d.dismiss().catch(() => {}); });
  try {
    await fn({ ctx, p, errs });
  } catch (e) {
    R[`${name}:completed`] = 'FAIL';
    notes[name] = String(e).slice(0, 300);
  } finally {
    if (errs.length) notes[`${name}:pageErrors`] = errs.slice(0, 3);
    await ctx.close();
  }
}

// ---- helpers ----
const O = (p, fn, arg) => p.evaluate(fn, arg);
const state = (p) => O(p, () => {
  const o = window.__orbital;
  let drawn = 0;
  const buf = o?.lastBuf;
  if (buf) for (let i = 0; i < buf.length; i += 3) if (Number.isFinite(buf[i])) drawn++;
  return {
    catalog: o?.catalog?.length ?? 0, drawn, ticks: o?.posTicks ?? 0,
    events: o?.events ?? [], engine: o?.engine ?? null,
    card: !!document.getElementById('recover-card'),
    bootError: !!document.querySelector('.toast.boot-error'),
    topbar: !!document.getElementById('topbar'),
  };
});
const poll = async (fn, ok, ms = 15000, gap = 250) => {
  const end = Date.now() + ms; let v;
  do { v = await fn(); if (ok(v)) return v; await sleep(gap); } while (Date.now() < end);
  return v;
};
// Booted = a catalog is loaded and the worker has delivered positions for it.
const booted = (p, ms = 45000) => poll(() => state(p), (s) => s.catalog > 500 && s.drawn > 500, ms);
// Positions keep arriving (the dots are moving), not just a stale frame.
const ticking = async (p, ms = 8000) => {
  const t0 = (await state(p)).ticks;
  return (await poll(() => state(p), (s) => s.ticks >= t0 + 2, ms)).ticks >= t0 + 2;
};
const propagator = (p) => p.workers().find((w) => w.url().includes('propagator.worker'));
const passesWorker = (p) => p.workers().find((w) => w.url().includes('passes.worker'));

// =========================================================== the data feed ====

await scenario('feedRefused', { celestrak: celestrakRefuses }, async ({ p, errs }) => {
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  const s = await booted(p);
  check('feedRefused:bundledSnapshotLoads', s.catalog > 5000 && s.drawn > 5000);
  check('feedRefused:noErrorShown', !s.bootError && !s.card);
  check('feedRefused:countedAsDegraded', s.events.includes('degraded/catalog-bundled') && !s.events.includes('error/boot'));
  check('feedRefused:dotsKeepMoving', await ticking(p));
  check('feedRefused:noPageErrors', errs.length === 0);
});

// CelesTrak's usual failure is not a refusal but a connection that never
// answers.  The first request must time out (15 s) and the rest must skip the
// wait — so the globe fills in well inside a minute, not a minute per request.
await scenario('feedHangs', { celestrak: () => { /* never answer */ } }, async ({ p }) => {
  const t0 = Date.now();
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  const s = await booted(p, 55000);
  notes.feedHangsSeconds = Math.round((Date.now() - t0) / 1000);
  check('feedHangs:fallsBackAfterTimeout', s.catalog > 5000 && s.drawn > 5000 && !s.bootError);
  // One 15 s timeout, not four (four requests hang): 40 s leaves room for a slow CI runner.
  check('feedHangs:oneTimeoutNotFour', Date.now() - t0 < 40000);
});

await scenario('everythingDown', { celestrak: celestrakRefuses }, async ({ ctx, p }) => {
  const blockSnapshot = (route) => route.abort('failed');
  await ctx.route('**/fallback/**', blockSnapshot);
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  const s = await poll(() => state(p), (v) => v.bootError, 30000);
  check('everythingDown:saysSoWithRetry', s.bootError && await p.locator('.toast.boot-error .toast-retry').isVisible());
  check('everythingDown:countedAsBootError', s.events.includes('error/boot'));
  check('everythingDown:appStillStanding', s.topbar && !s.card);
  // A view that needs no satellite catalog must still open.
  await p.locator('#system-toggle').click();
  check('everythingDown:systemViewStillOpens', await poll(() => O(p, () => document.body.classList.contains('system-mode')), (v) => v, 10000));
  await sleep(1200);
  await p.locator('#system-exit').click();
  await poll(() => O(p, () => !document.body.classList.contains('system-mode')), (v) => v, 10000);
  // The connection comes back: Retry recovers without a reload.
  await ctx.unroute('**/fallback/**', blockSnapshot);
  await p.locator('.toast.boot-error .toast-retry').click();
  const s2 = await booted(p);
  check('everythingDown:retryRecovers', s2.catalog > 5000 && s2.drawn > 5000 && !s2.bootError);
});

await scenario('imageryBlocked', {}, async ({ ctx, p, errs }) => {
  await ctx.route(/arcgisonline\.com|arcgis\.com/, (route) => route.abort('failed'));
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  const s = await booted(p);
  check('imageryBlocked:catalogStillLoads', s.catalog > 5000 && !s.card && !s.bootError);
  await p.locator('#search').click();
  await p.keyboard.type('ISS (ZARYA)', { delay: 20 });
  await p.locator('#search-results .result-row').first().click();
  const picked = await poll(() => O(p, () => window.__orbital.selected && !document.getElementById('infopanel').hidden), (v) => v, 8000);
  check('imageryBlocked:searchAndSelectWork', !!picked);
  check('imageryBlocked:dotsKeepMoving', await ticking(p));
  check('imageryBlocked:noPageErrors', errs.length === 0 && !(await state(p)).card);
});

// ============================================================= the workers ====

await scenario('workerLoadFails', {}, async ({ ctx, p }) => {
  let blocked = 0;
  await ctx.route('**/*propagator.worker*', (route) => (blocked++ === 0 ? route.abort('failed') : route.continue()));
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  const s = await booted(p);
  notes.workerLoadBlocked = blocked;
  check('workerLoadFails:scenarioIsReal', blocked >= 2);   // the first load really was refused, and a second was made
  check('workerLoadFails:restartedAndDrawing', s.engine?.restarts >= 1 && s.engine.alive && s.drawn > 5000);
  check('workerLoadFails:counted', s.events.includes('error/worker-propagator'));
  check('workerLoadFails:dotsKeepMoving', await ticking(p));
  check('workerLoadFails:noCard', !(await state(p)).card);
});

await scenario('workerCrashes', {}, async ({ p }) => {
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  await booted(p);
  await ticking(p);
  // An uncaught error inside the live worker, as a bug or a bad element set would raise.
  await propagator(p).evaluate(() => { setTimeout(() => { throw new Error('smoke: propagator crash'); }, 0); });
  const s = await poll(() => state(p), (v) => v.engine?.restarts >= 1 && v.engine.alive, 10000);
  check('workerCrashes:replaced', s.engine?.restarts >= 1 && s.engine.alive);
  check('workerCrashes:counted', s.events.includes('error/worker-propagator'));
  check('workerCrashes:dotsMoveAgain', await ticking(p, 12000));

  // Keeps dying → stop, and say so, rather than loop forever.
  for (let i = 0; i < 6; i++) {
    const w = await poll(() => propagator(p), (v) => !!v, 6000);
    if (!w) break;
    await w.evaluate(() => { setTimeout(() => { throw new Error('smoke: propagator crash'); }, 0); }).catch(() => {});
    const gone = await poll(() => state(p), (v) => v.engine?.gaveUp || !v.engine?.alive, 4000);
    if (gone.engine?.gaveUp) break;
    await poll(() => state(p), (v) => v.engine?.alive || v.engine?.gaveUp, 8000);
  }
  const end = await poll(() => state(p), (v) => v.engine?.gaveUp && v.card, 6000);
  check('workerCrashes:givesUpWithACard', !!end.engine?.gaveUp && end.card && end.events.includes('error/worker-gave-up'));
  check('workerCrashes:cardOffersReload', await p.locator('#recover-reload').isVisible());
});

// A worker spinning in a loop raises no error at all; only the watchdog can
// tell.  (30 s by design — this is the slow scenario.)
await scenario('workerStalls', {}, async ({ p }) => {
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  await booted(p);
  await ticking(p);
  propagator(p).evaluate(() => { self.onmessage = () => { for (;;) { /* hang on the next request */ } }; }).catch(() => {});
  await sleep(1500);
  const frozenAt = (await state(p)).ticks;
  await sleep(3000);
  check('workerStalls:scenarioIsReal', (await state(p)).ticks === frozenAt);   // it really is stuck
  const s = await poll(() => state(p), (v) => v.engine?.restarts >= 1 && v.engine.alive, 75000, 500);
  check('workerStalls:watchdogReplacesIt', s.engine?.restarts >= 1 && s.engine.alive);
  check('workerStalls:dotsMoveAgain', await ticking(p, 12000));
  check('workerStalls:noCard', !(await state(p)).card);
});

await scenario('passWorkerCrashes', { storage: { 'orbital.station': JSON.stringify({ lat: 40.7128, lon: -74.006 }) } }, async ({ p }) => {
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  await booted(p);
  await p.locator('#toggle-station').check();
  const w = await poll(() => passesWorker(p), (v) => !!v, 8000);
  await poll(() => O(p, () => document.getElementById('pass-status').textContent), (t) => /scanning/.test(t), 8000, 50);
  await w.evaluate(() => { setTimeout(() => { throw new Error('smoke: passes crash'); }, 0); });
  const interrupted = await poll(() => state(p), (v) => v.events.includes('error/worker-passes'), 8000, 50);
  check('passWorkerCrashes:counted', interrupted.events.includes('error/worker-passes'));
  // The scan starts again on the new worker by itself and makes headway (a
  // full scan of ~16,000 satellites takes minutes on a CI runner, so this
  // checks that it is running and advancing, not that it has finished).
  const passState = () => O(p, () => {
    const el = document.getElementById('pass-status');
    const t = el.hidden ? '' : el.textContent;
    const m = /scanning .*?(\d+)%/.exec(t);
    return { text: t, pct: m ? Number(m[1]) : null, done: /passes/.test(t) && !/scanning/.test(t), rows: document.querySelectorAll('#pass-list > *').length };
  });
  const resumed = await poll(passState, (v) => v.done || (v.pct !== null && v.pct >= 1), 40000, 250);
  const later = await poll(passState, (v) => v.done || (v.pct !== null && resumed.pct !== null && v.pct > resumed.pct), 40000, 500);
  notes.passAfterCrash = { resumed, later };
  check('passWorkerCrashes:scanResumesByItself', resumed.done || resumed.pct >= 1);
  check('passWorkerCrashes:scanKeepsAdvancing', later.done || later.pct > resumed.pct);
  check('passWorkerCrashes:passesAreListed', (await poll(passState, (v) => v.rows > 0, 30000, 500)).rows > 0);
  check('passWorkerCrashes:noFailureMessage', !/failed/.test((await passState()).text));
});

// ============================================================ the graphics ====

await scenario('gpuLost', {}, async ({ p }) => {
  await p.goto(`${SITE}#sat=25544`, { waitUntil: 'load', timeout: 30000 });
  await booted(p);
  await poll(() => O(p, () => !!window.__orbital.selected), (v) => v, 10000);
  const lose = () => O(p, () => {
    const gl = window.__orbital.viewer.scene.context._gl;
    gl.getExtension('WEBGL_lose_context').loseContext();   // exactly what the browser does when it reclaims the GPU
  });
  await lose();
  const s = await poll(() => state(p), (v) => v.card, 6000);
  check('gpuLost:cardAppears', s.card && await p.locator('#recover-reload').isVisible());
  check('gpuLost:counted', s.events.includes('error/webgl-lost'));
  await Promise.all([p.waitForEvent('load', { timeout: 30000 }), p.locator('#recover-reload').click()]);
  const s2 = await booted(p);
  check('gpuLost:reloadRestoresTheApp', s2.catalog > 5000 && !s2.card);
  check('gpuLost:reloadKeepsTheView', await poll(() => O(p, () => window.__orbital.selected && window.__orbital.catalog[window.__orbital.selected.index].norad === 25544), (v) => v, 10000));

  // Lost while the tab is in the background (the common case on a phone):
  // coming back reloads by itself — no card, no frozen globe.  Headless Chrome
  // never hides a tab (minimising, switching tabs and the lifecycle API were all
  // tried), so the tab's visibility is SIMULATED here; the context loss and the
  // reload are real.
  const setHidden = (h) => O(p, (hid) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hid });
    document.dispatchEvent(new Event('visibilitychange'));
  }, h);
  await setHidden(true);
  await lose();
  await sleep(600);
  check('gpuLost:silentWhileHidden', !(await state(p)).card);
  await Promise.all([p.waitForEvent('load', { timeout: 30000 }), setHidden(false).catch(() => {})]);
  const s3 = await booted(p);
  check('gpuLost:returningReloadsByItself', s3.catalog > 5000 && !s3.card);
  // …but only once a minute: a device that cannot keep a context gets the card, not a loop.
  await setHidden(true);
  await lose();
  await sleep(400);
  await setHidden(false);
  const s4 = await poll(() => state(p), (v) => v.card, 6000);
  check('gpuLost:noReloadLoop', s4.card);
});

// A viewer the app destroys on purpose (the planet globe is rebuilt per body)
// must not be mistaken for a lost context.
await scenario('planetSwapIsNotAFailure', {}, async ({ p }) => {
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  await booted(p);
  await p.locator('#system-toggle').click();
  await poll(() => O(p, () => window.__orbital.systemView.visible), (v) => v, 10000);
  await sleep(1200);
  let entered = 0;
  for (const body of ['Mars', 'Mercury']) {
    await O(p, (name) => window.__orbital.systemView.focus(name), body);   // setup only: pick the planet
    const btn = p.locator('#sys-enter-planet');
    if (!(await poll(() => btn.isVisible(), (v) => v, 8000))) continue;
    await btn.click();
    if (await poll(() => p.locator('#body-exit').isVisible(), (v) => v, 10000)) entered++;
    await sleep(1500);
    await p.locator('#body-exit').click();
    await sleep(1200);
  }
  await sleep(1000);
  const s = await state(p);
  check('planetSwap:scenarioIsReal', entered === 2);   // the second descent is what destroys the first globe
  check('planetSwap:noFalseAlarm', !s.card && !s.events.includes('error/webgl-lost'));
});

// ============================================================== the network ====

// One ordinary visit, then no network at all: the app must still open, from the
// service worker's copies and the cached element sets.  One visit is the hard
// case — the worker only takes control after the page has loaded, so it has to
// be told what to keep (the 'warm' message, sw.js).
await scenario('offlineRelaunch', {}, async ({ ctx, p }) => {
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  await booted(p);
  const kept = await poll(() => O(p, async () => {
    const names = (await (await caches.open('orbital-v2')).keys()).map((r) => new URL(r.url).pathname);
    return { n: names.length, shell: names.some((n) => n.endsWith('/')), js: names.some((n) => /assets\/index-.*\.js$/.test(n)), worker: names.some((n) => n.includes('propagator.worker')) };
  }), (v) => v.shell && v.js && v.worker, 25000, 500);
  notes.offlineCacheAfterOneVisit = kept;
  check('offlineRelaunch:firstVisitKeepsTheApp', kept.shell && kept.js && kept.worker);
  await ctx.setOffline(true);
  const reallyOffline = await O(p, () => fetch(`./missions/recent.json?${Date.now()}`, { cache: 'no-store' }).then((r) => !r.ok, () => true));
  check('offlineRelaunch:scenarioIsReal', reallyOffline);
  await p.reload({ waitUntil: 'load', timeout: 30000 });
  const s = await booted(p, 30000);
  check('offlineRelaunch:appOpensFromCache', s.topbar && s.catalog > 5000 && s.drawn > 5000);
  check('offlineRelaunch:noErrorCard', !s.card && !s.bootError);
  check('offlineRelaunch:dotsKeepMoving', await ticking(p));
  await ctx.setOffline(false);
});

// ===================================================== saved state and links ====

const GARBAGE = {
  'orbital.visits': '{not json', 'orbital.known-ids': '[[[', 'orbital.station': '{"lat":"north","lon":null}',
  'orbital.tle.active': 'yesterday', 'orbital.tle.cosmos2251': '{"t":"soon"}', 'orbital.celestrak.down': 'banana',
  'orbital.satcat': '<html>', 'orbital.welcomed': '{}',
};
await scenario('corruptStorage', { storage: GARBAGE }, async ({ p, errs }) => {
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  const s = await booted(p);
  check('corruptStorage:boots', s.catalog > 5000 && !s.card && !s.bootError);
  await p.locator('#toggle-station').check();
  await sleep(600);
  check('corruptStorage:stationAsksForALocation', await O(p, () => /location|tap|click/i.test(document.getElementById('pass-status').textContent)));
  check('corruptStorage:noPageErrors', errs.length === 0);
});

const HASHES = ['#sat=%E0%A4%A', '#sat=99999999', '#body=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', '#group=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E', '#moon=', '#%3Csvg%2Fonload%3Dalert(1)%3E', '#probe=nope&sat=1'];
await scenario('hostileLinks', {}, async ({ p, errs }) => {
  for (const h of HASHES) {
    await p.goto('about:blank');
    await p.goto(`${SITE}${h}`, { waitUntil: 'load', timeout: 30000 });
    const s = await poll(() => state(p), (v) => v.catalog > 500, 30000);
    await sleep(800);
    const injected = await O(p, () => document.querySelectorAll('img[src="x"], svg[onload]').length);
    check(`hostileLinks:${h.slice(0, 24)}`, s.catalog > 5000 && s.topbar && !(await state(p)).card && injected === 0);
  }
  check('hostileLinks:noPageErrorsOrDialogs', errs.length === 0);
});

// ============================================================ a newer build ====

// A long-lived session while a newer build is deployed: the app notices (it
// re-reads version.json when the connection comes back) and OFFERS a refresh —
// it must not reload under the visitor.
await scenario('newVersionDeployed', {}, async ({ ctx, p }) => {
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  await booted(p);
  const running = await O(p, () => window.__orbital.version);
  check('newVersion:buildIsLabelled', /^v\d+\.\d+\.\d+ · \S+$/.test(await O(p, () => document.getElementById('app-version').textContent)));
  if (running.build === 'dev') { notes.newVersion = 'dev server: no build id, update check is off — run against a build to exercise it'; return; }
  await ctx.route('**/version.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: '9.9.9', build: 'fffffff' }) }));
  let loads = 0; p.on('load', () => { loads++; });
  await ctx.setOffline(true); await sleep(300); await ctx.setOffline(false);   // a real 'online' event
  const offered = await poll(() => O(p, () => !!document.querySelector('.toast.update #update-refresh')), (v) => v, 10000);
  check('newVersion:refreshIsOffered', offered && (await state(p)).events.includes('update/offered'));
  await sleep(1500);
  check('newVersion:neverReloadsByItself', loads === 0);
  await Promise.all([p.waitForEvent('load', { timeout: 30000 }), p.locator('#update-refresh').click()]);
  check('newVersion:refreshReloads', (await booted(p)).catalog > 5000);
});

await b.close();

const fails = Object.entries(R).filter(([, v]) => v === 'FAIL').map(([k]) => k);
console.log(JSON.stringify({ result: fails.length ? 'RED' : 'GREEN', checks: Object.keys(R).length, fails, R, notes }, null, 1));
process.exit(fails.length ? 1 : 0);
