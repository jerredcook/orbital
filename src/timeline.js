// timeline.js — the launch-history scrubber.  Watch the tracked population
// accumulate by launch year, Sputnik-era → today.  A satellite shows when its
// category is on AND (timeline off, or it was launched by the scrubbed year).
// Launch year comes from the TLE international designator, so this works fully
// offline.  Objects with no designator (rare) sort to the end.
//
// It owns refreshVisibility() — the single place that applies both the legend
// category toggles and the timeline year filter to the swarm — because both the
// legend handler and applyCatalog need it too; they call timeline.refreshVisibility().
// The play/pause loop and the era banner come from scrubber.js, shared with the
// system view's spacecraft timeline (sys-probes.js).

import { createEraFlasher, createYearPlayer } from './scrubber.js';

export function initTimeline({ getCatalog, getSwarm, catVisible, catOf, passesGroup = () => true }) {
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
      swarm.setVisible(i, catVisible[catOf(s)] && byYear && passesGroup(s));
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
  const flashEra = createEraFlasher($('tl-era'));

  // One pass: per-category counts launched by `year`, the running total for the
  // readout — and, in passing, drive the legend counts live during playback.
  // Group-filtered, so the numbers always describe the dots actually on screen.
  function updateTimelineReadout(year) {
    const catalog = getCatalog();
    const c = { LEO: 0, MEO: 0, GEO: 0, HEO: 0, DEB: 0 };
    let total = 0;
    for (const s of catalog) {
      if ((s.launchYear ?? 9999) <= year && passesGroup(s)) { c[catOf(s)]++; total++; }
    }
    for (const k of Object.keys(c)) $(`count-${k}`).textContent = c[k].toLocaleString();
    $('tl-label').textContent = `${year} · ${total.toLocaleString()} tracked`;
  }

  // The single owner of the legend's per-regime numbers: they always describe
  // what's visible — filtered by the focused group, and by the scrubbed year
  // while the timeline is active.  Called by applyCatalog and on group change.
  function refreshCounts() {
    if (timelineYear !== null) { updateTimelineReadout(timelineYear); return; }
    const catalog = getCatalog();
    const c = { LEO: 0, MEO: 0, GEO: 0, HEO: 0, DEB: 0 };
    for (const s of catalog) if (passesGroup(s)) c[catOf(s)]++;
    for (const k of Object.keys(c)) $(`count-${k}`).textContent = c[k].toLocaleString();
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

  // Play/pause via the shared year player.  This scrubber steps integer years:
  // the wrapper floors the player's fractional year and dedupes repeats (the
  // per-year work — counts + visibility over the whole catalog — isn't per-frame).
  let tlYearsPerSec = 1;                          // playback speed; the dropdown sets it
  const player = createYearPlayer({
    min: TIMELINE_START,
    max: () => timelineMax,
    rate: () => tlYearsPerSec / 1000,
    getYear: () => timelineYear,
    setYear: (y) => { const iy = Math.floor(y); if (iy !== timelineYear) setTimelineYear(iy); },
    playBtn: $('tl-play'),
  });

  $('tl-year').max = String(timelineMax);
  $('tl-year').min = String(TIMELINE_START);
  $('toggle-timeline').addEventListener('change', (e) => {
    if (e.target.checked) {
      $('timeline-controls').hidden = false;
      setTimelineYear(TIMELINE_START);
    } else {
      player.stop();
      $('timeline-controls').hidden = true;
      $('tl-era').hidden = true;
      timelineYear = null;
      refreshCounts();   // back to present-day numbers (group-filtered if one is focused)
      refreshVisibility();
    }
  });
  $('tl-play').addEventListener('click', player.toggle);
  $('tl-speed').addEventListener('change', (e) => {
    tlYearsPerSec = parseFloat(e.target.value);
    if (player.playing) player.reanchor();   // don't jump the play-head at the new speed
  });
  $('tl-year').addEventListener('input', (e) => {
    player.stop();
    setTimelineYear(parseInt(e.target.value, 10));
  });

  return { refreshVisibility, refreshCounts };
}
