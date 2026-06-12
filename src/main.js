// main.js — scene setup, render loop, and UI wiring.

import {
  Viewer, ImageryLayer, UrlTemplateImageryProvider, EllipsoidTerrainProvider,
  Credit, Cartesian3, Color, PointPrimitiveCollection, JulianDate,
  ScreenSpaceEventHandler, ScreenSpaceEventType, Moon, defined,
  PolylineCollection, Material, DistanceDisplayCondition, Matrix3, Quaternion,
  CallbackProperty,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import * as satellite from 'satellite.js';
import { loadCatalog, cacheExpiresInMs } from './data.js';
import { decodeOwner, decodeSite } from './decode.js';
import { SatSwarm } from './swarm.js';
import { initMoonView } from './moon.js';

// ---------------------------------------------------------------- scene ----

// Display categories: the four orbit regimes for payloads, DEB for debris.
const CAT_COLORS = {
  LEO: Color.fromCssColorString('#5EC8E5'),
  MEO: Color.fromCssColorString('#C9A0FF'),
  GEO: Color.fromCssColorString('#FFD166'),
  HEO: Color.fromCssColorString('#FF8C66'),
  DEB: Color.fromCssColorString('#8B93A1'),
};
const SELECT_COLOR = Color.fromCssColorString('#FFB454');
const CONJ_COLOR = Color.fromCssColorString('#FF4D5E');

// Esri World Imagery: global high-resolution satellite imagery, street-level
// (~0.3 m/px) in populated areas, served keylessly with attribution.  Swap in
// Cesium Ion's Bing Aerial + World Terrain here if you ever add an Ion token.
const ESRI_IMAGERY = new UrlTemplateImageryProvider({
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  maximumLevel: 19,
  credit: new Credit('Imagery © Esri — Maxar, Earthstar Geographics, and the GIS User Community'),
});

// How close the camera may get to the globe when not inspecting a satellite.
const MIN_ZOOM_GROUND_M = 80;

const viewer = new Viewer('cesiumContainer', {
  baseLayer: new ImageryLayer(ESRI_IMAGERY),
  terrainProvider: new EllipsoidTerrainProvider(),
  baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, navigationHelpButton: false, animation: false,
  timeline: false, fullscreenButton: false, infoBox: false,
  selectionIndicator: false,
});

viewer.scene.moon = new Moon();
viewer.scene.globe.enableLighting = true;
viewer.scene.screenSpaceCameraController.minimumZoomDistance = MIN_ZOOM_GROUND_M;
viewer.clock.shouldAnimate = true;
viewer.clock.multiplier = 1;

// The "◐ Moon" toggle flies to a separate lunar globe (LRO imagery on the
// Moon ellipsoid) you can zoom into; see src/moon.js.
const moonView = initMoonView(viewer);

// The whole catalog renders through one GPU point-cloud primitive; this
// little collection only ever holds the enlarged selection highlight.
const overlay = viewer.scene.primitives.add(new PointPrimitiveCollection());

// Conjunction overlays: connector lines and endpoint markers, updated on
// every worker tick while the conjunction toggle is on (≤ 100 pairs).
// Pooled rather than rebuilt — PolylineCollection.removeAll() destroys each
// polyline's Material, so re-adding every tick crashes the render loop.
const conjLines = viewer.scene.primitives.add(new PolylineCollection());
const conjMarkers = viewer.scene.primitives.add(new PointPrimitiveCollection());

// ---------------------------------------------------------------- state ----

let catalog = [];          // [{ name, l1, l2, norad, kind, meta, regime }]
let swarm = null;          // SatSwarm, one point per catalog index
let selected = null;       // { index, satrec, highlight }
let following = false;
let autoFollowHoldUntil = 0;   // suppress auto-follow during camera flights
let lastBuf = null;        // most recent worker position buffer (meters, ECF)
const catVisible = { LEO: true, MEO: true, GEO: true, HEO: true, DEB: true };
const catOf = (sat) => (sat.kind === 'DEB' ? 'DEB' : sat.regime);

const $ = (id) => document.getElementById(id);
const status = (msg) => { $('status').textContent = msg; };

// --------------------------------------------------------------- worker ----

const worker = new Worker(
  new URL('./propagator.worker.js', import.meta.url),
  { type: 'module' },
);

let workerBusy = false;
worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    status(`${msg.count.toLocaleString()} objects on orbit`);
    return;
  }
  if (msg.type === 'positions') {
    workerBusy = false;
    lastBuf = msg.buf;
    swarm?.updatePositions(msg.buf);
    renderConjunctions(msg.pairs ?? []);
  }
};

