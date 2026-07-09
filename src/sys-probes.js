// sys-probes.js — the planetary-probe subsystem of the system view: manmade
// orbiters around the other planets, rendered like moons but in tech cyan, and
// gateable by arrival year via the spacecraft timeline so you can watch the
// robotic fleet arrive.  Data lives in probe-data.js; real orbit shapes (where
// Horizons tracks the craft) in probe-elements.js.  Built with initProbes(deps)
// — deps are getters because the system view's viewer and shared clock are
// created lazily on first open.

import {
  Cartesian3, Cartesian2, Color, CallbackProperty, Quaternion, Matrix3,
  DistanceDisplayCondition, LabelStyle, VerticalOrigin, NearFarScalar,
  PolylineGlowMaterialProperty, ArcType,
} from 'cesium';
import { eclipticFromElements } from './ephemeris.js';
import { PROBE_ELEMENTS } from './probe-elements.js';
import { PROBES, REAL_PROBES, PROBE_TL_START, PROBE_ERAS } from './probe-data.js';
import { createEraFlasher, createYearPlayer } from './scrubber.js';

const PROBE_COLOR = Color.fromCssColorString('#6FE0FF');           // active
const PROBE_COLOR_DERELICT = Color.fromCssColorString('#8AA7B2');  // dead but still orbiting
const PROBE_COLOR_GONE = Color.fromCssColorString('#FF9A5A');      // reentering — fading out
const PROBE_MODEL = `${import.meta.env.BASE_URL}models/probe.glb`; // generic, shown up close
const PROBE_ECAP = 0.8;    // cap rendered eccentricity so apoapsis stays in-frame and periapsis clears the planet
const TRAIL_STEPS = 20;    // segments in a probe's trailing arc
const TRAIL_ARC = 0.55;    // radians of orbit the trail spans (~32°)
const PROBE_FADE_YEARS = 1.5;                                      // fade span after a deorbit

export const nowYear = () => { const d = new Date(); return d.getUTCFullYear() + (d.getUTCMonth() + 0.5) / 12; };

