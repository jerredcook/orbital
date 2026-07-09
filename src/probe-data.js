// probe-data.js — reference data for the manmade orbiters shown in the system
// view (the rendering + arrival-timeline machinery lives in sys-probes.js;
// the real Horizons orbit shapes in probe-elements.js).

// [name, display factor, period (days), inclination°, node°, arrival year,
//  end year (null = still operating), deorbited? (true = left orbit at `end`,
//  so it fades out and is gone; false = derelict, still orbiting but dead)].
// Orbits are schematic where Horizons has no elements (real altitudes are
// ~1–1.5 planet radii); the point is to see what's there and when it got there.
export const PROBES = {
  Mercury: [['MESSENGER', 1.6, 0.5, 82, 30, 2011, 2015, true],
            ['BepiColombo', 1.4, 0.10, 88, 0, 2026.9, null, false]],   // orbit insertion Nov 2026
  Venus:   [['Venera 15', 1.8, 1.0, 87, 60, 1983, 1984, false],
            ['Pioneer Venus', 2.4, 0.99, 105, 40, 1978, 1992, true],
            ['Magellan', 1.6, 0.157, 86, 90, 1990, 1994, true],
            ['Venus Express', 2.2, 1.0, 89, 130, 2006, 2015, true],
            ['Akatsuki', 2.6, 10.5, 9, 0, 2015, 2024, false]],
  Mars:    [['Mariner 9', 1.5, 0.5, 64, 20, 1971, 1972, false],       // mission ended Oct 1972; still a derelict in orbit
            ['Viking 1 Orbiter', 1.95, 1.5, 38, 100, 1976, 1980, false],
            ['Viking 2 Orbiter', 2.2, 1.5, 55, 220, 1976, 1978, false],
            ['Mars Global Surveyor', 1.5, 0.078, 93, 60, 1997, 2006, false],
            ['Mars Odyssey', 1.30, 0.082, 93, 0, 2001, null, false],
            ['Mars Express', 1.7, 0.30, 86, 150, 2003, null, false],
            ['MRO', 1.45, 0.075, 93, 250, 2006, null, false],
            ['MAVEN', 2.1, 0.19, 75, 320, 2014, null, false],
            ['Mangalyaan', 2.9, 3.2, 150, 40, 2014, 2022, false],
            ['ExoMars TGO', 1.6, 0.083, 74, 110, 2016, null, false],
            ['Hope', 3.1, 2.3, 25, 200, 2021, null, false],
            ['Tianwen-1', 2.4, 0.30, 87, 290, 2021, null, false]],
  Jupiter: [['Galileo', 2.2, 7, 5, 200, 1995, 2003, true], ['Juno', 3.0, 53, 90, 0, 2016, null, false]],
  Saturn:  [['Cassini', 2.6, 16, 20, 0, 2004, 2017, true]],
};

