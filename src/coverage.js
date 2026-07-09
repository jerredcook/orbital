// coverage.js — the "Starlink in view" heat overlay.  For every point on Earth,
// how many Starlink satellites are above the user-terminal elevation mask right
// now?  A satellite at altitude h clears elevation E from everywhere within a
// fixed Earth-central angle of its sub-satellite point:
//     λ = acos( cos E · R/(R+h) ) − E
// (~8.5° of arc for a 550 km Starlink at E = 25°).  So each satellite paints a
// spherical cap around its ground track; summing caps over the live propagator
// buffer (Earth-fixed metres — exactly the frame a ground map needs) gives the
// line-of-sight density.  That is genuinely how many satellites a dish could see,
// but it is NOT service quality: gateways, inter-satellite links, licensing
// (no service over some countries) and cell capacity aren't modelled — the UI
// says "in view", deliberately.
//
// Rendered as a 1°-cell equirectangular canvas draped on the globe as a
// SingleTileImageryLayer, recomputed every few seconds while the Earth view is
// up (the propagator pauses off-screen, so the buffer wouldn't move anyway).

import { SingleTileImageryProvider, Rectangle } from 'cesium';

const W = 360, H = 180;                   // 1° cells
const ELEV_MASK = 25 * Math.PI / 180;     // Starlink user-terminal elevation mask
const R_EARTH = 6.371e6;                  // m
const REFRESH_MS = 3000;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export function initCoverage({ viewer, getCatalog, getLastBuf, isEarthActive }) {
  const $ = (id) => document.getElementById(id);
  const counts = new Uint8Array(W * H);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);

  let enabled = false;
  let layer = null;        // current ImageryLayer
  let swapping = false;    // guard against overlapping async layer swaps
  let lastCatalog = null, starlink = [];

  // Indices of the Starlink birds (recomputed when the catalog array changes).
  function indices() {
    const catalog = getCatalog();
    if (catalog !== lastCatalog) {
      lastCatalog = catalog;
      starlink = [];
      for (let i = 0; i < catalog.length; i++) {
        if (catalog[i].name.startsWith('STARLINK')) starlink.push(i);
      }
    }
    return starlink;
  }

  // Paint one spherical cap (centre latRad/lonRad, radius capRad) into counts.
  function splat(latRad, lonRad, capRad) {
    const rows = Math.ceil(capRad * R2D);
    const sin1 = Math.sin(latRad), cos1 = Math.cos(latRad), cosCap = Math.cos(capRad);
    const lat0 = Math.round((90 - latRad * R2D));           // row index of the sub-point
    for (let dr = -rows; dr <= rows; dr++) {
      const row = lat0 + dr;
      if (row < 0 || row >= H) continue;
      const lat2 = (90 - (row + 0.5)) * D2R;                // cell-centre latitude
      const sin2 = Math.sin(lat2), cos2 = Math.cos(lat2);
      // spherical law of cosines → half-width in longitude at this latitude
      const arg = (cosCap - sin1 * sin2) / (cos1 * cos2);
      if (arg >= 1) continue;                               // row outside the cap
      const half = arg <= -1 ? Math.PI : Math.acos(arg);    // ≤ -1: cap covers the whole row (over a pole)
      const cells = Math.round(half * R2D);
      const lon0 = Math.round((lonRad * R2D + 180));
      for (let dc = -cells; dc <= cells; dc++) {
        const col = ((lon0 + dc) % W + W) % W;              // dateline wrap
        const k = row * W + col;
        if (counts[k] < 255) counts[k]++;
      }
    }
  }

  function compute() {
    const buf = getLastBuf();
    if (!buf) return 0;
    counts.fill(0);
    const idx = indices();
    for (const i of idx) {
      const x = buf[i * 3], y = buf[i * 3 + 1], z = buf[i * 3 + 2];
      if (Number.isNaN(x)) continue;                        // failed propagation
      const r = Math.hypot(x, y, z);
      if (r < R_EARTH + 100_000) continue;                  // decaying / bogus state
      const cap = Math.acos(Math.cos(ELEV_MASK) * (R_EARTH / r)) - ELEV_MASK;
      splat(Math.asin(z / r), Math.atan2(y, x), cap);
    }
    return idx.length;
  }

  // Count → colour.  The scale top adapts to the busiest cell this frame (a full
  // Starlink shell puts 30–50 in view over the mid-latitudes but only a handful
  // near the equator and poles), so the ramp always spans the real spread instead
  // of saturating: nothing = transparent, thin coverage = deep orange, climbing
  // through amber to bright teal at the peak.  `peak` is stashed for the readout.
  let peak = 0;
  function paint() {
    peak = 0;
    for (let k = 0; k < W * H; k++) if (counts[k] > peak) peak = counts[k];
    const top = Math.max(8, peak);
    const d = img.data;
    for (let k = 0; k < W * H; k++) {
      const c = counts[k];
      const o = k * 4;
      if (!c) { d[o + 3] = 0; continue; }
      const t = Math.min(1, c / top);
      d[o] = Math.round(255 - 190 * t);       // R 255 → 65
      d[o + 1] = Math.round(110 + 115 * t);   // G 110 → 225
      d[o + 2] = Math.round(50 + 155 * t);    // B 50 → 205
      d[o + 3] = Math.round(70 + 120 * t);    // alpha 0.27 → 0.75 (thin coverage stays faint)
    }
    ctx.putImageData(img, 0, 0);
  }

  async function refresh() {
    if (!enabled || swapping || !isEarthActive()) return;
    const n = compute();
    if (!n) { $('cov-count').textContent = '—'; return; }
    paint();
    $('cov-count').textContent = peak ? `≤${peak}` : '—';   // most Starlinks in view over any one point
    swapping = true;
    try {
      const provider = await SingleTileImageryProvider.fromUrl(canvas.toDataURL(), { rectangle: Rectangle.MAX_VALUE });
      if (!enabled) return;                                 // toggled off while loading
      const next = viewer.imageryLayers.addImageryProvider(provider);
      next.alpha = 0.85;                                    // per-pixel alpha does most of the work
      if (layer) viewer.imageryLayers.remove(layer, true);  // swap after the new one exists (no flicker)
      layer = next;
    } catch { /* a failed frame just leaves the previous one up */ } finally {
      swapping = false;
    }
  }

  function setEnabled(on) {
    enabled = on;
    $('cov-scale').hidden = !on;
    if (on) refresh();
    else {
      if (layer) { viewer.imageryLayers.remove(layer, true); layer = null; }
      $('cov-count').textContent = '—';
    }
  }

  $('toggle-coverage').addEventListener('change', (e) => setEnabled(e.target.checked));
  setInterval(refresh, REFRESH_MS);

  return { get enabled() { return enabled; }, refresh };
}
