// smoke-failures.mjs — the bad-day pass.  smoke.mjs and smoke-phone.mjs prove
// the app works when everything it depends on works; this breaks those things
// one at a time, in a real browser, and checks the visitor still gets a working
// app or an honest way forward:
//   • the satellite data refuses, hangs, or is not satellite data at all;
//   • newer data arrives while a returning visitor is looking at the old;
//   • every data source is gone (then comes back, and Retry works);
//   • the map imagery host is blocked;
//   • the position worker fails to load, crashes mid-flight, or silently stalls;
//   • the pass-scan worker crashes mid-scan;
//   • the device takes the graphics context away;
//   • the drawing itself throws;
//   • the network is gone on a later launch (the service worker's job);
//   • saved settings are corrupt, and shared links are malformed or hostile.
//
// Each scenario gets a fresh browser profile.  The satellite data is the
// build's own data/ folder; "the feed" failing means that folder failing.
// CelesTrak is never contacted — any request to it is refused and fails the run.
//
//   npm run dev                      # terminal 1
//   PORT=5173 npm run smoke:failures # terminal 2      (SMOKE_URL=… for a build)
//   ONLY=offline,gpu …               # run just the scenarios whose name matches
//   SHARD=1/2 …                      # every second scenario (CI runs 1/2 and 2/2 side by side)
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { blockCelestrak } from './celestrak-stub.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = process.env.PORT || '5173';
const SITE = process.env.SMOKE_URL || `http://localhost:${PORT}/`;
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
// SHARD=1/2 runs the 1st, 3rd, 5th… scenario and SHARD=2/2 the rest — how CI
// splits this, the longest suite, across two runners.  By position, so a new
// scenario lands in one half or the other without anyone having to list it.
const SHARD = (() => { const m = /^(\d+)\/(\d+)$/.exec(process.env.SHARD || ''); return m && +m[1] >= 1 && +m[1] <= +m[2] ? { n: +m[1], of: +m[2] } : null; })();
let scenarioNo = 0;

const b = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-swiftshader', '--no-sandbox', '--use-gl=angle', '--enable-gpu', '--disable-dev-shm-usage'],
});

const R = {};
const notes = {};
const ran = [];   // scenarios this process actually ran
const check = (name, cond) => { R[name] = cond ? 'PASS' : 'FAIL'; if (process.env.SMOKE_TRACE) process.stderr.write(`[${R[name]}] ${name}\n`); };

// The satellite data is the site's own data/ folder.  These stand in for its bad days.
const DATA = '**/data/**';
const dataRefused = (route) => route.abort('connectionrefused');
const dataHangs = () => { /* never answer */ };
const celestrakHits = [];

async function scenario(name, { data = null, storage = {}, viewport = { width: 1280, height: 800 } } = {}, fn) {
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) return;
  if (SHARD && scenarioNo++ % SHARD.of !== SHARD.n - 1) return;
  ran.push(name);
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
  await blockCelestrak(ctx, celestrakHits);   // no scenario, however broken, may fall back to asking CelesTrak
  if (data) await ctx.route(DATA, data);
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
    catalog: o?.catalog?.length ?? 0, drawn, ticks: o?.posTicks ?? 0, settled: !!o?.feedSettled,
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
// Booted = a catalog is loaded, the worker has delivered positions for it, and
// this load's attempt at the live list has finished (the app draws a saved copy
// first and swaps the live list in behind it — a scenario about something else
// must not start while that swap is still on its way).
const booted = (p, ms = 45000) => poll(() => state(p), (s) => s.catalog > 500 && s.drawn > 500 && s.settled, ms);
// On screen = satellites are drawn, whether or not the live list has answered yet.
const onScreen = (p, ms = 45000) => poll(() => state(p), (s) => s.catalog > 500 && s.drawn > 500, ms);
// Positions keep arriving (the dots are moving), not just a stale frame.
const ticking = async (p, ms = 8000) => {
  const t0 = (await state(p)).ticks;
  return (await poll(() => state(p), (s) => s.ticks >= t0 + 2, ms)).ticks >= t0 + 2;
};
const propagator = (p) => p.workers().find((w) => w.url().includes('propagator.worker'));
const passesWorker = (p) => p.workers().find((w) => w.url().includes('passes.worker'));

// =========================================================== the data feed ====

