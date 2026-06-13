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
  Math as CMath,
} from 'cesium';
import {
  BODIES, PLANETS, planetPosition, orbitSamples, centuriesSinceJ2000,
  orbitalPeriodCenturies, AU_METERS,
} from './ephemeris.js';
import {
  scenePosition, bodyRadius, setTrueScale, isTrueScale, systemExtent,
} from './scale.js';
import { createBelt } from './belt.js';
import { initBodyGlobes } from './bodyglobe.js';

// Planets with a solid surface to descend onto (the rest show their cloud tops).
const ROCKY = new Set(['Mercury', 'Venus', 'Mars']);

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
const entities = {};        // body name -> marker/label Entity
const spheres = {};         // body name -> textured sphere Primitive
let orbitEntities = [];     // { name, entity } for rebuild on scale toggle
let skyPrimitive = null;    // the NASA star-map celestial sphere
let ringPrimitive = null;   // Saturn's rings
let belt = null;            // the asteroid-belt swarm controller
let bodyGlobes = null;      // the per-planet surface-globe controller
let inBodyGlobe = false;    // true while a planet globe is open over the system
let selectedName = null;

const ALL_BODIES = ['Sun', ...PLANETS];

// Scratch objects reused every frame to keep the per-frame allocation count low.
const _real = new Cartesian3();
const _pos = new Cartesian3();
const _moonHost = new Cartesian3();
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

// Major moons per planet, with real mean orbital elements (JPL):
//   [name, real orbit radius (m), sidereal period (days), display factor,
//    inclination (deg), ascending node (deg)].
// In readable mode a moon orbits at factor × the planet's *rendered* radius, so
// the moons sit just outside the exaggerated disc in a legible, correctly-ordered
// spread; in true scale they sit at their real distance (mostly invisible, as in
// reality).  Real inclinations tilt each orbit, so a moon system reads as a 3D
// family of paths rather than a flat ring (Iapetus, and retrograde Triton at
// i≈157°, stand well out of plane).  Eccentricities are ≲0.03 and invisible at
// this scale, so the orbits are taken circular.
const MOONS = {
  Earth:   [['Moon', 3.844e8, 27.32, 3.4, 5.14, 125]],
  Mars:    [['Phobos', 9.378e6, 0.319, 1.6, 1.08, 80], ['Deimos', 2.346e7, 1.263, 2.3, 1.79, 80]],
  Jupiter: [['Amalthea', 1.815e8, 0.498, 1.6, 0.37, 0], ['Thebe', 2.218e8, 0.675, 1.8, 1.08, 90],
            ['Io', 4.217e8, 1.769, 2.1, 0.04, 0], ['Europa', 6.711e8, 3.551, 2.7, 0.47, 180],
            ['Ganymede', 1.070e9, 7.155, 3.5, 0.20, 60], ['Callisto', 1.883e9, 16.69, 4.6, 0.19, 300],
            ['Himalia', 1.146e10, 250.6, 5.2, 27.5, 30]],
  Saturn:  [['Mimas', 1.855e8, 0.942, 1.7, 1.57, 0], ['Enceladus', 2.380e8, 1.370, 2.1, 0.01, 60],
            ['Tethys', 2.947e8, 1.888, 2.5, 1.09, 120], ['Dione', 3.774e8, 2.737, 2.9, 0.02, 180],
            ['Rhea', 5.270e8, 4.518, 3.4, 0.33, 240], ['Titan', 1.222e9, 15.95, 4.4, 0.35, 300],
            ['Hyperion', 1.481e9, 21.28, 5.0, 0.43, 200], ['Iapetus', 3.561e9, 79.32, 5.7, 15.5, 80],
            ['Phoebe', 1.295e10, 550.3, 6.2, 175.2, 120]],
  Uranus:  [['Puck', 8.6e7, 0.762, 1.45, 0.32, 60], ['Miranda', 1.299e8, 1.413, 1.8, 4.34, 100],
            ['Ariel', 1.909e8, 2.520, 2.3, 0.26, 160], ['Umbriel', 2.660e8, 4.144, 2.8, 0.21, 220],
            ['Titania', 4.358e8, 8.706, 3.4, 0.34, 280], ['Oberon', 5.835e8, 13.46, 4.0, 0.06, 340]],
  Neptune: [['Larissa', 7.35e7, 0.555, 1.5, 0.20, 0], ['Proteus', 1.176e8, 1.122, 1.9, 0.52, 60],
            ['Triton', 3.548e8, 5.877, 2.9, 157, 180], ['Nereid', 5.513e9, 360.1, 4.8, 7.09, 320]],
};
const MOON_COLOR = Color.fromCssColorString('#CFC7B8');

