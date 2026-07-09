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
  VertexFormat, MaterialAppearance, Material, Matrix3, SceneTransforms,
  Geometry, GeometryAttribute, ComponentDatatype, PrimitiveType, BlendingState,
  PolylineGlowMaterialProperty, PolylineDashMaterialProperty, Math as CMath,
} from 'cesium';
import {
  BODIES, PLANETS, planetPosition, orbitSamples, centuriesSinceJ2000,
  orbitalPeriodCenturies, AU_METERS, eclipticFromElements, POLES,
} from './ephemeris.js';
import { MOON_ELEMENTS } from './moon-elements.js';
import { DWARF_ELEMENTS } from './dwarf-elements.js';
import { COMET_ELEMENTS } from './comet-elements.js';
import { INTERSTELLAR_ELEMENTS } from './interstellar-elements.js';
import {
  scenePosition, bodyRadius, setTrueScale, isTrueScale, systemExtent,
} from './scale.js';
import { createBelt, createTrojans, createFamilies, createHildas } from './belt.js';
import { initBodyGlobes } from './bodyglobe.js';
import { writeHash } from './deeplink.js';
import { flySeconds } from './motion.js';
import {
  dwarfPos, cometPos, interstellarPos, elemHyperbolaSamples, elemOrbitSamples, moonRelPos,
} from './helio.js';
import { MOONS, MOON_FACTS, MOON_TEX, MOON_TEX_DIR } from './moon-data.js';
import { PROBES, PROBE_FACTS } from './probe-data.js';
import { initProbes, nowYear } from './sys-probes.js';

// Planets with a solid surface to descend onto (the rest show their cloud tops).
const ROCKY = new Set(['Mercury', 'Venus', 'Mars', 'Ceres']);

const $ = (id) => document.getElementById(id);
// Asset paths are base-relative so they resolve under the GitHub Pages subpath
// (/orbital/) as well as at the dev-server root.
const BASE = import.meta.env.BASE_URL;
const TEX = (file) => `${BASE}textures/planets/${file}`;
const SKY_TEX = `${BASE}textures/starmap.jpg`;

// Obliquity of the ecliptic — the star map is in equatorial coordinates, so we
// tilt it by this to sit correctly relative to the planets' (ecliptic) plane.
const OBLIQUITY = 23.43928 * Math.PI / 180;
// The celestial sphere sits well outside the planets; the camera's zoom-out is
// capped just inside it so you approach the stars but never fly through them.
// Capped in absolute terms so true scale (where the system is ~4.6e12 m across)
// doesn't push the sphere out to ~5e13 m, where the depth range gets unstable.
const skyRadius = () => Math.min(systemExtent() * 10, 3.0e13);

let viewer = null;          // created lazily on first open
let visible = false;
let earthClock = null;      // the shared source-of-truth clock (Earth viewer's)
let onReturnToEarth = null; // main.js hook to re-centre Earth when we exit
let moonRef = null;         // the Moon view, so show() can close it (one mode at a time)
const entities = {};        // body name -> marker/label Entity
const moonInfo = {};        // moon name -> { planet, entity, realR, periodDays, facts }
const spheres = {};         // body name -> textured sphere Primitive
const moonSpheres = {};     // moon name -> textured sphere Primitive (textured moons only)
let orbitEntities = [];     // { name, entity } for rebuild on scale toggle
let skyPrimitive = null;    // the NASA star-map celestial sphere
let ringPrimitive = null;   // Saturn's rings
let belt = null;            // the asteroid-belt swarm controller
let trojans = null;         // Jupiter L4/L5 Trojan swarm controller
let hildas = null;          // Hilda group swarm controller (3:2 resonance triangle)
let families = null;        // main-belt family swarm controller (coloured rings)
let bodyGlobes = null;      // the per-planet surface-globe controller
let inBodyGlobe = false;    // true while a planet globe is open over the system
let selectedName = null;
let selectedMoonName = null;
let selectedProbeName = null;
let anchorEntity = null;    // the entity (planet or moon) camera orbit/zoom pivots on
const _anchorPos = new Cartesian3();
const _anchorMat = new Matrix4();
const SYSTEM_MIN_ZOOM = 1e4;   // free-fly floor when not pivoting on a body

const DWARFS = Object.keys(DWARF_ELEMENTS);   // Ceres, Pluto, Haumea, Makemake, Eris
const COMETS = Object.keys(COMET_ELEMENTS);   // Halley, Encke, Hale-Bopp, NEOWISE
const INTERSTELLARS = Object.keys(INTERSTELLAR_ELEMENTS);   // Oumuamua, Borisov, 3I/ATLAS
// ALL_BODIES tracks bodies with a rendered sphere (Sun, planets, dwarfs) — the
// comets and interstellar objects have none, so they're excluded here but still
// get a marker via addBody.
const ALL_BODIES = ['Sun', ...PLANETS, ...DWARFS];

// Scratch objects reused every frame to keep the per-frame allocation count low.
const _real = new Cartesian3();
const _pos = new Cartesian3();
const _moonHost = new Cartesian3();
const _moonRel = new Cartesian3();

// Heliocentric positions + sampled orbit paths for the dwarfs, comets,
// interstellar visitors and moons come from src/helio.js (pure Kepler off the
// committed element tables).
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
  const days = T * 36525;
  if (DWARF_ELEMENTS[name]) dwarfPos(name, days, _real);
  else if (COMET_ELEMENTS[name]) cometPos(name, days, _real);
  else if (INTERSTELLAR_ELEMENTS[name]) interstellarPos(name, days, _real);
  else planetPosition(name, T, _real);
  return scenePosition(_real, out);
}

