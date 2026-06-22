// main.js — scene setup, render loop, and UI wiring.

import {
  Viewer, ImageryLayer, UrlTemplateImageryProvider, EllipsoidTerrainProvider,
  Credit, Cartesian3, Cartesian2, Color, PointPrimitiveCollection, JulianDate,
  ScreenSpaceEventHandler, ScreenSpaceEventType, Moon, defined,
  PolylineCollection, Material, DistanceDisplayCondition, Matrix3, Quaternion,
  CallbackProperty, LabelCollection, Cartographic,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import * as satellite from 'satellite.js';
import { loadCatalog, cacheExpiresInMs } from './data.js';
import { decodeOwner, decodeSite } from './decode.js';
import { SatSwarm } from './swarm.js';
import { initMoonView } from './moon.js';
import { initSystemView } from './solarsystem.js';
import { writeHash, readHash } from './deeplink.js';

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
const CAT_CSS = Object.fromEntries(Object.entries(CAT_COLORS).map(([k, v]) => [k, v.toCssColorString()]));

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

// The "☉ System" toggle flies out to a heliocentric solar-system view (globe
// off, planets on real Keplerian orbits); see src/solarsystem.js.  It can hand
// off into the Moon globe, so it gets a reference to the Moon view.  The third
// argument re-centres Earth when you come back: the Earth viewer's render loop
// is idled while the system view is up, so it never picks up viewport changes
// (mobile chrome show/hide) or sheds a leftover follow-lock — leaving Earth
// off-centre and un-recentreable.  Resize, drop any selection, and fly home.
function returnToEarthView() {
  clearSelection();
  $('infopanel').hidden = true;
  viewer.resize();
  viewer.camera.flyHome(1.0);
}
const systemView = initSystemView(viewer, moonView, returnToEarthView);

// The whole catalog renders through one GPU point-cloud primitive; this
// little collection only ever holds the enlarged selection highlight.
const overlay = viewer.scene.primitives.add(new PointPrimitiveCollection());

// Conjunction overlays: connector lines and endpoint markers, updated on
// every worker tick while the conjunction toggle is on (≤ 100 pairs).
// Pooled rather than rebuilt — PolylineCollection.removeAll() destroys each
// polyline's Material, so re-adding every tick crashes the render loop.
const conjLines = viewer.scene.primitives.add(new PolylineCollection());
const conjMarkers = viewer.scene.primitives.add(new PointPrimitiveCollection());

// Ground-station marker (point + label).  Its own collections, not viewer.entities
// — clearSelection() does entities.removeAll() and would wipe the station.
const stationPoints = viewer.scene.primitives.add(new PointPrimitiveCollection());
const stationLabels = viewer.scene.primitives.add(new LabelCollection());

// ---------------------------------------------------------------- state ----

let catalog = [];          // [{ name, l1, l2, norad, kind, meta, regime }]
let swarm = null;          // SatSwarm, one point per catalog index
let selected = null;       // { index, satrec, highlight }
let following = false;
let autoFollowHoldUntil = 0;   // suppress auto-follow during camera flights
let autoFollowDisabled = false; // set when the user manually stops following
let lastBuf = null;        // most recent worker position buffer (meters, ECF)
const catVisible = { LEO: true, MEO: true, GEO: true, HEO: true, DEB: true };
let catTotals = { LEO: 0, MEO: 0, GEO: 0, HEO: 0, DEB: 0 };   // full counts, to restore after the timeline
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
    renderSky();
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
  }
  refreshVisibility();   // apply category toggles + any active launch timeline
  viewer.scene.primitives.add(swarm);
  catTotals = { ...counts };
  for (const c of Object.keys(counts)) {
    $(`count-${c}`).textContent = counts[c].toLocaleString();
  }

  worker.postMessage({
    type: 'init',
    tles: catalog.map(({ norad, l1, l2 }) => ({ norad, l1, l2 })),
  });

  // A hot-swap renumbers every index, so any pass results point at the wrong
  // satellites now — drop them, and re-scan against the new catalog if the
  // station feature is live.
  if (passing) {
    cancelPasses();
    $('pass-list').innerHTML = '';
    $('pass-count').textContent = '—';
    if ($('toggle-station').checked && station) startPasses();
  }
}