// Operator + one-line mission note for the click-to-inspect panel.  The exact
// years live in the fact text; the panel's "status" is just the present state.
export const PROBE_FACTS = {
  MESSENGER: { op: 'NASA', fact: 'The first spacecraft to orbit Mercury (2011–15); it mapped the whole planet and found water ice in permanently shadowed polar craters before crashing into the surface.' },
  BepiColombo: { op: 'ESA / JAXA', fact: 'A joint European–Japanese mission cruising to Mercury by repeated flybys; it splits into two orbiters once it arrives in 2026.' },
  'Venera 15': { op: 'USSR', fact: 'With its twin Venera 16, it radar-mapped the northern hemisphere of cloud-shrouded Venus in 1983–84.' },
  'Pioneer Venus': { op: 'NASA', fact: 'Orbited Venus for 14 years (1978–92), studying its thick atmosphere and making the first global radar map of the surface.' },
  Magellan: { op: 'NASA', fact: 'Radar-mapped 98% of Venus at high resolution (1990–94), revealing volcanoes, lava plains and a young, resurfaced world with few craters.' },
  'Venus Express': { op: 'ESA', fact: "Europe's first Venus orbiter (2006–15); it tracked the super-rotating atmosphere and hints of recent volcanism." },
  Akatsuki: { op: 'JAXA', fact: "Japan's Venus climate orbiter, which limped into orbit in 2015 on a second attempt after its engine failed in 2010." },
  'Mariner 9': { op: 'NASA', fact: 'The first spacecraft to orbit another planet (1971); it waited out a global dust storm, then revealed Valles Marineris and the giant Tharsis volcanoes.' },
  'Viking 1 Orbiter': { op: 'NASA', fact: 'Relayed for the Viking 1 lander and imaged Mars from orbit (1976–80), scouting the surface and its moons.' },
  'Viking 2 Orbiter': { op: 'NASA', fact: 'Companion to the Viking 2 lander (1976–78), photographing Mars and Deimos from orbit.' },
  'Mars Global Surveyor': { op: 'NASA', fact: 'Mapped Mars for a decade (1997–2006): laser-altimeter topography, gullies hinting at water, and stripes of ancient crustal magnetism.' },
  'Mars Odyssey': { op: 'NASA', fact: 'The longest-working spacecraft at Mars (since 2001); it found vast subsurface water ice and still relays data from the rovers.' },
  'Mars Express': { op: 'ESA', fact: "Europe's first Mars orbiter (since 2003); its radar detected subsurface ice and a possible lake near the south pole." },
  MRO: { op: 'NASA', fact: 'The Mars Reconnaissance Orbiter (since 2006) carries HiRISE, the sharpest camera ever sent to Mars, and is a key relay for surface missions.' },
  MAVEN: { op: 'NASA', fact: 'Studies how Mars lost most of its atmosphere to space (since 2014), explaining how a once-wetter world dried out.' },
  Mangalyaan: { op: 'ISRO', fact: "India's first interplanetary mission — it made India the first nation to reach Mars orbit on its very first try (2014)." },
  'ExoMars TGO': { op: 'ESA / Roscosmos', fact: 'The Trace Gas Orbiter (since 2016) sniffs the atmosphere for methane and other gases, and relays for surface craft.' },
  Hope: { op: 'UAE Space Agency', fact: "The Emirates Mars Mission (since 2021) — the Arab world's first interplanetary probe — watches Martian weather from a high orbit." },
  'Tianwen-1': { op: 'CNSA', fact: "China's first Mars mission (2021): an orbiter that also delivered the Zhurong rover to the surface." },
  Galileo: { op: 'NASA', fact: 'The first Jupiter orbiter (1995–2003); it dropped a probe into the clouds, found evidence of an ocean inside Europa, then plunged into Jupiter to protect the moons.' },
  Juno: { op: 'NASA', fact: "A polar orbiter (since 2016) peering beneath Jupiter's clouds to map its gravity, magnetic field and deep interior — and its swirling poles." },
  Cassini: { op: 'NASA / ESA / ASI', fact: "Orbited Saturn 2004–17, landed the Huygens probe on Titan and discovered Enceladus's icy geysers, before its fiery “Grand Finale” dive into Saturn." },
};

// Real published NASA models (github.com/nasa/NASA-3D-Resources, public domain)
// for the flagship craft whose models are compact enough to read at icon scale;
// the rest keep the generic.  (Probes like MESSENGER / Magellan / Galileo model
// a very long magnetometer boom that shrinks the whole body to a speck here, so
// the tidy generic represents them better.)  `k` normalises each GLB's
// arbitrary native units so the rendered model is ~7% of its planet's radius.
export const REAL_PROBES = {
  Juno:    { file: 'juno',    k: 0.0039 },   // Jupiter
  Cassini: { file: 'cassini', k: 0.0020 },   // Saturn
  MRO:     { file: 'mro',     k: 0.00080 },  // Mars
};

// Milestones flashed (in the shared #tl-era banner) as the spacecraft play-head
// crosses them, plus the timeline's start year (the first planetary orbiter era).
export const PROBE_TL_START = 1970;
export const PROBE_ERAS = [
  [1971, 'Mariner 9 — first orbit of another planet'],
  [1978, 'Pioneer Venus maps the clouds'],
  [1990, 'Magellan radar-maps Venus'],
  [1995, 'Galileo arrives at Jupiter'],
  [1997, 'Mars Global Surveyor'],
  [2001, 'Mars Odyssey — still working today'],
  [2004, 'Cassini reaches Saturn'],
  [2006, 'Venus Express & MRO arrive'],
  [2011, 'MESSENGER orbits Mercury'],
  [2014, 'A fleet reaches Mars — MAVEN, Mangalyaan'],
  [2016, 'Juno arrives at Jupiter'],
  [2021, 'Hope & Tianwen-1 at Mars'],
  [2026, 'BepiColombo reaches Mercury'],
];
