// solarsystem.js — a heliocentric "fly the solar system" view.
//
// Phase 1 of zooming all the way out from Earth: the Sun and the eight planets
// on their real orbits, a starfield, time-warp, and click-to-fly that hands you
// off to the existing Earth tracker (or the Moon globe) for surface detail.
//
// Like moon.js, this is a SECOND Cesium Viewer on its own container — but with
// the globe switched off entirely: there's no single body to stand on out here,
// so the camera flies free through space.  Two custom modules do the real work:
//   • ephemeris.js — JPL Keplerian positions for the planets (real meters)
//   • scale.js     — the readable⟷true-scale mapping every position runs through
// Planet positions, sizes and spin are CallbackPropertys evaluated against the
// *Earth* viewer's clock, so the topbar time controls drive both views and the
// readable⟷true toggle is instant (no rebuild).  Orbit rings are static geometry
// rebuilt only when that toggle flips.
//
// The Earth viewer's clock only advances while its render loop runs, and we idle
// that loop out here — so this viewer ticks the shared clock by hand each frame.

import {
  Viewer, SkyBox, Cartesian3, Color, CallbackProperty, Quaternion, Matrix4,
  DirectionalLight, ScreenSpaceEventHandler, ScreenSpaceEventType, NearFarScalar,
  Cartesian2, LabelStyle, VerticalOrigin, HorizontalOrigin, BoundingSphere,
  HeadingPitchRange, ArcType, Primitive, GeometryInstance, EllipsoidGeometry,
  VertexFormat, MaterialAppearance, Material, SceneTransforms, Math as CMath,
} from 'cesium';
import {
  BODIES, PLANETS, planetPosition, orbitSamples, centuriesSinceJ2000,
  orbitalPeriodCenturies, AU_METERS,
} from './ephemeris.js';
import {
  scenePosition, bodyRadius, setTrueScale, isTrueScale, systemExtent,
} from './scale.js';

const $ = (id) => document.getElementById(id);
// Asset paths are base-relative so they resolve under the GitHub Pages subpath
// (/orbital/) as well as at the dev-server root.
const BASE = import.meta.env.BASE_URL;
const TEX = (file) => `${BASE}textures/planets/${file}`;

let viewer = null;          // created lazily on first open
let visible = false;
let earthClock = null;      // the shared source-of-truth clock (Earth viewer's)
const entities = {};        // body name -> marker/label Entity
const spheres = {};         // body name -> textured sphere Primitive
let orbitEntities = [];     // { name, entity } for rebuild on scale toggle
let selectedName = null;

const ALL_BODIES = ['Sun', ...PLANETS];

// Scratch objects reused every frame to keep the per-frame allocation count low.
const _real = new Cartesian3();
const _pos = new Cartesian3();
const _quat = new Quaternion();
const _qSpin = new Quaternion();
const _qTilt = new Quaternion();
const _dir = new Cartesian3();
const _one = new Cartesian3(1, 1, 1);

// ----------------------------------------------------------- body building ----

// Scene-space position of a body at the shared clock time (Sun at the origin).
function scenePosOf(name, out) {
  if (name === 'Sun') return Cartesian3.clone(Cartesian3.ZERO, out);
  const T = centuriesSinceJ2000(earthClock.currentTime);
  planetPosition(name, T, _real);
  return scenePosition(_real, out);
}

// Body orientation: axial tilt × spin, so time-warp visibly rotates it.
function quatOf(name, out) {
  const tilt = BODIES[name].tilt * Math.PI / 180;
  const periodSec = BODIES[name].day * 3600;     // signed: retrograde spins negate
  const sec = centuriesSinceJ2000(earthClock.currentTime) * 36525 * 86400;
  const spin = (sec / periodSec) * 2 * Math.PI;
  Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, spin, _qSpin);
  Quaternion.fromAxisAngle(Cartesian3.UNIT_X, tilt, _qTilt);
  return Quaternion.multiply(_qTilt, _qSpin, out);
}

// position Property for the marker/label entity to follow.
function positionProp(name) {
  if (name === 'Sun') return Cartesian3.ZERO;
  return new CallbackProperty((time, result) => scenePosOf(name, result || new Cartesian3()), false);
}