await scenario('feedRefused', { data: dataRefused }, async ({ p, errs }) => {
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  const s = await booted(p);
  check('feedRefused:bundledSnapshotLoads', s.catalog > 5000 && s.drawn > 5000);
  check('feedRefused:noErrorShown', !s.bootError && !s.card);
  check('feedRefused:countedAsDegraded', s.events.includes('degraded/catalog-bundled') && !s.events.includes('error/boot'));
  // …with the reason, so the counts can tell a refusal from a slow link.
  check('feedRefused:reasonCounted', s.events.includes('degraded/feed-network') && s.events.filter((e) => e.startsWith('degraded/feed-')).length === 1);
  check('feedRefused:dotsKeepMoving', await ticking(p));
  check('feedRefused:noPageErrors', errs.length === 0);
});

// A connection that never answers.  On a first visit there is nothing saved to
// draw, so the visitor does wait — but for one short limit, then the snapshot.
await scenario('feedHangs', { data: dataHangs }, async ({ p }) => {
  const t0 = Date.now();
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  const s = await booted(p, 70000);
  notes.feedHangsSecondsToSatellites = Math.round((Date.now() - t0) / 1000);
  // One 8 s limit, then the snapshot (≈9 s on a laptop; the bound leaves room
  // for a CI runner several times slower, and still catches "one limit per file").
  check('feedHangs:fallsBackAfterOneShortWait', s.catalog > 5000 && s.drawn > 5000 && !s.bootError && !s.card && Date.now() - t0 < 60000);
  check('feedHangs:countedAsTimeout', s.events.includes('degraded/feed-timeout') && s.events.includes('degraded/catalog-bundled'));
  check('feedHangs:dotsKeepMoving', await ticking(p));
});

