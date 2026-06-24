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
  DistanceDisplayCondition, PolylineGlowMaterialProperty, Math as CMath,
} from 'cesium';
import {
  BODIES, PLANETS, planetPosition, orbitSamples, centuriesSinceJ2000,
  orbitalPeriodCenturies, AU_METERS, eclipticFromElements,
} from './ephemeris.js';
import { MOON_ELEMENTS, MOON_EPOCH_JD } from './moon-elements.js';
import {
  scenePosition, bodyRadius, setTrueScale, isTrueScale, systemExtent,
} from './scale.js';
import { createBelt, createTrojans, createFamilies, createHildas } from './belt.js';
import { initBodyGlobes } from './bodyglobe.js';
import { writeHash } from './deeplink.js';

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
let onReturnToEarth = null; // main.js hook to re-centre Earth when we exit
const entities = {};        // body name -> marker/label Entity
const moonInfo = {};        // moon name -> { planet, entity, realR, periodDays, facts }
const probeInfo = {};       // spacecraft name -> { planet, entity, periodDays, inclDeg, arrival, end, deorbited }
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

const ALL_BODIES = ['Sun', ...PLANETS];

// Scratch objects reused every frame to keep the per-frame allocation count low.
const _real = new Cartesian3();
const _pos = new Cartesian3();
const _moonHost = new Cartesian3();
const _moonRel = new Cartesian3();
const MOON_EPOCH_REL = MOON_EPOCH_JD - 2451545.0;   // days from J2000 to the moon-element epoch

// Real position of a moon relative to its planet (metres, ecliptic J2000), by
// advancing its mean anomaly from the element epoch and solving Kepler.
function moonRelPos(name, daysSinceJ2000, result) {
  const el = MOON_ELEMENTS[name];
  const M = el.M0 + 360 * (daysSinceJ2000 - MOON_EPOCH_REL) / el.periodDays;
  return eclipticFromElements(el.a, el.e, el.i, el.node, el.peri, M, result);
}
const _quat = new Quaternion();
const _qSpin = new Quaternion();
const _qTilt = new Quaternion();
const _pom = new Matrix3();     // scratch basis for probe nadir-lock orientation
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

