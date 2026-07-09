// main.js — scene setup, render loop, and UI wiring.

import {
  Viewer, ImageryLayer, UrlTemplateImageryProvider, EllipsoidTerrainProvider,
  Credit, Cartesian3, PointPrimitiveCollection, JulianDate,
  ScreenSpaceEventHandler, ScreenSpaceEventType, Moon, defined,
  PolylineCollection, DistanceDisplayCondition, Quaternion,
  CallbackProperty, LabelCollection,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import * as satellite from 'satellite.js';
import { loadCatalog, cacheExpiresInMs, medianEpochMs } from './data.js';
import { decodeOwner, decodeSite } from './decode.js';
import { SatSwarm } from './swarm.js';
import { initMoonView } from './moon.js';
import { initSystemView } from './solarsystem.js';
import { writeHash, readHash } from './deeplink.js';
import { flySeconds } from './motion.js';
import { CAT_COLORS, SELECT_COLOR } from './palette.js';
import { modelFor, orientationFor } from './models.js';
import { initShowpieces } from './showpieces.js';
import { initConjunctions } from './conjunctions.js';
import { initStation } from './station.js';
import { initTimeline } from './timeline.js';
import { initGroups } from './groups.js';
import { initCoverage } from './coverage.js';
import { esc } from './esc.js';

// ---------------------------------------------------------------- scene ----

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
const moonView = initMoonView(viewer, () => writeHash(selected ? { sat: catalog[selected.index].norad } : null));

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
let catalogEpochMs = null;   // median TLE epoch — how far the propagation is being extrapolated
const catOf = (sat) => (sat.kind === 'DEB' ? 'DEB' : sat.regime);

const $ = (id) => document.getElementById(id);
const status = (msg) => { $('status').textContent = msg; };

// --------------------------------------------------------------- worker ----

const worker = new Worker(
  new URL('./propagator.worker.js', import.meta.url),
  { type: 'module' },
);

let workerBusy = false;
// Catalog generation: bumped on every hot-swap / in-place element refresh.
// Stamped on outbound worker requests and echoed back, so a response computed
// against the previous catalog (indices now point at different satellites) is
// dropped instead of mis-indexing conjunctions, TCA keys, or pass lists.
let catalogGen = 0;
let posTicks = 0;   // debug: count of applied full-catalog updates (idle-pause verification)
// A crashed worker must never deadlock the tracker: clear the busy latch and
// tell the user, instead of silently freezing every dot at its last position.
worker.onerror = worker.onmessageerror = (err) => {
  workerBusy = false;
  console.error('propagator worker error', err);
  status('position engine hiccuped — retrying…');
};
worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    status(`${msg.count.toLocaleString()} objects on orbit`);
    return;
  }
  if (msg.type === 'positions') {
    workerBusy = false;
    if (msg.gen !== catalogGen) return;   // computed against a now-replaced catalog — drop it
    lastBuf = msg.buf;
    posTicks++;                           // debug: applied full-catalog updates (idle-pause check)
    swarm?.updatePositions(msg.buf);
    conj.render(msg.pairs ?? []);
    groundStation.renderSky();
  }
};

// Ask the worker for a full-catalog update ~every 600 ms of wall time,
// evaluated at the simulation clock's current moment.
setInterval(() => {
  if (workerBusy || catalog.length === 0) return;
  // Don't propagate the whole catalog when the Earth view isn't on screen — a
  // System / Moon view is up (its own render loop drives the shared clock), or
  // the tab is backgrounded.  The swarm, conjunctions and sky chart are all
  // hidden then; propagation resumes on the next tick (≤ 600 ms) once Earth is
  // showing again.  This is the big idle-battery / thermal saver.
  if (document.hidden) return;
  const mode = document.body.classList;
  if (mode.contains('system-mode') || mode.contains('moon-mode')) return;
  workerBusy = true;
  worker.postMessage({
    type: 'propagate',
    isoTime: JulianDate.toIso8601(viewer.clock.currentTime),
    conjKm: $('toggle-conj').checked ? Number($('conj-range').value) : 0,
    gen: catalogGen,
  });
  updateDriftBadge();
}, 600);

