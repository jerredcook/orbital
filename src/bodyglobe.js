// bodyglobe.js — descend to a planet's surface, the way moon.js does for the Moon.
//
// "Entering" a planet from the solar-system view spins up a Cesium globe scoped
// to that planet's own ellipsoid (so the camera math, tiling and zoom limits are
// the planet's), clad in real imagery you can zoom into:
//   • Mars, Mercury & Ceres — NASA Solar System Treks tile pyramids (Viking /
//     MESSENGER / Dawn HAMO), high-resolution down toward the surface;
//   • Venus, the gas giants and Pluto — their equirectangular map as a single-
//     tile globe (a navigable world all the same; Pluto's 2k New Horizons map
//     is the best global data that exists).
//
// One globe lives at a time on a shared container: switching planets destroys the
// old viewer and builds the new one, keeping the WebGL-context count low (Earth,
// Moon, System, and at most one of these).  Exiting hands control back to the
// solar-system view via the onExit callback supplied by the caller.

import {
  Viewer, Globe, GeographicProjection, GeographicTilingScheme, Ellipsoid, ImageryLayer,
  UrlTemplateImageryProvider, SingleTileImageryProvider, EllipsoidTerrainProvider,
  Credit, Cartesian3,
} from 'cesium';
import { BODIES } from './ephemeris.js';
import { SURFACE, addSurfaceMarkers } from './surface.js';

const BASE = import.meta.env.BASE_URL;
const $ = (id) => document.getElementById(id);

// Real high-res surface mosaics (NASA Solar System Treks), same geographic tile
// pyramid the Moon uses.  maxLevel is where each pyramid bottoms out.
const TREKS = {
  Mars: {
    url: 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    maxLevel: 7, credit: 'Mars: NASA/USGS Viking MDIM2.1 · NASA Solar System Treks',
    // High-res overlay: the Bruce Murray Lab global CTX mosaic (~5 m/px, ~46×
    // finer than Viking), an Esri-hosted service on the *same* Mars_2000
    // geographic 2×1 tiling as Viking (512-px tiles).  It reveals past Viking's
    // depth (minLevel, applied as the layer's minimumTerrainLevel) so the colour
    // overview gives way to sharp grayscale as you descend; where CTX has a gap
    // the tile 404s and the colour Viking base shows through.
    hires: {
      url: 'https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX1/MapServer/tile/{z}/{y}/{x}',
      minLevel: 8, maxLevel: 12, tileSize: 512, minZoom: 30,
      credit: 'CTX mosaic: NASA/JPL/MSSS · Caltech Murray Lab · Esri',
    },
  },
  Mercury: {
    url: 'https://trek.nasa.gov/tiles/Mercury/EQ/Mercury_MESSENGER_MDIS_Basemap_LOI_Mosaic_Global_166m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    maxLevel: 7, credit: 'Mercury: NASA/JHUAPL/Carnegie MESSENGER MDIS · NASA Solar System Treks',
  },
  Ceres: {
    // The FC photo mosaic (59 ppd ≈ 140 m/px) — NOT the _ClrShade_ sibling,
    // which is a rainbow-tinted elevation map.
    url: 'https://trek.nasa.gov/tiles/Ceres/EQ/Ceres_Dawn_FC_DLR_global_59ppd_Feb2016/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    maxLevel: 5, credit: 'Ceres: NASA/JPL/MPS/DLR Dawn FC mosaic · NASA Solar System Treks',
  },
};
const LOCAL_CREDIT = 'Surface map © Solar System Scope (CC BY 4.0)';
// Bodies whose local map comes from Steve Albers' compilations instead.
const CREDIT_OVERRIDE = {
  Pluto: 'Surface map S. Albers (NASA New Horizons data)',
  Ceres: 'Surface map S. Albers (NASA Dawn data)',
};
const localCredit = (name) => CREDIT_OVERRIDE[name] || LOCAL_CREDIT;

let viewer = null;        // the single live body globe
let activeName = null;
let onExitCb = null;
let visible = false;