// Per-moon physical data for the click-to-inspect panel and the little spheres:
// r = mean radius (km), disc = discovery year (or 'antiquity'), by = discoverer,
// tint = surface colour, fact = one notable thing.  (Public-domain facts.)
const MOON_FACTS = {
  Moon: { r: 1737, disc: 'antiquity', by: '', tint: '#cfc7b8', fact: 'Tidally locked, so the same face always points at Earth; most likely formed when a Mars-sized body struck the young Earth.' },
  Phobos: { r: 11, disc: 1877, by: 'Asaph Hall', tint: '#6b6258', fact: 'Orbits Mars in 7.7 hours — faster than Mars spins — and is spiralling inward to break apart or crash in ~50 million years.' },
  Deimos: { r: 6, disc: 1877, by: 'Asaph Hall', tint: '#7a7165', fact: 'The smaller, outer Martian moon; a thick blanket of regolith gives it a smoother look than Phobos.' },
  Amalthea: { r: 84, disc: 1892, by: 'E. E. Barnard', tint: '#a85a44', fact: 'The reddest object in the Solar System, and the last moon found by direct visual observation.' },
  Thebe: { r: 49, disc: 1979, by: 'Voyager 1', tint: '#8a7a6a', fact: "A small inner moon whose shed dust feeds one of Jupiter's faint gossamer rings." },
  Io: { r: 1822, disc: 1610, by: 'Galileo', tint: '#e3d96b', fact: 'The most volcanically active world known — hundreds of vents kept molten by Jupiter’s tides.' },
  Europa: { r: 1561, disc: 1610, by: 'Galileo', tint: '#d8c9ad', fact: 'A cracked ice shell hides a global saltwater ocean — among the best places to look for life.' },
  Ganymede: { r: 2634, disc: 1610, by: 'Galileo', tint: '#9a8f80', fact: 'The largest moon in the Solar System — bigger than Mercury — and the only one with its own magnetic field.' },
  Callisto: { r: 2410, disc: 1610, by: 'Galileo', tint: '#6e6258', fact: 'The most heavily cratered body known; its ancient surface has barely changed in billions of years.' },
  Himalia: { r: 85, disc: 1904, by: 'C. D. Perrine', tint: '#7d7468', fact: "The largest of Jupiter's captured outer moons, on a distant, steeply tilted orbit." },
  Mimas: { r: 198, disc: 1789, by: 'William Herschel', tint: '#cdd2d8', fact: 'Its enormous Herschel crater gives it an uncanny resemblance to the Death Star.' },
  Enceladus: { r: 252, disc: 1789, by: 'William Herschel', tint: '#f0f4f8', fact: "Geysers of water ice erupt from a subsurface ocean through south-polar “tiger stripes,” feeding Saturn's E ring." },
  Tethys: { r: 531, disc: 1684, by: 'G. D. Cassini', tint: '#cdd2d8', fact: 'Almost pure water ice, scarred by the vast Ithaca Chasma canyon and the Odysseus impact basin.' },
  Dione: { r: 561, disc: 1684, by: 'G. D. Cassini', tint: '#c8cdd3', fact: 'Its bright wispy streaks turned out to be a network of towering ice cliffs.' },
  Rhea: { r: 764, disc: 1672, by: 'G. D. Cassini', tint: '#c5cace', fact: "Saturn's second-largest moon, an icy cratered world that may once have had a faint ring of its own." },
  Titan: { r: 2575, disc: 1655, by: 'Christiaan Huygens', tint: '#d9a441', fact: 'The only moon with a thick atmosphere; rivers and seas of liquid methane pool on its surface. Huygens landed there in 2005.' },
  Hyperion: { r: 135, disc: 1848, by: 'Bond & Lassell', tint: '#9a8a72', fact: 'A sponge-like, porous body that tumbles chaotically, never settling into a fixed spin.' },
  Iapetus: { r: 734, disc: 1671, by: 'G. D. Cassini', tint: '#8a7c64', fact: 'Two-faced — one hemisphere bright ice, the other coal-dark — with a strange ridge running along its equator.' },
  Phoebe: { r: 107, disc: 1899, by: 'W. H. Pickering', tint: '#5a544c', fact: "A captured body orbiting backward; debris from it forms Saturn's vast Phoebe ring. The first moon found photographically." },
  Puck: { r: 81, disc: 1985, by: 'Voyager 2', tint: '#7d7468', fact: "The largest of Uranus's small inner moons, spotted as Voyager 2 sped past." },
  Miranda: { r: 236, disc: 1948, by: 'Gerard Kuiper', tint: '#b8bcc2', fact: 'A jumbled patchwork of terrains, home to Verona Rupes — at ~20 km, the tallest known cliff.' },
  Ariel: { r: 579, disc: 1851, by: 'William Lassell', tint: '#c2c6cc', fact: 'The brightest, youngest-looking Uranian moon, cut by deep fault valleys.' },
  Umbriel: { r: 585, disc: 1851, by: 'William Lassell', tint: '#6e6e76', fact: 'The darkest of Uranus’s large moons, marked by the mysterious bright ring “Wunda.”' },
  Titania: { r: 789, disc: 1787, by: 'William Herschel', tint: '#a89e92', fact: 'The largest moon of Uranus, split by enormous canyons up to 1,500 km long.' },
  Oberon: { r: 761, disc: 1787, by: 'William Herschel', tint: '#9a8f84', fact: "Uranus's outermost large moon — ancient and cratered, with dark material pooled on some crater floors." },
  Larissa: { r: 97, disc: 1989, by: 'Voyager 2', tint: '#7a716a', fact: 'A small, irregular inner moon racing around Neptune in well under a day.' },
  Proteus: { r: 210, disc: 1989, by: 'Voyager 2', tint: '#5e5a54', fact: 'One of the darkest objects in the Solar System, and about as big as a body can get while staying lumpy rather than round.' },
  Triton: { r: 1353, disc: 1846, by: 'William Lassell', tint: '#d6cfc0', fact: 'Orbits backward — a captured Kuiper Belt world — with nitrogen geysers and one of the coldest surfaces ever measured (~38 K).' },
  Nereid: { r: 170, disc: 1949, by: 'Gerard Kuiper', tint: '#8a857c', fact: 'Follows one of the most lopsided orbits of any moon, swinging far out from Neptune and back.' },
};