async function boot() {
  try {
    const list = await loadCatalog(status);
    diffAndToast(list);
    applyCatalog(list);
    applyDeepLink();
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

// Base-relative so model URLs resolve under the GitHub Pages subpath (/orbital/)
// as well as at the dev-server root.
const MODELS = `${import.meta.env.BASE_URL}models/`;

function modelFor(sat) {
  const real = REAL_MODELS.get(sat.norad);
  if (real) return { uri: `${MODELS}${real.file}.glb`, scale: real.scale };
  if (/^TDRS \d/.test(sat.name)) return { uri: `${MODELS}tdrs.glb`, scale: 19.6 };
  if (sat.kind === 'DEB' || /\bDEB\b/.test(sat.name)) return { uri: `${MODELS}debris.glb`, scale: 1 };
  if (/\bR\/B\b/.test(sat.name)) return { uri: `${MODELS}rocketbody.glb`, scale: 1 };
  if (sat.name.startsWith('STARLINK')) return { uri: `${MODELS}starlink.glb`, scale: 1 };
  // Nav constellations (Galileo keyed off the GALILEO token, not GSAT — that
  // also names ISRO's comms birds; GPS BIIx/BIII and NAVSTAR are the same GPS).
  if (/GALILEO|NAVSTAR|BEIDOU/.test(sat.name) || /^GPS\b/.test(sat.name)) {
    return { uri: `${MODELS}navsat.glb`, scale: 1 };
  }
  // Sentinel EO/SAR (1/2/3/5P); Sentinel-6 has a real model and is caught above.
  if (/^SENTINEL-[1235]/.test(sat.name)) return { uri: `${MODELS}sar.glb`, scale: 1 };
  return { uri: `${MODELS}generic-sat.glb`, scale: 1 };
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
  writeHash({ sat: sat.norad });
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
  autoFollowDisabled = false;   // a fresh selection auto-follows normally again
  document.body.classList.remove('following');
  $('info-track').classList.remove('active');
  $('info-track').textContent = 'Follow this satellite';
  selected = null;
  // Only reached when a real selection was cleared (the guard above returns
  // early otherwise), so this never wipes a deep-link hash on a fresh boot.
  // While the system / Moon views are up they own the hash — don't clobber it
  // (hide() drops the body class before it calls back here, so returning to
  // Earth still clears the hash as it should).
  const m = document.body.classList;
  if (!m.contains('system-mode') && !m.contains('moon-mode')) writeHash(null);
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
  // (Stop following / Esc / deselect).  A manual stop disables auto-follow so
  // it doesn't immediately re-lock; it re-arms once you pull back out of model
  // range, so a later zoom-in locks on again.
  const camDist = Cartesian3.distance(viewer.camera.positionWC, pos);
  if (autoFollowDisabled && camDist > MODEL_SWAP_M) autoFollowDisabled = false;
  if (!following && !autoFollowDisabled && Date.now() > autoFollowHoldUntil
      && camDist < MODEL_SWAP_M * 0.85) {
    engageFollow();
  }

  const geo = satellite.eciToGeodetic(pv.position, gmst);
  $('info-alt').textContent = `${(geo.height).toFixed(0)} km`;
  const v = pv.velocity;
  $('info-speed').textContent = `${Math.hypot(v.x, v.y, v.z).toFixed(2)} km/s`;
});

// ---------------------------------------------------------------- picking ----

// Satellites are ~2 px GPU points; pick a padded box around the tap so they're
// actually hittable — generously on touch, where a fingertip covers tens of px.
const PICK_PAD = window.matchMedia?.('(pointer: coarse)').matches ? 22 : 8;

const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((click) => {
  // Placing a ground station: the next globe click drops it instead of selecting.
  if (stationPlacing) {
    const cart = viewer.camera.pickEllipsoid(click.position, viewer.scene.globe.ellipsoid);
    if (cart) {
      const c = Cartographic.fromCartesian(cart);
      stationPlacing = false;
      $('pass-setloc').classList.remove('active');
      placeStation(c.latitude / DEG2RAD, c.longitude / DEG2RAD);
    }
    return;
  }
  const picked = viewer.scene.pick(click.position, PICK_PAD, PICK_PAD);
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
  autoFollowDisabled = false;
  document.body.classList.add('following');   // mobile: collapse the panel off the centred sat
  $('info-track').classList.add('active');
  $('info-track').textContent = 'Stop following';
}

function releaseFollow() {
  viewer.trackedEntity = undefined;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = MIN_ZOOM_GROUND_M;
  following = false;
  autoFollowDisabled = true;   // don't let the per-tick auto-follow re-lock immediately
  document.body.classList.remove('following');
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
    catVisible[box.dataset.cat] = box.checked;
    refreshVisibility();
  });
});

