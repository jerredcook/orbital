// timeline.js — the launch-history scrubber.  Watch the tracked population
// accumulate by launch year, Sputnik-era → today.  A satellite shows when its
// category is on AND (timeline off, or it was launched by the scrubbed year).
// Launch year comes from the TLE international designator, so this works fully
// offline.  Objects with no designator (rare) sort to the end.
//
// While it is on, a small readout sits on the globe (#tl-hud: year, count,
// play/pause, close), so the feature works without the legend — which on a
// phone is a closed drawer.
//
// It owns refreshVisibility() — the single place that applies both the legend
// category toggles and the timeline year filter to the swarm — because both the
// legend handler and applyCatalog need it too; they call timeline.refreshVisibility().
// The play/pause loop and the era banner come from scrubber.js, shared with the
// system view's spacecraft timeline (sys-probes.js).

import { createEraFlasher, createYearPlayer, yearAt, progressAt } from './scrubber.js';

export function initTimeline({ getCatalog, getSwarm, catVisible, catOf, passesGroup = () => true, onToggle }) {
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
    // The readout on the globe itself (the legend's own label is inside a closed
    // drawer on a phone).  Same honest wording as capture mode: the dots are
    // TODAY'S active catalog revealed by launch year, so this is how many of
    // today's satellites had been launched by then — not that year's census.
    $('tl-hud-year').textContent = String(year);
    $('tl-hud-count').textContent = `${(total - c.DEB).toLocaleString()} of today’s active satellites`;
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

  // Play/pause via the shared year player.  It runs on PROGRESS through the
  // story (0 → 1), not on years: yearAt() gives the sparse early decades less of
  // the running time and the Starlink years more, the same pacing capture mode
  // uses.  The wrapper turns progress into an integer year and dedupes repeats
  // (the per-year work — counts + visibility over the whole catalog — isn't
  // per-frame).
  const RUN_MS = 40_000;                          // 1957 → today at "normal" speed
  let tlSpeed = 1;                                // playback speed multiplier; the dropdown sets it
  const player = createYearPlayer({
    min: 0,
    max: () => 1,
    rate: () => tlSpeed / RUN_MS,
    getYear: () => (timelineYear === null ? null : progressAt(timelineYear, timelineMax)),
    setYear: (p) => { const iy = Math.floor(yearAt(p, timelineMax) + 1e-9); if (iy !== timelineYear) setTimelineYear(iy); },
    playBtn: $('tl-play'),
    leadInMs: 1200,                               // let 1957 and Sputnik register before the years run
    onState: (playing) => { $('tl-hud-play').textContent = playing ? '⏸' : '▶'; },
  });

  $('tl-year').max = String(timelineMax);
  $('tl-year').min = String(TIMELINE_START);
  $('toggle-timeline').addEventListener('change', (e) => {
    const on = e.target.checked;
    $('tl-hud').hidden = !on;
    document.body.classList.toggle('tl-on', on);
    if (on) {
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
    onToggle?.(on);
  });
  $('tl-play').addEventListener('click', player.toggle);
  $('tl-hud-play').addEventListener('click', player.toggle);
  $('tl-hud-close').addEventListener('click', () => { const t = $('toggle-timeline'); if (t.checked) t.click(); });
  $('tl-speed').addEventListener('change', (e) => {
    tlSpeed = parseFloat(e.target.value);
    if (player.playing) player.reanchor();   // don't jump the play-head at the new speed
  });
  $('tl-year').addEventListener('input', (e) => {
    player.stop();
    setTimelineYear(parseInt(e.target.value, 10));
  });

  // Turn the timeline on and play it from the top — the "watch it happen" entry
  // point (the #timeline link and the first-visit card), no drawer needed.
  function startShow() {
    const t = $('toggle-timeline');
    if (!t.checked) t.click();
    else { player.stop(); setTimelineYear(TIMELINE_START); }
    player.start();
  }

  return { refreshVisibility, refreshCounts, startShow, get playing() { return player.playing; } };
}