// One moon as a marker+label entity whose CallbackProperty position is the host
// planet's position plus a circular but inclined orbit offset.
function addMoon(planet, moon, idx) {
  const [name, realR, periodDays, factor, inclDeg, nodeDeg] = moon;
  const phase = idx * 1.7;            // de-phase moons so they don't line up
  const i = inclDeg * Math.PI / 180, om = nodeDeg * Math.PI / 180;
  const cO = Math.cos(om), sO = Math.sin(om), ci = Math.cos(i), si = Math.sin(i);
  viewer.entities.add({
    name,
    position: new CallbackProperty((time, result) => {
      result = result || new Cartesian3();
      scenePosOf(planet, _moonHost);
      const days = centuriesSinceJ2000(earthClock.currentTime) * 36525;
      const r = isTrueScale() ? realR : factor * bodyRadius(BODIES[planet].radius);
      const th = (days / periodDays) * 2 * Math.PI + phase;
      const ct = Math.cos(th), st = Math.sin(th);
      result.x = _moonHost.x + r * (cO * ct - sO * ci * st);
      result.y = _moonHost.y + r * (sO * ct + cO * ci * st);
      result.z = _moonHost.z + r * (si * st);
      return result;
    }, false),
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
}

function buildMoons() {
  for (const planet of Object.keys(MOONS)) {
    MOONS[planet].forEach((moon, i) => addMoon(planet, moon, i));
  }
}

// Manmade orbiters around the other planets: [name, display factor, period
// (days), inclination°, node°, year reached orbit].  Rendered like moons but in
// tech cyan, and gateable by year via the spacecraft timeline so you can watch
// the robotic fleet arrive.  Orbits are schematic (real altitudes are ~1–1.5
// planet radii); the point is to see what's there and when it got there.
// [name, display factor, period (days), inclination°, node°, arrival year,
//  end year (null = still operating), deorbited? (true = left orbit at `end`,
//  so it fades out and is gone; false = derelict, still orbiting but dead)].
const PROBES = {
  Mercury: [['BepiColombo', 1.4, 0.10, 88, 0, 2026, null, false]],
  Venus:   [['Pioneer Venus', 2.4, 0.99, 105, 40, 1978, 1992, true],
            ['Magellan', 1.6, 0.157, 86, 90, 1990, 1994, true],
            ['Akatsuki', 2.6, 10.5, 9, 0, 2015, 2024, false]],
  Mars:    [['Mariner 9', 1.5, 0.5, 64, 20, 1971, 2022, true],
            ['Viking 1 Orbiter', 1.95, 1.5, 38, 100, 1976, 2019, true],
            ['Mars Odyssey', 1.30, 0.082, 93, 0, 2001, null, false],
            ['Mars Express', 1.7, 0.30, 86, 60, 2003, null, false],
            ['MRO', 1.45, 0.075, 93, 130, 2006, null, false],
            ['MAVEN', 2.1, 0.19, 75, 200, 2014, null, false],
            ['Mangalyaan', 2.9, 3.2, 150, 250, 2014, 2022, false],
            ['ExoMars TGO', 1.6, 0.083, 74, 310, 2016, null, false],
            ['Hope', 3.1, 2.3, 25, 30, 2021, null, false],
            ['Tianwen-1', 2.4, 0.30, 87, 160, 2021, null, false]],
  Jupiter: [['Galileo', 2.2, 7, 5, 200, 1995, 2003, true], ['Juno', 3.0, 53, 90, 0, 2016, null, false]],
  Saturn:  [['Cassini', 2.6, 16, 20, 0, 2004, 2017, true]],
};
const PROBE_COLOR = Color.fromCssColorString('#6FE0FF');           // active
const PROBE_COLOR_DERELICT = Color.fromCssColorString('#8AA7B2');  // dead but still orbiting
const PROBE_COLOR_GONE = Color.fromCssColorString('#FF9A5A');      // reentering — fading out
const PROBE_FADE_YEARS = 1.5;                                      // fade span after a deorbit
let probeList = [];          // { entity, year }
let probeYear = null;        // null = show all (timeline off)

function addProbe(planet, probe, idx) {
  const [name, factor, periodDays, inclDeg, nodeDeg, arrival, end, deorbited] = probe;
  const phase = idx * 2.1;
  const i = inclDeg * Math.PI / 180, om = nodeDeg * Math.PI / 180;
  const cO = Math.cos(om), sO = Math.sin(om), ci = Math.cos(i), si = Math.sin(i);
  const entity = viewer.entities.add({
    name,
    position: new CallbackProperty((time, result) => {
      result = result || new Cartesian3();
      scenePosOf(planet, _moonHost);
      const days = centuriesSinceJ2000(earthClock.currentTime) * 36525;
      const r = factor * bodyRadius(BODIES[planet].radius);
      const th = (days / periodDays) * 2 * Math.PI + phase;
      const ct = Math.cos(th), st = Math.sin(th);
      result.x = _moonHost.x + r * (cO * ct - sO * ci * st);
      result.y = _moonHost.y + r * (sO * ct + cO * ci * st);
      result.z = _moonHost.z + r * (si * st);
      return result;
    }, false),
    point: { pixelSize: 4, color: PROBE_COLOR, outlineColor: Color.fromCssColorString('#0A2733'), outlineWidth: 1 },
    label: {
      text: name,
      font: '500 11px Inter, system-ui, sans-serif',
      fillColor: PROBE_COLOR,
      style: LabelStyle.FILL,
      verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -7),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      translucencyByDistance: new NearFarScalar(6e8, 1.0, 3e9, 0.0),
    },
  });
  probeList.push({ entity, arrival, end, deorbited });
}

function buildProbes() {
  probeList = [];
  for (const planet of Object.keys(PROBES)) PROBES[planet].forEach((pr, i) => addProbe(planet, pr, i));
}

const nowYear = () => { const d = new Date(); return d.getUTCFullYear() + (d.getUTCMonth() + 0.5) / 12; };

// Appearance of a craft at (possibly fractional) year Y: null = not shown.
//   before arrival          → hidden
//   operating               → bright cyan
//   deorbited (after end)    → orange, fading to nothing over PROBE_FADE_YEARS
//   derelict (after end)     → dim slate, smaller (dead but still up there)
function probeAppearance(pr, Y) {
  if (Y < pr.arrival) return null;
  if (pr.end == null || Y < pr.end) return { color: PROBE_COLOR, size: 4, alpha: 1 };
  if (pr.deorbited) {
    const a = 1 - (Y - pr.end) / PROBE_FADE_YEARS;
    return a > 0 ? { color: PROBE_COLOR_GONE, size: 4, alpha: a } : null;
  }
  return { color: PROBE_COLOR_DERELICT, size: 3, alpha: 0.6 };
}

// Y defaults to the live timeline year, or today's date when the timeline is off
// (so the default view shows each craft's real present-day status).
function refreshProbes(yArg) {
  const Y = yArg != null ? yArg : (probeYear != null ? probeYear : nowYear());
  for (const p of probeList) {
    const ap = probeAppearance(p, Y);
    if (!ap) { p.entity.show = false; continue; }
    p.entity.show = true;
    p.entity.point.color = ap.color.withAlpha(ap.alpha);
    p.entity.point.pixelSize = ap.size;
    p.entity.label.fillColor = ap.color.withAlpha(Math.max(0.45, ap.alpha));
  }
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
    const tilt = Matrix4.fromRotationTranslation(
      Matrix3.fromRotationX(OBLIQUITY), Cartesian3.ZERO, new Matrix4());
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
  // Every planet but Earth can be entered as its own navigable globe.
  const enterBtn = $('sys-enter-planet');
  const enterable = name !== 'Sun' && name !== 'Earth';
  enterBtn.hidden = !enterable;
  if (enterable) {
    enterBtn.textContent = ROCKY.has(name) ? 'Descend to the surface ▸' : 'Explore the globe ▸';
  }
  $('system-panel').hidden = false;
  // Frame the body.  For a planet with moons, pull back far enough to take in
  // the outermost moon's orbit and look down at a steeper angle, so the moons
  // ring the planet instead of hiding edge-on behind it.
  const r = bodyRadius(BODIES[name].radius);
  const moons = MOONS[name];
  let range = r * 4.5;
  let pitch = -14;
  if (moons) {
    const outer = Math.max(...moons.map((m) => (isTrueScale() ? m[1] : m[3] * r)));
    range = Math.max(range, outer * 1.9);
    pitch = -34;
  }
  scenePosOf(name, _pos);
  viewer.camera.flyToBoundingSphere(new BoundingSphere(_pos, r), {
    duration: 1.5,
    offset: new HeadingPitchRange(0, CMath.toRadians(pitch), range),
  });
}

function deselect() {
  selectedName = null;
  $('system-panel').hidden = true;
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
  ctrl.minimumZoomDistance = 1e4;
  ctrl.maximumZoomDistance = skyRadius() * 0.92;   // stop just inside the stars

  viewer = v;
  earthClock = pendingClock;          // the Earth viewer's clock, captured in init()

  addBody('Sun');
  for (const name of PLANETS) addBody(name);
  buildMoons();
  buildProbes();
  refreshProbes();          // apply each craft's present-day status (active / derelict / gone)
  buildRing();
  rebuildOrbits();
  buildSky();
  createBelt(v, earthClock).then((b) => { belt = b; });
  frameWholeSystem();

  // Keep the headlight aimed where the camera looks, and hand-tick the shared
  // clock (the Earth loop that normally ticks it is idle while we're up here).
  v.scene.preRender.addEventListener(() => {
    if (earthClock && earthClock.shouldAnimate) earthClock.tick();
    updateSpheres();
    if (belt) belt.tick(performance.now());
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
  $('probe-timeline').hidden = false;
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
  $('probe-timeline').hidden = true;
  $('tl-era').hidden = true;
  probeStopPlay();
  document.body.classList.remove('system-mode');
  $('system-toggle').classList.remove('active');
  if (viewer) viewer.useDefaultRenderLoop = false;
  earthViewer.useDefaultRenderLoop = true;
}

// The Earth viewer's clock, captured at init so createViewer() can wire the
// CallbackPropertys against it before the first open.
let pendingClock = null;

// --------------------------------------------------------- spacecraft timeline ----
// Gate the manmade orbiters by the year they reached their planet, so you can
// watch the robotic fleet arrive (2001 →).  Mirrors the Earth launch timeline.
const PROBE_TL_START = 1970;                    // back to the first planetary orbiter
const probeMaxYear = () => new Date().getUTCFullYear();
let probePlaying = false, probeRaf = 0, probeAnchorMs = 0, probeAnchorYear = PROBE_TL_START;

// Milestones flashed (in the shared #tl-era banner) as the spacecraft play-head
// crosses them.
const PROBE_ERAS = [
  [1971, 'Mariner 9 — first orbit of another planet'],
  [1978, 'Pioneer Venus maps the clouds'],
  [1990, 'Magellan radar-maps Venus'],
  [1995, 'Galileo arrives at Jupiter'],
  [2001, 'Mars Odyssey — still working today'],
  [2004, 'Cassini reaches Saturn'],
  [2014, 'A fleet reaches Mars — MAVEN, Mangalyaan'],
  [2016, 'Juno arrives at Jupiter'],
  [2021, 'Hope & Tianwen-1 at Mars'],
  [2026, 'BepiColombo reaches Mercury'],
];
let sysEraTimer = 0;
function flashSystemEra(text) {
  const el = $('tl-era');
  el.textContent = text; el.hidden = false;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(sysEraTimer);
  sysEraTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

let prevProbeInt = null;
function setProbeYear(y) {                        // y may be fractional during play
  probeYear = y;
  const iy = Math.floor(y);
  $('ptl-year').value = String(iy);
  $('ptl-label').textContent = String(iy);
  if (iy !== prevProbeInt) {                      // era flash on integer-year crossings
    let era = null;
    for (const [yr, text] of PROBE_ERAS) if (yr === iy || (prevProbeInt !== null && yr > prevProbeInt && yr <= iy)) era = text;
    if (era) flashSystemEra(era);
    prevProbeInt = iy;
  }
  refreshProbes(y);
}
function probeStep(now) {
  if (!probePlaying) return;
  const max = probeMaxYear();
  const perYear = (20 * 1000) / Math.max(1, max - PROBE_TL_START);   // ~20 s sweep
  const y = Math.min(max, probeAnchorYear + (now - probeAnchorMs) / perYear);
  setProbeYear(y);                                // fractional → smooth deorbit fades
  if (y >= max) { probeStopPlay(); return; }
  probeRaf = requestAnimationFrame(probeStep);
}
function probeStartPlay() {
  const max = probeMaxYear();
  if (probeYear === null || probeYear >= max) setProbeYear(PROBE_TL_START);
  probePlaying = true;
  $('ptl-play').textContent = '⏸';
  probeAnchorYear = probeYear;
  probeAnchorMs = performance.now();
  probeRaf = requestAnimationFrame(probeStep);
}
function probeStopPlay() {
  probePlaying = false;
  $('ptl-play').textContent = '▶';
  cancelAnimationFrame(probeRaf);
}

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
      buildRing();
      rebuildOrbits();
      buildSky();
      if (belt) belt.tick(performance.now(), true);    // re-place at the new scale
      viewer.scene.screenSpaceCameraController.maximumZoomDistance = skyRadius() * 0.92;
      frameWholeSystem(1.2);
    }
  });

  // Spacecraft timeline — gate the manmade orbiters by arrival year.
  $('ptl-year').max = String(probeMaxYear());
  $('ptl-toggle').addEventListener('change', (e) => {
    if (e.target.checked) { $('ptl-controls').hidden = false; setProbeYear(PROBE_TL_START); }
    else { probeStopPlay(); $('ptl-controls').hidden = true; $('tl-era').hidden = true; probeYear = null; prevProbeInt = null; refreshProbes(); }
  });
  $('ptl-play').addEventListener('click', () => (probePlaying ? probeStopPlay() : probeStartPlay()));
  $('ptl-year').addEventListener('input', (e) => { probeStopPlay(); setProbeYear(parseInt(e.target.value, 10)); });

  // "Enter Earth" → back to the satellite tracker.  "Go to the Moon" → exit to
  // Earth first (its loop must be live), then open the lunar globe.
  $('sys-enter-earth').addEventListener('click', () => hide(earthViewer));
  $('sys-goto-moon').addEventListener('click', () => { hide(earthViewer); moonView.show(); });

  // Every other planet → descend onto its own globe (Mars/Mercury via Treks
  // imagery, the rest via their local map).
  bodyGlobes = initBodyGlobes();
  $('sys-enter-planet').addEventListener('click', () => { if (selectedName) enterPlanet(selectedName); });

  document.addEventListener('keydown', (e) => {
    if (inBodyGlobe) return;   // the body globe handles its own Esc (and exits to here)
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