// Mobile: the display-options legend is a ☰-toggled slide-in drawer.  Tapping the
// scrim closes it, and leaving the Earth view (System / Moon) closes it too.
const setLegendOpen = (open) => document.body.classList.toggle('legend-open', open);
$('legend-toggle').addEventListener('click', () =>
  setLegendOpen(!document.body.classList.contains('legend-open')));
$('legend-scrim').addEventListener('click', () => setLegendOpen(false));
$('system-toggle').addEventListener('click', () => setLegendOpen(false));
$('moon-toggle').addEventListener('click', () => setLegendOpen(false));

// First-run welcome / how-to overlay — shown once, re-openable from the ? button.
const welcome = $('welcome');
const closeWelcome = () => {
  welcome.hidden = true;
  try { localStorage.setItem('orbital.welcomed', '1'); } catch { /* ignore */ }
};
$('welcome-go').addEventListener('click', closeWelcome);
welcome.addEventListener('click', (e) => { if (e.target === welcome) closeWelcome(); });   // backdrop tap
$('help-toggle').addEventListener('click', () => { welcome.hidden = false; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !welcome.hidden) { e.stopPropagation(); closeWelcome(); }
}, true);
// First-timers see it — unless they followed a shared deep-link, which lands
// them straight on the thing the sender pointed at (the flag stays unset, so
// they still get the intro on a later visit to the bare page).
try { if (!location.hash && !localStorage.getItem('orbital.welcomed')) welcome.hidden = false; }
catch { if (!location.hash) welcome.hidden = false; }

// "Copy link" buttons (in each detail panel): the address bar already tracks
// the view via deeplink.js, so just hand over location.href.
async function copyShareLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied — paste it to share this view', 3000);
  } catch {
    toast(`Share this link:<br><span class="toast-url">${location.href}</span>`, 8000);
  }
}
document.querySelectorAll('.copy-link').forEach((b) => b.addEventListener('click', copyShareLink));

// Welcome quick-jump chips: one tap dismisses the intro and flies to a
// showcase destination (and the deep-link write makes that URL shareable too).
function destFromSpec(spec) {
  if (spec === 'luna') return { luna: true };
  if (spec === 'system') return { system: true };
  const [k, v] = spec.split(':');
  if (k === 'sat' || k === 'body' || k === 'moon' || k === 'probe') return { [k]: v };
  return null;
}
document.querySelectorAll('.welcome-chip').forEach((chip) => chip.addEventListener('click', () => {
  closeWelcome();
  navigateTo(destFromSpec(chip.dataset.go));
}));

// ------------------------------------------------------------ launch timeline ----
// Watch the tracked population accumulate by launch year, Sputnik-era → today.
// A satellite shows when its category is on AND (timeline off, or it was launched
// by the scrubbed year).  Launch year comes from the TLE international designator,
// so this works fully offline.  Objects with no designator (rare) sort to the end.
let timelineYear = null;                       // null = timeline off (show all)
const TIMELINE_START = 1957;                   // year before the first satellite
const timelineMax = new Date().getUTCFullYear();

function refreshVisibility() {
  if (!swarm) return;
  for (let i = 0; i < catalog.length; i++) {
    const s = catalog[i];
    const byYear = timelineYear === null
      || (s.launchYear ?? 9999) <= timelineYear;
    swarm.setVisible(i, catVisible[catOf(s)] && byYear);
  }
}

// Milestones flashed as the play-head crosses their year.
const ERAS = [
  [1957, 'Sputnik 1 — the Space Age begins'],
  [1958, 'Explorer 1 · NASA is founded'],
  [1960, 'TIROS-1 — first weather satellite'],
  [1962, 'Telstar — first active comsat'],
  [1971, 'Salyut 1 — first space station'],
  [1978, 'First GPS satellites'],
  [1981, 'Space Shuttle era begins'],
  [1990, 'Hubble Space Telescope'],
  [1998, 'ISS assembly begins'],
  [2019, 'Starlink — the megaconstellation era'],
];
let eraTimer = 0;
function flashEra(text) {
  const el = $('tl-era');
  el.textContent = text;
  el.hidden = false;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');  // restart the fade
  clearTimeout(eraTimer);
  eraTimer = setTimeout(() => { el.classList.remove('show'); }, 4500);
}