// deps: { getViewer, daysNow, scenePosOf, planetRadius, getSelectedProbeName }
//   getViewer()              → the system view's Cesium Viewer (lazily created)
//   daysNow()                → shared sim clock, days since J2000
//   scenePosOf(name, out)    → a body's scene-space position (Sun at origin)
//   planetRadius(planet)     → the planet's RENDERED radius (scale-aware)
//   getSelectedProbeName()   → so a rebuild can re-reveal the selected ring
export function initProbes({ getViewer, daysNow, scenePosOf, planetRadius, getSelectedProbeName }) {
  const $ = (id) => document.getElementById(id);
  const _host = new Cartesian3();
  const _rel = new Cartesian3();
  const _pom = new Matrix3();     // scratch basis for the nadir-lock orientation

  const probeInfo = {};        // name -> { planet, entity, ring, periodDays, inclDeg, ecc, apo, arrival, end, deorbited }
  let probeList = [];          // { entity, ring, arrival, end, deorbited }
  let probeYear = null;        // null = show all (timeline off)

  function addProbe(planet, probe, idx) {
    const [name, factor, illPeriod, illInc, illNode, arrival, end, deorbited] = probe;
    const viewer = getViewer();
    const planetR = planetRadius(planet);   // rendered radius — sizes the model + swap
    // Real orbit shape + orientation from JPL Horizons where we have it (Juno's
    // eccentric polar ellipse, MESSENGER's stretched orbit…), else the illustrative
    // circle.  Periapsis is anchored to factor·planetR and eccentricity capped, so
    // the orbit clears the planet and its apoapsis stays in frame.
    const el = PROBE_ELEMENTS[name];
    const e = el ? Math.min(el.e, PROBE_ECAP) : 0;
    const orbInc = el ? el.i : illInc;
    const orbNode = el ? el.node : illNode;
    const orbPeri = el ? el.peri : 0;
    const orbPeriod = el ? el.periodDays : illPeriod;
    const M0 = el ? el.M0 : idx * 120;                   // illustrative de-phasing if no real phase
    const aRender = (factor * planetR) / (1 - e);        // semi-major giving periapsis = factor·planetR
    const iR = orbInc * Math.PI / 180, omR = orbNode * Math.PI / 180, siR = Math.sin(iR);
    const nx = Math.sin(omR) * siR, ny = -Math.cos(omR) * siR, nz = Math.cos(iR);   // orbit-plane normal
    // Phase isn't anchored to the element epoch (unlike the moons): a probe's exact
    // spot on its orbit isn't observable at this scale, so M0 just sets a stable
    // starting point and it flies its real-shaped orbit from there.
    const meanAnom = (days) => M0 + 360 * days / orbPeriod;
    const relAt = (M, out) => eclipticFromElements(aRender, e, orbInc, orbNode, orbPeri, M, out);

    const trailPts = Array.from({ length: TRAIL_STEPS + 1 }, () => new Cartesian3());   // cached trail
    const real = REAL_PROBES[name];                       // a real NASA model, or the generic
    const modelUri = real ? `${import.meta.env.BASE_URL}models/${real.file}.glb` : PROBE_MODEL;
    const modelScale = (real ? real.k : 0.009) * planetR;
    const entity = viewer.entities.add({
      name,
      position: new CallbackProperty((time, result) => {
        result = result || new Cartesian3();
        scenePosOf(planet, _host);
        relAt(meanAnom(daysNow()), _rel);
        result.x = _host.x + _rel.x;
        result.y = _host.y + _rel.y;
        result.z = _host.z + _rel.z;
        return result;
      }, false),
      // Nadir-lock: the dish (+Y) points to space, the bus faces the planet, and
      // the wings (±Z) lie along-track — so each probe holds a purposeful attitude
      // and slowly turns to keep facing its world as it orbits.
      orientation: new CallbackProperty((time, result) => {
        relAt(meanAnom(daysNow()), _rel);
        let zx = _rel.x, zy = _rel.y, zz = _rel.z;                                   // zenith (away from planet)
        const zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
        let Zx = ny * zz - nz * zy, Zy = nz * zx - nx * zz, Zz = nx * zy - ny * zx;  // along-track
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
          scenePosOf(planet, _host);
          const M0t = meanAnom(daysNow());
          const arcDeg = TRAIL_ARC * 180 / Math.PI;
          for (let k = 0; k <= TRAIL_STEPS; k++) {
            relAt(M0t - arcDeg + (k / TRAIL_STEPS) * arcDeg, _rel);
            const pt = trailPts[k];
            pt.x = _host.x + _rel.x;
            pt.y = _host.y + _rel.y;
            pt.z = _host.z + _rel.z;
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
    // Faint orbit ring (the full real ellipse, relative to the planet — fixed, so
    // sampled once).  Shown only while this probe is selected, so flying to it
    // reveals its real shape without tangling the Mars fleet together.
    const ringRel = [];
    for (let k = 0; k <= 128; k++) ringRel.push(relAt((k / 128) * 360, new Cartesian3()));
    const ringPts = ringRel.map(() => new Cartesian3());
    const ring = viewer.entities.add({
      show: false,
      polyline: {
        positions: new CallbackProperty(() => {
          scenePosOf(planet, _host);
          for (let k = 0; k < ringPts.length; k++) {
            ringPts[k].x = _host.x + ringRel[k].x;
            ringPts[k].y = _host.y + ringRel[k].y;
            ringPts[k].z = _host.z + ringRel[k].z;
          }
          return ringPts;
        }, false),
        width: 1.5,
        arcType: ArcType.NONE,
        material: PROBE_COLOR.withAlpha(0.4),
      },
    });
    probeList.push({ entity, ring, arrival, end, deorbited });
    // ecc shows the REAL eccentricity (Juno 0.977, not the render-capped 0.8) —
    // the cap is a display device, not data.
    probeInfo[name] = { planet, entity, ring, periodDays: orbPeriod, inclDeg: orbInc, ecc: el ? el.e : 0,
      apo: aRender * (1 + e), arrival, end, deorbited };
  }

  function buildProbes() {
    probeList = [];
    for (const planet of Object.keys(PROBES)) PROBES[planet].forEach((pr, i) => addProbe(planet, pr, i));
  }

  // On a scale toggle, the probes' orbit size/model scale/swap distances are baked
  // from the planet's rendered radius (unlike the moons, which re-read it each
  // frame), so rebuild them against the new scale.
  function rebuildProbes() {
    const viewer = getViewer();
    for (const p of probeList) { viewer.entities.remove(p.entity); viewer.entities.remove(p.ring); }
    buildProbes();
    refreshProbes();
    const sel = getSelectedProbeName() && probeInfo[getSelectedProbeName()];
    if (sel) sel.ring.show = sel.entity.show;   // re-reveal the selected probe's ring
  }

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
      if (!ap) { p.entity.show = false; p.ring.show = false; continue; }
      p.entity.show = true;
      p.entity.point.color = ap.color.withAlpha(ap.alpha);
      p.entity.point.pixelSize = ap.size;
      p.entity.label.fillColor = ap.color.withAlpha(Math.max(0.45, ap.alpha));
    }
  }

  function hideProbeRings() { for (const p of probeList) p.ring.show = false; }

  // ---- spacecraft arrival timeline (mirrors the Earth launch timeline) ----
  const probeMaxYear = () => new Date().getUTCFullYear();
  const flashEra = createEraFlasher($('tl-era'));
  let prevProbeInt = null;
  function setProbeYear(y) {                        // y may be fractional during play
    probeYear = y;
    const iy = Math.floor(y);
    $('ptl-year').value = String(iy);
    $('ptl-label').textContent = String(iy);
    if (iy !== prevProbeInt) {                      // era flash on integer-year crossings
      let era = null;
      for (const [yr, text] of PROBE_ERAS) if (yr === iy || (prevProbeInt !== null && yr > prevProbeInt && yr <= iy)) era = text;
      if (era) flashEra(era);
      prevProbeInt = iy;
    }
    refreshProbes(y);
  }
  const player = createYearPlayer({                 // ~20 s sweep; fractional years → smooth deorbit fades
    min: PROBE_TL_START,
    max: probeMaxYear,
    rate: () => Math.max(1, probeMaxYear() - PROBE_TL_START) / 20_000,
    getYear: () => probeYear,
    setYear: setProbeYear,
    playBtn: $('ptl-play'),
  });
  $('ptl-year').max = String(probeMaxYear());
  $('ptl-toggle').addEventListener('change', (e) => {
    if (e.target.checked) { $('ptl-controls').hidden = false; setProbeYear(PROBE_TL_START); }
    else { player.stop(); $('ptl-controls').hidden = true; $('tl-era').hidden = true; probeYear = null; prevProbeInt = null; refreshProbes(); }
  });
  $('ptl-play').addEventListener('click', player.toggle);
  $('ptl-year').addEventListener('input', (e) => { player.stop(); setProbeYear(parseInt(e.target.value, 10)); });

  return { probeInfo, buildProbes, rebuildProbes, refreshProbes, hideProbeRings, stopProbePlay: player.stop };
}