// SGP4 accuracy decays as the propagation time moves away from the element
// epoch (~km/day for LEO).  Warn once the sim clock — under time-warp, or just a
// stale bundled fallback whose epochs are already old — is more than a few days
// off the catalog's median epoch, so extrapolated positions aren't mistaken for
// live truth.
const DRIFT_WARN_DAYS = 3;
function updateDriftBadge() {
  const el = $('drift-badge');
  if (catalogEpochMs == null) { el.hidden = true; return; }
  const days = (JulianDate.toDate(viewer.clock.currentTime).getTime() - catalogEpochMs) / 86400000;
  if (Math.abs(days) < DRIFT_WARN_DAYS) { el.hidden = true; return; }
  const n = Math.round(Math.abs(days));
  el.textContent = days > 0
    ? `⚠ positions extrapolated ~${n} day${n === 1 ? '' : 's'} past the latest elements — accuracy degrades`
    : `⚠ positions computed ~${n} day${n === 1 ? '' : 's'} before the elements' epoch`;
  el.hidden = false;
}

// ----------------------------------------------------------------- boot ----

// Swap in a (new) catalog: rebuild the swarm, re-init the worker, reset
// everything index-based.  Called at boot and again on auto-refresh.
function applyCatalog(list) {
  // A hot-swap renumbers every index, so the current selection is about to be
  // torn down.  Remember which satellite (by NORAD) and whether it was being
  // followed, so an auto-refresh doesn't yank the user off the object they were
  // watching — it's re-selected below if it survived into the new catalog.
  const keepNorad = selected ? catalog[selected.index]?.norad : null;
  const wasFollowing = following;

  catalogGen++;   // invalidate any in-flight worker results tied to the old indices
  clearSelection();
  closeResults();   // open search rows hold now-stale indices — drop them
  $('infopanel').hidden = true;
  conj.onCatalogSwap();
  if (swarm) viewer.scene.primitives.remove(swarm);   // destroys GL resources

  catalog = list;
  swarm = new SatSwarm(catalog.length);
  const counts = { LEO: 0, MEO: 0, GEO: 0, HEO: 0, DEB: 0 };
  for (let i = 0; i < catalog.length; i++) {
    const cat = catOf(catalog[i]);
    counts[cat]++;
    swarm.setStyle(i, CAT_COLORS[cat], cat === 'DEB' ? 1.7 : 2.2);
  }
  groups.recount();               // group-chip counts + hide groups absent from today's catalog
  timeline.refreshVisibility();   // apply category toggles + timeline + group focus
  viewer.scene.primitives.add(swarm);
  catTotals = { ...counts };
  catalogEpochMs = medianEpochMs(catalog);   // freshness reference for the drift badge
  // While the launch timeline is active it owns the legend numbers (year-filtered
  // counts); don't stomp them with full-catalog totals on an auto-refresh hot-swap.
  if (timeline.isActive()) timeline.refreshReadout();
  else for (const c of Object.keys(counts)) $(`count-${c}`).textContent = counts[c].toLocaleString();

  worker.postMessage({
    type: 'init',
    tles: catalog.map(({ norad, l1, l2 }) => ({ norad, l1, l2 })),
  });

  // A hot-swap renumbers every index, so any pass results point at the wrong
  // satellites now — drop them and re-scan if the station feature is live.
  groundStation.onCatalogSwap();

  // Restore the user's selection if their satellite is still on orbit (it may
  // have decayed out of the catalog, in which case diffAndToast already said so).
  if (keepNorad != null) {
    const i = catalog.findIndex((c) => c.norad === keepNorad);
    if (i >= 0) { selectByIndex(i); if (wasFollowing) engageFollow(); }
  }
}

// Humane, on-globe failure notice with a Retry — the status line lives in the
// legend drawer, which is off-screen on phones, so a bare "fetch failed" there
// leaves a mobile visitor staring at an empty globe with no explanation.
function bootFailed() {
  status('couldn’t load the catalog');
  const el = document.createElement('div');
  el.className = 'toast boot-error';
  el.innerHTML = '<div class="t-head">Couldn’t load the satellite catalog</div>'
    + '<div>Check your connection, then retry.</div>';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'toast-retry'; btn.textContent = 'Retry';
  btn.addEventListener('click', () => { el.remove(); status('loading catalog…'); boot(); });
  el.appendChild(btn);
  $('toasts').appendChild(el);
}