// One pass: per-category counts launched by `year`, the running total for the
// readout — and, in passing, drive the legend counts live during playback.
function updateTimelineReadout(year) {
  const c = { LEO: 0, MEO: 0, GEO: 0, HEO: 0, DEB: 0 };
  let total = 0;
  for (const s of catalog) {
    if ((s.launchYear ?? 9999) <= year) { c[catOf(s)]++; total++; }
  }
  for (const k of Object.keys(c)) $(`count-${k}`).textContent = c[k].toLocaleString();
  $('tl-label').textContent = `${year} · ${total.toLocaleString()} tracked`;
}

function setTimelineYear(year) {
  const prev = timelineYear;
  timelineYear = year;
  $('tl-year').value = String(year);
  updateTimelineReadout(year);
  // Flash the latest era milestone crossed since the previous year.
  let era = null;
  for (const [y, text] of ERAS) if (y === year || (prev !== null && y > prev && y <= year)) era = text;
  if (era) flashEra(era);
  refreshVisibility();
}

let tlPlaying = false;
let tlRaf = 0;
let tlAnchorMs = 0;
let tlAnchorYear = TIMELINE_START;
let tlYearsPerSec = 1;                          // playback speed; the dropdown sets it

function tlStep(nowMs) {
  if (!tlPlaying) return;
  const year = Math.min(timelineMax,
    Math.floor(tlAnchorYear + (nowMs - tlAnchorMs) / 1000 * tlYearsPerSec));
  if (year !== timelineYear) setTimelineYear(year);
  if (year >= timelineMax) { stopTimelinePlay(); return; }
  tlRaf = requestAnimationFrame(tlStep);
}

function startTimelinePlay() {
  if (timelineYear >= timelineMax) setTimelineYear(TIMELINE_START);  // replay from the top
  tlPlaying = true;
  $('tl-play').textContent = '⏸';
  tlAnchorYear = timelineYear;
  tlAnchorMs = performance.now();
  tlRaf = requestAnimationFrame(tlStep);
}

function stopTimelinePlay() {
  tlPlaying = false;
  $('tl-play').textContent = '▶';
  cancelAnimationFrame(tlRaf);
}

