// main.js — scene setup, render loop, and UI wiring.

import {
  Viewer, ImageryLayer, TileMapServiceImageryProvider, EllipsoidTerrainProvider,
  buildModuleUrl, Cartesian3, Color, PointPrimitiveCollection, JulianDate,
  ScreenSpaceEventHandler, ScreenSpaceEventType, Moon, NearFarScalar,
  CallbackProperty, defined,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import * as satellite from 'satellite.js';
import { loadCatalog } from './data.js';
import { decodeOwner, decodeSite } from './decode.js';

// ---------------------------------------------------------------- scene ----

const REGIME_COLORS = {
  LEO: Color.fromCssColorString('#5EC8E5'),
  MEO: Color.fromCssColorString('#C9A0FF'),
  GEO: Color.fromCssColorString('#FFD166'),
  HEO: Color.fromCssColorString('#FF8C66'),
};
const SELECT_COLOR = Color.fromCssColorString('#FFB454');

const viewer = new Viewer('cesiumContainer', {
  baseLayer: ImageryLayer.fromProviderAsync(
    TileMapServiceImageryProvider.fromUrl(
      buildModuleUrl('Assets/Textures/NaturalEarthII'),
    ),
  ),
  terrainProvider: new EllipsoidTerrainProvider(),
  baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, navigationHelpButton: false, animation: false,
  timeline: false, fullscreenButton: false, infoBox: false,
  selectionIndicator: false,
});

viewer.scene.moon = new Moon();
viewer.scene.globe.enableLighting = true;
viewer.scene.screenSpaceCameraController.minimumZoomDistance = 50_000;
viewer.clock.shouldAnimate = true;
viewer.clock.multiplier = 1;

const points = viewer.scene.primitives.add(new PointPrimitiveCollection());

// ---------------------------------------------------------------- state ----

let catalog = [];          // [{ name, l1, l2, norad, meta, regime }]
let pointRefs = [];        // PointPrimitive per catalog index
let selected = null;       // { index, satrec, entity }
let following = false;
const regimeVisible = { LEO: true, MEO: true, GEO: true, HEO: true };

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
    const buf = msg.buf;
    for (let i = 0; i < pointRefs.length; i++) {
      const x = buf[i * 3];
      if (Number.isNaN(x)) { pointRefs[i].show = false; continue; }
      pointRefs[i].show = regimeVisible[catalog[i].regime];
      pointRefs[i].position = new Cartesian3(x, buf[i * 3 + 1], buf[i * 3 + 2]);
    }
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
  });
}, 600);

// ----------------------------------------------------------------- boot ----

async function boot() {
  try {
    catalog = await loadCatalog(status);
  } catch (err) {
    status('catalog fetch failed — see console');
    console.error(err);
    return;
  }

  const counts = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };
  for (let i = 0; i < catalog.length; i++) {
    const sat = catalog[i];
    counts[sat.regime]++;
    pointRefs.push(points.add({
      position: Cartesian3.ZERO,
      pixelSize: 2.2,
      color: REGIME_COLORS[sat.regime],
      scaleByDistance: new NearFarScalar(2.0e6, 2.2, 6.0e7, 1.0),
      id: i,
      show: false,
    }));
  }
  for (const r of Object.keys(counts)) {
    $(`count-${r}`).textContent = counts[r].toLocaleString();
  }

  worker.postMessage({
    type: 'init',
    tles: catalog.map(({ norad, l1, l2 }) => ({ norad, l1, l2 })),
  });
}
boot();

// ------------------------------------------------------------- selection ----

function selectByIndex(index) {
  clearSelection();
  const sat = catalog[index];
  const satrec = satellite.twoline2satrec(sat.l1, sat.l2);
  selected = { index, satrec };
  pointRefs[index].color = SELECT_COLOR;
  pointRefs[index].pixelSize = 7;
  drawOrbitTrack(satrec);
  fillInfoPanel(sat);
  $('infopanel').hidden = false;
}

function clearSelection() {
  if (!selected) return;
  const i = selected.index;
  pointRefs[i].color = REGIME_COLORS[catalog[i].regime];
  pointRefs[i].pixelSize = 2.2;
  viewer.entities.removeAll();
  viewer.trackedEntity = undefined;
  following = false;
  $('info-track').classList.remove('active');
  $('info-track').textContent = 'Follow this satellite';
  selected = null;
}

// Closed-ellipse orbit track: sample one full period in ECI, project to the
// fixed frame at the current GMST so it renders as the classic orbital ring.
function drawOrbitTrack(satrec) {
  if (!$('toggle-orbit').checked) return;
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
  viewer.entities.add({
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
  pointRefs[selected.index].position = pos;

  const geo = satellite.eciToGeodetic(pv.position, gmst);
  $('info-alt').textContent = `${(geo.height).toFixed(0)} km`;
  const v = pv.velocity;
  $('info-speed').textContent = `${Math.hypot(v.x, v.y, v.z).toFixed(2)} km/s`;

  if (following && selected.followEntity) {
    selected.followEntity.position = pos;
  }
});

// ---------------------------------------------------------------- picking ----

const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  if (defined(picked) && typeof picked.id === 'number') {
    selectByIndex(picked.id);
  } else {
    clearSelection();
    $('infopanel').hidden = true;
  }
}, ScreenSpaceEventType.LEFT_CLICK);

// ------------------------------------------------------------- info panel ----

function fillInfoPanel(sat) {
  const m = sat.meta;
  $('info-regime').textContent = `${sat.regime} · NORAD catalog`;
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

$('info-track').addEventListener('click', () => {
  if (!selected) return;
  if (following) {
    viewer.trackedEntity = undefined;
    following = false;
    $('info-track').classList.remove('active');
    $('info-track').textContent = 'Follow this satellite';
    return;
  }
  const entity = viewer.entities.add({
    position: Cartesian3.ZERO,
    point: { pixelSize: 0 },
  });
  selected.followEntity = entity;
  viewer.trackedEntity = entity;
  following = true;
  $('info-track').classList.add('active');
  $('info-track').textContent = 'Stop following';
});

// ---------------------------------------------------------------- legend ----

document.querySelectorAll('#legend input[data-regime]').forEach((box) => {
  box.addEventListener('change', () => {
    regimeVisible[box.dataset.regime] = box.checked;
    for (let i = 0; i < pointRefs.length; i++) {
      if (catalog[i].regime === box.dataset.regime) {
        pointRefs[i].show = box.checked;
      }
    }
  });
});

$('toggle-orbit').addEventListener('change', () => {
  viewer.entities.removeAll();
  if (selected && $('toggle-orbit').checked) drawOrbitTrack(selected.satrec);
});

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