// The textured sphere itself is a Primitive, NOT an entity ellipsoid: entity
// ellipsoids silently drop image materials (they render flat white because the
// generated geometry lacks texture coordinates).  A Primitive with an explicit
// POSITION_NORMAL_AND_ST EllipsoidGeometry + MaterialAppearance textures
// reliably.  We move/spin it by writing its modelMatrix each frame.
function buildSphere(name) {
  const r = bodyRadius(BODIES[name].radius);
  const isSun = name === 'Sun';
  const primitive = new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new EllipsoidGeometry({
        radii: new Cartesian3(r, r, r),
        vertexFormat: VertexFormat.POSITION_NORMAL_AND_ST,
        slicePartitions: 48, stackPartitions: 48,
      }),
      id: name,                     // scene.pick resolves to this string
    }),
    appearance: new MaterialAppearance({
      material: Material.fromType('Image', { image: TEX(BODIES[name].texture) }),
      materialSupport: MaterialAppearance.MaterialSupport.TEXTURED,
      faceForward: false, closed: true,
      flat: isSun,                  // the Sun is emissive — don't shade a terminator onto it
    }),
    asynchronous: false,
  });
  viewer.scene.primitives.add(primitive);
  spheres[name] = primitive;
}

function addBody(name) {
  const isSun = name === 'Sun';
  entities[name] = viewer.entities.add({
    name,
    position: positionProp(name),
    // A constant-pixel marker so a body is locatable at any zoom (at full-system
    // scale even Jupiter is sub-pixel; up close the textured sphere dwarfs it).
    // Depth-tested, so flying in close hides it behind the body's own sphere.
    point: {
      pixelSize: isSun ? 18 : 9,
      color: Color.fromCssColorString(BODIES[name].color),
      outlineColor: Color.BLACK.withAlpha(0.5),
      outlineWidth: 1,
      // The Sun's marker lives inside its own (large) sphere, so it must draw on
      // top to be seen.  Planet markers stay depth-tested, so flying in close
      // tucks the dot behind the planet's sphere instead of floating on its face.
      disableDepthTestDistance: isSun ? Number.POSITIVE_INFINITY : undefined,
    },
    label: {
      text: name,
      font: '600 13px Inter, system-ui, sans-serif',
      fillColor: Color.fromCssColorString(BODIES[name].color),
      style: LabelStyle.FILL,
      verticalOrigin: VerticalOrigin.BOTTOM,
      horizontalOrigin: HorizontalOrigin.CENTER,
      pixelOffset: new Cartesian2(0, -10),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      // Fade labels out only when you're flying in very close (you can see the
      // body itself by then); readable across the whole overview otherwise.
      translucencyByDistance: new NearFarScalar(8e7, 0.0, 4e8, 1.0),
      show: !isSun,
    },
  });
  buildSphere(name);

  if (isSun) {
    viewer.entities.add({
      name: 'Sun',
      position: Cartesian3.ZERO,
      billboard: {
        // A real PNG URL — canvas/data-URL billboard images silently fail to
        // render in this build.  Pixel-sized (sizeInMeters billboards also don't
        // render here), grown toward the camera via scaleByDistance so it haloes
        // the Sun at every zoom.
        image: `${BASE}textures/sun-glow.png`,
        width: 130,
        height: 130,
        scaleByDistance: new NearFarScalar(5e8, 5.0, 2.0e10, 1.6),
        color: Color.WHITE.withAlpha(0.95),
      },
    });
  }
}

// Drive every sphere's transform from the ephemeris each frame (Primitives have
// no time-varying properties of their own, so we set modelMatrix by hand).
function updateSpheres() {
  for (const name of Object.keys(spheres)) {
    scenePosOf(name, _pos);
    quatOf(name, _quat);
    Matrix4.fromTranslationQuaternionRotationScale(_pos, _quat, _one, spheres[name].modelMatrix);
  }
}

// Radii are baked into the geometry, so a scale-toggle rebuilds the spheres once.
function rebuildSpheres() {
  for (const name of Object.keys(spheres)) {
    viewer.scene.primitives.remove(spheres[name]);   // destroys GL resources
    delete spheres[name];
  }
  for (const name of ALL_BODIES) buildSphere(name);
}

// After the scale toggle flips, rebuild the radius-baked sphere geometry.  (The
// Sun glow is pixel-sized, so it needs no rescaling.)
function applyScaleToBodies() {
  rebuildSpheres();
}

// Static orbit rings — sample the ellipse once (geometry barely moves over the
// overview's timescales), map through the current scale, rebuild on toggle.
function rebuildOrbits() {
  const T = centuriesSinceJ2000(earthClock.currentTime);
  for (const { name, entity } of orbitEntities) viewer.entities.remove(entity);
  orbitEntities = [];
  for (const name of PLANETS) {
    const positions = orbitSamples(name, T).map((p) => scenePosition(p, new Cartesian3()));
    const entity = viewer.entities.add({
      polyline: {
        positions,
        width: 2,
        // Straight segments between our 256 samples.  The default GEODESIC arc
        // type would densify each segment along Earth's ellipsoid — fatal out
        // here in heliocentric space (it tries to subdivide a billion-metre arc
        // into an unbounded vertex array and the heap dies).
        arcType: ArcType.NONE,
        material: Color.fromCssColorString(BODIES[name].color).withAlpha(0.5),
      },
    });
    orbitEntities.push({ name, entity });
  }
}