// Real surface maps for the major moons (tools/fetch-moon-textures.mjs).  The
// rest — Titan's haze, the Martian moons, the small irregulars — have no useful
// global map and stay flat-tinted spheres.
const MOON_TEX = {
  Moon: 'moon.jpg', Io: 'io.jpg', Europa: 'europa.jpg', Ganymede: 'ganymede.jpg',
  Callisto: 'callisto.jpg', Mimas: 'mimas.jpg', Enceladus: 'enceladus.jpg', Tethys: 'tethys.jpg',
  Dione: 'dione.jpg', Rhea: 'rhea.jpg', Iapetus: 'iapetus.jpg', Miranda: 'miranda.jpg',
  Ariel: 'ariel.jpg', Umbriel: 'umbriel.jpg', Titania: 'titania.jpg', Oberon: 'oberon.jpg',
  Triton: 'triton.jpg',
};
const MOON_TEX_DIR = `${BASE}textures/moons/`;

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
  const _rad = new Cartesian3();
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

// Manmade orbiters around the other planets: [name, display factor, period
// (days), inclination°, node°, year reached orbit].  Rendered like moons but in
// tech cyan, and gateable by year via the spacecraft timeline so you can watch
// the robotic fleet arrive.  Orbits are schematic (real altitudes are ~1–1.5
// planet radii); the point is to see what's there and when it got there.
// [name, display factor, period (days), inclination°, node°, arrival year,
//  end year (null = still operating), deorbited? (true = left orbit at `end`,
//  so it fades out and is gone; false = derelict, still orbiting but dead)].
const PROBES = {
  Mercury: [['MESSENGER', 1.6, 0.5, 82, 30, 2011, 2015, true],
            ['BepiColombo', 1.4, 0.10, 88, 0, 2026, null, false]],
  Venus:   [['Venera 15', 1.8, 1.0, 87, 60, 1983, 1984, true],
            ['Pioneer Venus', 2.4, 0.99, 105, 40, 1978, 1992, true],
            ['Magellan', 1.6, 0.157, 86, 90, 1990, 1994, true],
            ['Venus Express', 2.2, 1.0, 89, 130, 2006, 2015, true],
            ['Akatsuki', 2.6, 10.5, 9, 0, 2015, 2024, false]],
  Mars:    [['Mariner 9', 1.5, 0.5, 64, 20, 1971, 2022, true],
            ['Viking 1 Orbiter', 1.95, 1.5, 38, 100, 1976, 2019, true],
            ['Viking 2 Orbiter', 2.2, 1.5, 55, 220, 1976, 1979, true],
            ['Mars Global Surveyor', 1.5, 0.078, 93, 60, 1997, 2006, true],
            ['Mars Odyssey', 1.30, 0.082, 93, 0, 2001, null, false],
            ['Mars Express', 1.7, 0.30, 86, 150, 2003, null, false],
            ['MRO', 1.45, 0.075, 93, 250, 2006, null, false],
            ['MAVEN', 2.1, 0.19, 75, 320, 2014, null, false],
            ['Mangalyaan', 2.9, 3.2, 150, 40, 2014, 2022, false],
            ['ExoMars TGO', 1.6, 0.083, 74, 110, 2016, null, false],
            ['Hope', 3.1, 2.3, 25, 200, 2021, null, false],
            ['Tianwen-1', 2.4, 0.30, 87, 290, 2021, null, false]],
  Jupiter: [['Galileo', 2.2, 7, 5, 200, 1995, 2003, true], ['Juno', 3.0, 53, 90, 0, 2016, null, false]],
  Saturn:  [['Cassini', 2.6, 16, 20, 0, 2004, 2017, true]],
};

