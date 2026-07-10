// smoke.mjs — headless behaviour check for the whole app, the safety net the
// review sessions leaned on (now committed so its coverage can't silently rot).
// It drives a real page against a running dev server and asserts the key paths
// plus the regressions the second review caught: showpiece entities survive a
// deselect, external names are HTML-escaped not executed, the dialogs manage
// focus, list rows keep keyboard focus across a rebuild, and full-catalog
// propagation pauses when the Earth view is off-screen.
//
//   npm run dev            # terminal 1 (note the port it prints)
//   PORT=5173 npm run smoke # terminal 2
//
// Or against the production build (what CI gates deploys on — note the base path):
//   npm run build && npx vite preview --port 4173 &
//   SMOKE_URL=http://localhost:4173/orbital/ npm run smoke
//
// Uses playwright-core with channel:'chrome', so it needs Google Chrome present
// but downloads no browsers.  Default port 5173 (Vite's default).
import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = process.env.PORT || '5173';
const URL = process.env.SMOKE_URL || `http://localhost:${PORT}/`;

const b = await chromium.launch({
  channel: 'chrome', headless: true,
  // swiftshader/angle: software WebGL so this runs on GPU-less CI runners;
  // disable-dev-shm-usage: CI containers mount a tiny /dev/shm that crashes tabs.
  args: ['--enable-unsafe-swiftshader', '--no-sandbox', '--use-gl=angle', '--enable-gpu', '--disable-dev-shm-usage'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.addInitScript(() => {
  try {
    localStorage.setItem('orbital.station', JSON.stringify({ lat: 40.7128, lon: -74.006 }));
    localStorage.setItem('orbital.welcomed', '1');
  } catch { /* ignore */ }
});
const pageErrors = []; const consoleErrors = [];
p.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });

const R = {};
const check = (name, cond) => { R[name] = cond ? 'PASS' : 'FAIL'; };

try {
  await p.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await p.waitForFunction(() => window.__orbital?.catalog?.length > 500, { timeout: 45000 });
  check('catalogLoads', await p.evaluate(() => window.__orbital.catalog.length > 500));

  // baseline showpiece entity count (they live in viewer.entities)
  const showBefore = await p.evaluate(() => window.__orbital.viewer.entities.values.filter((e) => e.point || e.label).length);
  R._showBefore = showBefore;

  // --- select ISS, live readout, orbit track ---
  await p.evaluate(() => window.__orbital.selectByIndex(window.__orbital.catalog.findIndex((s) => s.norad === 25544)));
  await sleep(1500);
  const sel = await p.evaluate(() => ({ selected: !!window.__orbital.selected, name: document.getElementById('info-name').textContent, alt: document.getElementById('info-alt').textContent }));
  check('selectWorks', sel.selected && /ISS|ZARYA/i.test(sel.name));
  check('liveAltTicks', /\d/.test(sel.alt) && sel.alt !== '—');
  await p.evaluate(() => { const t = document.getElementById('toggle-orbit'); if (!t.checked) t.click(); });
  await sleep(400);
  check('orbitTrack', await p.evaluate(() => !!window.__orbital.selected?.trackEntity));

  // --- CRIT-1: deselect must NOT destroy the showpiece entities ---
  await p.evaluate(() => document.getElementById('info-close').click());
  await sleep(400);
  const showAfter = await p.evaluate(() => window.__orbital.viewer.entities.values.filter((e) => e.point || e.label).length);
  R._showAfter = showAfter;
  check('showpiecesSurviveDeselect', showAfter >= showBefore && showBefore >= 10);

  // --- showpiece inspect AFTER a deselect actually resolves to a live entity ---
  const insp = await p.evaluate(() => {
    const box = document.getElementById('search');
    box.value = 'JWST'; box.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#search-results .result-row').click();
    const t = window.__orbital.viewer.trackedEntity;
    return { tracked: !!t, inCollection: !!t && window.__orbital.viewer.entities.values.includes(t), hash: location.hash };
  });
  await sleep(600);
  check('showpieceInspectLive', insp.tracked && insp.inCollection && /jwst/i.test(insp.hash));
  await p.keyboard.press('Escape');
  await sleep(400);

  // --- conjunctions ---
  await p.evaluate(() => { const t = document.getElementById('toggle-conj'); if (!t.checked) t.click(); });
  await sleep(2200);
  check('conjCount', await p.evaluate(() => /^\d+$/.test(document.getElementById('conj-count').textContent)));

  // --- CRIT-4: keyboard focus on a conj row survives a 600ms rebuild tick ---
  const conjFocus = await p.evaluate(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = document.querySelector('#conj-list .conj-row');
    if (!row) return { hadRow: false };
    row.focus();
    await nap(900);   // > one propagator tick
    return { hadRow: true, stillFocused: document.getElementById('conj-list').contains(document.activeElement) };
  });
  check('conjRowKeyboardStable', !conjFocus.hadRow || conjFocus.stillFocused);
  R._conjFocus = conjFocus;

  // --- station auto-armed → sky chart + passes ---
  await sleep(2500);
  const station = await p.evaluate(() => ({ on: document.getElementById('toggle-station').checked, sky: (window.__orbital.skyPlotted || []).length, pass: document.getElementById('pass-count').textContent }));
  check('stationAutoArmed', station.on);
  R._sky = station.sky; R._pass = station.pass;
  check('passAlertsNoThrow', await p.evaluate(() => { try { window.__orbital.checkPassAlerts(); return true; } catch { return false; } }));

  // --- screening ---
  await p.evaluate(() => window.__orbital.selectByIndex(window.__orbital.catalog.findIndex((s) => s.norad === 25544)));
  await sleep(500);
  await p.evaluate(() => document.getElementById('info-screen').click());
  await sleep(3500);
  check('screening', await p.evaluate(() => /Screening|within|km/.test(document.getElementById('info-screen').textContent)));
  await p.evaluate(() => { const s = document.getElementById('info-screen'); if (s.classList.contains('active')) s.click(); });
  await p.evaluate(() => document.getElementById('info-close').click());
  await sleep(300);

  // --- search: catalog / showpiece / body ---
  const search = await p.evaluate(() => {
    const box = document.getElementById('search'); const n = () => document.getElementById('search-results').children.length;
    box.value = 'STARLINK'; box.dispatchEvent(new Event('input', { bubbles: true })); const cat = n();
    box.value = 'VOYAGER'; box.dispatchEvent(new Event('input', { bubbles: true })); const show = n();
    box.value = 'JUPITER'; box.dispatchEvent(new Event('input', { bubbles: true })); const body = n();
    box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true }));
    return { cat, show, body };
  });
  check('searchCatalog', search.cat > 0);
  check('searchShowpiece', search.show > 0);
  check('searchBody', search.body > 0);

  // --- CRIT-2: XSS — a malicious catalog name must be escaped, not executed ---
  const xss = await p.evaluate(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__xss = 0;
    const O = window.__orbital; const list = O.catalog.slice();
    const bad = { ...list[0], name: '<img src=x onerror="window.__xss=1">PWN', norad: 999999001 };
    list[0] = bad;
    O.applyCatalog(list);
    await nap(300);
    const box = document.getElementById('search');
    box.value = 'PWN'; box.dispatchEvent(new Event('input', { bubbles: true }));
    await nap(200);
    const html = document.getElementById('search-results').innerHTML;
    const injected = document.querySelector('#search-results img');
    box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true }));
    return { fired: window.__xss, hasImg: !!injected, escaped: html.includes('&lt;img') };
  });
  check('xssEscaped', xss.fired === 0 && !xss.hasImg && xss.escaped);
  R._xss = xss;

  // --- CRIT-3: dialog focus management ---
  const dlg = await p.evaluate(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById('help-toggle').focus();
    document.getElementById('help-toggle').click();   // open welcome
    await nap(200);
    const focusInDialog = document.getElementById('welcome').contains(document.activeElement);
    document.getElementById('welcome-go').click();     // close
    await nap(200);
    const restored = document.activeElement === document.getElementById('help-toggle');
    return { focusInDialog, restored };
  });
  check('dialogFocusIn', dlg.focusInDialog);
  check('dialogFocusRestore', dlg.restored);

  // --- system / moon views ---
  await p.evaluate(() => window.__orbital.systemView.show()); await sleep(1400);
  check('systemShow', await p.evaluate(() => window.__orbital.systemView.visible));
  await p.evaluate(() => window.__orbital.systemView.focus('Saturn')); await sleep(1200);
  await p.evaluate(() => window.__orbital.systemView.focus('Pluto')); await sleep(1200);
  await p.evaluate(() => window.__orbital.systemView.focus('Cassini')); await sleep(1200);
  check('systemFocus', await p.evaluate(() => !!window.__orbital.systemView.visible));

  // --- spacecraft arrival timeline (sys-probes.js): toggle, scrub, era flash ---
  const ptl = await p.evaluate(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById('ptl-toggle').click();      // on → jumps to 1970
    await nap(250);
    const at1970 = document.getElementById('ptl-label').textContent;
    const y = document.getElementById('ptl-year');
    y.value = '2005'; y.dispatchEvent(new Event('input', { bubbles: true }));
    await nap(250);
    const at2005 = document.getElementById('ptl-label').textContent;
    const era = document.getElementById('tl-era').textContent;   // crossing 1971→2005 flashes a milestone
    document.getElementById('ptl-toggle').click();      // off
    return { at1970, at2005, era };
  });
  check('probeTimeline', ptl.at1970 === '1970' && ptl.at2005 === '2005' && ptl.era.length > 0);
  R._ptl = ptl;
  await p.evaluate(() => { if (window.__orbital.systemView.visible) window.__orbital.systemView.hide(); }); await sleep(900);
  check('systemHide', await p.evaluate(() => !window.__orbital.systemView.visible));
  await p.evaluate(() => window.__orbital.moonView.show()); await sleep(1400);
  check('moonShow', await p.evaluate(() => window.__orbital.moonView.visible));
  await p.evaluate(() => window.__orbital.moonView.hide()); await sleep(900);
  check('moonHide', await p.evaluate(() => !window.__orbital.moonView.visible));

  // --- launch timeline ---
  const tl = await p.evaluate(() => {
    document.getElementById('toggle-timeline').click();
    const y = document.getElementById('tl-year'); y.value = '1965'; y.dispatchEvent(new Event('input', { bubbles: true }));
    const label = document.getElementById('tl-label').textContent;
    document.getElementById('toggle-timeline').click();
    return label;
  });
  check('timelineScrub', /1965/.test(tl) && /tracked/.test(tl));

  // --- group focus: Starlink chip filters the swarm + is deep-linkable ---
  const grp = await p.evaluate(() => {
    const O = window.__orbital;
    const chip = document.querySelector('.group-chip[data-id=starlink]');
    const count = chip?.querySelector('.g-count')?.textContent;
    chip?.click();
    const r = {
      hasChip: !!chip, count,
      active: O.groups.activeId(), hash: location.hash,
      keepStarlink: O.groups.passes({ name: 'STARLINK-1', meta: {} }),
      dropOther: O.groups.passes({ name: 'ISS (ZARYA)', meta: { owner: 'US' } }),
    };
    chip?.click();   // clear
    r.clearedActive = O.groups.activeId();
    return r;
  });
  check('groupFocus', grp.hasChip && grp.active === 'starlink' && /group=starlink/.test(grp.hash)
    && grp.keepStarlink && !grp.dropOther && grp.clearedActive === null);
  R._group = grp;

  // --- coverage overlay: toggle adds an imagery layer + a peak readout, off removes
  // it, and the overlay follows the focused group (GPS → 10° receiver mask) ---
  const cov = await p.evaluate(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const O = window.__orbital;
    const before = O.viewer.imageryLayers.length;
    document.getElementById('toggle-coverage').click();
    await nap(4500);
    const on = { layers: O.viewer.imageryLayers.length, enabled: O.coverage.enabled, count: document.getElementById('cov-count').textContent, label: document.getElementById('cov-label').textContent };
    document.querySelector('.group-chip[data-id=gps]')?.click();   // overlay follows the focused group
    await nap(4500);
    const gps = { label: document.getElementById('cov-label').textContent, mask: document.getElementById('cov-mask').textContent, count: document.getElementById('cov-count').textContent };
    document.querySelector('.group-chip[data-id=gps]')?.click();   // clear focus
    document.getElementById('toggle-coverage').click();
    await nap(400);
    return { before, on, gps, offLayers: O.viewer.imageryLayers.length };
  });
  check('coverageOverlay', cov.on.enabled && cov.on.layers > cov.before && /\d/.test(cov.on.count)
    && cov.on.label === 'Starlink' && cov.offLayers === cov.before);
  check('coverageFollowsGroup', cov.gps.label === 'GPS' && cov.gps.mask === '10°' && /\d/.test(cov.gps.count));
  R._cov = cov;

  // --- a11y landmarks + combobox ---
  const a11y = await p.evaluate(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const h1 = document.querySelector('h1'); const main = document.querySelector('[role=main], main');
    const box = document.getElementById('search'); box.focus();
    box.value = 'STARLINK'; box.dispatchEvent(new Event('input', { bubbles: true })); await nap(100);
    const expanded = box.getAttribute('aria-expanded') === 'true';
    const opts = document.querySelectorAll('#search-results [role=option]').length;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await nap(50);
    const active = !!box.getAttribute('aria-activedescendant');
    box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true }));
    return { h1: !!(h1 && h1.textContent.trim()), main: !!main, combobox: box.getAttribute('role') === 'combobox', expanded, opts, active };
  });
  check('a11yLandmarks', a11y.h1 && a11y.main);
  check('a11yCombobox', a11y.combobox && a11y.expanded && a11y.opts > 0 && a11y.active);

  // --- idle-pause: propagation ticks on Earth, stops in System view ---
  const idle = await p.evaluate(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const a = window.__orbital.posTicks; await nap(1600); const earth = window.__orbital.posTicks - a;
    window.__orbital.systemView.show(); await nap(500);
    const c = window.__orbital.posTicks; await nap(1600); const sys = window.__orbital.posTicks - c;
    window.__orbital.systemView.hide(); await nap(500);
    return { earth, sys };
  });
  check('propagatesInEarthView', idle.earth > 0);
  check('pausesInSystemView', idle.sys === 0);
  R._idle = idle;

  check('noPageErrors', pageErrors.length === 0);
} catch (e) {
  R._fatal = String(e).slice(0, 240);
} finally {
  await b.close();
}

const fails = Object.entries(R).filter(([k, v]) => v === 'FAIL').map(([k]) => k);
console.log(JSON.stringify({ result: (fails.length || R._fatal) ? 'RED' : 'GREEN', fails, R, pageErrors, consoleErrors: consoleErrors.slice(0, 4) }, null, 1));
process.exit((fails.length || R._fatal) ? 1 : 0);