// Body orientation: real IAU pole × spin, so time-warp visibly rotates it.
// Precompute each body's pole-alignment quaternion (rotate scene +Z onto the
// pole from ephemeris.POLES); bodies with no IAU pole (Haumea, Makemake, Eris)
// fall back to the simple about-X tilt.  This is what keeps Saturn's rings in
// the same plane its moons (real Horizons nodes) actually orbit in.
const _poleAxis = new Cartesian3();
const POLE_QUAT = {};
function poleQuat(name) {
  let q = POLE_QUAT[name];
  if (q) return q;
  q = new Quaternion();
  const pole = POLES[name];
  if (pole) {
    Cartesian3.cross(Cartesian3.UNIT_Z, pole, _poleAxis);
    const s = Cartesian3.magnitude(_poleAxis);
    if (s < 1e-9) Quaternion.clone(Quaternion.IDENTITY, q);   // pole ≈ +Z (or −Z, unused here)
    else {
      Cartesian3.divideByScalar(_poleAxis, s, _poleAxis);
      Quaternion.fromAxisAngle(_poleAxis, Math.acos(CMath.clamp(Cartesian3.dot(Cartesian3.UNIT_Z, pole), -1, 1)), q);
    }
  } else {
    Quaternion.fromAxisAngle(Cartesian3.UNIT_X, BODIES[name].tilt * Math.PI / 180, q);
  }
  POLE_QUAT[name] = q;
  return q;
}
function quatOf(name, out) {
  const periodSec = BODIES[name].day * 3600;     // signed: retrograde spins negate
  const sec = centuriesSinceJ2000(earthClock.currentTime) * 36525 * 86400;
  // Real pole + spin RATE, but no IAU prime-meridian phase (W0) — so a body's
  // absolute facing longitude is illustrative (its day length and axis are true;
  // which side faces us at a given instant is not).
  const spin = (sec / periodSec) * 2 * Math.PI;
  Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, spin, _qSpin);
  return Quaternion.multiply(poleQuat(name), _qSpin, out);
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
  const tex = BODIES[name].texture;
  // Planets carry a surface map; the dwarf planets have none, so they get a
  // solid-tinted (still shaded) sphere from their colour.
  const material = tex
    ? Material.fromType('Image', { image: TEX(tex) })
    : Material.fromType('Color', { color: Color.fromCssColorString(BODIES[name].color) });
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
      material,
      materialSupport: MaterialAppearance.MaterialSupport.TEXTURED,
      faceForward: false, closed: true,
      flat: isSun,                  // the Sun is emissive — don't shade a terminator onto it
    }),
    asynchronous: false,
  });
  viewer.scene.primitives.add(primitive);
  spheres[name] = primitive;
}

// A flat annulus in the local XY plane, UV.s running 0→1 from the inner to the
// outer edge so the ring texture's radial profile (a 2048×125 strip, alpha for
// the Cassini division and gaps) maps across the ring width.
function ringGeometry(ri, ro, seg = 256) {
  const pos = new Float64Array((seg + 1) * 2 * 3);
  const st = new Float32Array((seg + 1) * 2 * 2);
  const idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a), v = i * 2;
    pos[v * 3] = ri * c; pos[v * 3 + 1] = ri * s; pos[v * 3 + 2] = 0;
    pos[(v + 1) * 3] = ro * c; pos[(v + 1) * 3 + 1] = ro * s; pos[(v + 1) * 3 + 2] = 0;
    st[v * 2] = 0; st[v * 2 + 1] = 0.5;
    st[(v + 1) * 2] = 1; st[(v + 1) * 2 + 1] = 0.5;
  }
  for (let i = 0; i < seg; i++) {
    const k = i * 2;
    idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  return new Geometry({
    attributes: {
      position: new GeometryAttribute({
        componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos,
      }),
      st: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st,
      }),
    },
    indices: new Uint16Array(idx),
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: new BoundingSphere(Cartesian3.ZERO, ro),
  });
}

// Saturn's rings: a double-sided, alpha-blended annulus sized to the current
// (scale-dependent) Saturn radius.  Its transform is written each frame from
// Saturn's position and tilt (see updateSpheres) — the rings lie in Saturn's
// equatorial plane, which the body's tilt quaternion already encodes.
function buildRing() {
  if (ringPrimitive) { viewer.scene.primitives.remove(ringPrimitive); ringPrimitive = null; }
  const sr = bodyRadius(BODIES.Saturn.radius);
  ringPrimitive = viewer.scene.primitives.add(new Primitive({
    geometryInstances: new GeometryInstance({ geometry: ringGeometry(sr * 1.18, sr * 2.35) }),
    appearance: new MaterialAppearance({
      material: Material.fromType('Image', { image: TEX('saturn-ring.png') }),
      flat: true, translucent: true,
      renderState: {
        cull: { enabled: false },          // visible from above and below
        depthTest: { enabled: true },
        depthMask: false,                  // translucent — don't occlude
        blending: BlendingState.ALPHA_BLEND,
      },
    }),
    asynchronous: false,
  }));
}

// The moon registry, physical facts and surface textures are pure reference
// data in src/moon-data.js.

// Boot assert (ARC-06): every moon in the registry needs real elements, or
// moonRelPos silently collapses it onto its planet centre.  A gap means someone
// added a moon here but didn't re-run tools/fetch-moon-elements.mjs.  Fail loudly
// in dev; the live page keeps the graceful zero-guard fallback.
const missingMoonEls = Object.values(MOONS).flat().map((m) => m[0]).filter((n) => !MOON_ELEMENTS[n]);
if (missingMoonEls.length) {
  const msg = `moon-elements.js is missing: ${missingMoonEls.join(', ')} — re-run tools/fetch-moon-elements.mjs`;
  console.error(`[solarsystem] ${msg}`);
  if (import.meta.env.DEV) throw new Error(msg);
}

const MOON_COLOR = Color.fromCssColorString('#CFC7B8');
const COMET_COLOR = Color.fromCssColorString('#BFE8FF');   // icy cyan for comet markers + orbits
const INTERSTELLAR_COLOR = Color.fromCssColorString('#C9A6FF');   // violet for the interstellar visitors


// Rendered radius of a moon's little sphere — real metres in true scale, the same
// exaggerating power law the planets use otherwise.
function moonRadius(name) {
  const physM = (MOON_FACTS[name]?.r ?? 40) * 1000;
  return isTrueScale() ? physM : bodyRadius(physM);
}

// Textured-moon sphere — same Primitive recipe as the planets (an entity
// ellipsoid can't take an image material).  Picks resolve to the moon name.
function buildMoonSphere(name) {
  const r = moonRadius(name);
  const primitive = new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new EllipsoidGeometry({
        radii: new Cartesian3(r, r, r),
        vertexFormat: VertexFormat.POSITION_NORMAL_AND_ST,
        slicePartitions: 36, stackPartitions: 36,
      }),
      id: name,
    }),
    appearance: new MaterialAppearance({
      material: Material.fromType('Image', { image: `${MOON_TEX_DIR}${MOON_TEX[name]}` }),
      materialSupport: MaterialAppearance.MaterialSupport.TEXTURED,
      faceForward: false, closed: true,
    }),
    asynchronous: false,
  });
  viewer.scene.primitives.add(primitive);
  moonSpheres[name] = primitive;
}