async function boot() {
  try {
    const list = await loadCatalog(status);
    diffAndToast(list);
    applyCatalog(list);
  } catch (err) {
    console.error(err);
    bootFailed();
  } finally {
    // Always restore the shared view: a #system / #luna / #guide / #show link
    // needs no Earth catalog, so it must still open even if the catalog failed.
    applyDeepLink();
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
  const fmtList = (names) => names.slice(0, 4).map(esc).join(', ')
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
      // Same objects, but freshly fetched element sets carry new epochs.  Update
      // them in place (indices unchanged, so selection / passes / TCA stay valid)
      // and re-init the worker.  Skipping this let a days-long session keep flying
      // the boot-time satrecs — SGP4 drifts ~km/day for LEO.
      for (let i = 0; i < catalog.length; i++) {
        catalog[i].l1 = list[i].l1;
        catalog[i].l2 = list[i].l2;
        catalog[i].launchYear = list[i].launchYear;
        if (list[i].meta) catalog[i].meta = list[i].meta;
      }
      catalogGen++;   // drop any in-flight results propagated from the old elements
      catalogEpochMs = medianEpochMs(catalog);
      conj.onElementsRefresh();   // clears TCA cache and resets any running screen (indices still valid)
      worker.postMessage({ type: 'init', tles: catalog.map(({ norad, l1, l2 }) => ({ norad, l1, l2 })) });
      groundStation.onElementsRefresh();
      // The swarm/passes/TCA now use the fresh elements, but the selected
      // satellite's satrec (and its model's CallbackProperties, readout, orbit
      // ring) still close over the boot-time elements — rebuild the selection so
      // the one object rendered at per-frame precision isn't left drifting.
      if (selected) { const wasF = following; selectByIndex(selected.index); if (wasF) engageFollow(); }
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
  // A background reselect (catalog hot-swap / in-place refresh) can fire while a
  // System or Moon view is up — don't pop the Earth panel or clobber that view's
  // shareable hash with #sat=… ; those views own the hash while they're open.
  const m = document.body.classList;
  if (!m.contains('system-mode') && !m.contains('moon-mode')) {
    $('infopanel').hidden = false;
    writeHash({ sat: sat.norad });
  }
}

function clearSelection() {
  if (!selected) return;
  conj.cancelScreening();
  conj.resetScreenUi();
  swarm.setSuppressed(-1);
  overlay.removeAll();
  // Remove ONLY what this selection added — not viewer.entities.removeAll(), which
  // would also destroy the showpiece entities (JWST, Voyagers, SOHO…) that share
  // this viewer's entity collection and are never re-added (they'd fly to empty
  // space forever after the first deselect).
  if (selected.modelEntity) viewer.entities.remove(selected.modelEntity);
  if (selected.trackEntity) viewer.entities.remove(selected.trackEntity);
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

// Closed-ellipse orbit track: sample one full period in ECI, then project to the
// Earth-fixed frame at the current GMST.  Two things move it: Earth's spin
// (~15°/hr — handled cheaply by re-rotating the samples, renderOrbitTrack) and
// the orbit plane itself (SGP4 secular J2 precession, ~5°/day for LEO — handled
// by re-sampling when the sim clock drifts an hour off the sample epoch, onTick).
// Without both, the satellite visibly walks off its own ring under time-warp.
function drawOrbitTrack(satrec) {
  if (!$('toggle-orbit').checked || !selected) return;
  const now = JulianDate.toDate(viewer.clock.currentTime);
  const periodMin = (2 * Math.PI) / satrec.no; // satrec.no = rad/min
  const samples = 240;
  const eci = [];
  for (let s = 0; s <= samples; s++) {
    const t = new Date(now.getTime() + (s / samples) * periodMin * 60_000);
    const pv = satellite.propagate(satrec, t);
    if (pv?.position) eci.push(pv.position);
  }
  selected.trackEci = eci;   // km, inertial — re-rotated to the current GMST on draw
  selected.trackSampledMs = now.getTime();   // sim epoch these samples were taken at
  renderOrbitTrack();
}

// Rotate the stored ECI samples into the Earth-fixed frame at the current GMST
// and (re)draw the ring.  Cheap: a per-point Z-rotation, no re-propagation.
function renderOrbitTrack() {
  if (!selected?.trackEci) return;
  const gmst = satellite.gstime(JulianDate.toDate(viewer.clock.currentTime));
  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  const positions = selected.trackEci.map((p) =>   // ECI → ECF (rotate by −gmst about Z), km → m
    new Cartesian3((p.x * cg + p.y * sg) * 1000, (-p.x * sg + p.y * cg) * 1000, p.z * 1000));
  if (selected.trackEntity) {
    selected.trackEntity.polyline.positions = positions;
  } else {
    selected.trackEntity = viewer.entities.add({
      polyline: { positions, width: 1.3, material: SELECT_COLOR.withAlpha(0.55) },
    });
  }
  selected.trackGmst = gmst;
}

// Per-frame smooth motion + live readout for the selected satellite only.
viewer.clock.onTick.addEventListener((clock) => {
  if (!selected) return;
  // The System view hand-ticks this same clock while Earth's loop idles; the
  // Earth selection is invisible then, so don't burn a per-frame propagation on it.
  if (document.body.classList.contains('system-mode')) return;
  const date = JulianDate.toDate(clock.currentTime);
  const pv = satellite.propagate(selected.satrec, date);
  if (!pv?.position) return;
  const gmst = satellite.gstime(date);
  const ecf = satellite.eciToEcf(pv.position, gmst);
  const pos = new Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000);
  selected.highlight.position = pos;

  // Keep the orbit ring aligned as time advances: re-sample the ECI shape once
  // the plane has precessed (>1 h of sim time), otherwise just re-rotate for
  // Earth's spin (~0.5° steps) — so the satellite stays on its own track.
  if (selected.trackEntity) {
    if (Math.abs(date.getTime() - selected.trackSampledMs) > 3_600_000) drawOrbitTrack(selected.satrec);
    else if (Math.abs(gmst - selected.trackGmst) > 0.0087) renderOrbitTrack();
  }

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
  if (groundStation.handleGlobeClick(click.position)) return;
  const picked = viewer.scene.pick(click.position, PICK_PAD, PICK_PAD);
  if (defined(picked) && typeof picked.id === 'number') {
    selectByIndex(picked.id);
  } else if (picked?.id && picked.id === selected?.modelEntity) {
    // clicking the 3D model keeps the selection
  } else if (!leaveShowpiece()) {
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

// ------------------------------------------------------ famous-craft close-ups ----
// Select a satellite and fly straight into a tracked close-up of its 3D model —
// the cinematic "see it up close" path (vs. the standoff fly-to).  Cesium
// animates the camera to the tracked entity, so it works from anywhere.
function inspectSat(i) {
  selectByIndex(i);
  autoFollowHoldUntil = Date.now() + 6000;
  engageFollow();
}
function inspectByNorad(norad, tries = 0) {
  const i = catalog.findIndex((c) => String(c.norad) === String(norad));
  if (i >= 0) { inspectSat(i); return; }
  if (!catalog.length && tries < 30) { setTimeout(() => inspectByNorad(norad, tries + 1), 400); return; }   // catalog still loading (give up after ~12 s)
  if (catalog.length) toast(`That satellite isn’t in today’s catalog (NORAD ${norad}).`, 5000);
}

// Showpieces (JWST, the Voyagers, SOHO…) live in src/showpieces.js: their own
// entities at the Lagrange points / out in deep space, searchable and fly-to-able.
// holdAutoFollow lets inspect() suppress the per-tick auto-follow during its flight.
const holdAutoFollow = (ms) => { autoFollowHoldUntil = Date.now() + ms; };
const showpieces = initShowpieces({ viewer, clearSelection, toast, holdAutoFollow });
const { inspect: inspectShowpiece, leave: leaveShowpiece } = showpieces;

// ---------------------------------------------------------------- legend ----

document.querySelectorAll('#legend input[data-cat]').forEach((box) => {
  box.addEventListener('change', () => {
    catVisible[box.dataset.cat] = box.checked;
    timeline.refreshVisibility();
  });
});

// Mobile: the display-options legend is a ☰-toggled slide-in drawer.  Tapping the
// scrim closes it, and leaving the Earth view (System / Moon) closes it too.
// On phones the legends are off-screen drawers; when closed, mark them `inert`
// so their ~15 controls leave the Tab order (and mirror aria-expanded on the
// toggle).  On desktop the media query is false, so the always-visible legend
// never goes inert.
const drawerMq = window.matchMedia('(max-width: 760px)');
const setLegendOpen = (open) => {
  document.body.classList.toggle('legend-open', open);
  $('legend-toggle').setAttribute('aria-expanded', String(open));
  $('legend').inert = drawerMq.matches && !open;
};
$('legend-toggle').addEventListener('click', () =>
  setLegendOpen(!document.body.classList.contains('legend-open')));
// The solar-system legend gets its own mobile drawer (the topbar ☰ is hidden in
// system-mode); it shares the scrim.
const setSysLegendOpen = (open) => {
  document.body.classList.toggle('system-legend-open', open);
  $('system-legend-toggle').setAttribute('aria-expanded', String(open));
  $('system-legend').inert = drawerMq.matches && !open;
};
$('system-legend-toggle').addEventListener('click', () =>
  setSysLegendOpen(!document.body.classList.contains('system-legend-open')));
setLegendOpen(false); setSysLegendOpen(false);   // establish the initial inert/expanded state
drawerMq.addEventListener('change', () => {       // recompute on rotate / resize across the breakpoint
  setLegendOpen(document.body.classList.contains('legend-open'));
  setSysLegendOpen(document.body.classList.contains('system-legend-open'));
});
$('legend-scrim').addEventListener('click', () => { setLegendOpen(false); setSysLegendOpen(false); });
$('system-toggle').addEventListener('click', () => setLegendOpen(false));
$('moon-toggle').addEventListener('click', () => setLegendOpen(false));

// Modal focus management for the two aria-modal dialogs: on open, remember where
// focus was and move it into the dialog; keep Tab inside it; on close, restore.
const welcome = $('welcome');
const guide = $('guide');
let modalReturn = null;
const focusablesIn = (el) => [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
  .filter((x) => !x.hidden && x.offsetParent !== null);
function openModal(el, focusEl) {
  if (welcome.hidden && guide.hidden) modalReturn = document.activeElement;   // capture only when entering from the app
  el.hidden = false;
  (focusEl || focusablesIn(el)[0])?.focus();
}
function closeModal(el) {
  el.hidden = true;
  if (welcome.hidden && guide.hidden) {   // no dialog left open → hand focus back to the app
    if (modalReturn && modalReturn.focus && modalReturn.isConnected) modalReturn.focus();
    modalReturn = null;
  }
}
// Trap Tab within whichever dialog is open (guide sits above welcome).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const modal = !guide.hidden ? guide : (!welcome.hidden ? welcome : null);
  if (!modal) return;
  const f = focusablesIn(modal);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// First-run welcome / how-to overlay — shown once, re-openable from the ? button.
const closeWelcome = () => {
  closeModal(welcome);
  try { localStorage.setItem('orbital.welcomed', '1'); } catch { /* ignore */ }
};
$('welcome-go').addEventListener('click', closeWelcome);
welcome.addEventListener('click', (e) => { if (e.target === welcome) closeWelcome(); });   // backdrop tap
$('help-toggle').addEventListener('click', () => openModal(welcome, $('welcome-go')));

// The full guide — its own page, opened from the welcome (or a #guide link),
// floating over whatever view you're in.  It never owns the hash; we only clear
// a stale #guide on close so a reload doesn't reopen it.
const openGuide = () => { openModal(guide, $('guide-close')); welcome.hidden = true; guide.scrollTop = 0; };
const closeGuide = () => {
  closeModal(guide);
  if (location.hash === '#guide') history.replaceState(null, '', location.pathname + location.search);
};
$('welcome-guide').addEventListener('click', () => { closeWelcome(); openGuide(); });
$('guide-close').addEventListener('click', closeGuide);
$('guide-done').addEventListener('click', closeGuide);
guide.addEventListener('click', (e) => { if (e.target === guide) closeGuide(); });   // backdrop tap

// (Esc is handled by the single dispatcher near the search wiring below.)
// First-timers see it — unless they followed a shared deep-link, which lands
// them straight on the thing the sender pointed at (the flag stays unset, so
// they still get the intro on a later visit to the bare page).
try { if (!location.hash && !localStorage.getItem('orbital.welcomed')) openModal(welcome, $('welcome-go')); }
catch { if (!location.hash) openModal(welcome, $('welcome-go')); }

// Installable-app (PWA) plumbing.  Register the service worker, and when Chrome
// decides the app is installable, reveal the welcome's "Install" button and use
// the saved prompt.  (iOS has no prompt API — Safari users add it from Share →
// Add to Home Screen; the button simply never appears there.)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => { /* not fatal */ });
  });
}
let deferredInstall = null;
const installBtn = $('welcome-install');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();          // we drive the prompt from our own button
  deferredInstall = e;
  if (installBtn) installBtn.hidden = false;
});
installBtn?.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => { if (installBtn) installBtn.hidden = true; });

