// scrubber.js — the two pieces the launch-history timeline (timeline.js) and the
// spacecraft arrival timeline (sys-probes.js) used to duplicate nearly
// line-for-line: the era-milestone flash banner and the play/pause RAF loop that
// sweeps a year scrubber.

// One flash banner: writes the milestone text and restarts the fade animation.
// Each caller gets its own hide-timer (the two timelines share the #tl-era
// element but never run at once — one lives in the Earth view, one in the
// system view).
export function createEraFlasher(el) {
  let timer = 0;
  return (text) => {
    el.textContent = text;
    el.hidden = false;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');   // restart the fade
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('show'), 4500);
  };
}

// Pacing for the launch timeline: the early decades are sparse, the Starlink
// years are the payoff — so each stretch gets a share of the running time, not
// a share of the years.  Used by the timeline's ▶ and by capture mode (clip.js),
// so a recorded clip and the live feature tell the story at the same rhythm.
//   [fromYear, share of the run]
export const PACE = [[1957, 0.30], [1990, 0.22], [2010, 0.16], [2019, 0.32]];

// Year (fractional) at progress p ∈ [0, 1] through the run.
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

// The inverse: how far through the run a year is (so playback can resume from
// wherever the slider was dragged to).
export function progressAt(year, endYear, pace = PACE) {
  if (!(year > pace[0][0])) return 0;
  if (year >= endYear) return 1;
  let acc = 0;
  for (let i = 0; i < pace.length; i++) {
    const [from, share] = pace[i];
    const to = i + 1 < pace.length ? pace[i + 1][0] : endYear;
    if (year < to || i === pace.length - 1) return acc + share * Math.min(1, (year - from) / (to - from));
    acc += share;
  }
  return 1;
}

// Play/pause loop for a year scrubber.  `rate()` is years per millisecond read
// at each frame (so a speed dropdown works); `setYear` receives fractional years
// — integer-stepped scrubbers floor + dedupe in their own wrapper.  `leadInMs`
// holds the first frame for a beat when a run starts from the very beginning.
// `onState(playing)` reports every start and stop (a second play button can
// mirror the first).
export function createYearPlayer({ min, max, rate, getYear, setYear, playBtn, leadInMs = 0, onState }) {
  let playing = false, raf = 0, anchorMs = 0, anchorYear = min;
  function step(nowMs) {
    if (!playing) return;
    const y = Math.min(max(), anchorYear + Math.max(0, nowMs - anchorMs) * rate());
    setYear(y);
    if (y >= max()) { stop(); return; }
    raf = requestAnimationFrame(step);
  }
  function start() {
    const y = getYear();
    if (y == null || y >= max()) setYear(min);   // replay from the top
    playing = true;
    playBtn.textContent = '⏸';
    anchorYear = getYear();
    anchorMs = performance.now() + (anchorYear <= min ? leadInMs : 0);
    raf = requestAnimationFrame(step);
    onState?.(true);
  }
  function stop() {
    playing = false;
    playBtn.textContent = '▶';
    cancelAnimationFrame(raf);
    onState?.(false);
  }
  // Re-anchor mid-play (a speed change would otherwise jump the play-head).
  function reanchor() { anchorYear = getYear(); anchorMs = performance.now(); }
  return { start, stop, reanchor, toggle: () => (playing ? stop() : start()), get playing() { return playing; } };
}
