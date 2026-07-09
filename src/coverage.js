// coverage.js — the "<group> in view" heat overlay.  For every point on Earth,
// how many satellites of the focused group are above the elevation mask right
// now?  A satellite at altitude h clears elevation E from everywhere within a
// fixed Earth-central angle of its sub-satellite point:
//     λ = acos( cos E · R/(R+h) ) − E
// (~8.5° of arc for a 550 km Starlink at E = 25°; a huge ~66° for a GPS bird at
// 20,200 km with a 10° receiver mask — which is why four are always in view).
// Each satellite paints that spherical cap around its ground track; summing caps
// over the live propagator buffer (Earth-fixed metres — exactly the frame a
// ground map needs) gives the line-of-sight density.  That is genuinely how many
// satellites a dish/receiver could see, but it is NOT service quality: gateways,
// inter-satellite links, licensing and capacity aren't modelled — the UI says
// "in view", deliberately.
//
// The overlay follows the "Focus a group" chips: no chip → Starlink (the classic
// question), a chip → that group, with the navigation constellations using their
// ~10° receiver mask (groups.js sets per-group `elev`).  Rendered as an
// equirectangular canvas draped on the globe as a SingleTileImageryLayer,
// recomputed every few seconds while the Earth view is up (the propagator pauses
// off-screen, so the buffer wouldn't move anyway).  Cell size adapts: 1° cells
// normally, 2° when the group's total cap area is huge (thousands of GEO/MEO
// birds under an operator chip), keeping the splat under a few ms.

import { SingleTileImageryProvider, Rectangle } from 'cesium';

const ELEV_DEFAULT = 25;                  // user-terminal mask (Starlink-style)
const R_EARTH = 6.371e6;                  // m
const REFRESH_MS = 3000;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const CELL_BUDGET = 6e6;                  // splat-cell budget before coarsening to 2°