// Operator + one-line mission note for the click-to-inspect panel.  The exact
// years live in the fact text; the panel's "status" is just the present state.
const PROBE_FACTS = {
  MESSENGER: { op: 'NASA', fact: 'The first spacecraft to orbit Mercury (2011–15); it mapped the whole planet and found water ice in permanently shadowed polar craters before crashing into the surface.' },
  BepiColombo: { op: 'ESA / JAXA', fact: 'A joint European–Japanese mission cruising to Mercury by repeated flybys; it splits into two orbiters once it arrives in 2026.' },
  'Venera 15': { op: 'USSR', fact: 'With its twin Venera 16, it radar-mapped the northern hemisphere of cloud-shrouded Venus in 1983–84.' },
  'Pioneer Venus': { op: 'NASA', fact: 'Orbited Venus for 14 years (1978–92), studying its thick atmosphere and making the first global radar map of the surface.' },
  Magellan: { op: 'NASA', fact: 'Radar-mapped 98% of Venus at high resolution (1990–94), revealing volcanoes, lava plains and a young, resurfaced world with few craters.' },
  'Venus Express': { op: 'ESA', fact: "Europe's first Venus orbiter (2006–15); it tracked the super-rotating atmosphere and hints of recent volcanism." },
  Akatsuki: { op: 'JAXA', fact: "Japan's Venus climate orbiter, which limped into orbit in 2015 on a second attempt after its engine failed in 2010." },
  'Mariner 9': { op: 'NASA', fact: 'The first spacecraft to orbit another planet (1971); it waited out a global dust storm, then revealed Valles Marineris and the giant Tharsis volcanoes.' },
  'Viking 1 Orbiter': { op: 'NASA', fact: 'Relayed for the Viking 1 lander and imaged Mars from orbit (1976–80), scouting the surface and its moons.' },
  'Viking 2 Orbiter': { op: 'NASA', fact: 'Companion to the Viking 2 lander (1976–79), photographing Mars and Deimos from orbit.' },
  'Mars Global Surveyor': { op: 'NASA', fact: 'Mapped Mars for a decade (1997–2006): laser-altimeter topography, gullies hinting at water, and stripes of ancient crustal magnetism.' },
  'Mars Odyssey': { op: 'NASA', fact: 'The longest-working spacecraft at Mars (since 2001); it found vast subsurface water ice and still relays data from the rovers.' },
  'Mars Express': { op: 'ESA', fact: "Europe's first Mars orbiter (since 2003); its radar detected subsurface ice and a possible lake near the south pole." },
  MRO: { op: 'NASA', fact: 'The Mars Reconnaissance Orbiter (since 2006) carries HiRISE, the sharpest camera ever sent to Mars, and is a key relay for surface missions.' },
  MAVEN: { op: 'NASA', fact: 'Studies how Mars lost most of its atmosphere to space (since 2014), explaining how a once-wetter world dried out.' },
  Mangalyaan: { op: 'ISRO', fact: "India's first interplanetary mission — it made India the first nation to reach Mars orbit on its very first try (2014)." },
  'ExoMars TGO': { op: 'ESA / Roscosmos', fact: 'The Trace Gas Orbiter (since 2016) sniffs the atmosphere for methane and other gases, and relays for surface craft.' },
  Hope: { op: 'UAE Space Agency', fact: "The Emirates Mars Mission (since 2021) — the Arab world's first interplanetary probe — watches Martian weather from a high orbit." },
  'Tianwen-1': { op: 'CNSA', fact: "China's first Mars mission (2021): an orbiter that also delivered the Zhurong rover to the surface." },
  Galileo: { op: 'NASA', fact: 'The first Jupiter orbiter (1995–2003); it dropped a probe into the clouds, found evidence of an ocean inside Europa, then plunged into Jupiter to protect the moons.' },
  Juno: { op: 'NASA', fact: "A polar orbiter (since 2016) peering beneath Jupiter's clouds to map its gravity, magnetic field and deep interior — and its swirling poles." },
  Cassini: { op: 'NASA / ESA / ASI', fact: "Orbited Saturn 2004–17, landed the Huygens probe on Titan and discovered Enceladus's icy geysers, before its fiery “Grand Finale” dive into Saturn." },
};

const PROBE_COLOR = Color.fromCssColorString('#6FE0FF');           // active
const PROBE_COLOR_DERELICT = Color.fromCssColorString('#8AA7B2');  // dead but still orbiting
const PROBE_COLOR_GONE = Color.fromCssColorString('#FF9A5A');      // reentering — fading out
const PROBE_MODEL = `${import.meta.env.BASE_URL}models/probe.glb`; // generic, shown up close
// Real published NASA models (github.com/nasa/NASA-3D-Resources, public domain)
// for the flagship craft whose models are compact enough to read at icon scale;
// the rest keep the generic.  (Probes like MESSENGER / Magellan / Galileo model
// a very long magnetometer boom that shrinks the whole body to a speck here, so
// the tidy generic represents them better.)  `k` normalises each GLB's
// arbitrary native units so the rendered model is ~7% of its planet's radius.
const REAL_PROBES = {
  Juno:    { file: 'juno',    k: 0.0039 },   // Jupiter
  Cassini: { file: 'cassini', k: 0.0020 },   // Saturn
  MRO:     { file: 'mro',     k: 0.00080 },  // Mars
};
const TRAIL_STEPS = 20;          // segments in a probe's trailing arc
const TRAIL_ARC = 0.55;          // radians of orbit the trail spans (~32°)
const PROBE_FADE_YEARS = 1.5;                                      // fade span after a deorbit
let probeList = [];          // { entity, year }
let probeYear = null;        // null = show all (timeline off)