// Ask the worker for a full-catalog update ~every 600 ms of wall time,
// evaluated at the simulation clock's current moment.
setInterval(() => {
  if (workerBusy || catalog.length === 0) return;
  workerBusy = true;
  worker.postMessage({
    type: 'propagate',
    isoTime: JulianDate.toIso8601(viewer.clock.currentTime),
    conjKm: $('toggle-conj').checked ? Number($('conj-range').value) : 0,
  });
}, 600);

// ----------------------------------------------------------------- boot ----

// Swap in a (new) catalog: rebuild the swarm, re-init the worker, reset
// everything index-based.  Called at boot and again on auto-refresh.
function applyCatalog(list) {
  clearSelection();
  $('infopanel').hidden = true;
  tcaCache.clear();
  tcaPending.clear();
  if (swarm) viewer.scene.primitives.remove(swarm);   // destroys GL resources

  catalog = list;
  swarm = new SatSwarm(catalog.length);
  const counts = { LEO: 0, MEO: 0, GEO: 0, HEO: 0, DEB: 0 };
  for (let i = 0; i < catalog.length; i++) {
    const cat = catOf(catalog[i]);
    counts[cat]++;
    swarm.setStyle(i, CAT_COLORS[cat], cat === 'DEB' ? 1.7 : 2.2);
    if (!catVisible[cat]) swarm.setVisible(i, false);
  }
  viewer.scene.primitives.add(swarm);
  for (const c of Object.keys(counts)) {
    $(`count-${c}`).textContent = counts[c].toLocaleString();
  }

  worker.postMessage({
    type: 'init',
    tles: catalog.map(({ norad, l1, l2 }) => ({ norad, l1, l2 })),
  });
}

async function boot() {
  try {
    const list = await loadCatalog(status);
    diffAndToast(list);
    applyCatalog(list);
  } catch (err) {
    status('catalog fetch failed — see console');
    console.error(err);
  }
}
boot();

// ----------------------------------------------------------- auto-refresh ----
// When the 2 h element-set cache lapses, re-fetch and hot-swap the catalog.
// New NORAD IDs are launches (or newly cataloged objects), dropped IDs are
// decays/delistings; both get a toast.  The ID snapshot persists across
// sessions, so tomorrow's first load reports what changed overnight.

const ID_SNAPSHOT_KEY = 'orbital.known-ids';
let prevNames = new Map();   // norad → name from the previous catalog (in-memory)

function diffAndToast(list) {
  let prev = null;
  try { prev = JSON.parse(localStorage.getItem(ID_SNAPSHOT_KEY)); } catch { /* none */ }
  const nowIds = new Set(list.map((s) => s.norad));
  if (prev?.ids?.length) {
    // A >20% size jump means a partial load (source down) or its recovery,
    // not launches/decays — rebaseline silently instead of toasting 15k
    // "new" objects.
    const ratio = list.length / prev.ids.length;
    if (ratio >= 0.8 && ratio <= 1.25) {
      const prevIds = new Set(prev.ids);
      const added = list.filter((s) => !prevIds.has(s.norad));
      const removed = prev.ids
        .filter((id) => !nowIds.has(id))
        .map((id) => prevNames.get(id) ?? `#${id}`);
      if (added.length || removed.length) {
        toastCatalogDiff(added.map((s) => s.name), removed, prev.t);
      }
    } else {
      console.warn(`catalog size jumped ${prev.ids.length} → ${list.length}; rebaselining without diff`);
    }
  }
  try {
    localStorage.setItem(ID_SNAPSHOT_KEY, JSON.stringify({ t: Date.now(), ids: [...nowIds] }));
  } catch { /* quota — skip */ }
  prevNames = new Map(list.map((s) => [s.norad, s.name]));
}

