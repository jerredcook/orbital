// tour.js — "Take the tour": a guided, narrated flight through the real sky.
// Twelve stops, each one true thing worth knowing, each riding navigation the
// app already has (select/fly, group focus, coverage, the timelines, the system
// view, the showpieces).  Manual Next/Back so people read at their own pace; a
// stop's go() prepares its own state via tidy(), so stops are order-independent
// and safe to re-enter from anywhere the user wandered off to.
//
// Copy rules: plain text (rendered with textContent), short, concrete, and only
// facts we'd defend — this is the teaching surface of the app.

const STOPS = [
  {
    title: 'The station overhead',
    story: 'This is the International Space Station — a real home, about the size of a football field, 400 km up and moving at 7.7 km per second. It circles the whole Earth every 92 minutes, so the people aboard see 16 sunrises a day. It has been continuously lived in since November 2000.',
    go: (d) => { d.tidy(); d.ensureEarth(); d.inspectByNorad(25544); },
  },
  {
    title: 'The shell of the internet',
    story: 'Every dot you see now is a Starlink internet satellite — more than half of all working satellites belong to this one constellation. Notice the weave: they fly in tilted rings about 550 km up, arranged so that somewhere overhead, there is always one passing.',
    go: (d) => { d.tidy(); d.ensureEarth(); d.clearSelection(); d.focusGroup('starlink'); d.flyHome(); },
  },
  {
    title: 'You used space today',
    story: 'These are the GPS satellites — just a few dozen, but flying high at 20,200 km so each one sees a third of the planet. The glow shows how many are in view from every point on Earth: everywhere is covered, which is why your phone always knows where it is. Their atomic clocks even correct for Einstein’s relativity — without that, GPS would drift by kilometres a day.',
    go: (d) => { d.tidy(); d.ensureEarth(); d.clearSelection(); d.focusGroup('gps'); d.setCoverage(true); d.flyHome(); },
  },
  {
    title: 'The orbit that stands still',
    story: 'This satellite is 35,786 km up — the one special altitude where an orbit takes exactly as long as Earth’s rotation. So from the ground it appears to hover over one spot forever. Weather satellites and TV broadcasters live here, on a single crowded ring around the equator.',
    go: (d) => { d.tidy(); d.ensureEarth(); const n = d.findGeo(); if (n != null) d.gotoSat(n); },
  },
  {
    title: 'Seventy years in twenty seconds',
    story: 'Watch the Space Age happen: Sputnik alone in 1957, the Cold War build-up, GPS arriving in the 70s and 80s — and then the explosion after 2019, when reusable rockets made space cheap. Most of everything ever launched went up in the last few years.',
    go: (d) => { d.tidy(); d.ensureEarth(); d.clearSelection(); d.playTimeline(); },
  },
  {
    title: 'Our Moon',
    story: 'The Moon is 384,400 km away — you could line up all the other planets of the solar system in the gap, with room to spare. It is tidally locked, always showing us the same face; the far side stayed unseen by anyone until a spacecraft photographed it in 1959. Twelve people have walked here.',
    go: (d) => { d.tidy(); d.showMoon(); },
  },
  {
    title: 'Leaving Earth behind',
    story: 'This is the whole solar system — every planet exactly where it really is today. The spacing is gently compressed so you can see everything at once; flip “True scale” later to feel how empty space really is. Light from the Sun takes hours to cross what you’re looking at. Everything here can be tapped and flown to.',
    go: (d) => { d.tidy(); d.showSystem(); },
  },
  {
    title: 'The king and its dance',
    story: 'Jupiter — heavier than every other planet combined. The four bright moons circling it are the ones Galileo spotted through his little telescope in 1610, the discovery that proved not everything orbits the Earth. Io is the most volcanic world known; Europa hides a saltwater ocean under its ice that may be the best place to look for life.',
    go: (d) => { d.tidy(); d.gotoBody('Jupiter'); },
  },
  {
    title: 'The jewel',
    story: 'Saturn’s rings are almost pure water ice — billions of tumbling snowballs from dust-size to house-size. For all their quarter-million-kilometre width, they are staggeringly thin: mostly just tens of metres. The tilt you see is real, and the moons weave through and around them.',
    go: (d) => { d.tidy(); d.gotoBody('Saturn'); },
  },
  {
    title: 'The heart of Pluto',
    story: 'Pluto, five and a half light-hours from the Sun — and it has a heart. The bright lobe is a glacier of frozen nitrogen the size of Texas, photographed by New Horizons in 2015. Pluto and its moon Charon are so evenly matched they orbit a point in the space between them: a true double world.',
    go: (d) => { d.tidy(); d.gotoBody('Pluto'); },
  },
  {
    title: 'A visitor from another star',
    story: 'This arc doesn’t close — that’s the whole story. 3I/ATLAS fell in from interstellar space, is swinging once past the Sun, and will leave forever; no orbit, just a visit. It is only the third such interstellar visitor ever caught passing through, after ʻOumuamua and Borisov.',
    go: (d) => { d.tidy(); d.gotoBody('3I/ATLAS'); },
  },
  {
    title: 'The farthest thing we ever made',
    story: 'Voyager 1 left Earth in 1977 and never stopped: it is now more than 25 billion km away, in interstellar space, the most distant human-made object. Its radio whisper takes almost a full day to reach us, and it still calls home. Bolted to its side is a golden record of Earth’s sounds — just in case. That’s the tour; the rest of the sky is yours.',
    go: (d) => { d.tidy(); d.ensureEarth(); d.inspectShowpiece('voyager1'); },
  },
];

export function initTour(deps) {
  const $ = (id) => document.getElementById(id);
  const card = $('tour-card');
  let at = -1;   // -1 = tour off

  function render() {
    const s = STOPS[at];
    $('tour-step').textContent = `${at + 1} / ${STOPS.length}`;
    $('tour-title').textContent = s.title;
    $('tour-story').textContent = s.story;
    $('tour-back').disabled = at === 0;
    $('tour-next').textContent = at === STOPS.length - 1 ? 'Finish ✓' : 'Next →';
  }

  function show(i) {
    at = i;
    render();
    card.hidden = false;
    deps.closeDrawer();          // the show happens on the globe, not in the drawer
    STOPS[at].go(deps);
  }

  function start() { if (at < 0) show(0); }
  function next() { if (at < 0) return; at === STOPS.length - 1 ? end(true) : show(at + 1); }
  function back() { if (at > 0) show(at - 1); }
  function end(finished = false) {
    if (at < 0) return;
    at = -1;
    card.hidden = true;
    deps.tidy();                 // leave no tour state armed (group / coverage / timeline)
    if (finished) deps.toast('🌌 Enjoy the sky. The 📖 illustrated guide (behind the ? button) covers everything else.', 8000);
  }

  $('tour-next').addEventListener('click', next);
  $('tour-back').addEventListener('click', back);
  $('tour-close').addEventListener('click', () => end(false));

  return { start, next, back, end, get active() { return at >= 0; } };
}