function addProbe(planet, probe, idx) {
  const [name, factor, periodDays, inclDeg, nodeDeg, arrival, end, deorbited] = probe;
  const phase = idx * 2.1;
  const planetR = bodyRadius(BODIES[planet].radius);   // rendered radius — sizes the model + swap
  const i = inclDeg * Math.PI / 180, om = nodeDeg * Math.PI / 180;
  const cO = Math.cos(om), sO = Math.sin(om), ci = Math.cos(i), si = Math.sin(i);
  const nx = sO * si, ny = -cO * si, nz = ci;          // orbit-plane normal (for nadir-lock)
  const trailPts = Array.from({ length: TRAIL_STEPS + 1 }, () => new Cartesian3());   // cached trail
  const real = REAL_PROBES[name];                       // a real NASA model, or the generic
  const modelUri = real ? `${import.meta.env.BASE_URL}models/${real.file}.glb` : PROBE_MODEL;
  const modelScale = (real ? real.k : 0.009) * planetR;
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
    // Nadir-lock: the dish (+Y) points to space, the bus faces the planet, and
    // the wings (±Z) lie along-track — so each probe holds a purposeful attitude
    // and slowly turns to keep facing its world as it orbits.
    orientation: new CallbackProperty((time, result) => {
      const days = centuriesSinceJ2000(earthClock.currentTime) * 36525;
      const th = (days / periodDays) * 2 * Math.PI + phase;
      const ct = Math.cos(th), st = Math.sin(th);
      let zx = cO * ct - sO * ci * st, zy = sO * ct + cO * ci * st, zz = si * st;   // zenith
      const zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
      let Zx = ny * zz - nz * zy, Zy = nz * zx - nx * zz, Zz = nx * zy - ny * zx;    // along-track
      const Zl = Math.hypot(Zx, Zy, Zz) || 1; Zx /= Zl; Zy /= Zl; Zz /= Zl;
      const Xx = zy * Zz - zz * Zy, Xy = zz * Zx - zx * Zz, Xz = zx * Zy - zy * Zx;  // completes frame
      _pom[0] = Xx; _pom[1] = Xy; _pom[2] = Xz;
      _pom[3] = zx; _pom[4] = zy; _pom[5] = zz;
      _pom[6] = Zx; _pom[7] = Zy; _pom[8] = Zz;
      return Quaternion.fromRotationMatrix(_pom, result);
    }, false),
    // A dot in the system overview; up close (after you fly to its planet) it
    // swaps for the little spacecraft model.  Swap range + model size scale
    // with the rendered planet, so a probe reads the same at Mars or Jupiter.
    point: {
      pixelSize: 4, color: PROBE_COLOR,
      outlineColor: Color.fromCssColorString('#0A2733'), outlineWidth: 1,
      distanceDisplayCondition: new DistanceDisplayCondition(planetR * 6, Number.MAX_VALUE),
    },
    model: {
      uri: modelUri,
      minimumPixelSize: 56,
      scale: modelScale,
      distanceDisplayCondition: new DistanceDisplayCondition(0, planetR * 6),
    },
    // A short comet-tail sampled backward along the orbit, fading at the far end
    // (taperPower) — shows which way the craft is travelling.  Shown up close
    // with the model; mutates cached points so it costs no per-frame allocation.
    polyline: {
      positions: new CallbackProperty(() => {
        scenePosOf(planet, _moonHost);
        const days = centuriesSinceJ2000(earthClock.currentTime) * 36525;
        const th0 = (days / periodDays) * 2 * Math.PI + phase;
        const r = factor * bodyRadius(BODIES[planet].radius);
        for (let k = 0; k <= TRAIL_STEPS; k++) {
          const th = th0 - TRAIL_ARC + (k / TRAIL_STEPS) * TRAIL_ARC;
          const ct = Math.cos(th), st = Math.sin(th), pt = trailPts[k];
          pt.x = _moonHost.x + r * (cO * ct - sO * ci * st);
          pt.y = _moonHost.y + r * (sO * ct + cO * ci * st);
          pt.z = _moonHost.z + r * (si * st);
        }
        return trailPts;
      }, false),
      width: 2,
      material: new PolylineGlowMaterialProperty({ color: PROBE_COLOR.withAlpha(0.55), glowPower: 0.18, taperPower: 0.4 }),
      distanceDisplayCondition: new DistanceDisplayCondition(0, planetR * 6),
    },
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
  probeInfo[name] = { planet, entity, periodDays, inclDeg, arrival, end, deorbited };
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
  if (pr.end == null || Y < pr.end) return { color: PROBE_COLOR, size: 5, alpha: 1 };
  if (pr.deorbited) {
    const a = 1 - (Y - pr.end) / PROBE_FADE_YEARS;
    return a > 0 ? { color: PROBE_COLOR_GONE, size: 5, alpha: a } : null;
  }
  return { color: PROBE_COLOR_DERELICT, size: 4, alpha: 0.6 };
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
  selectedMoonName = null;
  selectedProbeName = null;
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
  const enterable = name !== 'Sun' && name !== 'Earth';
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
  releaseAnchor();                 // fly in the world frame…
  scenePosOf(name, _pos);
  viewer.camera.flyToBoundingSphere(new BoundingSphere(_pos, r), {
    duration: 1.5,
    offset: new HeadingPitchRange(0, CMath.toRadians(pitch), range),
    // …then pivot the camera on the body so scroll/drag orbit around it, and
    // floor the zoom just above its surface (no globe out here to collide with).
    complete: () => { if (selectedName === name && !inBodyGlobe) anchorOn(entities[name], r); },
  });
}