// "Copy link" buttons (in each detail panel): the address bar already tracks
// the view via deeplink.js, so just hand over location.href.
async function copyShareLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied — paste it to share this view', 3000);
  } catch {
    toast(`Share this link:<br><span class="toast-url">${esc(location.href)}</span>`, 8000);
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
  const go = chip.dataset.go;
  if (go === 'jwst') inspectShowpiece('jwst');
  else if (go.startsWith('sat:')) inspectByNorad(go.slice(4));   // fly into the model close-up
  else navigateTo(destFromSpec(go));
}));

// -------------------------------------------------------------- group focus ----
// "Focus a group" chips (Starlink, OneWeb, GPS…, or an operator/nation) filter
// the swarm through the same refreshVisibility() pipeline as the regime toggles
// and the launch timeline, so they compose.  When nothing else owns the URL
// hash, an active group is shareable as #group=<id>.
const groups = initGroups({
  getCatalog: () => catalog,
  onChange: () => {
    timeline.refreshVisibility();
    const m = document.body.classList;
    if (!selected && !m.contains('system-mode') && !m.contains('moon-mode')) {
      writeHash(groups.activeId() ? { group: groups.activeId() } : null);
    }
  },
});

// ------------------------------------------------------------ launch timeline ----
// The launch-history scrubber lives in src/timeline.js.  It owns
// refreshVisibility() — the one place that applies the legend category toggles +
// the timeline year filter + the group focus to the swarm — which the legend
// handler and applyCatalog() call via timeline.refreshVisibility().
const timeline = initTimeline({
  getCatalog: () => catalog,
  getSwarm: () => swarm,
  catVisible, catOf,
  getCatTotals: () => catTotals,
  passesGroup: (s) => groups.passes(s),
});