export function initCoverage({ viewer, getCatalog, getLastBuf, isEarthActive, getActiveGroup }) {
  const $ = (id) => document.getElementById(id);
  const counts = new Uint8Array(360 * 180);            // reused at either cell size
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  let enabled = false;
  let layer = null;        // current ImageryLayer
  let swapping = false;    // guard against overlapping async layer swaps
  let lastCatalog = null, lastGroupId = '';
  let members = [];

  // Indices of the focused group's satellites (no focus → Starlink).
  function indices() {
    const catalog = getCatalog();
    const g = getActiveGroup();
    const gid = g ? g.id : '';
    if (catalog !== lastCatalog || gid !== lastGroupId) {
      lastCatalog = catalog; lastGroupId = gid;
      members = [];
      const match = g ? g.match : (s) => s.name.startsWith('STARLINK');
      for (let i = 0; i < catalog.length; i++) if (match(catalog[i])) members.push(i);
    }
    return members;
  }

  // Scratch per-member sub-point + cap radius (sized for the largest groups).
  let sLat = new Float64Array(0), sLon = new Float64Array(0), sCap = new Float64Array(0);

  // Paint one spherical cap (centre latRad/lonRad, radius capRad) into counts
  // on a W×H equirectangular grid.
  function splat(latRad, lonRad, capRad, W, H) {
    const degPerCell = 180 / H;
    const rows = Math.ceil(capRad * R2D / degPerCell);
    const sin1 = Math.sin(latRad), cos1 = Math.cos(latRad), cosCap = Math.cos(capRad);
    const lat0 = Math.round((90 - latRad * R2D) / degPerCell);
    for (let dr = -rows; dr <= rows; dr++) {
      const row = lat0 + dr;
      if (row < 0 || row >= H) continue;
      const lat2 = (90 - (row + 0.5) * degPerCell) * D2R;   // cell-centre latitude
      const sin2 = Math.sin(lat2), cos2 = Math.cos(lat2);
      // spherical law of cosines → half-width in longitude at this latitude
      const arg = (cosCap - sin1 * sin2) / (cos1 * cos2);
      if (arg >= 1) continue;                               // row outside the cap
      const half = arg <= -1 ? Math.PI : Math.acos(arg);    // ≤ -1: cap covers the whole row (over a pole)
      const cells = Math.round(half * R2D / degPerCell);
      const lon0 = Math.round((lonRad * R2D + 180) / degPerCell);
      for (let dc = -cells; dc <= cells; dc++) {
        const col = ((lon0 + dc) % W + W) % W;              // dateline wrap
        const k = row * W + col;
        if (counts[k] < 255) counts[k]++;
      }
    }
  }

  // Two passes: measure every member's sub-point + cap and estimate the total
  // splat area (picking 1° or 2° cells), then paint.  Returns { n, W, H, maskDeg }.
  function compute() {
    const buf = getLastBuf();
    if (!buf) return null;
    const idx = indices();
    const maskDeg = getActiveGroup()?.elev ?? ELEV_DEFAULT;
    const mask = maskDeg * D2R;
    if (sLat.length < idx.length) {
      sLat = new Float64Array(idx.length); sLon = new Float64Array(idx.length); sCap = new Float64Array(idx.length);
    }
    let n = 0, estCells = 0;
    for (const i of idx) {
      const x = buf[i * 3], y = buf[i * 3 + 1], z = buf[i * 3 + 2];
      if (Number.isNaN(x)) continue;                        // failed propagation
      const r = Math.hypot(x, y, z);
      if (r < R_EARTH + 100_000) continue;                  // decaying / bogus state
      const cap = Math.acos(Math.cos(mask) * (R_EARTH / r)) - mask;
      sLat[n] = Math.asin(z / r); sLon[n] = Math.atan2(y, x); sCap[n] = cap;
      estCells += 20627 * (1 - Math.cos(cap));              // cap area in 1° cells ≈ 2π(1−cosλ)·(cells/sr)
      n++;
    }
    if (!n) return { n: 0 };
    const coarse = estCells > CELL_BUDGET;                  // e.g. thousands of GEO caps under an operator chip
    const W = coarse ? 180 : 360, H = coarse ? 90 : 180;
    counts.fill(0, 0, W * H);
    for (let k = 0; k < n; k++) splat(sLat[k], sLon[k], sCap[k], W, H);
    return { n, W, H, maskDeg };
  }

  // Count → colour.  The scale top adapts to the busiest cell this frame (a full
  // Starlink shell puts 30–50 in view over the mid-latitudes but only a handful
  // near the equator and poles; GPS peaks around a dozen), so the ramp always
  // spans the real spread instead of saturating: nothing = transparent, thin
  // coverage = deep orange, climbing through amber to bright teal at the peak.
  let peak = 0;
  function paint(W, H) {
    peak = 0;
    for (let k = 0; k < W * H; k++) if (counts[k] > peak) peak = counts[k];
    const top = Math.max(8, peak);
    canvas.width = W; canvas.height = H;
    const img = ctx.createImageData(W, H);
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

  function dropLayer() {
    if (layer) { viewer.imageryLayers.remove(layer, true); layer = null; }
  }

  async function refresh() {
    if (!enabled || swapping || !isEarthActive()) return;
    // Follow the focused group: label + mask caption update even between frames.
    const g = getActiveGroup();
    $('cov-label').textContent = g ? g.label : 'Starlink';
    $('cov-mask').textContent = `${g?.elev ?? ELEV_DEFAULT}°`;
    const res = compute();
    if (!res) return;
    if (!res.n) { dropLayer(); $('cov-count').textContent = '—'; return; }   // group absent from today's catalog
    paint(res.W, res.H);
    $('cov-count').textContent = peak ? `≤${peak}` : '—';   // most in view over any one point
    swapping = true;
    try {
      const provider = await SingleTileImageryProvider.fromUrl(canvas.toDataURL(), { rectangle: Rectangle.MAX_VALUE });
      if (!enabled) return;                                 // toggled off while loading
      const next = viewer.imageryLayers.addImageryProvider(provider);
      next.alpha = 0.85;                                    // per-pixel alpha does most of the work
      dropLayer();                                          // swap after the new one exists (no flicker)
      layer = next;
    } catch { /* a failed frame just leaves the previous one up */ } finally {
      swapping = false;
    }
  }

  function setEnabled(on) {
    enabled = on;
    $('cov-scale').hidden = !on;
    if (on) refresh();
    else { dropLayer(); $('cov-count').textContent = '—'; }
  }

  $('toggle-coverage').addEventListener('change', (e) => setEnabled(e.target.checked));
  setInterval(refresh, REFRESH_MS);

  return { get enabled() { return enabled; }, refresh };
}