function buildMoonSpheres() {
  for (const name of Object.keys(MOON_TEX)) if (moonInfo[name]) buildMoonSphere(name);
}

// Translate each textured moon sphere to its live position every frame (radii are
// baked into the geometry; orientation is north-up, no spin).
function updateMoonSpheres() {
  for (const name of Object.keys(moonSpheres)) {
    moonInfo[name].entity.position.getValue(earthClock.currentTime, _pos);
    Matrix4.fromTranslationQuaternionRotationScale(_pos, Quaternion.IDENTITY, _one, moonSpheres[name].modelMatrix);
  }
}

function rebuildMoonSpheres() {
  for (const name of Object.keys(moonSpheres)) {
    viewer.scene.primitives.remove(moonSpheres[name]);   // destroys GL resources
    delete moonSpheres[name];
  }
  buildMoonSpheres();
}

// One moon: a marker + label + a small tinted sphere you can fly to, whose
// CallbackProperty position is the host planet's position plus a circular but
// inclined orbit offset.  Registered in moonInfo so a click selects it.
function addMoon(planet, moon) {
  const [name, realR, periodDays, factor] = moon;   // position now comes from real elements
  const tint = Color.fromCssColorString(MOON_FACTS[name]?.tint ?? '#b8b2a6');
  const entity = viewer.entities.add({
    name,
    position: new CallbackProperty((time, result) => {
      result = result || new Cartesian3();
      scenePosOf(planet, _moonHost);
      const days = centuriesSinceJ2000(earthClock.currentTime) * 36525;
      moonRelPos(name, days, _moonRel);          // real offset (m, ecliptic) from the planet
      if (isTrueScale()) {                        // true scale: real distance + shape
        result.x = _moonHost.x + _moonRel.x;
        result.y = _moonHost.y + _moonRel.y;
        result.z = _moonHost.z + _moonRel.z;
      } else {                                    // orrery: real direction, eased-out radius
        const r = factor * bodyRadius(BODIES[planet].radius);
        const s = r / (Math.hypot(_moonRel.x, _moonRel.y, _moonRel.z) || 1);
        result.x = _moonHost.x + _moonRel.x * s;
        result.y = _moonHost.y + _moonRel.y * s;
        result.z = _moonHost.z + _moonRel.z * s;
      }
      return result;
    }, false),
    // Moons with a real surface map get a textured Primitive sphere (built
    // separately); the rest get a small flat-tinted entity ellipsoid here —
    // sub-pixel from afar (the marker shows then), a body you can orbit up close.
    // A solid colour needs no texture coords, so it renders fine as an ellipsoid;
    // radii is a CallbackProperty so it tracks the scale toggle.
    ...(MOON_TEX[name] ? {} : {
      ellipsoid: {
        radii: new CallbackProperty((time, result) => {
          const rr = moonRadius(name);
          result = result || new Cartesian3();
          result.x = result.y = result.z = rr;
          return result;
        }, false),
        material: tint,
      },
    }),
    point: { pixelSize: 3.5, color: MOON_COLOR, outlineColor: Color.BLACK.withAlpha(0.5), outlineWidth: 1 },
    label: {
      text: name,
      font: '500 11px Inter, system-ui, sans-serif',
      fillColor: MOON_COLOR,
      style: LabelStyle.FILL,
      verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -7),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      // Only legible once you've flown in close to the planet.
      translucencyByDistance: new NearFarScalar(6e8, 1.0, 3e9, 0.0),
    },
  });
  moonInfo[name] = { planet, entity, realR, periodDays, facts: MOON_FACTS[name] };
}

function buildMoons() {
  for (const planet of Object.keys(MOONS)) {
    MOONS[planet].forEach((moon, i) => addMoon(planet, moon, i));
  }
}

// Faint orbit rings for the moons, off by default (a legend toggle).  Each is a
// polyline whose CallbackProperty positions trace the moon's inclined circle
// around its host planet's *current* position — the same math the marker rides —
// so it follows the planet and, reading isTrueScale each frame, tracks the scale
// toggle with no rebuild.
const moonOrbits = [];
let moonOrbitsOn = false;

function buildMoonOrbits() {
  const SEG = 96;
  for (const planet of Object.keys(MOONS)) {
    for (const moon of MOONS[planet]) {
      const [name, , , factor] = moon;
      const el = MOON_ELEMENTS[name];
      if (!el) continue;
      // The real orbit relative to the planet is fixed, so sample it once: the
      // true ellipse (m), and an orrery copy normalised to the eased-out radius.
      const compR = factor * bodyRadius(BODIES[planet].radius);
      const realRel = [], compRel = [];
      for (let k = 0; k <= SEG; k++) {
        const p = eclipticFromElements(el.a, el.e, el.i, el.node, el.peri, (k / SEG) * 360, new Cartesian3());
        realRel.push(p);
        const s = compR / (Math.hypot(p.x, p.y, p.z) || 1);
        compRel.push(new Cartesian3(p.x * s, p.y * s, p.z * s));
      }
      const pts = Array.from({ length: SEG + 1 }, () => new Cartesian3());
      const entity = viewer.entities.add({
        show: false,
        polyline: {
          positions: new CallbackProperty(() => {
            scenePosOf(planet, _moonHost);
            const rel = isTrueScale() ? realRel : compRel;
            for (let k = 0; k <= SEG; k++) {
              pts[k].x = _moonHost.x + rel[k].x;
              pts[k].y = _moonHost.y + rel[k].y;
              pts[k].z = _moonHost.z + rel[k].z;
            }
            return pts;
          }, false),
          width: 1,
          arcType: ArcType.NONE,          // NONE: geodesic densify OOM-crashes out here
          material: MOON_COLOR.withAlpha(0.3),
        },
      });
      moonOrbits.push(entity);
    }
  }
}

function setMoonOrbits(on) {
  moonOrbitsOn = on;
  for (const e of moonOrbits) e.show = on;
}

