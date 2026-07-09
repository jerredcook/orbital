// showpieces.js — craft that never enter Earth's catalog because they don't
// orbit Earth: they sit at the Sun–Earth Lagrange points or coast through deep
// space.  Each is its own entity you can search for and fly to.  Position by
// region: L1 sunward and L2 anti-sunward (~1.5 M km, recomputed as Earth turns),
// or a fixed faraway direction for the interstellar probes (their true distance
// is billions of km — far too far to show to scale, so it's noted in the blurb).

import {
  Color, Cartesian3, Cartesian2, CallbackProperty, Quaternion, JulianDate,
  DistanceDisplayCondition, ModelGraphics,
} from 'cesium';
import { MODELS } from './models.js';
import { sunEcefDir } from './astro.js';
import { writeHash } from './deeplink.js';

const SHOW_GOLD = Color.fromCssColorString('#FFD27A');
const L_DIST = 1.5e9, DEEP_DIST = 6e9;
const SHOWPIECES = [
  { id: 'jwst', name: 'James Webb · L2', file: 'jwst', loc: 'L2',
    kw: 'JAMES WEBB SPACE TELESCOPE JWST',
    blurb: '🔭 <b>James Webb Space Telescope</b> — at L2, ~1.5 million km out on Earth’s night side, watching the early universe in the cold and dark.' },
  { id: 'soho', name: 'SOHO · L1', file: 'soho', loc: 'L1',
    kw: 'SOHO SOLAR AND HELIOSPHERIC OBSERVATORY',
    blurb: '☀ <b>SOHO</b> — the Solar &amp; Heliospheric Observatory, watching the Sun non-stop from L1, ~1.5 million km sunward, since 1995.' },
  { id: 'dscovr', name: 'DSCOVR · L1', file: 'dscovr', loc: 'L1',
    kw: 'DSCOVR DEEP SPACE CLIMATE OBSERVATORY TRIANA EPIC',
    blurb: '🌍 <b>DSCOVR</b> — at L1, ~1.5 million km sunward; its EPIC camera takes the famous full-disc portraits of the sunlit Earth.' },
  { id: 'voyager1', name: 'Voyager 1 · interstellar', file: 'voyager', loc: 'deep', dir: [0.30, 0.42, 0.86],
    kw: 'VOYAGER 1 VOYAGER ONE',
    blurb: '🛰 <b>Voyager 1</b> — the most distant human-made object, more than 25 billion km out and receding, still calling home since 1977. <i>(Far too distant to show to scale.)</i>' },
  { id: 'voyager2', name: 'Voyager 2 · interstellar', file: 'voyager', loc: 'deep', dir: [-0.46, -0.78, -0.43],
    kw: 'VOYAGER 2 VOYAGER TWO',
    blurb: '🛰 <b>Voyager 2</b> — more than 21 billion km out and receding, the only craft to visit all four giant planets, now in interstellar space. <i>(Far too distant to show to scale.)</i>' },
  { id: 'pioneer10', name: 'Pioneer 10 · deep space', file: 'pioneer', loc: 'deep', dir: [0.72, -0.12, 0.68],
    kw: 'PIONEER 10 PIONEER TEN',
    blurb: '🛰 <b>Pioneer 10</b> — first craft through the asteroid belt and past Jupiter, now silent and coasting ~20 billion km out. <i>(Far too distant to show to scale.)</i>' },
  { id: 'newhorizons', name: 'New Horizons · Kuiper Belt', file: 'newhorizons', loc: 'deep', dir: [0.12, -0.90, 0.42],
    kw: 'NEW HORIZONS PLUTO KUIPER ARROKOTH',
    blurb: '🛰 <b>New Horizons</b> — flew past Pluto in 2015 and the Kuiper-Belt world Arrokoth in 2019; now ~9 billion km out and still exploring. <i>(Far too distant to show to scale.)</i>' },
  { id: 'ace', name: 'ACE · L1', file: 'ace', loc: 'L1',
    kw: 'ACE ADVANCED COMPOSITION EXPLORER',
    blurb: '☀ <b>Advanced Composition Explorer</b> — at L1, ~1.5 million km sunward, sampling the solar wind and giving ~1 hour’s warning of space-weather storms since 1997.' },
  { id: 'wmap', name: 'WMAP · retired', file: 'wmap', loc: 'deep', dir: [-0.72, 0.55, 0.42],
    kw: 'WMAP WILKINSON MICROWAVE ANISOTROPY PROBE',
    blurb: '🌌 <b>WMAP</b> — the Wilkinson Microwave Anisotropy Probe mapped the infant universe’s afterglow from L2 (2001–2010), pinning the age of the cosmos at 13.8 billion years; since retired to a Sun-circling graveyard orbit.' },
  { id: 'parker', name: 'Parker Solar Probe · the Sun', file: 'parker', loc: 'deep', dir: [0.85, 0.40, -0.34],
    kw: 'PARKER SOLAR PROBE',
    blurb: '☀ <b>Parker Solar Probe</b> — dives closer to the Sun than any craft, through the corona at ~6 million km from the surface. <i>(Shown as a model; really looping the Sun.)</i>' },
  { id: 'spitzer', name: 'Spitzer · solar orbit', file: 'spitzer', loc: 'deep', dir: [-0.60, 0.50, 0.62],
    kw: 'SPITZER SPACE TELESCOPE',
    blurb: '🔭 <b>Spitzer Space Telescope</b> — NASA’s great infrared observatory, trailing Earth in a Sun-circling orbit (2003–2020). <i>(Shown as a model; really far out in solar orbit.)</i>' },
  { id: 'kepler', name: 'Kepler · solar orbit', file: 'kepler', loc: 'deep', dir: [0.50, -0.70, -0.51],
    kw: 'KEPLER PLANET HUNTER',
    blurb: '🔭 <b>Kepler</b> — stared at one patch of sky from a Sun-trailing orbit and found thousands of exoplanets. <i>(Shown as a model; really in solar orbit.)</i>' },
  { id: 'ulysses', name: 'Ulysses · over the Sun’s poles', file: 'ulysses', loc: 'deep', dir: [-0.30, 0.85, -0.43],
    kw: 'ULYSSES',
    blurb: '☀ <b>Ulysses</b> — slung over the Sun’s poles via a Jupiter flyby, the only craft to survey the solar wind from high solar latitudes. <i>(Shown as a model; really in a polar solar orbit.)</i>' },
  { id: 'ds1', name: 'Deep Space 1 · deep space', file: 'ds1', loc: 'deep', dir: [-0.80, -0.20, 0.56],
    kw: 'DEEP SPACE 1 DEEP SPACE ONE DS1',
    blurb: '🛰 <b>Deep Space 1</b> — proved ion propulsion and flew past comet Borrelly out in deep space (1998–2001). <i>(Shown as a model.)</i>' },
];

