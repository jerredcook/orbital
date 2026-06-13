// bodyglobe.js — descend to a planet's surface, the way moon.js does for the Moon.
//
// "Entering" a planet from the solar-system view spins up a Cesium globe scoped
// to that planet's own ellipsoid (so the camera math, tiling and zoom limits are
// the planet's), clad in real imagery you can zoom into:
//   • Mars & Mercury — NASA Solar System Treks tile pyramids (Viking / MESSENGER),
//     high-resolution all the way down to the surface;
//   • Venus and the gas giants — their equirectangular map as a single-tile
//     globe (no rocky surface to descend to, but a navigable world all the same).
//
// One globe lives at a time on a shared container: switching planets destroys the
// old viewer and builds the new one, keeping the WebGL-context count low (Earth,
// Moon, System, and at most one of these).  Exiting hands control back to the
// solar-system view via the onExit callback supplied by the caller.

import {
  Viewer, Globe, GeographicProjection, Ellipsoid, ImageryLayer,
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
  },
  Mercury: {
    url: 'https://trek.nasa.gov/tiles/Mercury/EQ/Mercury_MESSENGER_MDIS_Basemap_LOI_Mosaic_Global_166m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    maxLevel: 7, credit: 'Mercury: NASA/JHUAPL/Carnegie MESSENGER MDIS · NASA Solar System Treks',
  },
};
const LOCAL_CREDIT = 'Surface map © Solar System Scope (CC BY 4.0)';

let viewer = null;        // the single live body globe
let activeName = null;
let onExitCb = null;
let visible = false;

function makeViewer(name) {
  const R = BODIES[name].radius;
  const ellipsoid = new Ellipsoid(R, R, R);
  const treks = TREKS[name];

  // Passing the ellipsoid to the Viewer (not just its Globe) is what scopes the
  // camera controller to this body — see moon.js for the gory detail.
  const v = new Viewer('bodyContainer', {
    ellipsoid,
    globe: new Globe(ellipsoid),
    mapProjection: new GeographicProjection(ellipsoid),
    baseLayer: treks
      ? new ImageryLayer(new UrlTemplateImageryProvider({
        url: treks.url, maximumLevel: treks.maxLevel, credit: new Credit(treks.credit),
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

  // Gas giants / Venus: drape the local equirectangular map as one tile.
  if (!treks) {
    v.imageryLayers.add(ImageryLayer.fromProviderAsync(
      SingleTileImageryProvider.fromUrl(`${BASE}textures/planets/${BODIES[name].texture}`,
        { credit: new Credit(LOCAL_CREDIT) }), {}));
  }

  const ctrl = v.scene.screenSpaceCameraController;
  ctrl.minimumZoomDistance = treks ? 150 : R * 0.03;   // descend to the surface on Treks bodies
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
  $('body-attr').textContent = TREKS[name] ? TREKS[name].credit : `${name}: ${LOCAL_CREDIT}`;
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && visible) { e.stopPropagation(); hide(); }
  }, true);
  return { show, hide, get visible() { return visible; } };
}