function makeViewer(name) {
  const R = BODIES[name].radius;
  const ellipsoid = new Ellipsoid(R, R, R);
  const treks = TREKS[name];

  // The Treks (and CTX) pyramids are equirectangular — 2×1 tiles at level 0 —
  // so they MUST use a GeographicTilingScheme.  UrlTemplateImageryProvider
  // otherwise defaults to WebMercator (1×1 at level 0), which misaddresses the
  // tiles (only the western hemisphere, stretched, with the markers floating
  // over the wrong terrain).
  const tilingScheme = new GeographicTilingScheme({ ellipsoid });

  // Passing the ellipsoid to the Viewer (not just its Globe) is what scopes the
  // camera controller to this body — see moon.js for the gory detail.
  const v = new Viewer('bodyContainer', {
    ellipsoid,
    globe: new Globe(ellipsoid),
    mapProjection: new GeographicProjection(ellipsoid),
    baseLayer: treks
      ? new ImageryLayer(new UrlTemplateImageryProvider({
        url: treks.url, maximumLevel: treks.maxLevel, tilingScheme, credit: new Credit(treks.credit),
      }))
      : false,
    terrainProvider: new EllipsoidTerrainProvider({ ellipsoid }),
    skyAtmosphere: false,
    baseLayerPicker: false, geocoder: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false, animation: false,
    timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
  });

  // The mosaics are uniformly-lit albedo maps; leave lighting off so the whole
  // globe reads (enabling it would re-impose a terminator and black out half).
  v.scene.globe.enableLighting = false;
  v.scene.globe.showGroundAtmosphere = false;
  v.scene.fog.enabled = false;
  v.scene.moon = undefined;

  // High-res overlay on top of the colour base, where one exists (Mars CTX).
  // The reveal is gated by the LAYER's minimumTerrainLevel (skip the overlay
  // until the globe has refined past Viking's depth) — NOT the provider's
  // minimumLevel, which would clamp every terrain tile up to level 8 and fire
  // tens of thousands of CTX requests at the wide global view (Cesium warns
  // against exactly that).
  if (treks?.hires) {
    const h = treks.hires;
    v.imageryLayers.add(new ImageryLayer(new UrlTemplateImageryProvider({
      url: h.url, maximumLevel: h.maxLevel,
      tileWidth: h.tileSize, tileHeight: h.tileSize, tilingScheme, credit: new Credit(h.credit),
    }), { minimumTerrainLevel: h.minLevel }));
  }

  // Gas giants / Venus: drape the local equirectangular map as one tile.
  if (!treks) {
    v.imageryLayers.add(ImageryLayer.fromProviderAsync(
      SingleTileImageryProvider.fromUrl(`${BASE}textures/planets/${BODIES[name].texture}`,
        { credit: new Credit(localCredit(name)) }), {}));
  }

  const ctrl = v.scene.screenSpaceCameraController;
  // Treks bodies descend to the surface; with a high-res overlay go closer still.
  ctrl.minimumZoomDistance = treks ? (treks.hires?.minZoom ?? 150) : R * 0.03;
  ctrl.maximumZoomDistance = R * 5;
  addSurfaceMarkers(v, ellipsoid, SURFACE[name]);   // landing sites, where we have them
  v.camera.setView({ destination: Cartesian3.fromDegrees(0, 0, R * 1.4, ellipsoid) });
  return v;
}

function show(name, onExit) {
  if (viewer && activeName !== name) { viewer.destroy(); viewer = null; }
  if (!viewer) { viewer = makeViewer(name); activeName = name; }
  onExitCb = onExit;
  if (window.__orbital) window.__orbital.bodyViewer = viewer;   // debug
  visible = true;
  $('bodyContainer').hidden = false;
  $('body-exit').hidden = false;
  $('body-attr').hidden = false;
  const treks = TREKS[name];
  $('body-attr').textContent = treks
    ? (treks.hires ? `${treks.credit} · ${treks.hires.credit}` : treks.credit)
    : `${name}: ${localCredit(name)}`;
  viewer.useDefaultRenderLoop = true;
  viewer.resize();
}

function hide() {
  if (!visible) return;
  visible = false;
  $('bodyContainer').hidden = true;
  $('body-exit').hidden = true;
  $('body-attr').hidden = true;
  if (viewer) viewer.useDefaultRenderLoop = false;
  const cb = onExitCb; onExitCb = null;
  if (cb) cb();
}

export function initBodyGlobes() {
  $('body-exit').addEventListener('click', hide);
  // Esc is handled by main.js's dispatcher (via systemView.stepBack → this hide).
  return { show, hide, get visible() { return visible; } };
}