// ------------------------------------------------------------ info & select ----

const fmt = (n, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d });

function bodyFacts(name) {
  const b = BODIES[name];
  const diameterKm = b.radius * 2 / 1000;
  const dayH = Math.abs(b.day);
  const dayStr = dayH >= 48 ? `${fmt(dayH / 24, 1)} days` : `${fmt(dayH, 1)} h`;
  if (name === 'Sun') {
    return { type: 'Star · G2V', dist: '—', diameter: fmt(diameterKm), day: dayStr, year: '—' };
  }
  const T = centuriesSinceJ2000(earthClock.currentTime);
  planetPosition(name, T, _real);
  const distAu = Cartesian3.magnitude(_real) / AU_METERS;
  const years = orbitalPeriodCenturies(name) * 100;
  const yearStr = years >= 2 ? `${fmt(years, 1)} yr` : `${fmt(years * 365.25, 0)} days`;
  return {
    type: name === 'Earth' ? 'Planet · home' : 'Planet',
    dist: `${fmt(distAu, 2)} AU`, diameter: fmt(diameterKm),
    day: `${dayStr}${b.day < 0 ? ' (retro)' : ''}`, year: yearStr,
  };
}

function selectBody(name) {
  selectedName = name;
  const f = bodyFacts(name);
  $('sys-name').textContent = name;
  $('sys-type').textContent = f.type;
  $('sys-dist').textContent = f.dist;
  $('sys-diam').textContent = `${f.diameter} km`;
  $('sys-day').textContent = f.day;
  $('sys-year').textContent = f.year;
  $('sys-earth-actions').hidden = name !== 'Earth';
  $('system-panel').hidden = false;
  // Frame the body: a bounding sphere around its current position at a few radii.
  const r = bodyRadius(BODIES[name].radius);
  scenePosOf(name, _pos);
  viewer.camera.flyToBoundingSphere(new BoundingSphere(_pos, r), {
    duration: 1.5,
    offset: new HeadingPitchRange(0, CMath.toRadians(-12), r * 4.5),
  });
}

function deselect() {
  selectedName = null;
  $('system-panel').hidden = true;
}

// --------------------------------------------------------------- viewer ----

// Frame the whole system centred on the Sun, looking down at a 3/4 angle so the
// orbits read as concentric ellipses.  We place the camera explicitly and aim it
// at the origin: flyToBoundingSphere's HeadingPitchRange offset is computed in
// the local ENU frame at the sphere centre, which is *singular* at the geocentre
// (0,0,0) — so its pitch/heading come out garbage and the Sun lands off-screen.
function frameWholeSystem(duration = 0) {
  const D = systemExtent() * 2.0;
  const elev = CMath.toRadians(38);
  const C = new Cartesian3(0, -D * Math.cos(elev), D * Math.sin(elev));
  const dir = Cartesian3.normalize(Cartesian3.negate(C, new Cartesian3()), new Cartesian3());
  const up = Cartesian3.subtract(
    Cartesian3.UNIT_Z,
    Cartesian3.multiplyByScalar(dir, Cartesian3.dot(Cartesian3.UNIT_Z, dir), new Cartesian3()),
    new Cartesian3(),
  );
  Cartesian3.normalize(up, up);
  if (duration > 0) {
    viewer.camera.flyTo({ destination: C, orientation: { direction: dir, up }, duration, convert: false });
  } else {
    viewer.camera.setView({ destination: C, orientation: { direction: dir, up } });
  }
}

