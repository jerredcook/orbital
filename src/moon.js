// moon.js — a navigable lunar globe you can fly to and zoom into.
//
// Cesium's built-in `scene.moon` is only a billboard in the Earth sky; the
// camera is bound to Earth's ellipsoid, so there's no way to descend to the
// surface.  This module spins up a *second* Viewer whose globe sits on the
// Moon ellipsoid (Ellipsoid.MOON) and is clad in NASA/USGS imagery, so the
// camera math, tiling, and zoom limits are all lunar.  Scoping the ellipsoid
// to this viewer's Globe keeps Earth's WGS84 math (satellite propagation,
// picking) completely untouched — `scene.ellipsoid` reads from the globe, so
// we never touch the global `Ellipsoid.default`.

import {
  Viewer, Globe, GeographicProjection, Ellipsoid, ImageryLayer,
  UrlTemplateImageryProvider, EllipsoidTerrainProvider, Credit, Cartesian3,
} from 'cesium';

// LRO Wide Angle Camera global mosaic, 303 px/deg (~100 m/px), served
// keylessly by NASA's Solar System Treks as a plain geographic tile pyramid
// (level 0 = two root tiles, matching Cesium's default GeographicTilingScheme).
// Max depth is level 8.
const LRO_WAC = new UrlTemplateImageryProvider({
  url: 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
  maximumLevel: 8,
  credit: new Credit('Lunar imagery: NASA/USGS LRO WAC Global Mosaic · NASA Solar System Treks'),
});

const $ = (id) => document.getElementById(id);

let moonViewer = null;   // created lazily on first open
let visible = false;

function createMoonViewer() {
  const v = new Viewer('moonContainer', {
    // `ellipsoid` is what sets scene.ellipsoid — the surface the camera
    // controller collides and clamps against.  Passing only a Moon `globe`
    // renders a Moon-sized sphere but leaves the controller fenced off at
    // Earth's 6,378 km radius, so you can never descend to the surface.
    ellipsoid: Ellipsoid.MOON,
    globe: new Globe(Ellipsoid.MOON),
    mapProjection: new GeographicProjection(Ellipsoid.MOON),
    baseLayer: new ImageryLayer(LRO_WAC),
    terrainProvider: new EllipsoidTerrainProvider({ ellipsoid: Ellipsoid.MOON }),
    skyAtmosphere: false,         // no air on the Moon — no limb glow
    baseLayerPicker: false, geocoder: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false, animation: false,
    timeline: false, fullscreenButton: false, infoBox: false,
    selectionIndicator: false,
  });

  // The WAC mosaic is already a uniformly-lit albedo map, so leave globe
  // lighting off (enabling it would re-impose a day/night terminator and
  // black out half the surface).  Kill the Earth-flavoured atmosphere/fog too.
  v.scene.globe.enableLighting = false;
  v.scene.globe.showGroundAtmosphere = false;
  v.scene.fog.enabled = false;
  v.scene.moon = undefined;       // don't render a moon-in-the-sky from the Moon

  // Zoom envelope in lunar terms: from ~100 m off the regolith out to a few
  // lunar radii so the whole disk frames cleanly.
  const ctrl = v.scene.screenSpaceCameraController;
  ctrl.minimumZoomDistance = 100;
  ctrl.maximumZoomDistance = 12_000_000;

  // Open looking at the full disk from ~4,000 km up over (0°, 0°).
  v.camera.setView({
    destination: Cartesian3.fromDegrees(0, 0, 4_000_000, Ellipsoid.MOON),
  });

  return v;
}

function show(earthViewer) {
  if (!moonViewer) moonViewer = createMoonViewer();
  visible = true;
  $('moonContainer').hidden = false;
  $('moon-exit').hidden = false;
  document.body.classList.add('moon-mode');
  $('moon-toggle').classList.add('active');

  // Hand the render loop to the Moon and idle the Earth scene so we're not
  // paying for two globes at once.
  earthViewer.useDefaultRenderLoop = false;
  moonViewer.useDefaultRenderLoop = true;
  moonViewer.resize();
}

function hide(earthViewer) {
  visible = false;
  $('moonContainer').hidden = true;
  $('moon-exit').hidden = true;
  document.body.classList.remove('moon-mode');
  $('moon-toggle').classList.remove('active');

  if (moonViewer) moonViewer.useDefaultRenderLoop = false;
  earthViewer.useDefaultRenderLoop = true;
}

// Wire the topbar toggle, the in-view exit button, and Esc-to-leave.
export function initMoonView(earthViewer) {
  $('moon-toggle').addEventListener('click', () => {
    if (visible) hide(earthViewer);
    else show(earthViewer);
  });
  $('moon-exit').addEventListener('click', () => hide(earthViewer));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && visible) {
      e.stopPropagation();   // don't also clear the (hidden) Earth selection
      hide(earthViewer);
    }
  }, true);

  // Expose for debugging, mirroring window.__orbital.viewer.
  return { show: () => show(earthViewer), hide: () => hide(earthViewer), get viewer() { return moonViewer; } };
}