function deselect() {
  selectedName = null;
  selectedMoonName = null;
  selectedProbeName = null;
  releaseAnchor();
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
  $('system-panel').hidden = true;
  $('probe-panel').hidden = true;
  fillMoonPanel(name, info);
  $('moon-panel').hidden = false;
  expandCard('moon-panel');
  writeHash({ moon: name });

  const rr = moonRadius(name);
  releaseAnchor();
  info.entity.position.getValue(earthClock.currentTime, _pos);
  viewer.camera.flyToBoundingSphere(new BoundingSphere(_pos, rr), {
    duration: 1.3,
    offset: new HeadingPitchRange(0, CMath.toRadians(-22), rr * 4.5),
    complete: () => { if (selectedMoonName === name && !inBodyGlobe) anchorOn(info.entity, rr); },
  });
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
  $('system-panel').hidden = true;
  $('moon-panel').hidden = true;
  fillProbePanel(name, info);
  $('probe-panel').hidden = false;
  expandCard('probe-panel');
  writeHash({ probe: name });

  const planetR = bodyRadius(BODIES[info.planet].radius);
  releaseAnchor();
  info.entity.position.getValue(earthClock.currentTime, _pos);
  viewer.camera.flyToBoundingSphere(new BoundingSphere(_pos, planetR), {
    duration: 1.3,
    offset: new HeadingPitchRange(0, CMath.toRadians(-22), planetR * 3.5),
    complete: () => { if (selectedProbeName === name && !inBodyGlobe) anchorOn(info.entity, planetR * 0.25); },
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
  $('probe-orbit').textContent = `${period} · ${info.inclDeg.toFixed(0)}° incl`;
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
  probeStopPlay();
  document.body.classList.remove('system-mode');
  $('system-toggle').classList.remove('active');
  if (viewer) viewer.useDefaultRenderLoop = false;
  earthViewer.useDefaultRenderLoop = true;
  if (recenter && onReturnToEarth) onReturnToEarth();
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
  [1997, 'Mars Global Surveyor'],
  [2001, 'Mars Odyssey — still working today'],
  [2004, 'Cassini reaches Saturn'],
  [2006, 'Venus Express & MRO arrive'],
  [2011, 'MESSENGER orbits Mercury'],
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
      applyScaleToBodies();
      buildRing();
      rebuildOrbits();
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
  $('sys-goto-moon').addEventListener('click', () => { hide(earthViewer, false); moonView.show(); });

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
    focus: (name) => focusByName(name),      // deep-link entry: planet · moon · spacecraft
    get viewer() { return viewer; },
    select: (name) => selectBody(name),     // debug
    get bodies() { return entities; },        // debug
    screenOf: (name) => {                      // debug
      const p = scenePosOf(name, new Cartesian3());
      return SceneTransforms.worldToWindowCoordinates(viewer.scene, p);
    },
  };
}