// Manmade orbiters around the other planets — the whole subsystem lives in
// sys-probes.js (data in probe-data.js): building, arrival-year appearance, and
// the spacecraft timeline.  Deps are getters because this view’s viewer and the
// shared clock are created lazily in initSystemView below; selection + panel
// logic (selectProbe / fillProbePanel) stays here with the view’s state machine.
const {
  probeInfo, buildProbes, rebuildProbes, refreshProbes, hideProbeRings, stopProbePlay,
} = initProbes({
  getViewer: () => viewer,
  daysNow: () => centuriesSinceJ2000(earthClock.currentTime) * 36525,
  scenePosOf: (name, out) => scenePosOf(name, out),
  planetRadius: (planet) => bodyRadius(BODIES[planet].radius),
  getSelectedProbeName: () => selectedProbeName,
});

function addBody(name) {
  const isSun = name === 'Sun';
  entities[name] = viewer.entities.add({
    name,
    position: positionProp(name),
    // A constant-pixel marker so a body is locatable at any zoom (at full-system
    // scale even Jupiter is sub-pixel; up close the textured sphere dwarfs it).
    // Depth-tested, so flying in close hides it behind the body's own sphere.
    point: {
      pixelSize: isSun ? 18 : ((BODIES[name].dwarf || BODIES[name].comet || BODIES[name].interstellar) ? 7 : 9),
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
  if (!BODIES[name].comet && !BODIES[name].interstellar) buildSphere(name);   // comets/interstellar: marker + orbit, no sphere

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
  if (ringPrimitive) {
    scenePosOf('Saturn', _pos);
    quatOf('Saturn', _quat);           // tilt (and an invisible spin) of Saturn
    Matrix4.fromTranslationQuaternionRotationScale(_pos, _quat, _one, ringPrimitive.modelMatrix);
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
  rebuildMoonSpheres();
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
  // Dwarf-planet orbits: dashed and fainter so they read as a distinct, more
  // tilted/eccentric family beyond the planets.
  for (const name of DWARFS) {
    const positions = elemOrbitSamples(DWARF_ELEMENTS[name]).map((p) => scenePosition(p, new Cartesian3()));
    const entity = viewer.entities.add({
      polyline: {
        positions, width: 1.5, arcType: ArcType.NONE,
        material: new PolylineDashMaterialProperty({
          color: Color.fromCssColorString(BODIES[name].color).withAlpha(0.55), dashLength: 12,
        }),
      },
    });
    orbitEntities.push({ name, entity });
  }
  // Comet orbits: a cyan glow, densely sampled so the sharp near-parabolic
  // perihelion stays smooth — dramatic paths slicing through the planetary plane.
  for (const name of COMETS) {
    const positions = elemOrbitSamples(COMET_ELEMENTS[name], 512).map((p) => scenePosition(p, new Cartesian3()));
    const entity = viewer.entities.add({
      polyline: {
        positions, width: 2, arcType: ArcType.NONE,
        material: new PolylineGlowMaterialProperty({ color: COMET_COLOR.withAlpha(0.7), glowPower: 0.3 }),
      },
    });
    orbitEntities.push({ name, entity });
  }
  // Interstellar trajectories: open violet arcs (not closed loops) — they arrive,
  // whip once around the Sun, and leave forever.
  for (const name of INTERSTELLARS) {
    const positions = elemHyperbolaSamples(INTERSTELLAR_ELEMENTS[name]).map((p) => scenePosition(p, new Cartesian3()));
    const entity = viewer.entities.add({
      polyline: {
        positions, width: 2, arcType: ArcType.NONE,
        material: new PolylineGlowMaterialProperty({ color: INTERSTELLAR_COLOR.withAlpha(0.7), glowPower: 0.3 }),
      },
    });
    orbitEntities.push({ name, entity });
  }
}

// The night sky: NASA's Deep Star Map 2020 (real Tycho + Gaia star positions and
// colours, the Milky Way, the Magellanic Clouds) wrapped on a huge sphere
// centred on the Sun and tilted by the obliquity so it sits correctly relative
// to the planets' ecliptic plane.  It's a *finite* sphere, not an infinite
// skybox, so the imagery gains detail as you zoom out toward it — and the
// camera's zoom-out is capped just inside it (see createViewer / the toggle).
function buildSky() {
  const r = skyRadius();
  // Drop the previous sphere up front (not inside onload): on a scale toggle the
  // camera flies to the new framing immediately, and a stale-radius sphere left
  // in the scene during that fly is what intermittently wedged the render loop.
  // The generic skybox shows through for the moment until the new one loads.
  if (skyPrimitive) { viewer.scene.primitives.remove(skyPrimitive); skyPrimitive = null; }
  // Preload so the 8k texture is decoded before the opaque, scene-enclosing
  // sphere appears — otherwise it flashes white over everything for a frame.
  const img = new Image();
  img.onload = () => {
    if (!viewer) return;
    // −ε: Cesium's fromRotationX(θ) sends +Z to (0, −sinθ, cosθ), and the
    // celestial north pole belongs at ecliptic (0, +sinε, cosε) — the +ε form
    // mirrored the whole sky, putting Polaris on the wrong side of the ecliptic
    // (and disagreeing with the bodies' real IAU poles).
    const tilt = Matrix4.fromRotationTranslation(
      Matrix3.fromRotationX(-OBLIQUITY), Cartesian3.ZERO, new Matrix4());
    const sky = new Primitive({
      geometryInstances: new GeometryInstance({
        geometry: new EllipsoidGeometry({
          radii: new Cartesian3(r, r, r),
          vertexFormat: VertexFormat.POSITION_AND_ST,
          slicePartitions: 64, stackPartitions: 64,
        }),
        modelMatrix: tilt,
      }),
      appearance: new MaterialAppearance({
        material: Material.fromType('Image', { image: SKY_TEX }),
        flat: true, translucent: false,
        // Cull nothing, so the *inside* of the sphere is what we see; keep depth
        // testing so the (nearer) planets and orbit rings draw in front of it.
        renderState: { cull: { enabled: false }, depthTest: { enabled: true }, depthMask: true },
      }),
      asynchronous: false,
    });
    if (skyPrimitive) viewer.scene.primitives.remove(skyPrimitive);
    skyPrimitive = viewer.scene.primitives.add(sky);
  };
  img.src = SKY_TEX;
}

// ------------------------------------------------------------ info & select ----

const fmt = (n, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d });

// Long-period comets have wildly uncertain periods, so an exact integer reads as
// false precision (NEOWISE is not known to be 8,177 yr).  Show ~2 significant
// figures with a ~ once we're past a century; short, well-determined orbits
// (Halley, Encke) keep their integer.
const cometYears = (yrs) => {
  if (yrs < 100) return `${fmt(yrs, 0)} yr`;
  const mag = 10 ** (Math.floor(Math.log10(yrs)) - 1);
  return `~${fmt(Math.round(yrs / mag) * mag, 0)} yr`;
};

function bodyFacts(name) {
  const b = BODIES[name];
  const diameterKm = b.radius * 2 / 1000;
  const dayH = Math.abs(b.day);
  const dayStr = dayH >= 48 ? `${fmt(dayH / 24, 1)} days` : `${fmt(dayH, 1)} h`;
  if (name === 'Sun') {
    return { type: 'Star · G2V', dist: '—', diameter: fmt(diameterKm), day: dayStr, year: '—' };
  }
  const T = centuriesSinceJ2000(earthClock.currentTime);
  const dayOut = `${dayStr}${b.day < 0 ? ' (retrograde)' : ''}`;
  if (b.dwarf) {
    dwarfPos(name, T * 36525, _real);
    const distAu = Cartesian3.magnitude(_real) / AU_METERS;
    const years = DWARF_ELEMENTS[name].periodDays / 365.25;
    return { type: 'Dwarf planet', dist: `${fmt(distAu, 2)} AU`, diameter: fmt(diameterKm), day: dayOut, year: `${fmt(years, 0)} yr` };
  }
  if (b.comet) {
    cometPos(name, T * 36525, _real);
    const distAu = Cartesian3.magnitude(_real) / AU_METERS;
    const years = COMET_ELEMENTS[name].periodDays / 365.25;
    return { type: 'Comet', dist: `${fmt(distAu, 2)} AU`, diameter: fmt(diameterKm, 1), day: dayOut, year: cometYears(years) };
  }
  if (b.interstellar) {
    interstellarPos(name, T * 36525, _real);
    const distAu = Cartesian3.magnitude(_real) / AU_METERS;
    const e = INTERSTELLAR_ELEMENTS[name].e;
    return { type: 'Interstellar object', dist: `${fmt(distAu, 1)} AU`, diameter: `~${fmt(diameterKm, 1)}`, day: b.day ? dayOut : '—', year: `unbound · e ${e.toFixed(2)}` };
  }
  planetPosition(name, T, _real);
  const distAu = Cartesian3.magnitude(_real) / AU_METERS;
  const years = orbitalPeriodCenturies(name) * 100;
  const yearStr = years >= 2 ? `${fmt(years, 1)} yr` : `${fmt(years * 365.25, 0)} days`;
  return {
    type: name === 'Earth' ? 'Planet · home' : 'Planet',
    dist: `${fmt(distAu, 2)} AU`, diameter: fmt(diameterKm),
    day: dayOut, year: yearStr,
  };
}

// A comet or interstellar visitor is really its orbit — so selecting one pulls
// the camera back to frame the sweep (Sun-centred), tilted so the wild
// inclination reads.  No anchor: you're free to fly the path.
function frameOpenOrbit(name) {
  let R;
  if (BODIES[name].interstellar) {
    R = systemExtent() * 1.3;   // frame the near-Sun swing of the unbound hyperbola
  } else {
    const el = COMET_ELEMENTS[name];
    scenePosition(new Cartesian3(el.a * (1 + el.e), 0, 0), _pos);   // aphelion → scene units
    // Cap at ~1.5× the planetary system so the giant long-period orbits (Hale-Bopp,
    // NEOWISE) keep the planets in view and sweep off the edge rather than zooming
    // out to a faint thread.
    R = Math.min(Cartesian3.magnitude(_pos), systemExtent() * 1.5);
  }
  const range = Math.min(R * 2.2, skyRadius() * 0.85);            // never past the zoom cap
  releaseAnchor();
  viewer.camera.flyToBoundingSphere(new BoundingSphere(Cartesian3.ZERO, R), {
    duration: flySeconds(1.6),
    offset: new HeadingPitchRange(0, CMath.toRadians(-45), range),
  });
}

function selectBody(name) {
  selectedName = name;
  selectedMoonName = null;
  selectedProbeName = null;
  hideProbeRings();
  $('moon-panel').hidden = true;
  $('probe-panel').hidden = true;
  const f = bodyFacts(name);
  $('sys-name').textContent = name;
  $('sys-type').textContent = f.type;
  $('sys-dist').textContent = f.dist;
  $('sys-diam').textContent = `${f.diameter} km`;
  $('sys-day').textContent = f.day;
  $('sys-year').textContent = f.year;
  $('sys-earth-actions').hidden = name !== 'Earth';
  // Every planet but Earth can be entered as its own navigable globe.
  const enterBtn = $('sys-enter-planet');
  // Dwarfs with a real surface map (Pluto, Ceres) are enterable globes too.
  const enterable = name !== 'Sun' && name !== 'Earth' && !BODIES[name].comet && !BODIES[name].interstellar
    && (!BODIES[name].dwarf || !!BODIES[name].texture);
  enterBtn.hidden = !enterable;
  if (enterable) {
    enterBtn.textContent = ROCKY.has(name) ? 'Descend to the surface ▸' : 'Explore the globe ▸';
  }
  // Show/Hide this body's moon orbits — only for bodies that have moons.
  const moonBtn = $('sys-moon-orbits');
  moonBtn.hidden = !MOONS[name];
  if (MOONS[name]) moonBtn.textContent = moonOrbitsOn ? 'Hide moon orbits' : 'Show moon orbits';
  $('system-panel').hidden = false;
  expandCard('system-panel');
  writeHash({ body: name });
  if (BODIES[name].comet || BODIES[name].interstellar) { frameOpenOrbit(name); return; }   // frame the open orbit
  // Frame the body so its whole entourage — moons AND spacecraft — fits, looking
  // down at a steeper angle so they ring the planet instead of hiding edge-on.
  const r = bodyRadius(BODIES[name].radius);
  const moons = MOONS[name];
  const probes = PROBES[name];
  const extents = [];
  if (moons) extents.push(...moons.map((m) => (isTrueScale() ? m[1] : m[3] * r)));
  if (probes) extents.push(...probes.map((pr) => pr[1] * r));
  let range = r * 4.5;
  let pitch = -14;
  if (extents.length) {
    range = Math.max(range, Math.max(...extents) * 1.9);
    pitch = -34;
  }
  // Pluto–Charon is a close binary: give it extra room so the pair composes.
  if (BODIES[name].dwarf) range = Math.max(range, r * 6);
  releaseAnchor();                 // fly in the world frame…
  scenePosOf(name, _pos);
  // …then pivot the camera on the body so scroll/drag orbit around it, and
  // floor the zoom just above its surface (no globe out here to collide with).
  flyEquatorial(_pos, range, -pitch, flySeconds(1.5),
    () => { if (selectedName === name && !inBodyGlobe) anchorOn(entities[name], r); });
}

// Fly to an explicit vantage: keep the current viewing azimuth, elevated
// elevDeg° above the target's equatorial (scene-XY) plane.  flyToBoundingSphere's
// heading/pitch offset lives in a WGS84 east-north-up frame that degrades for
// bodies far off the ecliptic (Pluto, Ceres) — it arrived pole-on out there,
// staring at the maps' unimaged southern fills.
function flyEquatorial(target, range, elevDeg, duration, complete) {
  const az = Math.atan2(target.y - viewer.camera.positionWC.y, target.x - viewer.camera.positionWC.x);
  const el = CMath.toRadians(elevDeg);
  const dest = new Cartesian3(
    target.x - Math.cos(az) * Math.cos(el) * range,
    target.y - Math.sin(az) * Math.cos(el) * range,
    target.z + Math.sin(el) * range,
  );
  const dir = Cartesian3.normalize(Cartesian3.subtract(target, dest, new Cartesian3()), new Cartesian3());
  const right = Cartesian3.normalize(Cartesian3.cross(dir, Cartesian3.UNIT_Z, new Cartesian3()), new Cartesian3());
  const up = Cartesian3.cross(right, dir, new Cartesian3());
  viewer.camera.flyTo({ destination: dest, orientation: { direction: dir, up }, duration, complete });
}

function deselect() {
  selectedName = null;
  selectedMoonName = null;
  selectedProbeName = null;
  releaseAnchor();
  hideProbeRings();
  $('system-panel').hidden = true;
  $('moon-panel').hidden = true;
  $('probe-panel').hidden = true;
}

// Reset a body card to its expanded state (a fresh selection always shows the
// details; the mobile collapse toggle then hides them to reveal the scene).
function expandCard(id) {
  const card = $(id);
  card.classList.remove('collapsed');
  const btn = card.querySelector('.card-collapse');
  if (btn) { btn.textContent = '▾'; btn.setAttribute('aria-label', 'Collapse details'); }
}

// Route a name to the right selector — a moon, a spacecraft, or a planet/Sun.
// Shared by the canvas click handler and the deep-link entry point.
function focusByName(name) {
  if (name && moonInfo[name]) selectMoon(name);
  else if (name && probeInfo[name]) selectProbe(name);
  else if (name && entities[name]) selectBody(name);
}

// Click a moon: show its facts panel, fly in close, and pivot the camera on it
// so you can orbit/zoom the little world the way you do a planet.
function selectMoon(name) {
  const info = moonInfo[name];
  if (!info) return;
  selectedName = null;
  selectedProbeName = null;
  selectedMoonName = name;
  hideProbeRings();
  $('system-panel').hidden = true;
  $('probe-panel').hidden = true;
  fillMoonPanel(name, info);
  $('moon-panel').hidden = false;
  expandCard('moon-panel');
  writeHash({ moon: name });

  const rr = moonRadius(name);
  releaseAnchor();
  info.entity.position.getValue(earthClock.currentTime, _pos);
  flyEquatorial(_pos, rr * 4.5, 22, flySeconds(1.3),
    () => { if (selectedMoonName === name && !inBodyGlobe) anchorOn(info.entity, rr); });
}

function fillMoonPanel(name, info) {
  const f = info.facts || {};
  const days = info.periodDays;
  const period = days < 1 ? `${(days * 24).toFixed(1)} hours` : `${days.toFixed(2)} days`;
  const disc = f.disc === 'antiquity' ? 'known since antiquity'
    : f.by ? `${f.disc} · ${f.by}` : `${f.disc}`;
  $('moon-host').textContent = `Moon of ${info.planet}`;
  $('moon-name').textContent = name;
  $('moon-diam').textContent = f.r ? `${(f.r * 2).toLocaleString()} km` : '—';
  $('moon-period').textContent = period;
  $('moon-dist').textContent = `${Math.round(info.realR / 1000).toLocaleString()} km`;
  $('moon-disc').textContent = disc;
  $('moon-fact').textContent = f.fact || '';
}

// Click a manmade orbiter: show its mission panel and frame it over its planet,
// pivoting the camera on it (it has no body of its own, so this just lets you
// orbit/zoom the marker against the planet behind it).
function selectProbe(name) {
  const info = probeInfo[name];
  if (!info) return;
  selectedName = null;
  selectedMoonName = null;
  selectedProbeName = name;
  hideProbeRings();                                 // reveal just this probe's orbit ring
  info.ring.show = true;                             // show the orbit even if the craft itself is faded/hidden (deorbited, not-yet-arrived) so there's something to see
  $('system-panel').hidden = true;
  $('moon-panel').hidden = true;
  fillProbePanel(name, info);
  $('probe-panel').hidden = false;
  expandCard('probe-panel');
  writeHash({ probe: name });

  const planetR = bodyRadius(BODIES[info.planet].radius);
  releaseAnchor();
  // Frame the whole orbit (centred on the planet, sized to apoapsis) so the real
  // shape reads — eccentric orbits like Juno's are far larger than the planet.
  // Anchor on the probe afterwards so you can still zoom down onto the model.
  scenePosOf(info.planet, _pos);
  const frameR = Math.max(info.apo, planetR * 1.6);
  viewer.camera.flyToBoundingSphere(new BoundingSphere(_pos, frameR), {
    duration: flySeconds(1.3),
    offset: new HeadingPitchRange(0, CMath.toRadians(-30), frameR * 2.4),
    complete: () => {
      if (selectedProbeName !== name || inBodyGlobe) return;
      // A deorbited / not-yet-arrived probe isn't drawn — pivot on its planet so
      // zooming still has something real to orbit, not an invisible point (BUG-09).
      anchorOn(info.entity.show ? info.entity : entities[info.planet], planetR * 0.25);
    },
  });
}

// Present-day state — the legend's vocabulary; the fact text carries the years.
function probeStatusLabel(info) {
  const Y = nowYear();
  if (Y < info.arrival) return ['en route', 'st-active'];
  if (info.end == null || Y < info.end) return ['operating', 'st-active'];
  return info.deorbited ? ['mission ended', 'st-gone'] : ['derelict', 'st-derelict'];
}

function fillProbePanel(name, info) {
  const f = PROBE_FACTS[name] || {};
  const d = info.periodDays;
  const period = d < 1 ? `${(d * 24).toFixed(1)} h` : `${d.toFixed(d < 10 ? 1 : 0)} day${d >= 2 ? 's' : ''}`;
  const [status, statusClass] = probeStatusLabel(info);
  $('probe-eyebrow').textContent = `Spacecraft at ${info.planet}`;
  $('probe-name').textContent = name;
  $('probe-op').textContent = f.op || '—';
  $('probe-arrived').textContent = `${Math.floor(info.arrival)}${nowYear() < info.arrival ? ' (en route)' : ''}`;
  $('probe-status').textContent = status;
  $('probe-status').className = statusClass;
  const shape = info.ecc >= 0.2 ? ` · e ${info.ecc.toFixed(2)}` : '';   // note eccentric orbits
  $('probe-orbit').textContent = `${period} · ${info.inclDeg.toFixed(0)}° incl${shape}`;
  $('probe-fact').textContent = f.fact || '';
}

// Pivot the camera's orbit/zoom on the selected body — the way the tracker
// orbits Earth — instead of on the scene origin (the Sun).  Out here there's no
// globe, so the controller otherwise pivots on (0,0,0); a lookAtTransform at the
// body's live position makes drag/scroll orbit and zoom around *it*.  Re-applied
// each frame so it stays centred as the body creeps along its orbit.
function maintainAnchor() {
  if (!anchorEntity || inBodyGlobe) return;
  anchorEntity.position.getValue(earthClock.currentTime, _anchorPos);
  viewer.camera.lookAtTransform(Matrix4.fromTranslation(_anchorPos, _anchorMat));
}

// Pivot the camera on a body's entity and floor the zoom just above its surface.
function anchorOn(entity, renderedRadius) {
  anchorEntity = entity;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = renderedRadius * 1.1;
}

// Back to the world frame.  Must run before any flyTo/setView (those are
// singular or misbehave inside a translated reference frame).
function releaseAnchor() {
  anchorEntity = null;
  if (viewer) {
    viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = SYSTEM_MIN_ZOOM;
  }
}

// Drop from the system view onto a planet's own globe (bodyglobe.js).  The system
// scene idles underneath and is restored when the globe is exited.
function enterPlanet(name) {
  if (!bodyGlobes) return;
  inBodyGlobe = true;
  viewer.useDefaultRenderLoop = false;
  document.body.classList.add('body-mode');   // hides the system chrome (CSS)
  bodyGlobes.show(name, () => {
    inBodyGlobe = false;
    document.body.classList.remove('body-mode');
    viewer.useDefaultRenderLoop = true;
  });
}

// --------------------------------------------------------------- viewer ----

// Frame the whole system centred on the Sun, looking down at a 3/4 angle so the
// orbits read as concentric ellipses.  We place the camera explicitly and aim it
// at the origin: flyToBoundingSphere's HeadingPitchRange offset is computed in
// the local ENU frame at the sphere centre, which is *singular* at the geocentre
// (0,0,0) — so its pitch/heading come out garbage and the Sun lands off-screen.
function frameWholeSystem(duration = 0) {
  releaseAnchor();
  const D = systemExtent() * 2.0;
  const elev = CMath.toRadians(50);   // a high 3/4 angle so the belt ring reads
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
  ctrl.minimumZoomDistance = SYSTEM_MIN_ZOOM;
  ctrl.maximumZoomDistance = skyRadius() * 0.92;   // stop just inside the stars

  viewer = v;
  earthClock = pendingClock;          // the Earth viewer's clock, captured in init()

  addBody('Sun');
  for (const name of PLANETS) addBody(name);
  for (const name of DWARFS) addBody(name);
  for (const name of COMETS) addBody(name);
  for (const name of INTERSTELLARS) addBody(name);
  buildMoons();
  buildMoonSpheres();
  buildMoonOrbits();
  buildProbes();
  refreshProbes();          // apply each craft's present-day status (active / derelict / gone)
  buildRing();
  rebuildOrbits();
  buildSky();
  createBelt(v, earthClock).then((b) => { belt = b; });
  createTrojans(v, earthClock).then((t) => { trojans = t; });
  createHildas(v, earthClock).then((h) => { hildas = h; });
  createFamilies(v, earthClock).then((f) => { families = f; buildFamilyLegend(); });
  frameWholeSystem();

  // Keep the headlight aimed where the camera looks, and hand-tick the shared
  // clock (the Earth loop that normally ticks it is idle while we're up here).
  v.scene.preRender.addEventListener(() => {
    if (earthClock && earthClock.shouldAnimate) earthClock.tick();
    updateSpheres();
    updateMoonSpheres();
    maintainAnchor();
    if (belt) belt.tick(performance.now());
    if (trojans) trojans.tick(performance.now());
    if (hildas) hildas.tick(performance.now());
    if (families) families.tick(performance.now());
    Cartesian3.clone(v.camera.directionWC, _dir);
    v.scene.light.direction = _dir;
  });

  // Click a body to select + fly to it; click empty space to deselect.  A sphere
  // pick resolves to its instance id (the body-name string); a marker/label pick
  // resolves to the Entity (read its .name).
  // Pad the pick so the small moon/spacecraft markers are hittable on touch.
  const pickPad = window.matchMedia?.('(pointer: coarse)').matches ? 22 : 6;
  const handler = new ScreenSpaceEventHandler(v.scene.canvas);
  handler.setInputAction(({ position }) => {
    const picked = v.scene.pick(position, pickPad, pickPad);
    const id = picked && picked.id;
    const name = typeof id === 'string' ? id : (id && id.name);
    if (name && (moonInfo[name] || probeInfo[name] || entities[name])) focusByName(name);
    else { deselect(); writeHash({ system: true }); }
  }, ScreenSpaceEventType.LEFT_CLICK);

  return v;
}

// ------------------------------------------------------------- show / hide ----

function show(earthViewer) {
  if (moonRef && moonRef.visible) moonRef.hide();   // never stack Moon + System (two render loops)
  if (!viewer) { pendingClock = earthViewer.clock; createViewer(); }
  visible = true;
  $('systemContainer').hidden = false;
  $('system-exit').hidden = false;
  $('system-scale').hidden = false;
  $('probe-timeline').hidden = false;
  $('system-legend').hidden = false;
  document.body.classList.add('system-mode');
  $('system-toggle').classList.add('active');
  earthViewer.useDefaultRenderLoop = false;
  viewer.useDefaultRenderLoop = true;
  viewer.resize();
  writeHash({ system: true });   // a deep-link selection overwrites this in turn
}

// recenter: re-frame the Earth viewer on return.  Suppressed for the Moon
// hand-off, where the Earth scene is only a transient stop on the way to the
// lunar globe and re-centring it would be wasted (and briefly visible) motion.
function hide(earthViewer, recenter = true) {
  visible = false;
  deselect();
  $('systemContainer').hidden = true;
  $('system-exit').hidden = true;
  $('system-scale').hidden = true;
  $('system-legend').hidden = true;
  $('probe-timeline').hidden = true;
  $('tl-era').hidden = true;
  stopProbePlay();
  document.body.classList.remove('system-mode');
  $('system-toggle').classList.remove('active');
  if (viewer) viewer.useDefaultRenderLoop = false;
  earthViewer.useDefaultRenderLoop = true;
  writeHash(null);   // back to the bare Earth view — don't leave a stale #system/#body= hash
  if (recenter && onReturnToEarth) onReturnToEarth();
}

// The Earth viewer's clock, captured at init so createViewer() can wire the
// CallbackPropertys against it before the first open.
let pendingClock = null;

// Populate the asteroid-family legend from the loaded metadata — a colour dot +
// name per family, inner→outer.  No-op until createFamilies resolves.
function buildFamilyLegend() {
  const host = $('family-list');
  if (!host || !families?.families) return;
  host.replaceChildren();
  for (const f of families.families) {
    if (!f.count) continue;          // a family whose fetch failed has no rings to label
    const row = document.createElement('span');
    row.className = 'sl-fam';
    const dot = document.createElement('span');
    dot.className = 'sl-dot';
    dot.style.background = f.color;
    row.append(dot, document.createTextNode(f.name));
    host.appendChild(row);
  }
}

// ------------------------------------------------------------------- init ----

export function initSystemView(earthViewer, moonView, onReturn) {
  moonRef = moonView;
  pendingClock = earthViewer.clock;
  onReturnToEarth = onReturn;

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
      releaseAnchor();              // rebuilding probes drops their entities; clear any anchor first
      applyScaleToBodies();
      buildRing();
      rebuildOrbits();
      rebuildProbes();             // re-size probe orbits/models to the new scale
      buildSky();
      if (belt) belt.tick(performance.now(), true);    // re-place at the new scale
      if (trojans) trojans.tick(performance.now(), true);
      if (hildas) hildas.tick(performance.now(), true);
      if (families) families.tick(performance.now(), true);
      viewer.scene.screenSpaceCameraController.maximumZoomDistance = skyRadius() * 0.92;
      frameWholeSystem(1.2);
    }
  });

  // Asteroid-family rings — show/hide the coloured family swarm over the belt.
  $('toggle-families').addEventListener('change', (e) => {
    if (families) families.show = e.target.checked;
    $('family-list').classList.toggle('off', !e.target.checked);
  });

  $('sys-moon-orbits').addEventListener('click', () => {
    setMoonOrbits(!moonOrbitsOn);
    $('sys-moon-orbits').textContent = moonOrbitsOn ? 'Hide moon orbits' : 'Show moon orbits';
  });

  // Collapse / expand a body card (mobile) to clear the moons + craft behind it.
  document.querySelectorAll('.card-collapse').forEach((btn) => {
    btn.addEventListener('click', () => {
      const collapsed = btn.closest('.body-card').classList.toggle('collapsed');
      btn.textContent = collapsed ? '▸' : '▾';
      btn.setAttribute('aria-label', collapsed ? 'Show details' : 'Collapse details');
    });
  });

  // The spacecraft arrival timeline (ptl-*) is wired inside sys-probes.js.

  // "Enter Earth" → back to the satellite tracker.  "Go to the Moon" → exit to
  // Earth first (its loop must be live), then open the lunar globe.
  $('sys-enter-earth').addEventListener('click', () => hide(earthViewer));
  $('sys-goto-moon').addEventListener('click', () => { hide(earthViewer, false); moonView.show(); });

  // Every other planet → descend onto its own globe (Mars/Mercury via Treks
  // imagery, the rest via their local map).
  bodyGlobes = initBodyGlobes();
  $('sys-enter-planet').addEventListener('click', () => { if (selectedName) enterPlanet(selectedName); });

  // Esc is routed by main.js's single dispatcher (which calls stepBack below) so
  // one keypress can't fire four capture-phase handlers at once.
  return {
    show: () => show(earthViewer), hide: () => hide(earthViewer),
    get visible() { return visible; },
    // One level back: leave a body globe → drop a selection → exit to Earth.
    stepBack: () => {
      if (inBodyGlobe) { bodyGlobes.hide(); return; }
      if (selectedName || selectedMoonName || selectedProbeName) { deselect(); writeHash({ system: true }); }
      else hide(earthViewer);
    },
    focus: (name) => focusByName(name),      // deep-link entry: planet · moon · spacecraft
    // Searchable heliocentric bodies (for the Earth-view search box).
    searchBodies: [
      { name: 'Sun', kind: 'star' },
      ...PLANETS.map((name) => ({ name, kind: 'planet' })),
      ...DWARFS.map((name) => ({ name, kind: 'dwarf planet' })),
      ...COMETS.map((name) => ({ name, kind: 'comet' })),
      ...INTERSTELLARS.map((name) => ({ name, kind: 'interstellar' })),
    ],
    get viewer() { return viewer; },
    select: (name) => selectBody(name),     // debug
    get bodies() { return entities; },        // debug
    screenOf: (name) => {                      // debug
      const p = scenePosOf(name, new Cartesian3());
      return SceneTransforms.worldToWindowCoordinates(viewer.scene, p);
    },
  };
}
