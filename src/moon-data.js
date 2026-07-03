// moon-data.js — the reference data for the moons shown in the system view: the
// per-planet registry (display orbit parameters), the click-to-inspect physical
// facts, and which moons have a real surface texture.  Pure data; solarsystem.js
// consumes it when it builds the moon markers, spheres and info panels.  The real
// osculating orbital elements live separately in moon-elements.js (generated).

// Major moons per planet, with real mean orbital elements (JPL):
//   [name, real orbit radius (m), sidereal period (days), display factor,
//    inclination (deg), ascending node (deg)].
// In readable mode a moon orbits at factor × the planet's *rendered* radius, so
// the moons sit just outside the exaggerated disc in a legible, correctly-ordered
// spread; in true scale they sit at their real distance (mostly invisible, as in
// reality).  Real inclinations tilt each orbit, so a moon system reads as a 3D
// family of paths rather than a flat ring (Iapetus, and retrograde Triton at
// i≈157°, stand well out of plane).  Eccentricities are ≲0.03 and invisible at
// this scale, so the orbits are taken circular.
export const MOONS = {
  Earth:   [['Moon', 3.844e8, 27.32, 3.4, 5.14, 125]],
  Mars:    [['Phobos', 9.378e6, 0.319, 1.6, 1.08, 80], ['Deimos', 2.346e7, 1.263, 2.3, 1.79, 80]],
  Jupiter: [['Amalthea', 1.815e8, 0.498, 1.6, 0.37, 0], ['Thebe', 2.218e8, 0.675, 1.8, 1.08, 90],
            ['Io', 4.217e8, 1.769, 2.1, 0.04, 0], ['Europa', 6.711e8, 3.551, 2.7, 0.47, 180],
            ['Ganymede', 1.070e9, 7.155, 3.5, 0.20, 60], ['Callisto', 1.883e9, 16.69, 4.6, 0.19, 300],
            ['Himalia', 1.146e10, 250.6, 5.2, 27.5, 30]],
  Saturn:  [['Mimas', 1.855e8, 0.942, 1.7, 1.57, 0], ['Enceladus', 2.380e8, 1.370, 2.1, 0.01, 60],
            ['Tethys', 2.947e8, 1.888, 2.5, 1.09, 120], ['Dione', 3.774e8, 2.737, 2.9, 0.02, 180],
            ['Rhea', 5.270e8, 4.518, 3.4, 0.33, 240], ['Titan', 1.222e9, 15.95, 4.4, 0.35, 300],
            ['Hyperion', 1.481e9, 21.28, 5.0, 0.43, 200], ['Iapetus', 3.561e9, 79.32, 5.7, 15.5, 80],
            ['Phoebe', 1.295e10, 550.3, 6.2, 175.2, 120]],
  Uranus:  [['Puck', 8.6e7, 0.762, 1.45, 0.32, 60], ['Miranda', 1.299e8, 1.413, 1.8, 4.34, 100],
            ['Ariel', 1.909e8, 2.520, 2.3, 0.26, 160], ['Umbriel', 2.660e8, 4.144, 2.8, 0.21, 220],
            ['Titania', 4.358e8, 8.706, 3.4, 0.34, 280], ['Oberon', 5.835e8, 13.46, 4.0, 0.06, 340]],
  Neptune: [['Larissa', 7.35e7, 0.555, 1.5, 0.20, 0], ['Proteus', 1.176e8, 1.122, 1.9, 0.52, 60],
            ['Triton', 3.548e8, 5.877, 2.9, 157, 180], ['Nereid', 5.513e9, 360.1, 4.8, 7.09, 320]],
  Pluto:   [['Charon', 1.9596e7, 6.387, 2.6, 112.9, 227],
            ['Styx', 4.3024e7, 20.16, 3.3, 112.9, 350], ['Nix', 4.9593e7, 24.85, 3.7, 112.9, 350],
            ['Kerberos', 5.8409e7, 32.17, 4.2, 113.3, 350], ['Hydra', 6.5120e7, 38.20, 4.7, 112.6, 350]],
};