// What the site sends is not satellite data — a captive portal's sign-in page,
// say, answering 200 to everything.
await scenario('feedIsGarbage', { data: (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Sign in to the airport Wi-Fi</body></html>' }) }, async ({ p, errs }) => {
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  const s = await booted(p);
  check('feedIsGarbage:bundledSnapshotLoads', s.catalog > 5000 && s.drawn > 5000 && !s.bootError && !s.card);
  check('feedIsGarbage:countedAsBadData', s.events.includes('degraded/feed-bad-data') && s.events.includes('degraded/catalog-bundled'));
  check('feedIsGarbage:noPageErrors', errs.length === 0);
});

// Make the app believe its last check for new data was long ago, so the next
// load asks the site again.
const ageSavedCopy = (p) => O(p, () => {
  const s = JSON.parse(localStorage.getItem('orbital.data'));
  s.t -= 6 * 3600 * 1000;
  localStorage.setItem('orbital.data', JSON.stringify(s));
  return s.stamp;
});

// The ordinary case: nothing has changed on the site.  Every load asks — one
// tiny request — and the lists are not downloaded again.
await scenario('nothingNewIsCheap', {}, async ({ p }) => {
  const asked = [];
  p.on('request', (r) => { if (r.url().includes('/data/')) asked.push(r.url().replace(/^.*\/data\//, '')); });
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  const first = await booted(p);
  notes.firstVisitDataRequests = [...asked];
  check('nothingNewIsCheap:firstVisitDownloadsOnce', first.catalog > 5000 && asked.filter((u) => u.startsWith('active.tle')).length === 1 && asked[0].startsWith('meta.json'));
  asked.length = 0;
  await p.reload({ waitUntil: 'load', timeout: 30000 });
  const again = await booted(p);
  notes.reloadDataRequests = [...asked];
  check('nothingNewIsCheap:reloadAsksOnlyWhetherAnythingChanged', again.catalog === first.catalog && asked.length === 1 && asked[0].startsWith('meta.json'));
  asked.length = 0;
  await ageSavedCopy(p);
  await p.reload({ waitUntil: 'load', timeout: 30000 });
  const later = await booted(p);
  notes.laterDataRequests = [...asked];
  check('nothingNewIsCheap:laterAsksOnlyWhetherAnythingChanged', later.catalog === first.catalog && asked.length === 1 && asked[0].startsWith('meta.json'));
  check('nothingNewIsCheap:thenAsksNothingAgain', await O(p, () => JSON.parse(localStorage.getItem('orbital.data')).t > Date.now() - 60000));
  check('nothingNewIsCheap:notCountedAsDegraded', !later.events.some((e) => e.startsWith('degraded/') || e.startsWith('error/')));
});

// A returning visitor on a day the site's data cannot be reached: the saved
// copy is on screen at once, and the hung request is invisible.
await scenario('returningVisitorFeedHangs', {}, async ({ ctx, p }) => {
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  await booted(p);
  await ageSavedCopy(p);
  await ctx.route(DATA, dataHangs);
  const t0 = Date.now();
  await p.reload({ waitUntil: 'load', timeout: 30000 });
  const first = await onScreen(p, 25000);
  notes.returningSecondsToSatellites = Math.round((Date.now() - t0) / 1000);
  // Drawn while the request is still hanging — i.e. nobody waited for it.
  check('returningVisitorFeedHangs:satellitesShowWithoutWaiting', first.catalog > 5000 && first.drawn > 5000 && !first.settled && !first.bootError);
  check('returningVisitorFeedHangs:dotsMoveWhileWaiting', await ticking(p));
  check('returningVisitorFeedHangs:noStaleWarningWhileWaiting', await O(p, () => document.getElementById('drift-badge').hidden));
  const s = await booted(p, 45000);
  check('returningVisitorFeedHangs:givesUpQuietly', s.settled && s.catalog === first.catalog && !s.bootError && !s.card);
  check('returningVisitorFeedHangs:countedAsStale', s.events.includes('degraded/feed-timeout') && s.events.includes('degraded/catalog-stale') && !s.events.includes('degraded/catalog-bundled'));
  check('returningVisitorFeedHangs:dotsKeepMoving', await ticking(p));
});

// The site has newer data — a different list: launches since, objects gone,
// other debris.  A returning visitor is already looking at the saved copy when
// it arrives, so the swap must not disturb them: the dots stay put and the
// satellite they have picked stays picked.
const NEWER = (() => {
  const lines = readFileSync(new URL('../public/fallback/active.tle', import.meta.url), 'utf8').split('\n').filter(Boolean);
  const active = `${lines.slice(0, 3).concat(lines.slice(3 + 3 * 40)).join('\n')}\n`;   // 40 objects gone (the first is kept)
  const debris = ['ORBITAL TEST DEB', '1 99001U 99025ZZZ 26310.50000000  .00000100  00000-0  10000-3 0  9990', '2 99001  98.6000 100.0000 0010000  90.0000 270.0000 14.30000000100000'].join('\n') + '\n';
  return { active, debris, count: lines.length / 3 - 40 + 1, stamp: 'feedfacefeedface' };
})();
const newerData = async (route) => {
  const name = new URL(route.request().url()).pathname.split('/').pop();
  const send = (body, contentType = 'text/plain') => route.fulfill({ status: 200, contentType, body }).catch(() => {});
  // Held back 10 s (the app waits up to 15): long enough, even on a slow CI
  // runner, for the saved copy to be drawn and a satellite picked first.
  if (name === 'meta.json') { await sleep(10000); return send(JSON.stringify({ stamp: NEWER.stamp, fetchedAt: Date.now() }), 'application/json'); }
  if (!route.request().url().includes(`v=${NEWER.stamp}`)) return route.abort('failed');   // must ask for exactly the data meta.json described
  if (name === 'active.tle') return send(NEWER.active);
  if (name === 'debris.tle') return send(NEWER.debris);
  if (name === 'satcat.json') return send('[]', 'application/json');
  return route.abort('failed');
};
await scenario('newDataReplacesSavedCopy', {}, async ({ ctx, p, errs }) => {
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  const visit1 = await booted(p);
  await sleep(800);
  // A first visit downloads once and shows it: there is no swap, so no "catalog updated" notice.
  check('newDataReplacesSavedCopy:newcomerSeesNoUpdateNotice', await O(p, () => document.querySelectorAll('#toasts .toast').length === 0));
  await ageSavedCopy(p);
  await ctx.route(DATA, newerData);
  await p.reload({ waitUntil: 'load', timeout: 30000 });
  const first = await onScreen(p, 25000);
  check('newDataReplacesSavedCopy:savedCopyDrawnFirst', first.catalog === visit1.catalog && !first.settled);
  // The visitor picks the Space Station before the new data has arrived.
  await O(p, () => { const o = window.__orbital; o.selectByIndex(o.catalog.findIndex((s) => s.norad === 25544)); });
  // Watch the swap: sample often what the dot cloud is drawing, keep the lowest seen.
  await O(p, () => {
    window.__minDrawn = Infinity;
    window.__watch = setInterval(() => {
      const alive = window.__orbital.swarm?._alive; let n = 0;
      if (alive) for (let i = 0; i < alive.length; i++) n += alive[i];
      window.__minDrawn = Math.min(window.__minDrawn, n);
    }, 30);
  });
  const s = await booted(p, 60000);
  await sleep(1500);
  const after = await O(p, () => {
    clearInterval(window.__watch);
    const o = window.__orbital;
    return {
      minDrawn: window.__minDrawn, catalog: o.catalog.length, hasNew: o.catalog.some((c) => c.norad === 99001 && c.kind === 'DEB'),
      selected: o.selected ? o.catalog[o.selected.index]?.norad : null, name: document.getElementById('info-name').textContent,
      saved: JSON.parse(localStorage.getItem('orbital.data')).stamp,
    };
  });
  notes.dataSwap = { before: first.catalog, after: after.catalog, minDrawn: after.minDrawn };
  check('newDataReplacesSavedCopy:newDataSwappedIn', s.settled && after.catalog === NEWER.count && after.hasNew && after.saved === NEWER.stamp);
  check('newDataReplacesSavedCopy:dotsNeverVanish', after.minDrawn > Math.min(first.catalog, after.catalog) * 0.9);
  check('newDataReplacesSavedCopy:selectionSurvives', after.selected === 25544 && /ISS|ZARYA/i.test(after.name));
  check('newDataReplacesSavedCopy:notCountedAsDegraded', !s.events.some((e) => e.startsWith('degraded/') || e.startsWith('error/')));
  check('newDataReplacesSavedCopy:dotsKeepMoving', await ticking(p));
  check('newDataReplacesSavedCopy:noPageErrors', errs.length === 0);
});

// The photos-and-descriptions file is an extra.  Without it the detail panel
// must be exactly what it was before it existed — and pick it up when it returns.
const ABOUT = '**/data/about.json*';
const aboutState = (p) => O(p, () => ({ shown: !document.getElementById('info-about').hidden, name: document.getElementById('info-name').textContent, panel: !document.getElementById('infopanel').hidden,
  alt: document.getElementById('info-alt').textContent }));
const selectNorad = (p, n) => O(p, (norad) => { const o = window.__orbital; const i = o.catalog.findIndex((s) => s.norad === norad); if (i >= 0) o.selectByIndex(i); return i >= 0; }, n);
const hasAbout = (p) => O(p, async () => !!(await window.__orbital.loadAbout()));
await scenario('aboutUnavailable', {}, async ({ ctx, p, errs }) => {
  const refuse = (route) => route.abort('failed');
  await ctx.route(ABOUT, refuse);
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  await booted(p);
  await selectNorad(p, 25544); await sleep(1800);
  const s = await aboutState(p);
  check('aboutUnavailable:panelWorksWithoutIt', s.panel && /ISS|ZARYA/i.test(s.name) && /\d/.test(s.alt) && !s.shown);
  check('aboutUnavailable:noPageErrors', errs.length === 0);
  await ctx.unroute(ABOUT, refuse);
  if (await hasAbout(p)) {                       // (a build with no about.json at all has nothing to come back)
    await selectNorad(p, 20580);
    const back = await poll(() => aboutState(p), (v) => v.shown, 8000);
    check('aboutUnavailable:returnsWhenItCan', back.shown && /HST|HUBBLE/i.test(back.name));
  }
});

// about.json is built from Wikidata, which anyone can edit.  Whatever it says is
// shown as text, and every link goes to Wikipedia or Wikimedia Commons only.
await scenario('aboutIsHostile', {}, async ({ ctx, p, errs }) => {
  const evil = { v: 1, objects: { 25544: ['<img src=x onerror="window.__xss=1">space station', 'COM', '<script>window.__xss=2</script>', '1 Jan 2020', 0,
    'javascript:alert(1)//"><svg onload=window.__xss=3>', '"><img src=x onerror=window.__xss=4>.jpg', '<b onmouseover="window.__xss=5">Mallory</b> · CC0'] } };
  await ctx.route(ABOUT, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(evil) }));
  await p.goto(SITE, { waitUntil: 'load', timeout: 30000 });
  await booted(p);
  if (!(await O(p, () => fetch('data/meta.json', { cache: 'no-store' }).then((r) => r.json()).then((m) => !!m.about, () => false)))) return;   // nothing to subvert in a build without it
  await selectNorad(p, 25544);
  await poll(() => aboutState(p), (v) => v.shown, 8000);
  await sleep(800);
  const r = await O(p, () => ({
    xss: window.__xss ?? null, shown: !document.getElementById('info-about').hidden,
    injected: document.querySelectorAll('#about-desc *, #about-facts *, #info-about script, #info-about svg, #info-about b, #about-credit img').length,
    desc: document.getElementById('about-desc').textContent,
    wiki: (() => { try { const u = new URL(document.getElementById('about-wiki').href); return `${u.protocol}//${u.hostname}${u.pathname.slice(0, 6)}`; } catch { return 'bad'; } })(),
    photo: (() => { try { const u = new URL(document.getElementById('about-photo').src); return `${u.protocol}//${u.hostname}${u.pathname.slice(0, 6)}`; } catch { return 'none'; } })(),
    page: (() => { try { const u = new URL(document.getElementById('about-photo-link').href); return `${u.protocol}//${u.hostname}${u.pathname.slice(0, 6)}`; } catch { return 'none'; } })(),
  }));
  notes.hostileAbout = r;
  check('aboutIsHostile:shownAsText', r.shown && r.injected === 0 && r.desc.includes('<img src=x'));
  check('aboutIsHostile:nothingRuns', r.xss === null && errs.length === 0);
  check('aboutIsHostile:linksStayOnWikimedia', r.wiki === 'https://en.wikipedia.org/wiki/' && ['https://commons.wikimedia.org/wiki/', 'none'].includes(r.photo) && ['https://commons.wikimedia.org/wiki/', 'none'].includes(r.page));
});

await scenario('everythingDown', { data: dataRefused }, async ({ ctx, p }) => {
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
  await ctx.unroute(DATA, dataRefused);
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

// The drawing itself throws (a driver that will not compile a shader, a code
// path one browser trips on): the visitor gets the reload card, and the count
// says which view, what sort of failure and when — and nothing from the error.
await scenario('drawingCrashes', {}, async ({ p }) => {
  await p.goto(`${SITE}#sat=25544`, { waitUntil: 'load', timeout: 30000 });
  await booted(p);
  await O(p, () => {
    // A primitive is updated inside Cesium's frame, where a real failure happens.
    window.__orbital.viewer.scene.primitives.add({
      update() { throw new TypeError("smoke: cannot read 'shaderProgram' of someone@example.com"); },
      isDestroyed: () => false, destroy() {},
    });
  });
  const s = await poll(() => state(p), (v) => v.card, 6000);
  const counted = s.events.filter((e) => e.startsWith('error/render'));
  notes.drawingCrashes = counted;
  check('drawingCrashes:cardAppears', s.card && await p.locator('#recover-reload').isVisible());
  check('drawingCrashes:countedWithViewKindAndWhen', counted.length === 1 && /^error\/render\/earth\/type\/(early|later)$/.test(counted[0]));
  check('drawingCrashes:nothingFromTheMessage', !s.events.some((e) => /smoke|example|shaderProgram/i.test(e)));
  check('drawingCrashes:notMistakenForGpuLoss', !s.events.includes('error/webgl-lost'));
  await Promise.all([p.waitForEvent('load', { timeout: 30000 }), p.locator('#recover-reload').click()]);
  const s2 = await booted(p);
  check('drawingCrashes:reloadRestoresTheApp', s2.catalog > 5000 && !s2.card);
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
  'orbital.tle.active': 'yesterday', 'orbital.tle.cosmos2251': '{"t":"soon"}', 'orbital.celestrak.down': 'banana', 'orbital.data': '{"stamp":5,"t":"never"}',
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

// Across every scenario above — data refused, hung, garbage, everything down —
// the app must never have fallen back to asking CelesTrak.
if (!ONLY.length) check('neverContactsCelestrak', celestrakHits.length === 0);
if (celestrakHits.length) notes.celestrakHits = celestrakHits.slice(0, 5);

const fails = Object.entries(R).filter(([, v]) => v === 'FAIL').map(([k]) => k);
console.log(JSON.stringify({ result: fails.length ? 'RED' : 'GREEN', checks: Object.keys(R).length, scenarios: ran, fails, R, notes }, null, 1));
process.exit(fails.length ? 1 : 0);