// ------------------------------------------------------- coverage overlay ----
// "Starlink in view" heat overlay: for every point on Earth, how many Starlink
// satellites are above 25° elevation right now — line-of-sight density computed
// from the live propagator buffer, NOT service quality (gateways, licensing and
// capacity aren't modelled).
const coverage = initCoverage({
  viewer,
  getCatalog: () => catalog,
  getLastBuf: () => lastBuf,
  isEarthActive: () => !document.hidden
    && !document.body.classList.contains('system-mode')
    && !document.body.classList.contains('moon-mode'),
});

$('toggle-orbit').addEventListener('change', () => {
  if (selected?.trackEntity) {
    viewer.entities.remove(selected.trackEntity);
    selected.trackEntity = null;
  }
  if (selected && $('toggle-orbit').checked) drawOrbitTrack(selected.satrec);
});

// ------------------------------------------------- conjunctions + screening ----
// Live conjunctions, the 24 h forecast, and on-demand catalog screening all
// live in src/conjunctions.js (they share one TCA worker).  main feeds it each
// propagator tick's pairs via conj.render() and the lifecycle hooks below.
const conj = initConjunctions({
  viewer, conjLines, conjMarkers,
  getCatalog: () => catalog,
  getSelected: () => selected,
  getLastBuf: () => lastBuf,
  getGen: () => catalogGen,
  selectByIndex,
  holdAutoFollow,
});