$('tl-year').max = String(timelineMax);
$('tl-year').min = String(TIMELINE_START);
$('toggle-timeline').addEventListener('change', (e) => {
  if (e.target.checked) {
    $('timeline-controls').hidden = false;
    setTimelineYear(TIMELINE_START);
  } else {
    stopTimelinePlay();
    $('timeline-controls').hidden = true;
    $('tl-era').hidden = true;
    timelineYear = null;
    for (const k of Object.keys(catTotals)) $(`count-${k}`).textContent = catTotals[k].toLocaleString();
    refreshVisibility();
  }
});
$('tl-play').addEventListener('click', () => (tlPlaying ? stopTimelinePlay() : startTimelinePlay()));
$('tl-speed').addEventListener('change', (e) => {
  tlYearsPerSec = parseFloat(e.target.value);
  if (tlPlaying) { tlAnchorYear = timelineYear; tlAnchorMs = performance.now(); }   // re-anchor at new speed
});
$('tl-year').addEventListener('input', (e) => {
  stopTimelinePlay();
  setTimelineYear(parseInt(e.target.value, 10));
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

// ------------------------------------------------- ground-station passes ----
// Drop a station on the globe; a worker sweeps the whole catalog for every pass
// above a minimum elevation over the next 24 h (rise / peak / set) and the list
// streams in sorted by rise time.  Click a pass to jump the clock to its peak
// and watch the satellite ride over the station.

const DEG2RAD = Math.PI / 180;
const RE_KM = 6378.137;
const PASS_HORIZON_H = 24;
const PASS_STORE_KEY = 'orbital.station';

let station = null;        // { lat, lon } in degrees
let stationPlacing = false;
let passing = null;        // { passes: [...], active }
let lastPassRenderMs = 0;  // throttle the streaming re-render (sort cost grows)

const passesWorker = new Worker(
  new URL('./passes.worker.js', import.meta.url),
  { type: 'module' },
);

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

// ------------------------------------------------------ overhead sky chart ----
// A live polar plot of everything currently above the station: zenith at the
// centre, the horizon at the rim, azimuth around (N up).  Fed straight off the
// propagator's ECF buffer each tick, projected through the station's ENU frame.
const sky = { canvas: null, ctx: null, obs: null, plotted: [] };

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

// Low-precision Sun direction (unit vector, Earth-fixed frame) — enough to tell
// day from night and which satellites are catching the sunlight.
function sunEcefDir(date) {
  const n = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;          // days since J2000
  const g = (357.529 + 0.98560028 * n) * DEG2RAD;                            // mean anomaly
  const L = (280.459 + 0.98564736 * n) * DEG2RAD;                            // mean longitude
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG2RAD; // ecliptic longitude
  const eps = 23.439 * DEG2RAD;
  const eci = { x: Math.cos(lam), y: Math.cos(eps) * Math.sin(lam), z: Math.sin(eps) * Math.sin(lam) };
  return satellite.eciToEcf(eci, satellite.gstime(date));
}
const SUN_DARK = Math.sin(-6 * Math.PI / 180);   // sky dark enough to spot satellites
const EARTH_R = 6.371e6;
// The handful bright enough to actually catch the naked eye when sunlit — these
// get a ring + name on the sky chart (the ~hundreds of other sunlit craft are
// real but far too faint to see, so they're only reported as a count).
const NAKED_EYE = new Map([[25544, 'ISS'], [48274, 'Tiangong']]);

function renderSky() {
  const panel = $('sky-now');
  if (!sky.ctx || panel.hidden || !sky.obs || !lastBuf) return;
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
    if (px === 0 && py === 0 && pz === 0) continue;
    const dx = px - o.ox, dy = py - o.oy, dz = pz - o.oz;
    const u = dx * o.ux + dy * o.uy + dz * o.uz;
    if (u <= 0) continue;                              // below horizon — cheap reject
    const e = dx * o.ex + dy * o.ey + dz * o.ez;
    const nn = dx * o.nx + dy * o.ny + dz * o.nz;
    const elDeg = Math.atan2(u, Math.hypot(e, nn)) * 180 / Math.PI;
    if (elDeg < minEl) continue;
    const az = Math.atan2(e, nn), r = (1 - elDeg / 90) * R;
    const x = cx + r * Math.sin(az), y = cy - r * Math.cos(az);
    // Sunlit? — outside Earth's cylindrical shadow.  On the dark side, lit only
    // if its offset from the Earth–Sun axis clears the planet's radius.
    const along = px * sun.x + py * sun.y + pz * sun.z;
    let sunlit = along > 0;
    if (!sunlit) {
      const wx = px - along * sun.x, wy = py - along * sun.y, wz = pz - along * sun.z;
      sunlit = (wx * wx + wy * wy + wz * wz) > EARTH_R * EARTH_R;
    }
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
initSkyChart();

// ------------------------------------------------------- visible-pass alerts ----
// While a station is set, give a heads-up before the bright naked-eye craft
// (ISS, Tiangong) make a *visible* pass — sunlit, in a dark sky, clear of the
// horizon — so you can step outside in time.
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (az) => COMPASS[Math.round(((az % 360) + 360) % 360 / 45) % 8];
const PASS_LEAD_MS = 7 * 60_000;     // announce up to ~7 min ahead
const alertedPasses = new Set();

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
      const along = px * sun.x + py * sun.y + pz * sun.z;
      let sunlit = along > 0;
      if (!sunlit) {
        const wx = px - along * sun.x, wy = py - along * sun.y, wz = pz - along * sun.z;
        sunlit = (wx * wx + wy * wy + wz * wz) > EARTH_R * EARTH_R;
      }
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
  if (!station || !sky.obs || !$('toggle-station').checked) return;
  if (Math.abs(viewer.clock.multiplier) > 4) return;          // not during fast time-warp
  const now = JulianDate.toDate(viewer.clock.currentTime);
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
setInterval(checkPassAlerts, 60_000);

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
  const latAbs = Math.abs(station.lat);
  const cosEl = Math.cos(minEl * DEG2RAD);
  const out = [];
  for (let i = 0; i < catalog.length; i++) {
    const sat = catalog[i];
    const revsPerDay = parseFloat(sat.l2.slice(52, 63));
    if (revsPerDay && revsPerDay < 1.2) continue;   // near-geostationary: no discrete passes
    const incl = parseFloat(sat.l2.slice(8, 16)) || 0;
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
  if (!station) return;
  if (!catalog.length) { updatePassStatus('waiting for the catalog…'); return; }
  cancelPasses();
  const minEl = Number($('pass-minel').value);
  const candidates = passCandidates(minEl);
  passing = { passes: [], active: true };
  passesWorker.postMessage({
    type: 'passes',
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
  const listEl = $('pass-list');
  listEl.innerHTML = '';
  if (!passing) { $('pass-count').textContent = '—'; return; }
  const n = passing.passes.length;
  $('pass-count').textContent = !n ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const nowMs = JulianDate.toDate(viewer.clock.currentTime).getTime();
  const upcoming = passing.passes
    .filter((p) => p.setMs > nowMs)
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
    const row = document.createElement('div');
    row.className = 'conj-row';
    row.innerHTML =
      `<div class="conj-main"><span class="cnames">${sat.name}</span>` +
      `<span class="ckm">${Math.round(p.peakEl)}°</span></div>` +
      `<div class="conj-sub">${when} · ${durMin} min${sat.kind === 'DEB' ? ' · debris' : ''}</div>`;
    row.addEventListener('click', () => jumpToPass(p));
    listEl.appendChild(row);
  }
}

// Fly the camera out to frame a satellite from a comfortable standoff (without
// locking on — auto-follow is held off so the flight isn't yanked short).
function flyToSat(i) {
  const pos = currentPosition(satellite.twoline2satrec(catalog[i].l1, catalog[i].l2));
  if (!pos) return;
  const range = Math.max(Cartesian3.magnitude(pos) * 0.12, 1.2e6);
  const dest = Cartesian3.multiplyByScalar(
    Cartesian3.normalize(pos, new Cartesian3()), Cartesian3.magnitude(pos) + range, new Cartesian3());
  autoFollowHoldUntil = Date.now() + 3000;
  viewer.camera.flyTo({ destination: dest, duration: 1.4 });
}

// Jump the clock to the pass's peak and fly to the satellite, so it's framed
// high over the station; time then runs forward at 1× through the pass.
function jumpToPass(p) {
  viewer.clock.currentTime = JulianDate.fromDate(new Date(p.peakMs));
  setRate(0);
  selectByIndex(p.i);
  flyToSat(p.i);
}

// Navigate to a view described by a deep-link state object — shared by the
// on-load hash restore (applyDeepLink) and the welcome overlay's quick-jump
// chips.  A #sat= target needs the catalog; if it isn't in yet (a chip tapped
// during boot), retry until it loads.
function navigateTo(s) {
  if (!s) return;
  if (s.sat != null) {
    const i = catalog.findIndex((c) => String(c.norad) === String(s.sat));
    if (i >= 0) { selectByIndex(i); flyToSat(i); }
    else if (!catalog.length) setTimeout(() => navigateTo(s), 400);
    return;
  }
  if (s.luna) { moonView.show(); return; }
  if (s.system) { systemView.show(); return; }
  const name = s.body || s.moon || s.probe;
  if (name) { systemView.show(); systemView.focus(name); }
}

// Restore the view named in the URL hash on first load (see deeplink.js).
function applyDeepLink() { navigateTo(readHash()); }

passesWorker.onmessage = (e) => {
  const msg = e.data;
  if (!passing) return;
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
      autoFollowHoldUntil = Date.now() + 3000;
      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(coords.longitude, coords.latitude, 7.5e6),
        duration: 1.6,
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

$('pass-minel').addEventListener('change', () => {
  if ($('toggle-station').checked && station) startPasses();
});

loadStation();

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
  systemView,
  selectByIndex,
  refreshCatalog,
  get catalog() { return catalog; },
  get swarm() { return swarm; },
  get selected() { return selected; },
  get skyPlotted() { return sky.plotted; },   // debug: dots in the overhead chart
  checkPassAlerts,                              // debug: force a visible-pass check
};
