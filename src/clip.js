// clip.js — capture mode, for recording the launch timeline as a shareable
// clip.  Open the app with ?clip on the URL:
//
//   https://jerredcook.github.io/orbital/?clip          (≈40 s)
//   …/orbital/?clip=60                                  (stretch it to ≈60 s)
//
// Every panel and button is hidden, leaving the globe, a large year + object
// count, the era banners and a small wordmark + address.  Start your screen
// recorder, then press Space (on a touchscreen: tap): the opening frame holds
// for a couple of seconds, the timeline plays 1957 → today while the globe
// turns slowly, and it holds on the final frame.  R replays, Esc leaves.
//
// A MOUSE click deliberately does nothing: setting up a screen recording means
// clicking around — to focus the window, to dismiss the recorder's toolbar —
// and any of those used to start the clip before the recording had.
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

export function initClip({ viewer, isReady, dataAgeDays }) {
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
  const HOLD_MS = 2500;                       // the opening frame holds on 1957 before the years start to run
  const touch = !!window.matchMedia?.('(pointer: coarse)').matches;
  const STALE_DAYS = 3;
  const dataAge = () => Math.round(dataAgeDays?.() ?? 0);
  const dataDate = () => new Date(Date.now() - (dataAgeDays?.() ?? 0) * 86_400_000)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const SPIN_RAD_PER_S = (2 * Math.PI) / 150; // one slow turn every 2½ minutes
  let state = 'loading', t0 = 0, shownYear = null, lastFrame = 0;

  function setYear(y) {
    if (y === shownYear) return;
    shownYear = y;
    const s = $('tl-year');
    s.value = String(y);
    s.dispatchEvent(new Event('input', { bubbles: true }));   // the timeline filters the swarm + flashes eras
    $('clip-year').textContent = String(y);
    // Honest wording.  The dots are TODAY'S active-satellite catalog, revealed by
    // launch year — so the number is "how many of today's active satellites had
    // been launched by then".  It is not that year's census, and it is not
    // "everything still in orbit": dead satellites (Vanguard 1, up since 1958)
    // and most debris are not in this catalog at all.  Debris is left out of the
    // clip entirely (see arm) so the count and the dots are the same set.
    const num = (id) => Number(String($(id).textContent).replace(/\D/g, '')) || 0;
    const total = Number((/·(.*)/.exec($('tl-label').textContent)?.[1] ?? '').replace(/\D/g, '')) || 0;
    const sats = Math.max(0, total - num('count-DEB'));
    // "Today" only when the data is: on a saved snapshot, give its date instead.
    $('clip-count').textContent = dataAge() >= STALE_DAYS
      ? `${sats.toLocaleString()} active satellites as of ${dataDate()}`
      : `${sats.toLocaleString()} of today’s active satellites`;
  }

  function arm() {
    const t = $('toggle-timeline');
    if (!t.checked) t.click();                // timeline on → the swarm empties back to 1957
    // Debris off: the three breakup clouds would pop in at their PARENT'S launch
    // year (Fengyun-1C's 2007 debris in 1999), which is not when they appeared.
    const deb = document.querySelector('input[data-cat="DEB"]');
    if (deb?.checked) deb.click();
    shownYear = null; setYear(1957);
    state = 'armed';
    const how = touch
      ? 'start your screen recording, then tap to play'
      : 'start your screen recording, then press Space · R replays · Esc exits';
    // The clip hides the app's own "data is old" badge, so say it here, before
    // anyone records: when the live feed is unreachable the app is showing a
    // saved snapshot, and "today's satellites" would be weeks or months out.
    const age = dataAge();
    $('clip-hint').innerHTML = age >= STALE_DAYS
      ? `<span class="clip-warn">⚠ live satellite data is unavailable — this is a snapshot about ${age} days old.<br>For current numbers, come back and record later.</span><br>${how}`
      : how;
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
  // Fingers only — see the note at the top about mouse clicks.
  hud.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' || e.pointerType === 'pen') play(); });

  // For tools/make-timeline-stills.mjs: freeze on one year and report what is
  // shown, so a still image carries exactly the numbers the clip would.
  return {
    showYear(y) {
      state = 'still';
      $('clip-hint').hidden = true;
      shownYear = null; setYear(y);
      return { year: y, count: Number($('clip-count').textContent.replace(/\D/g, '')) || 0 };
    },
    get state() { return state; },
  };
}