// ------------------------------------------------------ ground station + sky ----
// The station marker, pass scans, the overhead sky chart and visible-pass alerts
// live in src/station.js.  main feeds it each propagator tick via renderSky(),
// routes globe clicks through handleGlobeClick(), and calls onCatalogSwap() /
// onElementsRefresh() from its catalog lifecycle.
const groundStation = initStation({
  viewer, stationPoints, stationLabels,
  getCatalog: () => catalog,
  getSelected: () => selected,
  getLastBuf: () => lastBuf,
  getGen: () => catalogGen,
  catVisible, catOf,
  selectByIndex, flyToSat, setRate, setLegendOpen, toast, holdAutoFollow,
});

// Fly the camera out to frame a satellite from a comfortable standoff (without
// locking on — auto-follow is held off so the flight isn't yanked short).
function flyToSat(i) {
  const pos = currentPosition(satellite.twoline2satrec(catalog[i].l1, catalog[i].l2));
  if (!pos) return;
  const range = Math.max(Cartesian3.magnitude(pos) * 0.12, 1.2e6);
  const dest = Cartesian3.multiplyByScalar(
    Cartesian3.normalize(pos, new Cartesian3()), Cartesian3.magnitude(pos) + range, new Cartesian3());
  autoFollowHoldUntil = Date.now() + 3000;
  viewer.camera.flyTo({ destination: dest, duration: flySeconds(1.4) });
}

