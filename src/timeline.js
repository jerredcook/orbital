// timeline.js — the launch-history scrubber.  Watch the tracked population
// accumulate by launch year, Sputnik-era → today.  A satellite shows when its
// category is on AND (timeline off, or it was launched by the scrubbed year).
// Launch year comes from the TLE international designator, so this works fully
// offline.  Objects with no designator (rare) sort to the end.
//
// It owns refreshVisibility() — the single place that applies both the legend
// category toggles and the timeline year filter to the swarm — because both the
// legend handler and applyCatalog need it too; they call timeline.refreshVisibility().

export function initTimeline({ getCatalog, getSwarm, catVisible, catOf, getCatTotals }) {
  const $ = (id) => document.getElementById(id);

  let timelineYear = null;                       // null = timeline off (show all)
  const TIMELINE_START = 1957;                   // year before the first satellite
  const timelineMax = new Date().getUTCFullYear();

  function refreshVisibility() {
    const swarm = getSwarm();
    if (!swarm) return;
    const catalog = getCatalog();
    for (let i = 0; i < catalog.length; i++) {
      const s = catalog[i];
      const byYear = timelineYear === null
        || (s.launchYear ?? 9999) <= timelineYear;
      swarm.setVisible(i, catVisible[catOf(s)] && byYear);
    }
  }

  // Milestones flashed as the play-head crosses their year.
  const ERAS = [
    [1957, 'Sputnik 1 — the Space Age begins'],
    [1958, 'Explorer 1 · NASA is founded'],
    [1960, 'TIROS-1 — first weather satellite'],
    [1962, 'Telstar — first active comsat'],
    [1971, 'Salyut 1 — first space station'],
    [1978, 'First GPS satellites'],
    [1981, 'Space Shuttle era begins'],
    [1990, 'Hubble Space Telescope'],
    [1998, 'ISS assembly begins'],
    [2019, 'Starlink — the megaconstellation era'],
  ];
  let eraTimer = 0;
  function flashEra(text) {
    const el = $('tl-era');
    el.textContent = text;
    el.hidden = false;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');  // restart the fade
    clearTimeout(eraTimer);
    eraTimer = setTimeout(() => { el.classList.remove('show'); }, 4500);
  }

  // One pass: per-category counts launched by `year`, the running total for the
  // readout — and, in passing, drive the legend counts live during playback.
  function updateTimelineReadout(year) {
    const catalog = getCatalog();
    const c = { LEO: 0, MEO: 0, GEO: 0, HEO: 0, DEB: 0 };
    let total = 0;
    for (const s of catalog) {
      if ((s.launchYear ?? 9999) <= year) { c[catOf(s)]++; total++; }
    }
    for (const k of Object.keys(c)) $(`count-${k}`).textContent = c[k].toLocaleString();
    $('tl-label').textContent = `${year} · ${total.toLocaleString()} tracked`;
  }

  function setTimelineYear(year) {
    const prev = timelineYear;
    timelineYear = year;
    $('tl-year').value = String(year);
    updateTimelineReadout(year);
    // Flash the latest era milestone crossed since the previous year.
    let era = null;
    for (const [y, text] of ERAS) if (y === year || (prev !== null && y > prev && y <= year)) era = text;
    if (era) flashEra(era);
    refreshVisibility();
  }

  let tlPlaying = false;
  let tlRaf = 0;
  let tlAnchorMs = 0;
  let tlAnchorYear = TIMELINE_START;
  let tlYearsPerSec = 1;                          // playback speed; the dropdown sets it

  function tlStep(nowMs) {
    if (!tlPlaying) return;
    const year = Math.min(timelineMax,
      Math.floor(tlAnchorYear + (nowMs - tlAnchorMs) / 1000 * tlYearsPerSec));
    if (year !== timelineYear) setTimelineYear(year);
    if (year >= timelineMax) { stopTimelinePlay(); return; }
    tlRaf = requestAnimationFrame(tlStep);
  }

  function startTimelinePlay() {
    if (timelineYear >= timelineMax) setTimelineYear(TIMELINE_START);  // replay from the top
    tlPlaying = true;
    $('tl-play').textContent = '⏸';
    tlAnchorYear = timelineYear;
    tlAnchorMs = performance.now();
    tlRaf = requestAnimationFrame(tlStep);
  }

  function stopTimelinePlay() {
    tlPlaying = false;
    $('tl-play').textContent = '▶';
    cancelAnimationFrame(tlRaf);
  }

  $('tl-year').max = String(timelineMax);
  $('tl-year').min = String(TIMELINE_START);
  $('toggle-timeline').addEventListener('change', (e) => {
    if (e.target.checked) {
      $('timeline-controls').hidden = false;
      setTimelineYear(TIMELINE_START);
    } else {
      stopTimelinePlay();
      $('timeline-controls').hidden = true;
      $('tl-era').hidden = true;
      timelineYear = null;
      const catTotals = getCatTotals();
      for (const k of Object.keys(catTotals)) $(`count-${k}`).textContent = catTotals[k].toLocaleString();
      refreshVisibility();
    }
  });
  $('tl-play').addEventListener('click', () => (tlPlaying ? stopTimelinePlay() : startTimelinePlay()));
  $('tl-speed').addEventListener('change', (e) => {
    tlYearsPerSec = parseFloat(e.target.value);
    if (tlPlaying) { tlAnchorYear = timelineYear; tlAnchorMs = performance.now(); }   // re-anchor at new speed
  });
  $('tl-year').addEventListener('input', (e) => {
    stopTimelinePlay();
    setTimelineYear(parseInt(e.target.value, 10));
  });

  return {
    refreshVisibility,
    isActive: () => timelineYear !== null,
    refreshReadout: () => { if (timelineYear !== null) updateTimelineReadout(timelineYear); },
  };
}
