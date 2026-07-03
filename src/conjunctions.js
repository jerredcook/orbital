// conjunctions.js — the close-approach features that ride the propagator's
// per-tick output plus a dedicated TCA worker:
//   • live conjunctions — the pairs the propagator flags each tick, drawn as
//     connector lines + markers with a top-10 list;
//   • forecast — for the listed pairs, the TCA worker searches 24 h ahead for
//     the time + distance of closest approach, cached per pair;
//   • screening — on demand for the selected satellite, prefilter the catalog by
//     altitude band then sweep the survivors for 24 h close approaches.
// The forecast and screening share one tca.worker.  Built with initConjunctions
// (deps below); returns the hooks main wires into its render loop + lifecycle.

import { Cartesian3, Material, JulianDate } from 'cesium';
import { CONJ_COLOR } from './palette.js';
import { altBandOf } from './orbit.js';
import { flySeconds } from './motion.js';

const SCREEN_REPORT_KM = 25;
const SCREEN_BAND_MARGIN_KM = 75;

export function initConjunctions({
  viewer, conjLines, conjMarkers,
  getCatalog, getSelected, getLastBuf, getGen,
  selectByIndex, holdAutoFollow,
}) {
  const $ = (id) => document.getElementById(id);
  const bufPos = (i) => { const b = getLastBuf(); return new Cartesian3(b[i * 3], b[i * 3 + 1], b[i * 3 + 2]); };

  const tcaWorker = new Worker(new URL('./tca.worker.js', import.meta.url), { type: 'module' });
  const tcaCache = new Map();    // "i:j" → { tcaMs, missM } (missM null = no result)
  const tcaPending = new Set();  // keys requested but not yet answered
  let screening = null;          // { targetIndex, found: [{i, tcaMs, missM}], done, active }

  tcaWorker.onerror = tcaWorker.onmessageerror = (err) => {
    console.error('tca worker error', err);
    tcaPending.clear();          // let the rows re-request instead of "computing…" forever
  };

  tcaWorker.onmessage = (e) => {
    const msg = e.data;
    if (msg.gen !== getGen()) return;   // stale: keys index the previous catalog
    if (msg.type === 'tca-results') {
      for (const r of msg.results) {
        tcaPending.delete(r.key);
        tcaCache.set(r.key, r);
      }
      // The next worker tick (≤ 600 ms) re-renders the list with the new data.
      return;
    }
    if (msg.type === 'screen-progress' && screening) {
      screening.done = msg.done;
      screening.found.push(...msg.found);
      const pct = Math.round((msg.done / msg.total) * 100);
      $('info-screen').textContent = `Screening ${msg.total.toLocaleString()} candidates… ${pct}%`;
      if (msg.found.length) renderScreenResults();
      return;
    }
    if (msg.type === 'screen-done' && screening) {
      screening.active = false;
      $('info-screen').textContent =
        `${screening.found.length} within ${SCREEN_REPORT_KM} km · screen again`;
      $('info-screen').classList.remove('active');
      renderScreenResults();
    }
  };

  function requestTca(pairs) {
    const catalog = getCatalog();
    const nowMs = JulianDate.toDate(viewer.clock.currentTime).getTime();
    const batch = [];
    for (const [i, j] of pairs) {
      const key = `${i}:${j}`;
      const cached = tcaCache.get(key);
      if (cached && cached.tcaMs !== null && cached.tcaMs < nowMs - 60_000) {
        tcaCache.delete(key);          // TCA has passed — recompute
      } else if (cached || tcaPending.has(key)) {
        continue;
      }
      tcaPending.add(key);
      batch.push({
        key,
        l1a: catalog[i].l1, l2a: catalog[i].l2,
        l1b: catalog[j].l1, l2b: catalog[j].l2,
      });
    }
    if (tcaCache.size > 500) tcaCache.clear();
    if (batch.length) {
      tcaWorker.postMessage({
        type: 'tca',
        gen: getGen(),
        startIso: JulianDate.toIso8601(viewer.clock.currentTime),
        horizonHours: 24,
        pairs: batch,
      });
    }
  }

  function fmtTca(key, nowMs) {
    if (tcaPending.has(key)) return 'computing closest approach…';
    const c = tcaCache.get(key);
    if (!c || c.tcaMs === null) return '';
    const dt = c.tcaMs - nowMs;
    if (dt < -60_000) return '';
    const km = (c.missM / 1000).toFixed(2);
    if (dt < 90_000) return `closest approach ≈ now · ${km} km`;
    const when = dt < 3.6e6
      ? `${Math.round(dt / 60_000)} min`
      : `${(dt / 3.6e6).toFixed(1)} h`;
    return `min ${km} km in ${when}`;
  }

  // Update the conjunction overlays and legend list from one worker tick's
  // pairs.  Positions come from the same buffer the swarm just drew, so the
  // markers sit exactly on their dots.
  function render(pairs) {
    const catalog = getCatalog();
    const lastBuf = getLastBuf();
    const n = pairs.length;
    while (conjLines.length < n) {
      conjLines.add({
        positions: [], width: 2, show: false,
        material: Material.fromType('Color', { color: CONJ_COLOR.withAlpha(0.8) }),
      });
    }
    while (conjMarkers.length < n * 2) {
      conjMarkers.add({ pixelSize: 5, color: CONJ_COLOR, show: false });
    }
    for (let k = 0; k < conjLines.length; k++) {
      const line = conjLines.get(k);
      if (k < n && lastBuf) {
        const [i, j] = pairs[k];
        line.positions = [bufPos(i), bufPos(j)];
        line.show = true;
        const ma = conjMarkers.get(k * 2), mb = conjMarkers.get(k * 2 + 1);
        ma.position = bufPos(i); ma.id = i; ma.show = true;
        mb.position = bufPos(j); mb.id = j; mb.show = true;
      } else {
        line.show = false;
        conjMarkers.get(k * 2).show = false;
        conjMarkers.get(k * 2 + 1).show = false;
      }
    }

    const listEl = $('conj-list');
    listEl.innerHTML = '';
    $('conj-count').textContent = $('toggle-conj').checked ? String(n) : '—';
    const top = pairs.slice(0, 10);
    if (top.length) requestTca(top);
    const nowMs = JulianDate.toDate(viewer.clock.currentTime).getTime();
    for (const [i, j, meters] of top) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'conj-row';
      const sub = fmtTca(`${i}:${j}`, nowMs);
      row.innerHTML =
        `<div class="conj-main">` +
        `<span class="cnames">${catalog[i].name} × ${catalog[j].name}</span>` +
        `<span class="ckm">${(meters / 1000).toFixed(1)} km</span></div>` +
        (sub ? `<div class="conj-sub">${sub}</div>` : '');
      row.addEventListener('click', () => flyToPair(i, j));
      listEl.appendChild(row);
    }
  }

  function flyToPair(i, j) {
    const lastBuf = getLastBuf();
    if (!lastBuf) return;
    const a = bufPos(i), b = bufPos(j);
    const mid = Cartesian3.midpoint(a, b, new Cartesian3());
    const range = Math.max(Cartesian3.distance(a, b) * 6, 100_000);
    const destination = Cartesian3.multiplyByScalar(
      Cartesian3.normalize(mid, new Cartesian3()),
      Cartesian3.magnitude(mid) + range,
      new Cartesian3(),
    );
    holdAutoFollow(3000);   // don't let auto-follow cancel the flight
    viewer.camera.flyTo({ destination, duration: flySeconds(1.6) });
    selectByIndex(i);
  }

  // ---- catalog screening (selected satellite → 24 h close-approach sweep) ----
  function startScreening() {
    const selected = getSelected();
    if (!selected) return;
    cancelScreening();
    const catalog = getCatalog();
    const target = catalog[selected.index];
    const [tPer, tApo] = altBandOf(target);
    const candidates = [];
    for (let i = 0; i < catalog.length; i++) {
      if (i === selected.index) continue;
      const [per, apo] = altBandOf(catalog[i]);
      if (per > tApo + SCREEN_BAND_MARGIN_KM || apo < tPer - SCREEN_BAND_MARGIN_KM) continue;
      candidates.push({ i, l1: catalog[i].l1, l2: catalog[i].l2 });
    }
    screening = { targetIndex: selected.index, found: [], done: 0, active: true };
    $('info-screen').textContent = `Screening ${candidates.length.toLocaleString()} candidates… 0%`;
    $('info-screen').classList.add('active');
    $('screen-results').innerHTML = '';
    tcaWorker.postMessage({
      type: 'screen',
      gen: getGen(),
      targetL1: target.l1, targetL2: target.l2,
      candidates,
      startIso: JulianDate.toIso8601(viewer.clock.currentTime),
      horizonHours: 24,
      reportKm: SCREEN_REPORT_KM,
    });
  }

  function cancelScreening() {
    if (!screening) return;
    if (screening.active) tcaWorker.postMessage({ type: 'screen-cancel' });
    screening = null;
  }

  function resetScreenUi() {
    $('info-screen').textContent = 'Screen close approaches · 24 h';
    $('info-screen').classList.remove('active');
    $('screen-results').innerHTML = '';
  }

  function renderScreenResults() {
    if (!screening) return;
    const catalog = getCatalog();
    const listEl = $('screen-results');
    listEl.innerHTML = '';
    if (screening.found.length === 0) return;
    screening.found.sort((a, b) => a.missM - b.missM);
    const head = document.createElement('div');
    head.className = 'screen-head';
    head.textContent = `closest approaches · next 24 h`;
    listEl.appendChild(head);
    const nowMs = JulianDate.toDate(viewer.clock.currentTime).getTime();
    for (const r of screening.found.slice(0, 20)) {
      const sat = catalog[r.i];
      const dt = r.tcaMs - nowMs;
      const when = dt < 90_000 ? 'now'
        : dt < 3.6e6 ? `in ${Math.round(dt / 60_000)} min`
        : `in ${(dt / 3.6e6).toFixed(1)} h`;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'conj-row';
      row.innerHTML =
        `<div class="conj-main">` +
        `<span class="cnames">${sat.name}</span>` +
        `<span class="ckm">${(r.missM / 1000).toFixed(2)} km</span></div>` +
        `<div class="conj-sub">${when}${sat.kind === 'DEB' ? ' · debris' : ''}</div>`;
      row.addEventListener('click', () => selectByIndex(r.i));
      listEl.appendChild(row);
    }
  }

  // ---- DOM wiring ----
  $('toggle-conj').addEventListener('change', () => {
    if (!$('toggle-conj').checked) render([]);
    // turning it on: the next worker tick (≤ 600 ms) delivers pairs
  });
  $('info-screen').addEventListener('click', () => {
    if (screening?.active) { cancelScreening(); resetScreenUi(); return; }
    startScreening();
  });

  // Drop cached forecasts/pending when the catalog is hot-swapped (indices moved).
  function onCatalogSwap() { tcaCache.clear(); tcaPending.clear(); }

  return { render, onCatalogSwap, cancelScreening, resetScreenUi };
}