// Navigate to a view described by a deep-link state object — shared by the
// on-load hash restore (applyDeepLink) and the welcome overlay's quick-jump
// chips.  A #sat= target needs the catalog; if it isn't in yet (a chip tapped
// during boot), retry until it loads.
function navigateTo(s, tries = 0) {
  if (!s) return;
  if (s.sat != null) {
    const i = catalog.findIndex((c) => String(c.norad) === String(s.sat));
    if (i >= 0) { selectByIndex(i); flyToSat(i); }
    else if (!catalog.length && tries < 30) setTimeout(() => navigateTo(s, tries + 1), 400);   // give up after ~12 s
    return;
  }
  if (s.guide) { openGuide(); return; }
  if (s.luna) { moonView.show(); return; }
  if (s.show) { inspectShowpiece(s.show); return; }
  if (s.system) { systemView.show(); return; }
  if (s.group) { if (groups.has(s.group) && groups.activeId() !== s.group) groups.setActive(s.group); return; }
  const name = s.body || s.moon || s.probe;
  if (name) { systemView.show(); systemView.focus(name); }
}

// Restore the view named in the URL hash on first load (see deeplink.js).
function applyDeepLink() { navigateTo(readHash()); }


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

// ARIA 1.2 combobox: the input keeps focus, options are navigated with the arrow
// keys via aria-activedescendant, Enter activates the highlighted one.
const options = [];       // { el, go } for the currently-listed results
let activeOpt = -1;

function closeResults() {
  resultsEl.hidden = true;
  searchBox.setAttribute('aria-expanded', 'false');
  searchBox.removeAttribute('aria-activedescendant');
  activeOpt = -1;
}

function setActiveOpt(i) {
  if (!options.length) return;
  activeOpt = (i + options.length) % options.length;
  options.forEach((o, k) => {
    const on = k === activeOpt;
    o.el.classList.toggle('active', on);
    o.el.setAttribute('aria-selected', String(on));
  });
  const el = options[activeOpt].el;
  searchBox.setAttribute('aria-activedescendant', el.id);
  el.scrollIntoView({ block: 'nearest' });
}

// Append one result row wired for both pointer (click) and keyboard (Enter on the
// highlighted option); `action` performs the navigation, then the list is cleared.
function addOption(innerHTML, action) {
  const row = document.createElement('div');
  row.className = 'result-row';
  row.id = `search-opt-${options.length}`;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', 'false');
  row.tabIndex = -1;
  row.innerHTML = innerHTML;
  const go = () => { action(); closeResults(); searchBox.value = ''; };
  row.addEventListener('click', go);
  resultsEl.appendChild(row);
  options.push({ el: row, go });
}