function toastCatalogDiff(addedNames, removedNames, sinceMs) {
  const fmtList = (names) => names.slice(0, 4).join(', ')
    + (names.length > 4 ? ` +${names.length - 4} more` : '');
  const h = (Date.now() - sinceMs) / 3.6e6;
  const ago = h < 1.5 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`;
  const parts = [`<div class="t-head">catalog updated · vs ${ago} ago</div>`];
  if (addedNames.length) {
    parts.push(`<div class="t-add">▲ ${addedNames.length} new on orbit: ${fmtList(addedNames)}</div>`);
  }
  if (removedNames.length) {
    parts.push(`<div class="t-del">▼ ${removedNames.length} gone (decayed/delisted): ${fmtList(removedNames)}</div>`);
  }
  toast(parts.join(''));
}

function toast(html, ms = 15_000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 700);
  }, ms);
}

let lastRefreshAttempt = 0;

async function refreshCatalog() {
  lastRefreshAttempt = Date.now();
  try {
    const list = await loadCatalog(status);
    const unchanged = list.length === catalog.length
      && list.every((s, i) => s.norad === catalog[i].norad);
    if (unchanged) {
      status(`${catalog.length.toLocaleString()} objects on orbit`);
      return;
    }
    diffAndToast(list);
    applyCatalog(list);
  } catch (err) {
    console.warn('catalog refresh failed — keeping current data', err);
  }
}

// Stale-cache fallback means a refresh attempt re-parses the whole catalog
// even when the source is down, so space the attempts out.
setInterval(() => {
  if (!catalog.length) return;
  if (cacheExpiresInMs() > 0) return;
  if (Date.now() - lastRefreshAttempt < 20 * 60 * 1000) return;
  refreshCatalog();
}, 5 * 60 * 1000);

// ------------------------------------------------------------- selection ----

// ------------------------------------------------------------- 3D models ----
// Inside this camera range the selected satellite's dot hands off to a real
// 3D model: NASA's published glTFs for the ISS and Hubble, class-appropriate
// generics (built by tools/make-models.mjs) for everything else.

const MODEL_SWAP_M = 150_000;

// Spacecraft with real published models (NASA solarsystem.nasa.gov and
// github.com/nasa/NASA-3D-Resources), keyed by NORAD ID — exact IDs because
// catalog names are full of traps (SAOCOM contains "OCO", TERRASAR-X
// contains "TERRA").  GRACE-FO reuses the GRACE bus; Landsat 9 is a
// near-copy of Landsat 8; Sentinel-6B matches 6A.
// Scale maps each model's true rendered extent (accessor bounds pushed
// through the node hierarchy — see the audit in tools/) to the spacecraft's
// real deployed size in meters.  The published GLBs are wildly inconsistent:
// Terra renders 26 km long, TDRS 0.9 m, while ISS (112 m), Chandra (19.5 m)
// and Sentinel-6 (5.1 m) are already true to life.
const REAL_MODELS = new Map([
  [25544, { file: 'iss', scale: 1 }],
  [20580, { file: 'hubble', scale: 1 }],
  [25994, { file: 'terra', scale: 0.00035 }],
  [27424, { file: 'aqua', scale: 0.0385 }],
  [28376, { file: 'aura', scale: 0.34 }],
  [43613, { file: 'icesat2', scale: 1 }],
  [39084, { file: 'landsat8', scale: 1 }],
  [49260, { file: 'landsat8', scale: 1 }],
  [46984, { file: 'sentinel6', scale: 1 }],
  [66514, { file: 'sentinel6', scale: 1 }],
  [40059, { file: 'oco2', scale: 0.23 }],
  [37849, { file: 'suominpp', scale: 1 }],
  [28485, { file: 'swift', scale: 0.143 }],
  [33053, { file: 'fermi', scale: 0.24 }],     // FGRST (GLAST)
  [25867, { file: 'chandra', scale: 1 }],      // CXO
  [43476, { file: 'grace', scale: 1 }],
  [43477, { file: 'grace', scale: 1 }],
  [43435, { file: 'tess', scale: 0.11 }],      // not in 'active' today
  [50463, { file: 'jwst', scale: 0.74 }],      // not in 'active' today
]);

function modelFor(sat) {
  const real = REAL_MODELS.get(sat.norad);
  if (real) return { uri: `/models/${real.file}.glb`, scale: real.scale };
  if (/^TDRS \d/.test(sat.name)) return { uri: '/models/tdrs.glb', scale: 19.6 };
  if (sat.kind === 'DEB' || /\bDEB\b/.test(sat.name)) return { uri: '/models/debris.glb', scale: 1 };
  if (/\bR\/B\b/.test(sat.name)) return { uri: '/models/rocketbody.glb', scale: 1 };
  if (sat.name.startsWith('STARLINK')) return { uri: '/models/starlink.glb', scale: 1 };
  return { uri: '/models/generic-sat.glb', scale: 1 };
}

// Orientation from the propagated state: +X along velocity, +Z zenith.
const scrX = new Cartesian3(), scrY = new Cartesian3(), scrZ = new Cartesian3();
const scrM = new Matrix3(), scrQ = new Quaternion();
function orientationFor(posEcf, velEcf) {
  Cartesian3.normalize(Cartesian3.fromElements(velEcf.x, velEcf.y, velEcf.z, scrX), scrX);
  Cartesian3.normalize(posEcf, scrZ);
  Cartesian3.normalize(Cartesian3.cross(scrZ, scrX, scrY), scrY);
  Cartesian3.cross(scrY, scrZ, scrX);
  Matrix3.fromArray([
    scrX.x, scrX.y, scrX.z,
    scrY.x, scrY.y, scrY.z,
    scrZ.x, scrZ.y, scrZ.z,
  ], 0, scrM); // column-major: columns are the model axes in world space
  return Quaternion.fromRotationMatrix(scrM, scrQ);
}

// ECF position of a satrec at the sim clock's current time, or null.
function currentPosition(satrec) {
  const date = JulianDate.toDate(viewer.clock.currentTime);
  const pv = satellite.propagate(satrec, date);
  if (!pv?.position) return null;
  const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
  return new Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000);
}

function selectByIndex(index) {
  clearSelection();
  const sat = catalog[index];
  const satrec = satellite.twoline2satrec(sat.l1, sat.l2);
  const pos = currentPosition(satrec) ?? Cartesian3.ZERO;
  const highlight = overlay.add({
    position: pos,
    pixelSize: 7,
    color: SELECT_COLOR,
    id: index,
    // beyond the swap range the dot shows; inside it the model takes over
    distanceDisplayCondition: new DistanceDisplayCondition(MODEL_SWAP_M, Number.MAX_VALUE),
  });
  // CallbackProperties evaluate the orbit at exact render time, so the model
  // is glassy-smooth under camera tracking (imperative per-tick updates lag
  // the entity-view camera by one frame — fatal at 200 m range / 7.6 km/s).
  const scratchDate = { date: null, gmst: 0 };
  const stateAt = (time) => {
    const date = JulianDate.toDate(time);
    const pv = satellite.propagate(satrec, date);
    if (!pv?.position) return null;
    scratchDate.gmst = satellite.gstime(date);
    return pv;
  };
  const modelEntity = viewer.entities.add({
    position: new CallbackProperty((time, result) => {
      const pv = stateAt(time);
      if (!pv) return undefined;
      const e = satellite.eciToEcf(pv.position, scratchDate.gmst);
      return Cartesian3.fromElements(e.x * 1000, e.y * 1000, e.z * 1000, result);
    }, false),
    orientation: new CallbackProperty((time, result) => {
      const pv = stateAt(time);
      if (!pv) return undefined;
      const p = satellite.eciToEcf(pv.position, scratchDate.gmst);
      const v = satellite.eciToEcf(pv.velocity, scratchDate.gmst);
      const q = orientationFor(new Cartesian3(p.x * 1000, p.y * 1000, p.z * 1000), v);
      return Quaternion.clone(q, result);
    }, false),
    model: {
      ...modelFor(sat),
      minimumPixelSize: 72,
      distanceDisplayCondition: new DistanceDisplayCondition(0, MODEL_SWAP_M),
    },
  });
  selected = { index, satrec, highlight, modelEntity };
  swarm.setSuppressed(index);   // the overlay point replaces the swarm dot
  drawOrbitTrack(satrec);
  fillInfoPanel(sat);
  $('infopanel').hidden = false;
}

function clearSelection() {
  if (!selected) return;
  cancelScreening();
  resetScreenUi();
  swarm.setSuppressed(-1);
  overlay.removeAll();
  viewer.entities.removeAll();
  viewer.trackedEntity = undefined;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = MIN_ZOOM_GROUND_M;
  following = false;
  $('info-track').classList.remove('active');
  $('info-track').textContent = 'Follow this satellite';
  selected = null;
}

// Closed-ellipse orbit track: sample one full period in ECI, project to the
// fixed frame at the current GMST so it renders as the classic orbital ring.
function drawOrbitTrack(satrec) {
  if (!$('toggle-orbit').checked || !selected) return;
  const now = JulianDate.toDate(viewer.clock.currentTime);
  const gmst = satellite.gstime(now);
  const periodMin = (2 * Math.PI) / satrec.no; // satrec.no = rad/min
  const samples = 240;
  const positions = [];
  for (let s = 0; s <= samples; s++) {
    const t = new Date(now.getTime() + (s / samples) * periodMin * 60_000);
    const pv = satellite.propagate(satrec, t);
    if (!pv?.position) continue;
    const ecf = satellite.eciToEcf(pv.position, gmst);
    positions.push(new Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000));
  }
  selected.trackEntity = viewer.entities.add({
    polyline: {
      positions,
      width: 1.3,
      material: SELECT_COLOR.withAlpha(0.55),
    },
  });
}

// Per-frame smooth motion + live readout for the selected satellite only.
viewer.clock.onTick.addEventListener((clock) => {
  if (!selected) return;
  const date = JulianDate.toDate(clock.currentTime);
  const pv = satellite.propagate(selected.satrec, date);
  if (!pv?.position) return;
  const gmst = satellite.gstime(date);
  const ecf = satellite.eciToEcf(pv.position, gmst);
  const pos = new Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000);
  selected.highlight.position = pos;

  // Inside model range a free camera loses a 7.6 km/s satellite in seconds —
  // lock on automatically so zooming in "just works".  Release is manual
  // (Stop following / Esc / deselect).
  if (!following && Date.now() > autoFollowHoldUntil
      && Cartesian3.distance(viewer.camera.positionWC, pos) < MODEL_SWAP_M * 0.85) {
    engageFollow();
  }

  const geo = satellite.eciToGeodetic(pv.position, gmst);
  $('info-alt').textContent = `${(geo.height).toFixed(0)} km`;
  const v = pv.velocity;
  $('info-speed').textContent = `${Math.hypot(v.x, v.y, v.z).toFixed(2)} km/s`;
});

// ---------------------------------------------------------------- picking ----

const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  if (defined(picked) && typeof picked.id === 'number') {
    selectByIndex(picked.id);
  } else if (picked?.id && picked.id === selected?.modelEntity) {
    // clicking the 3D model keeps the selection
  } else {
    clearSelection();
    $('infopanel').hidden = true;
  }
}, ScreenSpaceEventType.LEFT_CLICK);

// ------------------------------------------------------------- info panel ----

function fillInfoPanel(sat) {
  const m = sat.meta;
  $('info-regime').textContent = sat.kind === 'DEB'
    ? `DEBRIS · ${sat.regime}`
    : `${sat.regime} · NORAD catalog`;
  $('info-name').textContent = sat.name;
  $('info-norad').textContent = sat.norad;
  $('info-intl').textContent = m?.intlDes || '—';
  $('info-owner').textContent = decodeOwner(m?.owner);
  $('info-launch').textContent = m?.launchDate || '—';
  $('info-site').textContent = decodeSite(m?.launchSite);
  $('info-age').textContent = m?.launchDate ? onOrbitAge(m.launchDate) : '—';
  $('info-period').textContent = m?.period ? `${m.period.toFixed(1)} min` : '—';
  $('info-incl').textContent = m?.inclination != null ? `${m.inclination.toFixed(2)}°` : '—';
  $('info-apsis').textContent = (m?.apogee != null && m?.perigee != null)
    ? `${m.apogee.toLocaleString()} × ${m.perigee.toLocaleString()} km` : '—';
  $('info-alt').textContent = '—';
  $('info-speed').textContent = '—';
}

function onOrbitAge(launchDate) {
  const days = Math.floor((Date.now() - new Date(launchDate)) / 86_400_000);
  if (days < 365) return `${days} days`;
  const years = Math.floor(days / 365.25);
  return `${years} yr ${Math.floor(days - years * 365.25)} d`;
}

$('info-close').addEventListener('click', () => {
  clearSelection();
  $('infopanel').hidden = true;
});

// Track the model entity itself, and let the camera get close enough to
// actually see the spacecraft.
function engageFollow() {
  if (!selected || following) return;
  viewer.trackedEntity = selected.modelEntity;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 20;
  following = true;
  $('info-track').classList.add('active');
  $('info-track').textContent = 'Stop following';
}

function releaseFollow() {
  viewer.trackedEntity = undefined;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = MIN_ZOOM_GROUND_M;
  following = false;
  $('info-track').classList.remove('active');
  $('info-track').textContent = 'Follow this satellite';
}

$('info-track').addEventListener('click', () => {
  if (!selected) return;
  if (following) releaseFollow();
  else engageFollow();
});

// ---------------------------------------------------------------- legend ----

document.querySelectorAll('#legend input[data-cat]').forEach((box) => {
  box.addEventListener('change', () => {
    const cat = box.dataset.cat;
    catVisible[cat] = box.checked;
    for (let i = 0; i < catalog.length; i++) {
      if (catOf(catalog[i]) === cat) swarm.setVisible(i, box.checked);
    }
  });
});

$('toggle-orbit').addEventListener('change', () => {
  if (selected?.trackEntity) {
    viewer.entities.remove(selected.trackEntity);
    selected.trackEntity = null;
  }
  if (selected && $('toggle-orbit').checked) drawOrbitTrack(selected.satrec);
});

// ----------------------------------------------------------- conjunctions ----

const bufPos = (i) => new Cartesian3(lastBuf[i * 3], lastBuf[i * 3 + 1], lastBuf[i * 3 + 2]);

// Update the conjunction overlays and legend list from one worker tick's
// pairs.  Positions come from the same buffer the swarm just drew, so the
// markers sit exactly on their dots.
function renderConjunctions(pairs) {
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
    const row = document.createElement('div');
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
  if (!lastBuf) return;
  const a = bufPos(i), b = bufPos(j);
  const mid = Cartesian3.midpoint(a, b, new Cartesian3());
  const range = Math.max(Cartesian3.distance(a, b) * 6, 100_000);
  const destination = Cartesian3.multiplyByScalar(
    Cartesian3.normalize(mid, new Cartesian3()),
    Cartesian3.magnitude(mid) + range,
    new Cartesian3(),
  );
  autoFollowHoldUntil = Date.now() + 3000;   // don't let auto-follow cancel the flight
  viewer.camera.flyTo({ destination, duration: 1.6 });
  selectByIndex(i);
}

$('toggle-conj').addEventListener('change', () => {
  if (!$('toggle-conj').checked) renderConjunctions([]);
  // turning it on: the next worker tick (≤ 600 ms) delivers pairs
});

// --------------------------------------------------- conjunction forecast ----
// For listed pairs, a second worker searches the next 24 h for the time of
// closest approach and miss distance.  Results are cached per pair and shown
// as a subline; the cache entry drops once its TCA has passed.

const tcaWorker = new Worker(
  new URL('./tca.worker.js', import.meta.url),
  { type: 'module' },
);

const tcaCache = new Map();    // "i:j" → { tcaMs, missM } (missM null = no result)
const tcaPending = new Set();  // keys requested but not yet answered

tcaWorker.onmessage = (e) => {
  const msg = e.data;
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
      startIso: JulianDate.toIso8601(viewer.clock.currentTime),
      horizonHours: 24,
      pairs: batch,
    });
  }
}

// ---------------------------------------------------- catalog screening ----
// On demand for the selected satellite: prefilter the catalog by altitude
// band (an object whose perigee–apogee band can never overlap the target's
// can never come close), then hand the survivors to the TCA worker for a
// 24 h close-approach sweep.  Results stream in sorted by miss distance.

const SCREEN_REPORT_KM = 25;
const SCREEN_BAND_MARGIN_KM = 75;

let screening = null;   // { targetIndex, found: [{i, tcaMs, missM}], done, active }

// [perigee, apogee] altitude band in km — SATCAT when present, else derived
// from the TLE's mean motion and eccentricity.
function altBandOf(sat) {
  const m = sat.meta;
  if (m?.apogee != null && m?.perigee != null) return [m.perigee, m.apogee];
  const ecc = parseFloat(`0.${sat.l2.slice(26, 33).trim()}`) || 0;
  const revsPerDay = parseFloat(sat.l2.slice(52, 63));
  if (!revsPerDay) return [0, Infinity];
  const a = Math.cbrt(398600.4418 / ((revsPerDay * 2 * Math.PI / 86400) ** 2));
  return [a * (1 - ecc) - 6371, a * (1 + ecc) - 6371];
}

function startScreening() {
  if (!selected) return;
  cancelScreening();
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
    const row = document.createElement('div');
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

$('info-screen').addEventListener('click', () => {
  if (screening?.active) { cancelScreening(); resetScreenUi(); return; }
  startScreening();
});

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

// ------------------------------------------------------------------ time ----

const RATES = [1, 10, 60, 300, 1800, 7200];
let rateIdx = 0;

function setRate(idx) {
  rateIdx = Math.max(0, Math.min(RATES.length - 1, idx));
  viewer.clock.multiplier = RATES[rateIdx];
  $('time-rate').textContent = `${RATES[rateIdx]}×`;
}
$('time-faster').addEventListener('click', () => setRate(rateIdx + 1));
$('time-slower').addEventListener('click', () => setRate(rateIdx - 1));
$('time-now').addEventListener('click', () => {
  viewer.clock.currentTime = JulianDate.now();
  setRate(0);
});

setInterval(() => {
  $('time-clock').textContent =
    JulianDate.toDate(viewer.clock.currentTime).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}, 250);

// ---------------------------------------------------------------- search ----

const searchBox = $('search');
const resultsEl = $('search-results');

searchBox.addEventListener('input', () => {
  const q = searchBox.value.trim().toUpperCase();
  if (q.length < 2) { resultsEl.hidden = true; return; }
  const hits = [];
  for (let i = 0; i < catalog.length && hits.length < 12; i++) {
    if (catalog[i].name.toUpperCase().includes(q) || String(catalog[i].norad) === q) {
      hits.push(i);
    }
  }
  resultsEl.innerHTML = '';
  for (const i of hits) {
    const row = document.createElement('div');
    row.className = 'result-row';
    row.tabIndex = 0;
    row.innerHTML = `<span>${catalog[i].name}</span><span class="rid">${catalog[i].norad}</span>`;
    const go = () => {
      selectByIndex(i);
      resultsEl.hidden = true;
      searchBox.value = '';
    };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    resultsEl.appendChild(row);
  }
  resultsEl.hidden = hits.length === 0;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    resultsEl.hidden = true;
    clearSelection();
    $('infopanel').hidden = true;
  }
  if (e.key === '/' && document.activeElement !== searchBox) {
    e.preventDefault();
    searchBox.focus();
  }
});

// ----------------------------------------------------------------- debug ----

window.__orbital = {
  viewer,
  moonView,
  selectByIndex,
  refreshCatalog,
  get catalog() { return catalog; },
  get swarm() { return swarm; },
  get selected() { return selected; },
};
