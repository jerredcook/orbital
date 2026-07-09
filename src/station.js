// station.js — everything that hangs off a user-placed ground station:
//   • the station marker on the globe;
//   • a passes worker that sweeps the catalog for every pass above a minimum
//     elevation over the next 24 h (rise / peak / set), streamed as a list;
//   • a live overhead sky chart (polar plot of everything currently up), fed off
//     the propagator's ECF buffer each tick;
//   • visible-pass alerts — a heads-up before the bright naked-eye craft make a
//     sunlit, dark-sky pass.
// Built with initStation(deps); returns the hooks main wires into its render
// loop, picking handler and catalog lifecycle.

import { Cartesian3, Cartesian2, Color, Cartographic, JulianDate } from 'cesium';
import * as satellite from 'satellite.js';
import { DEG2RAD, RE_KM, SUN_DARK, NAKED_EYE, sunEcefDir, compass, isSunlit } from './astro.js';
import { tleMeanMotion, tleInclination } from './data.js';
import { CAT_CSS } from './palette.js';
import { esc } from './esc.js';
import { altBandOf } from './orbit.js';
import { flySeconds } from './motion.js';

const PASS_HORIZON_H = 24;
const PASS_STORE_KEY = 'orbital.station';
const PASS_LEAD_MS = 7 * 60_000;     // announce a visible pass up to ~7 min ahead