searchBox.addEventListener('input', () => {
  const q = searchBox.value.trim().toUpperCase();
  options.length = 0;
  activeOpt = -1;
  searchBox.removeAttribute('aria-activedescendant');   // don't leave it pointing at a recycled/removed option
  resultsEl.innerHTML = '';
  if (q.length < 2) { closeResults(); return; }
  const hits = [];
  for (let i = 0; i < catalog.length && hits.length < 12; i++) {
    if (catalog[i].name.toUpperCase().includes(q) || String(catalog[i].norad) === q) {
      hits.push(i);
    }
  }
  // Showpieces (JWST, Voyager, SOHO…) aren't in the catalog — they don't orbit
  // Earth — so surface any that match and fly out to them, searchable like a sat.
  // Match on word boundaries so "ace" finds ACE without also matching "sp-ACE".
  const qWord = new RegExp('\\b' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const sp of showpieces.list) {
    if (!qWord.test(sp.kw) && !qWord.test(sp.name.toUpperCase())) continue;
    const [name, tag] = sp.name.split(' · ');
    addOption(`<span>${name}</span><span class="rid">${tag || ''}</span>`, () => inspectShowpiece(sp.id));
  }
  // Solar-system bodies (the Sun, planets, dwarf planets) — fly out to them in
  // the system view, searchable by name like everything else.
  for (const b of systemView.searchBodies) {
    if (!b.name.toUpperCase().includes(q)) continue;
    addOption(`<span>${b.name}</span><span class="rid">${b.kind}</span>`, () => navigateTo({ body: b.name }));
  }
  for (const i of hits) {
    addOption(`<span>${esc(catalog[i].name)}</span><span class="rid">${catalog[i].norad}</span>`, () => selectByIndex(i));
  }
  const has = options.length > 0;
  resultsEl.hidden = !has;
  searchBox.setAttribute('aria-expanded', String(has));
});

searchBox.addEventListener('keydown', (e) => {
  if (resultsEl.hidden || !options.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); setActiveOpt(activeOpt + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveOpt(activeOpt - 1); }
  else if (e.key === 'Enter' && activeOpt >= 0) { e.preventDefault(); options[activeOpt].go(); }
});
// Close the popup when focus leaves the combobox (tab away / click the scene) so
// it doesn't sit open over the globe with aria-expanded stuck true.  The mousedown
// preventDefault keeps a row click from blurring the input first (which would hide
// the row before its click fired).
resultsEl.addEventListener('mousedown', (e) => e.preventDefault());
searchBox.addEventListener('focusout', (e) => { if (!resultsEl.contains(e.relatedTarget)) closeResults(); });

// Single Esc dispatcher — one keypress, one action, in strict priority order.
// (Previously four capture-phase listeners across the view modules all fired on
// the same Esc because stopPropagation doesn't stop siblings on the same node.)
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchBox) {
    e.preventDefault(); searchBox.focus(); return;
  }
  if (e.key !== 'Escape') return;
  if (!resultsEl.hidden) { closeResults(); return; }        // an open search dropdown consumes Esc (one key, one action)
  if (!guide.hidden) { closeGuide(); return; }              // modal overlays first
  if (!welcome.hidden) { closeWelcome(); return; }
  if (moonView.visible) { moonView.hide(); return; }         // then the open view
  if (systemView.visible) { systemView.stepBack(); return; } // (handles body globe + selections)
  if (!leaveShowpiece()) { clearSelection(); $('infopanel').hidden = true; }   // Earth view
}, true);

// ----------------------------------------------------------------- debug ----

window.__orbital = {
  viewer,
  moonView,
  systemView,
  selectByIndex,
  refreshCatalog,
  applyCatalog,   // debug: force a full hot-swap (e.g. to check selection survival)
  get catalog() { return catalog; },
  get swarm() { return swarm; },
  get selected() { return selected; },
  get skyPlotted() { return groundStation.skyPlotted; },   // debug: dots in the overhead chart
  get posTicks() { return posTicks; },                     // debug: applied full-catalog updates
  checkPassAlerts: () => groundStation.checkPassAlerts(),   // debug: force a visible-pass check
  groups,                                                   // debug: group-focus filter
  coverage,                                                 // debug: Starlink coverage overlay
};