// Per-moon physical data for the click-to-inspect panel and the little spheres:
// r = mean radius (km), disc = discovery year (or 'antiquity'), by = discoverer,
// tint = surface colour, fact = one notable thing.  (Public-domain facts.)
export const MOON_FACTS = {
  Moon: { r: 1737, disc: 'antiquity', by: '', tint: '#cfc7b8', fact: 'Tidally locked, so the same face always points at Earth; most likely formed when a Mars-sized body struck the young Earth.' },
  Phobos: { r: 11, disc: 1877, by: 'Asaph Hall', tint: '#6b6258', fact: 'Orbits Mars in 7.7 hours — faster than Mars spins — and is spiralling inward to break apart or crash in ~50 million years.' },
  Deimos: { r: 6, disc: 1877, by: 'Asaph Hall', tint: '#7a7165', fact: 'The smaller, outer Martian moon; a thick blanket of regolith gives it a smoother look than Phobos.' },
  Amalthea: { r: 84, disc: 1892, by: 'E. E. Barnard', tint: '#a85a44', fact: 'The reddest object in the Solar System, and the last moon found by direct visual observation.' },
  Thebe: { r: 49, disc: 1979, by: 'Voyager 1', tint: '#8a7a6a', fact: "A small inner moon whose shed dust feeds one of Jupiter's faint gossamer rings." },
  Io: { r: 1822, disc: 1610, by: 'Galileo', tint: '#e3d96b', fact: 'The most volcanically active world known — hundreds of vents kept molten by Jupiter’s tides.' },
  Europa: { r: 1561, disc: 1610, by: 'Galileo', tint: '#d8c9ad', fact: 'A cracked ice shell hides a global saltwater ocean — among the best places to look for life.' },
  Ganymede: { r: 2634, disc: 1610, by: 'Galileo', tint: '#9a8f80', fact: 'The largest moon in the Solar System — bigger than Mercury — and the only one with its own magnetic field.' },
  Callisto: { r: 2410, disc: 1610, by: 'Galileo', tint: '#6e6258', fact: 'The most heavily cratered body known; its ancient surface has barely changed in billions of years.' },
  Himalia: { r: 85, disc: 1904, by: 'C. D. Perrine', tint: '#7d7468', fact: "The largest of Jupiter's captured outer moons, on a distant, steeply tilted orbit." },
  Mimas: { r: 198, disc: 1789, by: 'William Herschel', tint: '#cdd2d8', fact: 'Its enormous Herschel crater gives it an uncanny resemblance to the Death Star.' },
  Enceladus: { r: 252, disc: 1789, by: 'William Herschel', tint: '#f0f4f8', fact: "Geysers of water ice erupt from a subsurface ocean through south-polar “tiger stripes,” feeding Saturn's E ring." },
  Tethys: { r: 531, disc: 1684, by: 'G. D. Cassini', tint: '#cdd2d8', fact: 'Almost pure water ice, scarred by the vast Ithaca Chasma canyon and the Odysseus impact basin.' },
  Dione: { r: 561, disc: 1684, by: 'G. D. Cassini', tint: '#c8cdd3', fact: 'Its bright wispy streaks turned out to be a network of towering ice cliffs.' },
  Rhea: { r: 764, disc: 1672, by: 'G. D. Cassini', tint: '#c5cace', fact: "Saturn's second-largest moon, an icy cratered world that may once have had a faint ring of its own." },
  Titan: { r: 2575, disc: 1655, by: 'Christiaan Huygens', tint: '#d9a441', fact: 'The only moon with a thick atmosphere; rivers and seas of liquid methane pool on its surface. Huygens landed there in 2005.' },
  Hyperion: { r: 135, disc: 1848, by: 'Bond & Lassell', tint: '#9a8a72', fact: 'A sponge-like, porous body that tumbles chaotically, never settling into a fixed spin.' },
  Iapetus: { r: 734, disc: 1671, by: 'G. D. Cassini', tint: '#8a7c64', fact: 'Two-faced — one hemisphere bright ice, the other coal-dark — with a strange ridge running along its equator.' },
  Phoebe: { r: 107, disc: 1899, by: 'W. H. Pickering', tint: '#5a544c', fact: "A captured body orbiting backward; debris from it forms Saturn's vast Phoebe ring. The first moon found photographically." },
  Puck: { r: 81, disc: 1985, by: 'Voyager 2', tint: '#7d7468', fact: "The largest of Uranus's small inner moons, spotted as Voyager 2 sped past." },
  Miranda: { r: 236, disc: 1948, by: 'Gerard Kuiper', tint: '#b8bcc2', fact: 'A jumbled patchwork of terrains, home to Verona Rupes — at ~20 km, the tallest known cliff.' },
  Ariel: { r: 579, disc: 1851, by: 'William Lassell', tint: '#c2c6cc', fact: 'The brightest, youngest-looking Uranian moon, cut by deep fault valleys.' },
  Umbriel: { r: 585, disc: 1851, by: 'William Lassell', tint: '#6e6e76', fact: 'The darkest of Uranus’s large moons, marked by the mysterious bright ring “Wunda.”' },
  Titania: { r: 789, disc: 1787, by: 'William Herschel', tint: '#a89e92', fact: 'The largest moon of Uranus, split by enormous canyons up to 1,500 km long.' },
  Oberon: { r: 761, disc: 1787, by: 'William Herschel', tint: '#9a8f84', fact: "Uranus's outermost large moon — ancient and cratered, with dark material pooled on some crater floors." },
  Charon: { r: 606, disc: 1978, by: 'James Christy', tint: '#a89f96', fact: "Half Pluto's size — so large the pair orbit a point in the space between them, making Pluto–Charon a true binary. A dark red polar cap, Mordor Macula, stains its north." },
  Styx: { r: 6, disc: 2012, by: 'Hubble (M. Showalter)', tint: '#c4c4c0', fact: 'The smallest and faintest of Pluto’s moons, spotted during the search for hazards ahead of the New Horizons flyby; named for the river of the underworld.' },
  Nix: { r: 20, disc: 2005, by: 'Hubble (Weaver & Stern)', tint: '#cbc5bd', fact: 'Tumbles chaotically — the shifting pull of the Pluto–Charon binary means its day length is unpredictable and its poles can flip; one large crater wears a reddish stain.' },
  Kerberos: { r: 6, disc: 2011, by: 'Hubble (M. Showalter)', tint: '#b8b4ae', fact: 'A double-lobed moonlet — two icy chunks gently stuck together. Predicted to be coal-dark before the flyby, New Horizons found it bright instead.' },
  Hydra: { r: 21, disc: 2005, by: 'Hubble (Weaver & Stern)', tint: '#d0d3d6', fact: 'The outermost moon of Pluto, coated in nearly pure water ice, and spinning chaotically once every ~10 hours — faster than any other moon of Pluto.' },
  Larissa: { r: 97, disc: 1981, by: 'H. Reitsema et al.', tint: '#7a716a', fact: 'A small, irregular inner moon racing around Neptune in well under a day — first glimpsed from the ground during a 1981 star occultation, then confirmed by Voyager 2.' },
  Proteus: { r: 210, disc: 1989, by: 'Voyager 2', tint: '#5e5a54', fact: 'One of the darkest objects in the Solar System, and about as big as a body can get while staying lumpy rather than round.' },
  Triton: { r: 1353, disc: 1846, by: 'William Lassell', tint: '#d6cfc0', fact: 'Orbits backward — a captured Kuiper Belt world — with nitrogen geysers and one of the coldest surfaces ever measured (~38 K).' },
  Nereid: { r: 170, disc: 1949, by: 'Gerard Kuiper', tint: '#8a857c', fact: 'Follows one of the most lopsided orbits of any moon, swinging far out from Neptune and back.' },
};

// Real surface maps for the major moons (tools/fetch-moon-textures.mjs).  The
// rest — Titan's haze, the Martian moons, the small irregulars — have no useful
// global map and stay flat-tinted spheres.
export const MOON_TEX = {
  Moon: 'moon.jpg', Io: 'io.jpg', Europa: 'europa.jpg', Ganymede: 'ganymede.jpg',
  Callisto: 'callisto.jpg', Mimas: 'mimas.jpg', Enceladus: 'enceladus.jpg', Tethys: 'tethys.jpg',
  Dione: 'dione.jpg', Rhea: 'rhea.jpg', Iapetus: 'iapetus.jpg', Miranda: 'miranda.jpg',
  Ariel: 'ariel.jpg', Umbriel: 'umbriel.jpg', Titania: 'titania.jpg', Oberon: 'oberon.jpg',
  Triton: 'triton.jpg', Charon: 'charon.jpg',
};
export const MOON_TEX_DIR = `${import.meta.env.BASE_URL}textures/moons/`;