export function initStation({
  viewer, stationPoints, stationLabels,
  getCatalog, getSelected, getLastBuf, getGen,
  catVisible, catOf,
  selectByIndex, flyToSat, setRate, setLegendOpen, toast, holdAutoFollow,
}) {
  const $ = (id) => document.getElementById(id);

  let station = null;        // { lat, lon } in degrees
  let stationPlacing = false;
  let passing = null;        // { passes: [...], active, scanId }
  let passScanId = 0;        // bumped each scan so a restart's stale in-flight batch is dropped
  let lastPassRenderMs = 0;  // throttle the streaming re-render (sort cost grows)
  const sky = { canvas: null, ctx: null, obs: null, plotted: [] };
  const alertedPasses = new Set();

  const passesWorker = new Worker(new URL('./passes.worker.js', import.meta.url), { type: 'module' });
  passesWorker.onerror = passesWorker.onmessageerror = (err) => {
    console.error('passes worker error', err);
    if (passing) { passing.active = false; updatePassStatus('pass scan failed — toggle the station to retry'); }
  };

  function drawStation() {
    stationPoints.removeAll();
    stationLabels.removeAll();
    if (!station) return;
    const pos = Cartesian3.fromDegrees(station.lon, station.lat, 0);
    stationPoints.add({
      position: pos, pixelSize: 11, color: Color.fromCssColorString('#5BE0C8'),
      outlineColor: Color.fromCssColorString('#06120F'), outlineWidth: 2,
    });
    stationLabels.add({
      position: pos, text: '⌖ station', font: '12px ui-monospace, monospace',
      fillColor: Color.fromCssColorString('#9FF3E4'), pixelOffset: new Cartesian2(0, -16),
    });
  }

  // ---- overhead sky chart ----
  // Precompute the observer's ECF position and east/north/up basis (geodetic) so
  // each tick is just a dot product per satellite.
  function prepStation() {
    if (!station) { sky.obs = null; return; }
    const latR = station.lat * DEG2RAD, lonR = station.lon * DEG2RAD;
    const o = Cartesian3.fromDegrees(station.lon, station.lat, 0);
    const sLa = Math.sin(latR), cLa = Math.cos(latR), sLo = Math.sin(lonR), cLo = Math.cos(lonR);
    sky.obs = {
      ox: o.x, oy: o.y, oz: o.z,
      ex: -sLo, ey: cLo, ez: 0,                        // east
      nx: -sLa * cLo, ny: -sLa * sLo, nz: cLa,         // north
      ux: cLa * cLo, uy: cLa * sLo, uz: sLa,           // up (zenith)
    };
  }

  function renderSky() {
    const panel = $('sky-now');
    const lastBuf = getLastBuf();
    if (!sky.ctx || panel.hidden || !sky.obs || !lastBuf) return;
    const catalog = getCatalog(), selected = getSelected();
    const ctx = sky.ctx, W = sky.canvas.width, H = sky.canvas.height;
    const cx = W / 2, cy = H / 2, R = Math.min(cx, cy) - 13 * (W / 240);
    const s = W / 240;   // scale factor vs the 240-unit design
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(9,14,23,0.9)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(120,140,165,0.30)'; ctx.lineWidth = s;
    for (const el of [0, 30, 60]) { ctx.beginPath(); ctx.arc(cx, cy, (1 - el / 90) * R, 0, 7); ctx.stroke(); }
    ctx.fillStyle = '#8FA0B4'; ctx.font = `${11 * s}px ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [lbl, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const a = az * DEG2RAD;
      ctx.fillText(lbl, cx + (R + 8 * s) * Math.sin(a), cy - (R + 8 * s) * Math.cos(a));
    }
    const o = sky.obs, minEl = Number($('pass-minel').value) || 10;
    const sun = sunEcefDir(JulianDate.toDate(viewer.clock.currentTime));
    const sunEl = sun.x * o.ux + sun.y * o.uy + sun.z * o.uz;   // sin(Sun's elevation here)
    const dark = sunEl < SUN_DARK;                              // dark enough to spot satellites
    const bright = [];                                         // headline targets, ringed + named
    sky.plotted = [];
    let count = 0, sunCount = 0;
    for (let i = 0, n = catalog.length; i < n; i++) {
      if (!catVisible[catOf(catalog[i])]) continue;
      const px = lastBuf[i * 3], py = lastBuf[i * 3 + 1], pz = lastBuf[i * 3 + 2];
      if (Number.isNaN(px)) continue;   // failed SGP4 → NaN triple (the worker's dead-object sentinel)
      const dx = px - o.ox, dy = py - o.oy, dz = pz - o.oz;
      const u = dx * o.ux + dy * o.uy + dz * o.uz;
      if (u <= 0) continue;                              // below horizon — cheap reject
      const e = dx * o.ex + dy * o.ey + dz * o.ez;
      const nn = dx * o.nx + dy * o.ny + dz * o.nz;
      const elDeg = Math.atan2(u, Math.hypot(e, nn)) * 180 / Math.PI;
      if (elDeg < minEl) continue;
      const az = Math.atan2(e, nn), r = (1 - elDeg / 90) * R;
      const x = cx + r * Math.sin(az), y = cy - r * Math.cos(az);
      // Sunlit? — outside Earth's cylindrical shadow (see astro.isSunlit).
      const sunlit = isSunlit(px, py, pz, sun);
      if (sunlit && dark) {
        sunCount++;
        const nm = NAKED_EYE.get(catalog[i].norad);
        if (nm) bright.push({ x, y, label: nm });
      }
      const selHere = selected && selected.index === i;
      // In a dark sky the shadowed satellites can't be seen — dim them so the
      // sunlit population reads as the brighter band it really is.
      ctx.globalAlpha = selHere || !dark || sunlit ? 1 : 0.4;
      ctx.fillStyle = selHere ? '#FFB454' : CAT_CSS[catOf(catalog[i])];
      ctx.beginPath(); ctx.arc(x, y, (selHere ? 4 : 2) * s, 0, 7); ctx.fill();
      if (selHere) { ctx.strokeStyle = '#fff'; ctx.lineWidth = s; ctx.stroke(); }
      sky.plotted.push({ i, x, y });
      count++;
    }
    ctx.globalAlpha = 1;
    // Ring + name the genuinely naked-eye targets when they're lit in a dark sky.
    ctx.font = `${10 * s}px ui-monospace, monospace`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const v of bright) {
      ctx.beginPath(); ctx.arc(v.x, v.y, 3 * s, 0, 7); ctx.fillStyle = '#FFF6E0'; ctx.fill();
      ctx.beginPath(); ctx.arc(v.x, v.y, 6 * s, 0, 7); ctx.lineWidth = 1.4 * s; ctx.strokeStyle = '#FFD27A'; ctx.stroke();
      ctx.fillStyle = '#FFD27A'; ctx.fillText(v.label, v.x + 8 * s, v.y);
    }
    const sunDeg = Math.asin(Math.max(-1, Math.min(1, sunEl))) / DEG2RAD;
    const lead = sunDeg > -0.83 ? '☀ daylight' : (dark ? '🌙 dark sky' : '🌅 twilight');
    const spot = bright.length ? ` · 👀 ${bright.map((v) => v.label).join(', ')} overhead` : '';
    $('sky-count').textContent = (!count ? `nothing above ${minEl}° · ${lead}`
      : dark ? `${sunCount} sunlit · ${count} up · ${lead}`
      : `${count} up · ${lead}`) + spot;
  }

  function initSkyChart() {
    sky.canvas = $('sky-canvas');
    if (!sky.canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    sky.canvas.width = sky.canvas.height = Math.round(240 * dpr);
    sky.ctx = sky.canvas.getContext('2d');
    sky.canvas.addEventListener('click', (ev) => {
      const rect = sky.canvas.getBoundingClientRect();
      const mx = (ev.clientX - rect.left) * (sky.canvas.width / rect.width);
      const my = (ev.clientY - rect.top) * (sky.canvas.height / rect.height);
      const hit = 13 * (sky.canvas.width / 240);
      let best = null, bestD = hit * hit;
      for (const p of sky.plotted) { const d = (p.x - mx) ** 2 + (p.y - my) ** 2; if (d < bestD) { bestD = d; best = p; } }
      if (best) { selectByIndex(best.i); flyToSat(best.i); setLegendOpen(false); }
    });
  }

  // ---- visible-pass alerts ----
  // Step a satellite forward from `from` and return its next visible pass
  // { rise, riseAz, peakEl } within the hour, or null.
  function nextVisiblePass(satrec, from) {
    const o = sky.obs;
    let rise = null, riseAz = 0, peakEl = 0;
    for (let m = 0.5; m <= 60; m += 0.5) {            // 30-second steps, 1 h ahead
      const t = new Date(from.getTime() + m * 60_000);
      const pv = satellite.propagate(satrec, t);
      if (!pv?.position) continue;
      const gmst = satellite.gstime(t);
      const ecf = satellite.eciToEcf(pv.position, gmst);
      const px = ecf.x * 1000, py = ecf.y * 1000, pz = ecf.z * 1000;
      const dx = px - o.ox, dy = py - o.oy, dz = pz - o.oz;
      const u = dx * o.ux + dy * o.uy + dz * o.uz;
      let visible = false, elDeg = 0, az = 0;
      if (u > 0) {
        const e = dx * o.ex + dy * o.ey + dz * o.ez, nn = dx * o.nx + dy * o.ny + dz * o.nz;
        elDeg = Math.atan2(u, Math.hypot(e, nn)) * 180 / Math.PI;
        az = Math.atan2(e, nn) * 180 / Math.PI;
        const sun = sunEcefDir(t);
        const dark = (sun.x * o.ux + sun.y * o.uy + sun.z * o.uz) < SUN_DARK;
        const sunlit = isSunlit(px, py, pz, sun);
        visible = elDeg >= 10 && sunlit && dark;
      }
      if (visible) {
        if (!rise) { rise = t; riseAz = az; }
        if (elDeg > peakEl) peakEl = elDeg;
      } else if (rise) break;                          // visible window ended
    }
    return rise ? { rise, riseAz, peakEl } : null;
  }

  function checkPassAlerts() {
    const catalog = getCatalog();
    if (!station || !sky.obs || !$('toggle-station').checked) return;
    if (Math.abs(viewer.clock.multiplier) > 4) return;          // not during fast time-warp
    const now = JulianDate.toDate(viewer.clock.currentTime);
    // "Go look up!" only makes sense when the sim clock tracks the real sky —
    // after jumping to a pass (or scrubbing) the clock can sit hours off, so a
    // pass "in ~1 min" wouldn't actually be overhead now.
    if (Math.abs(now.getTime() - Date.now()) > 120_000) return;
    for (const [norad, label] of NAKED_EYE) {
      const idx = catalog.findIndex((c) => c.norad === norad);
      if (idx < 0) continue;
      const pass = nextVisiblePass(satellite.twoline2satrec(catalog[idx].l1, catalog[idx].l2), now);
      if (!pass) continue;
      const lead = pass.rise - now;
      if (lead <= 0 || lead > PASS_LEAD_MS) continue;
      const key = `${norad}@${Math.round(pass.rise.getTime() / 60_000)}`;
      if (alertedPasses.has(key)) continue;
      alertedPasses.add(key);
      toast(
        `🛰 <b>${label}</b> visible pass in ~${Math.max(1, Math.round(lead / 60_000))} min` +
        ` · rises in the ${compass(pass.riseAz)}, peaks ~${Math.round(pass.peakEl)}° · go look up!`,
        45_000,
      );
    }
  }

  function placeStation(lat, lon) {
    station = { lat, lon };
    try { localStorage.setItem(PASS_STORE_KEY, JSON.stringify(station)); } catch { /* ignore */ }
    prepStation();
    $('sky-now').hidden = false;
    drawStation();
    startPasses();
    checkPassAlerts();
    // On a phone the pass list lives in the ☰ drawer, which we closed to free the
    // globe for the tap — point them back to it.
    if (window.matchMedia?.('(pointer: coarse)').matches) {
      toast('Ground station set — reopen ☰ for upcoming passes', 5000);
    }
  }

  // Arm "tap the globe to place a station" mode.  Closing the legend drawer is
  // the crux on mobile: it (and its scrim) sits over the globe, so without this
  // the placing tap just dismisses the menu.  The "click the map" prompt lives
  // inside that drawer too, so echo it as a toast that survives the close.
  function beginStationPlacing() {
    stationPlacing = true;
    $('pass-setloc').classList.add('active');
    setLegendOpen(false);
    updatePassStatus('click the map to place your station');
    if (window.matchMedia?.('(pointer: coarse)').matches) {
      toast('Tap the globe to drop your ground station', 6000);
    }
  }

  function loadStation() {
    try {
      const s = JSON.parse(localStorage.getItem(PASS_STORE_KEY) || 'null');
      if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon)) station = s;
    } catch { /* ignore */ }
  }

  // Prefilter: a satellite can only be seen if the station's latitude can fall
  // within (max sub-satellite latitude + the horizon's Earth-central angle) of it.
  function passCandidates(minEl) {
    const catalog = getCatalog();
    const latAbs = Math.abs(station.lat);
    const cosEl = Math.cos(minEl * DEG2RAD);
    const out = [];
    for (let i = 0; i < catalog.length; i++) {
      const sat = catalog[i];
      const revsPerDay = tleMeanMotion(sat.l2);
      if (revsPerDay && revsPerDay < 1.2) continue;   // near-geostationary: no discrete passes
      const incl = tleInclination(sat.l2) || 0;
      const maxSubLat = incl <= 90 ? incl : 180 - incl;
      const apo = altBandOf(sat)[1];
      const apoKm = Number.isFinite(apo) ? apo : 40_000;
      const ratio = (RE_KM / (RE_KM + apoKm)) * cosEl;
      const lam = Math.abs(ratio) <= 1 ? Math.acos(ratio) / DEG2RAD - minEl : 90;
      if (latAbs <= maxSubLat + lam + 5) out.push({ i, l1: sat.l1, l2: sat.l2 });
    }
    return out;
  }

  function startPasses() {
    const catalog = getCatalog();
    if (!station) return;
    if (!catalog.length) { updatePassStatus('waiting for the catalog…'); return; }
    cancelPasses();
    const minEl = Number($('pass-minel').value);
    const candidates = passCandidates(minEl);
    // A restart keeps the same catalog gen (same objects), so gen tagging can't
    // tell a cancelled scan's in-flight batch from the new one — a per-scan id
    // does (e.g. changing the min-elevation filter mid-scan).
    const scanId = ++passScanId;
    passing = { passes: [], active: true, scanId };
    passesWorker.postMessage({
      type: 'passes',
      gen: getGen(),
      scanId,
      startMs: JulianDate.toDate(viewer.clock.currentTime).getTime(),
      horizonHours: PASS_HORIZON_H,
      minElevDeg: minEl,
      station: { latRad: station.lat * DEG2RAD, lonRad: station.lon * DEG2RAD, altM: 0 },
      candidates,
    });
    updatePassStatus(`scanning ${candidates.length.toLocaleString()} satellites… 0%`);
  }

  function cancelPasses() {
    if (passing?.active) passesWorker.postMessage({ type: 'passes-cancel' });
    passing = null;
  }

  function updatePassStatus(text) {
    const el = $('pass-status');
    el.hidden = false;
    if (text) { el.textContent = text; return; }
    const n = passing ? passing.passes.length : 0;
    el.textContent = `${n} pass${n === 1 ? '' : 'es'} · next ${PASS_HORIZON_H} h`;
  }

  function renderPasses() {
    const catalog = getCatalog();
    const listEl = $('pass-list');
    if (!passing) { listEl.innerHTML = ''; $('pass-count').textContent = '—'; return; }
    const n = passing.passes.length;
    $('pass-count').textContent = !n ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    // Don't rebuild the rows while a keyboard user is on one (this streams during
    // a scan and would drop their focus).
    if (listEl.contains(document.activeElement)) return;
    listEl.innerHTML = '';
    const nowMs = JulianDate.toDate(viewer.clock.currentTime).getTime();
    const visOnly = $('pass-visonly')?.checked;
    const upcoming = passing.passes
      .filter((p) => p.setMs > nowMs && (!visOnly || p.visible))
      .sort((a, b) => a.riseMs - b.riseMs)
      .slice(0, 40);
    for (const p of upcoming) {
      const sat = catalog[p.i];
      const dt = p.riseMs - nowMs;
      const when = dt < -20_000 ? 'up now'
        : dt < 60_000 ? 'rising now'
          : dt < 3.6e6 ? `in ${Math.round(dt / 60_000)} min`
            : `in ${(dt / 3.6e6).toFixed(1)} h`;
      const durMin = Math.max(1, Math.round((p.setMs - p.riseMs) / 60_000));
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'conj-row';
      row.innerHTML =
        `<div class="conj-main"><span class="cnames">${esc(sat.name)}</span>` +
        `<span class="ckm">${p.visible ? '👁 ' : ''}${Math.round(p.peakEl)}°</span></div>` +
        `<div class="conj-sub">${when} · ${durMin} min${p.visible ? ' · visible to the eye' : ''}${sat.kind === 'DEB' ? ' · debris' : ''}</div>`;
      row.addEventListener('click', () => jumpToPass(p));
      listEl.appendChild(row);
    }
    if (visOnly && !upcoming.length) {
      const note = document.createElement('div');
      note.className = 'pass-status';
      note.textContent = 'no naked-eye passes in the scan window';
      listEl.appendChild(note);
    }
  }

  // Jump the clock to the pass's peak and fly to the satellite, so it's framed
  // high over the station; time then runs forward at 1× through the pass.
  function jumpToPass(p) {
    viewer.clock.currentTime = JulianDate.fromDate(new Date(p.peakMs));
    setRate(0);
    selectByIndex(p.i);
    flyToSat(p.i);
  }

  passesWorker.onmessage = (e) => {
    const msg = e.data;
    if (!passing || msg.gen !== getGen() || msg.scanId !== passing.scanId) return;   // stale scan (hot-swap or a restart) — drop it
    if (msg.type === 'passes-progress') {
      passing.passes.push(...msg.passes);
      updatePassStatus(`scanning ${msg.total.toLocaleString()} satellites… ${Math.round((msg.done / msg.total) * 100)}%`);
      const now = Date.now();
      if (now - lastPassRenderMs > 400) { lastPassRenderMs = now; renderPasses(); }
    } else if (msg.type === 'passes-done') {
      passing.active = false;
      renderPasses();
      updatePassStatus();
    }
  };

  // ---- DOM wiring ----
  $('toggle-station').addEventListener('change', (e) => {
    if (e.target.checked) {
      $('pass-controls').hidden = false;
      if (station) { prepStation(); $('sky-now').hidden = false; drawStation(); startPasses(); }
      else updatePassStatus('Use your location, or tap the map, to set a ground station');
    } else {
      stationPlacing = false;
      cancelPasses();
      stationPoints.removeAll();
      stationLabels.removeAll();
      $('pass-controls').hidden = true;
      $('sky-now').hidden = true;
      $('pass-list').innerHTML = '';
      $('pass-status').hidden = true;
      $('pass-count').textContent = '—';
      $('pass-setloc').classList.remove('active');
    }
  });

  $('pass-setloc').addEventListener('click', () => {
    if (stationPlacing) { stationPlacing = false; $('pass-setloc').classList.remove('active'); }
    else beginStationPlacing();
  });

  // One-tap station at the visitor's own location — the fast path to "what flies
  // over my house".  Falls back to the tap-the-map flow if it's denied/blocked.
  $('pass-geoloc').addEventListener('click', () => {
    if (!navigator.geolocation) {
      toast('Location isn’t available here — tap the map to place your station instead');
      return;
    }
    stationPlacing = false;                       // geolocation supersedes any pending tap-to-place
    $('pass-setloc').classList.remove('active');
    $('pass-geoloc').classList.add('active');
    updatePassStatus('finding your location…');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        $('pass-geoloc').classList.remove('active');
        setLegendOpen(false);                     // the drawer covers the globe on mobile
        placeStation(coords.latitude, coords.longitude);
        // The visitor didn't pick the spot, so fly there to show it.
        holdAutoFollow(3000);
        viewer.camera.flyTo({
          destination: Cartesian3.fromDegrees(coords.longitude, coords.latitude, 7.5e6),
          duration: flySeconds(1.6),
        });
      },
      () => {
        $('pass-geoloc').classList.remove('active');
        updatePassStatus('couldn’t get your location — tap the map instead');
        toast('Couldn’t get your location — tap the map to place your station');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  });

  $('pass-visonly').addEventListener('change', renderPasses);
  $('pass-minel').addEventListener('change', () => {
    if ($('toggle-station').checked && station) startPasses();
  });

  // The picking handler hands globe clicks here first; consume the click when
  // we're in "tap to place a station" mode.
  function handleGlobeClick(clickPosition) {
    if (!stationPlacing) return false;
    const cart = viewer.camera.pickEllipsoid(clickPosition, viewer.scene.globe.ellipsoid);
    if (cart) {
      const c = Cartographic.fromCartesian(cart);
      stationPlacing = false;
      $('pass-setloc').classList.remove('active');
      placeStation(c.latitude / DEG2RAD, c.longitude / DEG2RAD);
    }
    return true;
  }

  // A full catalog hot-swap renumbers every index, so any pass results point at
  // the wrong satellites — drop them and re-scan if the station is live.
  function onCatalogSwap() {
    // A station placed before the catalog loaded left passing=null with the
    // status stuck at "waiting for the catalog…"; when it arrives, kick off the
    // first scan even though nothing was in flight.
    if (!passing) { if ($('toggle-station').checked && station) startPasses(); return; }
    cancelPasses();
    $('pass-list').innerHTML = '';
    $('pass-count').textContent = '—';
    if ($('toggle-station').checked && station) startPasses();
  }

  // An in-place element refresh keeps indices, but the elements are newer —
  // re-scan so the pass times track them.
  function onElementsRefresh() {
    if (passing && $('toggle-station').checked && station) { cancelPasses(); startPasses(); }
  }

  // ---- boot ----
  initSkyChart();
  setInterval(checkPassAlerts, 60_000);
  // The pass list is rendered once when a scan finishes, but its "in 47 min" /
  // "up now" labels age; re-render a finished scan periodically so they stay true
  // (skipped while a keyboard user is on a row, see renderPasses).
  setInterval(() => { if (passing && !passing.active) renderPasses(); }, 30_000);
  loadStation();
  // A returning visitor with a saved spot shouldn't have to re-arm the station
  // every day: bring the passes (and sky chart) straight back.
  if (station) {
    $('toggle-station').checked = true;
    $('pass-controls').hidden = false;
    prepStation();
    $('sky-now').hidden = false;
    // wait for the catalog before scanning
    const armWhenReady = setInterval(() => {
      if (!getCatalog().length) return;
      clearInterval(armWhenReady);
      drawStation();
      startPasses();
    }, 500);
  }

  return {
    renderSky, checkPassAlerts, handleGlobeClick, onCatalogSwap, onElementsRefresh,
    get skyPlotted() { return sky.plotted; },
  };
}
