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

// Play/pause loop for a year scrubber.  `rate()` is years per millisecond read
// at each frame (so a speed dropdown works); `setYear` receives fractional years
// — integer-stepped scrubbers floor + dedupe in their own wrapper.
export function createYearPlayer({ min, max, rate, getYear, setYear, playBtn }) {
  let playing = false, raf = 0, anchorMs = 0, anchorYear = min;
  function step(nowMs) {
    if (!playing) return;
    const y = Math.min(max(), anchorYear + (nowMs - anchorMs) * rate());
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
    anchorMs = performance.now();
    raf = requestAnimationFrame(step);
  }
  function stop() {
    playing = false;
    playBtn.textContent = '▶';
    cancelAnimationFrame(raf);
  }
  // Re-anchor mid-play (a speed change would otherwise jump the play-head).
  function reanchor() { anchorYear = getYear(); anchorMs = performance.now(); }
  return { start, stop, reanchor, toggle: () => (playing ? stop() : start()), get playing() { return playing; } };
}
