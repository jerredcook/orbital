// clip.js — capture mode, for recording the launch timeline as a shareable
// clip.  Open the app with ?clip on the URL:
//
//   https://jerredcook.github.io/orbital/?clip          (≈40 s)
//   …/orbital/?clip=60                                  (stretch it to ≈60 s)
//
// Every panel and button is hidden, leaving the globe, a large year + object
// count, the era banners and a small wordmark + address.  Start your screen
// recorder, then press Space (or tap): the timeline plays 1957 → today while
// the globe turns slowly, and holds on the final frame.  R replays, Esc leaves.
//
// It drives the existing timeline through its own controls (the same DOM
// contract the smoke suite uses) rather than reaching into timeline.js, so the
// clip always shows exactly what the real feature shows.

import { Cartesian3 } from 'cesium';

export const clipSeconds = (() => {
  try {
    const q = new URLSearchParams(location.search);
    if (!q.has('clip')) return 0;
    const n = parseFloat(q.get('clip'));
    return Number.isFinite(n) && n >= 10 && n <= 300 ? n : 40;
  } catch { return 0; }
})();
export const clipMode = clipSeconds > 0;

// Pacing: the early decades are sparse, the Starlink years are the payoff —
// so each stretch gets a share of the running time, not a share of the years.
//   [fromYear, share of the clip]
const PACE = [[1957, 0.30], [1990, 0.22], [2010, 0.16], [2019, 0.32]];

// Year (fractional) at progress p ∈ [0, 1] through the clip.
export function yearAt(p, endYear, pace = PACE) {
  if (!(p > 0)) return pace[0][0];
  if (p >= 1) return endYear;
  let acc = 0;
  for (let i = 0; i < pace.length; i++) {
    const [from, share] = pace[i];
    const to = i + 1 < pace.length ? pace[i + 1][0] : endYear;
    if (p <= acc + share || i === pace.length - 1) return from + (to - from) * Math.min(1, (p - acc) / share);
    acc += share;
  }
  return endYear;
}

export function initClip({ viewer, isReady }) {
  if (!clipMode) return;
  const $ = (id) => document.getElementById(id);
  document.body.classList.add('clip-mode');

  const hud = document.createElement('div');
  hud.id = 'clip-hud';
  hud.innerHTML = `
    <div class="clip-mark">ORBITAL</div>
    <div class="clip-readout"><div class="clip-year" id="clip-year">1957</div><div class="clip-count" id="clip-count"></div></div>
    <div class="clip-url">jerredcook.github.io/orbital</div>
    <div class="clip-hint" id="clip-hint">loading the catalog…</div>`;
  document.body.appendChild(hud);

  const endYear = parseInt($('tl-year').max, 10) || new Date().getUTCFullYear();
  const HOLD_MS = 1200;                       // a beat on 1957 before the years start to run
  const SPIN_RAD_PER_S = (2 * Math.PI) / 150; // one slow turn every 2½ minutes
  let state = 'loading', t0 = 0, shownYear = null, lastFrame = 0;

  function setYear(y) {
    if (y === shownYear) return;
    shownYear = y;
    const s = $('tl-year');
    s.value = String(y);
    s.dispatchEvent(new Event('input', { bubbles: true }));   // the timeline filters the swarm + flashes eras
    $('clip-year').textContent = String(y);
    const m = /·\s*([\d,.\s]+)/.exec($('tl-label').textContent);
    // Honest wording: the timeline shows today's tracked objects by launch year,
    // so the number is "launched by then and still up", not that year's census.
    $('clip-count').textContent = m ? `${m[1].trim()} still in orbit today` : '';
  }

  function arm() {
    const t = $('toggle-timeline');
    if (!t.checked) t.click();                // timeline on → the swarm empties back to 1957
    shownYear = null; setYear(1957);
    state = 'armed';
    $('clip-hint').textContent = 'start recording, then press Space or tap · R replays · Esc exits';
    $('clip-hint').hidden = false;
  }
  function play() {
    if (state !== 'armed' && state !== 'done') return;
    if (state === 'done') { shownYear = null; setYear(1957); }
    $('clip-hint').hidden = true;
    state = 'playing'; t0 = performance.now(); lastFrame = t0;
  }

  viewer.scene.preRender.addEventListener(() => {
    if (state !== 'playing') return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
    viewer.camera.rotate(Cartesian3.UNIT_Z, -SPIN_RAD_PER_S * dt);   // the globe turns eastward under the camera
    const p = (now - t0 - HOLD_MS) / (clipSeconds * 1000);
    setYear(Math.floor(yearAt(p, endYear)));
    if (p >= 1) state = 'done';               // hold the final frame; the globe stops with it
  });

  const ready = setInterval(() => { if (isReady()) { clearInterval(ready); arm(); } }, 250);

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); play(); }
    else if (e.key === 'r' || e.key === 'R') { if (state === 'playing' || state === 'done') { state = 'done'; play(); } }
    else if (e.key === 'Escape') { e.stopImmediatePropagation(); location.href = location.pathname; }
  }, true);
  hud.addEventListener('pointerdown', () => play());
}