function createViewer() {
  const v = new Viewer('systemContainer', {
    globe: false,                 // no body to stand on out here — fly free
    baseLayer: false,
    skyBox: SkyBox.createEarthSkyBox(),
    baseLayerPicker: false, geocoder: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false, animation: false,
    timeline: false, fullscreenButton: false, infoBox: false,
    selectionIndicator: false,
  });

  v.scene.backgroundColor = Color.BLACK;
  v.scene.sun.show = false;          // the real Sun lives at our origin instead
  if (v.scene.moon) v.scene.moon.show = false;
  v.scene.skyAtmosphere.show = false;
  v.scene.fog.enabled = false;
  // A camera "headlight": the planet hemisphere you're looking at is always lit,
  // so the texture is visible no matter where the planet sits relative to a
  // fixed light (a directional light can't radiate from the Sun at the origin).
  v.scene.light = new DirectionalLight({ direction: new Cartesian3(0, 0, -1), intensity: 1.4 });

  // No globe to collide with — let the camera fly anywhere, close or far.
  const ctrl = v.scene.screenSpaceCameraController;
  ctrl.enableCollisionDetection = false;
  ctrl.minimumZoomDistance = 1e4;
  ctrl.maximumZoomDistance = systemExtent() * 8;

  viewer = v;
  earthClock = pendingClock;          // the Earth viewer's clock, captured in init()

  addBody('Sun');
  for (const name of PLANETS) addBody(name);
  rebuildOrbits();
  frameWholeSystem();

  // Keep the headlight aimed where the camera looks, and hand-tick the shared
  // clock (the Earth loop that normally ticks it is idle while we're up here).
  v.scene.preRender.addEventListener(() => {
    if (earthClock && earthClock.shouldAnimate) earthClock.tick();
    updateSpheres();
    Cartesian3.clone(v.camera.directionWC, _dir);
    v.scene.light.direction = _dir;
  });

  // Click a body to select + fly to it; click empty space to deselect.  A sphere
  // pick resolves to its instance id (the body-name string); a marker/label pick
  // resolves to the Entity (read its .name).
  const handler = new ScreenSpaceEventHandler(v.scene.canvas);
  handler.setInputAction(({ position }) => {
    const picked = v.scene.pick(position);
    const id = picked && picked.id;
    const name = typeof id === 'string' ? id : (id && id.name);
    if (name && entities[name]) selectBody(name);
    else deselect();
  }, ScreenSpaceEventType.LEFT_CLICK);

  return v;
}

// ------------------------------------------------------------- show / hide ----

function show(earthViewer) {
  if (!viewer) { pendingClock = earthViewer.clock; createViewer(); }
  visible = true;
  $('systemContainer').hidden = false;
  $('system-exit').hidden = false;
  $('system-scale').hidden = false;
  document.body.classList.add('system-mode');
  $('system-toggle').classList.add('active');
  earthViewer.useDefaultRenderLoop = false;
  viewer.useDefaultRenderLoop = true;
  viewer.resize();
}

function hide(earthViewer) {
  visible = false;
  deselect();
  $('systemContainer').hidden = true;
  $('system-exit').hidden = true;
  $('system-scale').hidden = true;
  document.body.classList.remove('system-mode');
  $('system-toggle').classList.remove('active');
  if (viewer) viewer.useDefaultRenderLoop = false;
  earthViewer.useDefaultRenderLoop = true;
}

// The Earth viewer's clock, captured at init so createViewer() can wire the
// CallbackPropertys against it before the first open.
let pendingClock = null;

// ------------------------------------------------------------------- init ----

export function initSystemView(earthViewer, moonView) {
  pendingClock = earthViewer.clock;

  $('system-toggle').addEventListener('click', () => {
    if (visible) hide(earthViewer);
    else show(earthViewer);
  });
  $('system-exit').addEventListener('click', () => hide(earthViewer));

  // Scale toggle — flip the mapping and rebuild the (static) orbit rings; the
  // CallbackProperty positions/radii pick up the change on the next frame.
  $('system-scale').addEventListener('change', (e) => {
    setTrueScale(e.target.checked);
    if (viewer) {
      applyScaleToBodies();
      rebuildOrbits();
      viewer.scene.screenSpaceCameraController.maximumZoomDistance = systemExtent() * 8;
      frameWholeSystem(1.2);
    }
  });

  // "Enter Earth" → back to the satellite tracker.  "Go to the Moon" → exit to
  // Earth first (its loop must be live), then open the lunar globe.
  $('sys-enter-earth').addEventListener('click', () => hide(earthViewer));
  $('sys-goto-moon').addEventListener('click', () => { hide(earthViewer); moonView.show(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && visible) {
      e.stopPropagation();   // don't also clear the hidden Earth selection
      if (selectedName) deselect();
      else hide(earthViewer);
    }
  }, true);

  return {
    show: () => show(earthViewer), hide: () => hide(earthViewer),
    get viewer() { return viewer; },
    select: (name) => selectBody(name),     // debug
    get bodies() { return entities; },        // debug
    screenOf: (name) => {                      // debug
      const p = scenePosOf(name, new Cartesian3());
      return SceneTransforms.worldToWindowCoordinates(viewer.scene, p);
    },
  };
}