// Build the showpiece entities and return the inspect / leave controls plus the
// searchable list.  deps: { viewer, clearSelection, toast, holdAutoFollow(ms) }.
export function initShowpieces({ viewer, clearSelection, toast, holdAutoFollow }) {
  const SHOW_NEAR = new DistanceDisplayCondition(0, 5e8);   // visible only when you're inspecting it
  const turntable = new CallbackProperty((time, result) =>
    Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, (JulianDate.toDate(time).getTime() / 1000 * 0.1) % (2 * Math.PI), result), false);
  for (const sp of SHOWPIECES) {
    sp.entity = viewer.entities.add({
      position: new CallbackProperty((time, result) => {
        result = result || new Cartesian3();
        if (sp.loc === 'deep') return Cartesian3.fromElements(sp.dir[0] * DEEP_DIST, sp.dir[1] * DEEP_DIST, sp.dir[2] * DEEP_DIST, result);
        const s = sunEcefDir(JulianDate.toDate(time));   // L1 sunward, L2 anti-sunward
        const k = (sp.loc === 'L1' ? 1 : -1) * L_DIST;
        return Cartesian3.fromElements(s.x * k, s.y * k, s.z * k, result);
      }, false),
      orientation: turntable,                            // slow museum turntable
      // Only render a showpiece when the camera is near it (i.e. while you're
      // inspecting it) so the others — billions of km away in other directions —
      // don't litter the view with stray labels and dots.  The model graphic is
      // NOT set here: Cesium downloads a glTF the moment the graphic exists
      // (DistanceDisplayCondition only gates rendering), which used to pull
      // ~20 MB of showpiece models on every cold page load.  inspect() attaches
      // it on first visit instead.
      point: { pixelSize: 5, color: SHOW_GOLD, distanceDisplayCondition: SHOW_NEAR },
      label: {
        text: sp.name, font: '500 12px Inter, system-ui, sans-serif', fillColor: SHOW_GOLD,
        pixelOffset: new Cartesian2(0, -12), disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: SHOW_NEAR,
      },
    });
  }
  const showpieceById = Object.fromEntries(SHOWPIECES.map((sp) => [sp.id, sp]));

  function inspect(id) {
    const sp = Object.hasOwn(showpieceById, id) ? showpieceById[id] : null;   // own-prop only, so #constructor etc. can't reach Object.prototype
    if (!sp) return;
    clearSelection();
    // Lazy-load the 3D model on first inspect (see the entity-creation note).
    if (!sp.entity.model) {
      sp.entity.model = new ModelGraphics({
        uri: `${MODELS}${sp.file}.glb`, scale: 1, minimumPixelSize: 64, distanceDisplayCondition: SHOW_NEAR,
      });
    }
    document.getElementById('infopanel').hidden = true;
    holdAutoFollow(8000);
    viewer.trackedEntity = sp.entity;
    writeHash({ show: id });
    toast(`${sp.blurb} Scroll out or press Esc to leave.`, 11000);
  }

  function leave() {
    if (!viewer.trackedEntity || !SHOWPIECES.some((sp) => sp.entity === viewer.trackedEntity)) return false;
    viewer.trackedEntity = undefined;
    writeHash(null);
    return true;
  }

  return { inspect, leave, list: SHOWPIECES };
}
