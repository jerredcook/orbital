# ORBITAL — live satellite tracker

A 3D real-time visualization of every active satellite in the public catalog
plus the three big fragmentation-event debris clouds (~18,000 objects),
rendered on a CesiumJS globe with live SGP4 propagation.

## Quick start

```bash
npm install
npm run dev
```

Open the printed localhost URL.  First load fetches two datasets from
CelesTrak (the active-satellite element sets and the SATCAT metadata
catalog, ~4 MB total) and caches them in localStorage for two hours.

No API keys or accounts are required.  The globe streams Esri World
Imagery — high-resolution satellite photography, street-level in
populated areas — keylessly, with on-screen attribution.  Zoom from the
full constellation view all the way down to ~80 m above your own
street.  (If you ever add a Cesium Ion token you can swap in Bing
Aerial + World Terrain for 3D relief; see the provider block at the
top of `src/main.js`.)

**Install it as an app.**  Orbital is a PWA (`public/manifest.webmanifest`,
`public/sw.js`, icons in `public/icons/` from `tools/icon.svg`).  On Android,
open it in Chrome and tap **Install app** — or the **Install** button on the
welcome screen; on iPhone, Share → **Add to Home Screen**.  It then launches
full-screen from a home-screen icon and updates itself whenever the site is
redeployed (the service worker serves navigations network-first, and caches the
app's own hashed assets stale-while-revalidate; cross-origin tiles/TLE feeds are
left to the network).

## Controls

| Action | Input |
|---|---|
| Rotate globe | left-drag |
| Zoom | scroll / pinch |
| Tilt | middle-drag or ctrl-drag |
| Select satellite | click a point |
| Search | `/` or click the search box (name or NORAD ID) |
| Deselect / close | `Esc` or click empty space |
| Help | first-run welcome (a 3-tip intro + quick-jump chips); the `?` button reopens it. **"See everything it can do"** opens the full in-app guide — its own scrollable page documenting every feature, also reachable at `#guide` |
| Time warp | − / + buttons, NOW to return to real time |
| Launch timeline | legend toggle — scrub or ▶-play from 1957 to today (with a speed selector for the dense modern years) and watch the tracked population accumulate by launch year; era banners flash the milestones |
| Conjunctions | legend toggle — every pair now within 5/10/25 km; click a list row to fly there |
| Screening | select a satellite → "Screen close approaches" — its passes within 25 km over the next 24 h |
| Ground station | legend toggle → **⌖ set location** → click the globe to drop a station; a worker predicts every satellite pass over the next 24 h (above 10/25/50°), streamed and sorted by rise time with peak elevation and duration. Click a pass to jump the clock to its peak and fly to the satellite. The station persists across sessions |
| See the spacecraft | select → Follow → scroll in; inside 150 km the dot becomes a 3D model |
| Visit the Moon | `◐ Moon` in the top bar — a separate lunar globe you can rotate and zoom down to the surface; `← Back to Earth` or `Esc` returns |
| Fly the solar system | `☉ System` in the top bar — a heliocentric view of the Sun, all eight planets on their real orbits, the asteroid belt, the two Jupiter Trojan clouds (~60° ahead of and behind Jupiter), the Hilda group's 3:2-resonance triangle, the major asteroid families as coloured rings (toggle + legend, top-right), major moons, Saturn's rings, and an accurate NASA star sky; click anything — planet, moon, or robotic spacecraft — to fly to it and orbit/zoom around it (like the tracker does Earth), down to just above its surface; a moon opens a panel with its size, orbit, discovery and a fact, and a spacecraft opens one with its operator, arrival, status and mission; a planet's panel has a **Show moon orbits** button to ring it with its natural satellites' paths; toggle **True scale**; from Earth drop into the satellite tracker or the Moon; `Esc` / exit returns |
| See moons & rings | In the system view, click a planet — the camera frames its moons (Galilean, Titan, Luna, Triton…) and, for Saturn, its rings |
| Descend to a planet | Select a planet → **Descend to the surface** (Mars/Mercury in NASA high-res, others as their map); on Mars, keep zooming and the colour Viking overview gives way to the ~5 m/px CTX mosaic — ~46× sharper, real craters and channels under every landing site; landing sites are pinned at their real coordinates — gold = crewed, orange = rover, cyan = lander; `← Back` / `Esc` returns |
| Landing sites | Mars rovers & landers (Viking → Perseverance, Zhurong), the Moon's Apollo + Luna/Lunokhod/Surveyor/Chang'e/Chandrayaan sites, and Venus's Venera landers — visible on the surface globes, near-side only as you rotate |
| Planetary spacecraft | Fly to a planet to see its robotic orbiters alongside its moons, colored by status (a legend, top-right, explains them): **bright cyan** = operating, **dim slate** = derelict (dead but still in orbit), and craft that **deorbited fade out** (orange) and are gone. The **Spacecraft timeline** (bottom-left) plays/scrubs from 1971 by arrival year — with the deorbit fades animating live — and flashes its own era banners |

## Architecture

```
index.html                  UI shell (top bar, legend, info panel, time bar)
src/style.css               dark telemetry theme
src/main.js                 Cesium scene, picking, selection, UI wiring
src/swarm.js                custom GPU point-cloud primitive (one draw call)
src/moon.js                 standalone lunar globe (Moon ellipsoid + LRO imagery)
src/solarsystem.js          heliocentric view: Sun, planets, rings, moons, sky
src/bodyglobe.js            descend to a planet's surface globe (Treks / local map)
src/surface.js              landing-site markers pinned on the surface globes
src/ephemeris.js            JPL Keplerian planet positions (pure, no Cesium globe)
src/scale.js                readable ⟷ true-scale mapping for the system view
src/belt.js                 belt + Trojans + Hildas + families: Kepler swarms
src/data.js                 CelesTrak fetch + TLE/SATCAT parsing + caching
src/decode.js               SATCAT owner & launch-site code expansion
src/propagator.worker.js    SGP4 for the full catalog, off the main thread
src/tca.worker.js           closest-approach search for conjunction pairs
src/passes.worker.js        ground-station pass prediction (look-angle sweep)
tools/make-models.mjs       generates the generic spacecraft GLBs
public/models/              ISS + Hubble (NASA) and generated generics
```

Design decisions worth knowing before you extend it:

- **Two propagation paths.**  The web worker recomputes all ~14k positions
  every 600 ms at the simulation clock's current time — at global zoom
  that is far below one pixel of motion per update.  The *selected*
  satellite is additionally propagated every frame on the main thread so
  close-up motion and the live altitude/speed readout are smooth.
- **Positions are Earth-fixed (ECF).**  satellite.js propagates in ECI;
  the worker converts with the GMST for the sample time, and Cesium's
  default frame is Earth-fixed, so coordinates drop straight in.
- **Orbit track** is one full period sampled in ECI and projected at the
  current GMST — the classic closed ellipse, not the ground-relative
  spiral.  Swap the per-sample `gmst` if you prefer ground tracks.
- **Regime classification** (LEO/MEO/GEO/HEO) is derived from SATCAT
  period and apsis data, falling back to TLE mean motion.  Debris keeps
  its regime for the info panel but renders as its own legend category.
- **Rendering is one draw call.**  `swarm.js` is a hand-rolled Cesium
  primitive: positions live in two float32 vertex buffers (high/low
  encoded for relative-to-eye precision), per-point color alpha doubles
  as the visibility flag, and picking uses a per-point pick-ID color
  attribute.  Each worker tick is two `bufferSubData` uploads.  It uses
  undocumented-but-exported Cesium renderer internals (`DrawCommand`,
  `ShaderProgram`, …), so treat Cesium upgrades as API-break suspects.
- **Conjunctions are a spatial hash in the worker** — uniform grid with
  cell size = threshold, each object checks its 27 neighbor cells, exact
  distance test on candidates, O(n + pairs) per tick.  Pairs closer than
  250 m are dropped as docked/same-complex (ISS and CSS modules each have
  their own NORAD IDs and would otherwise pin the list at 0.0 km).  The
  overlay polylines are pooled, never removed: `PolylineCollection.
  removeAll()` destroys polyline materials and crashes the render loop on
  the next add if you share or reuse them.
- **Closest-approach forecasts run in a second worker** so a TCA batch
  (~50 ms/pair: 30 s coarse grid over 24 h + ternary refinement) never
  stalls the position ticks.  It receives only the two TLEs per pair.
  Results cache per pair until their TCA passes.  Caveat: a 30 s grid
  can miss the true minimum of a fast-crossing encounter (closest window
  ≪ 1 s); candidates come from the live view, which surfaces co-moving
  pairs, so the smooth-curve assumption holds in practice.
- **Screening one target against the catalog** prefilters by altitude
  band (perigee–apogee overlap ± 75 km — an object whose band can't
  reach the target's can never come close), then sweeps survivors on a
  120 s coarse grid against precomputed target positions, with a 15 s
  fine scan wherever a pair dips under 950 km (the worst excursion a
  120 s gap can hide at LEO crossing speeds) and ternary refinement
  under 300 km.  Uses `satellite.sgp4` (minutes-since-epoch) directly
  rather than `satellite.propagate` — skipping per-call Date/jday math
  makes an ISS screen (~9k candidates, ~6.5M propagations) take about a
  second.  Crossing geometries are caught, not just co-moving ones: the
  staged gates were validated against an independent 1 s brute-force
  search on a 51.6° × 120.4° inclination pair.
- **Ground-station passes** (`src/passes.worker.js`) reuse that screening shape
  for a different question: when does each satellite rise above *your* horizon?
  The worker builds the station's ECF position + local east/north/up basis once,
  precomputes per-step GMST (advanced linearly — `gmst0 + ω·Δt` — so the ECI→ECF
  rotation is a couple of multiplies, not a `gstime` call, per sample), then for
  every satellite walks a 60 s grid computing elevation = `asin(los·up / |los|)`.
  Each above-horizon run becomes a pass; the min-elevation crossings are bisected
  for exact rise/set and the peak is ternary-refined.  The look-angle math was
  checked against `satellite.ecfToLookAngles` (agrees to 0.0000°), and rise/set
  bisect to el ≈ the threshold within ~0.01°.  A latitude prefilter (station |lat|
  vs the satellite's max sub-point latitude + the horizon's Earth-central angle)
  skips the never-visible; near-geostationary objects are dropped and any run
  spanning the whole window is discarded, since neither is a discrete *pass*.
  Clicking a pass flies `viewer.clock` to its peak so the catalog snaps to that
  instant and the satellite is framed over the station.
- **Solar System view** (`src/solarsystem.js`) is a third Cesium Viewer with
  the globe switched off (`globe: false`) — there's no body to stand on out in
  heliocentric space.  Planet positions come from JPL low-precision Keplerian
  elements (`src/ephemeris.js`, validated: Earth's heliocentric longitude lands
  within a degree of reality), and *everything* — positions and radii — passes
  through one switchable readable⟷true scale mapping (`src/scale.js`).  Hard-won
  Cesium gotchas, all the way down: (1) orbit polylines **must** set
  `arcType: NONE` — the default GEODESIC densifies each segment along Earth's
  ellipsoid and OOM-crashes the renderer with billion-metre arcs; (2) entity
  ellipsoids silently drop **image** materials (they render flat white — no
  texture coordinates), so planets are `Primitive` + `EllipsoidGeometry`
  (POSITION_NORMAL_AND_ST) + `MaterialAppearance`, moved each frame by writing
  `modelMatrix`; (3) billboards only render from a real image **URL** here —
  `<canvas>`/data-URL images and `sizeInMeters` billboards silently don't draw
  (the Sun glow is a PNG file, pixel-sized with `scaleByDistance`); (4)
  `flyToBoundingSphere`'s `HeadingPitchRange` is singular at the geocentre, so
  the opening camera is aimed at the origin explicitly.  The shared Earth clock
  drives the planets, hand-ticked each frame because its own render loop is idle
  while this view is up.  The stars are a real NASA all-sky map on a *finite*
  celestial sphere (not an infinite skybox), so the imagery gains detail as you
  zoom out toward it; the camera's zoom-out is capped just inside the sphere so
  you approach the stars without flying through them.
- **Belt, moons, rings** ride on the same scale map.  The asteroid belt
  ([src/belt.js](src/belt.js)) reuses the satellite swarm primitive
  (`new SatSwarm(n, { boundingRadius })`) — 14k orbits Kepler-solved on a
  throttled tick and run through `scenePosition`, one draw call.  The same
  module also renders **Jupiter's Trojans**: ~2,700 of the real largest members
  on a second swarm (cooler tint), no procedural fill — their osculating
  elements already librate ~±60° from Jupiter and share its period, so the two
  clouds (L4 leading, L5 trailing, ~1.5:1 like the real camps) form and co-move
  on their own.  It also renders the major **asteroid families** as their own
  coloured swarm (toggle + legend, top-right): 14 families (Vesta, Flora, Eos,
  Themis, Koronis, Hygiea, Eunomia, Hungaria…), ~600 brightest members each,
  tinted by taxonomy.  A family is a cluster in *proper*-element space (a, e,
  sin i), **not** in physical position — its members are spread all around their
  orbits — so each member carries its real Nesvorný proper a/e/i (the tightest
  family signature) and is given a *random* orbital phase: the result is a set of
  inclined, coloured rings threading the belt (Themis and Hygiea overlapping in
  radius but split by inclination; Hungaria a high-i ring inside the belt; Koronis
  a tight low-i band), not blobs.  And the **Hilda group** — ~1,150 asteroids in
  3:2 mean-motion resonance with Jupiter (a ≈ 3.97 AU) — rides the same machinery
  with its real angles kept (like the Trojans, not the families): locked in
  resonance they librate around Jupiter's L3/L4/L5 and trace the famous **Hilda
  triangle**, which rotates with Jupiter (verified: a present-day snapshot shows a
  ~2× density contrast peaking at the three vertices, minimum toward Jupiter).
  Two-body propagation reproduces today's snapshot and smears the triangle only
  under long time-warp.  Belt, Trojans, Hildas and families all run through one
  generic `createKeplerSwarm` core (per-point colour for families).  Moons (Luna,
  the Galileans + Amalthea, seven of Saturn's, five Uranian, Triton + Proteus)
  carry real JPL mean elements — period and *inclination*, so each orbit tilts
  realistically (Iapetus and retrograde Triton stand out of plane).  Each is a
  marker+label entity whose `CallbackProperty` position is the host planet's
  position plus an inclined circular offset — sized to the planet's *rendered*
  radius in readable mode (so they clear the exaggerated disc) and to their real
  distance in true scale.  **Manmade orbiters** (Mars's fleet, Akatsuki, Juno,
  BepiColombo, plus historic Mariner 9 / Viking / Magellan / Galileo / Cassini)
  ride the same machinery, each carrying arrival + end years and a deorbit flag.
  `probeAppearance(year)` maps that to a look — operating (cyan), derelict (dim),
  or deorbiting (orange, alpha fading over ~1.5 yr) — driven by the *fractional*
  timeline year so the fades animate during playback; with the timeline off it
  uses today's date, so the default view shows each craft's real present status.
  Their orbits are schematic (real altitudes are ~1–1.5 planet radii) — the point
  is what's there, when it arrived, and whether it's still alive.  Saturn's rings
  are a hand-built double-sided annulus geometry
  (UV.s = inner→outer) with the alpha ring texture, transformed each frame to
  Saturn's position and tilt.
- **Descend to a planet** ([src/bodyglobe.js](src/bodyglobe.js)) reuses the
  moon.js pattern — a Cesium globe scoped to the planet's own `Ellipsoid` (passed
  to the *Viewer*, so the camera controller collides against the right surface),
  clad in NASA Treks tiles (Mars/Mercury) or the local map as a single tile.  One
  globe lives at a time on a shared container — switching planets destroys and
  rebuilds it — to keep the WebGL-context count low.  The system scene idles
  beneath and is restored on exit; a guard flag keeps the system view's Esc from
  firing while a planet globe owns it.
- **Mars zooms in for real.**  On top of the colour Viking base sits the Bruce
  Murray Lab global **CTX mosaic** (~5 m/px, ~46× finer; Esri-hosted, keyless),
  added as a second imagery layer.  It's gated by the layer's `minimumTerrainLevel`
  so it loads only once you descend past Viking's depth (using the provider's
  `minimumLevel` instead would clamp every tile up to level 8 and fire tens of
  thousands of requests at the global view — Cesium warns against exactly that);
  where CTX has a gap the colour Viking base shows through.  **Tiling-scheme
  gotcha, the hard-won one:** Treks/CTX pyramids are equirectangular (2×1 tiles at
  level 0), but `UrlTemplateImageryProvider` *defaults to WebMercator* (1×1) —
  leaving it implicit (as the Mars, Mercury **and** Moon globes originally did)
  misaddresses the tiles so only the western hemisphere renders, stretched, with
  the geographic landing-site markers floating over the wrong terrain.  Every
  Treks/CTX provider is now handed an explicit `GeographicTilingScheme`.  (Earth's
  Esri World Imagery genuinely *is* Web Mercator, so it keeps the default.)

## Roadmap (good Claude Code sessions)

1. **More debris** — the full SATCAT DEB population via space-track.org
   GP data (~25k more objects).  The swarm renderer won't blink; the
   SGP4 worker may want batching by then.
2. **More real models** — 17 spacecraft have real models now; ESA
   publishes Sentinel/Galileo models (Sketchfab, CC-BY-NC-SA) and the
   mapping in `modelFor` takes one line per spacecraft.  TESS and JWST
   models are already in `public/models/`, waiting for their element
   sets to appear in the catalog.
3. **Smarter refresh cadence** — auto-refresh exists (see below); a
   nicety would be scheduling fetches off CelesTrak's own update times
   instead of a fixed TTL.
4. **All-vs-all screening** — per-target screening exists; the full
   SOCRATES-style catalog × catalog sweep is ~18k targets × the same
   pipeline.  Needs smarter sieving (orbit-path/MOID filter after the
   band filter) and probably batching across several workers.
5. **More worlds and detail** — the overview, asteroid belt, major moons (with
   real JPL elements and inclinations), Saturn's rings, an accurate NASA star
   sky, and descend-to-surface globes for every planet all ship now.  Worth doing
   next: **3D terrain relief** on the surface globes — `CustomHeightmapTerrainProvider`
   is the hook, but it needs a global MOLA/LOLA elevation grid, which (unlike the
   imagery) Treks doesn't expose as open tiles; sourcing/hosting a downsampled DEM
   (or adding a Cesium Ion token, which has Mars terrain ready-made) is the
   blocker.  The Jupiter Trojans, the major main-belt asteroid families
   (Themis, Eos, Koronis…) and the Hilda group (3:2 resonance triangle) now ship
   as their own swarms; still open: higher-res / regional imagery
   (Mars CTX/HiRISE) on the surface globes.

Data freshness and resilience:

- **Auto-refresh.**  Every 5 minutes the app checks whether the 2 h
  element-set cache has lapsed; if so it re-fetches, diffs the NORAD ID
  set against a persisted snapshot, hot-swaps the catalog in place
  (swarm rebuild + worker re-init), and toasts what changed — new IDs
  are launches, dropped IDs are decays/delistings.  The snapshot
  survives sessions, so tomorrow's first load reports what changed
  overnight.  A >20% catalog size jump is treated as a partial load or
  its recovery and rebaselined silently rather than toasted.
- **CelesTrak rate-limits.**  Re-fetch the big files too often and you
  get HTTP 403 — or a stalled connection — for a couple of hours (ask me
  how I know).  Defenses, weakest to strongest: every fetch is bounded by
  a timeout (so a hung CelesTrak can't wedge the load); expired cache
  entries are kept and served when a fetch fails; a **bundled offline
  snapshot** (`public/fallback/active.tle`, ~17k objects from a CelesTrak
  mirror via `tools/fetch-fallback-tle.mjs`) backs the main group so the
  sky is never empty even on a cold load with CelesTrak down; and a
  localStorage **circuit breaker** skips live CelesTrak calls for 10 min
  after a failure, so reloads during an outage drop straight to the
  fallback in ~1 s instead of eating a timeout per request.  A group that
  fails entirely is skipped rather than failing the boot, and refresh
  attempts are spaced ≥ 20 minutes apart.

Design notes for the 3D close-up view:

- **Selected satellite renders as a 3D model inside 150 km** (`Follow`,
  then scroll in).  Real published models cover ISS, Hubble, Terra, Aqua,
  Aura, ICESat-2, Landsat 8/9, Sentinel-6A/B, OCO-2, Suomi NPP, Swift,
  Fermi, Chandra, GRACE-FO, and the TDRS fleet (NASA solar system site +
  github.com/nasa/NASA-3D-Resources); everything else gets a
  class-appropriate generic from `tools/make-models.mjs` (bus-with-wings,
  Starlink flat-panel, a nav-sat with a nadir antenna farm and no dish for
  the Galileo/GPS/BeiDou constellations, an EO/SAR bus with the long
  side-mounted antenna for the Sentinels, spent stage, debris shard) picked
  by NORAD ID / name pattern in `modelFor`.  Each real model carries a scale factor —
  the published GLBs' units are wildly inconsistent (native Terra is
  26 km long, native TDRS is 0.9 m).  `tools/fix-models.mjs` strips
  texture bindings that reference missing UV sets, which otherwise kill
  Cesium's shader compile (Terra, Hubble shipped that way).
- **Planetary probes in the solar-system view** swap dot→model up close too,
  each nadir-locked to its planet with a short comet-tail.  Juno, Cassini and
  MRO use their real NASA models (`REAL_PROBES` in `solarsystem.js`); the rest
  use a generic deep-space-probe build from `make-models.mjs`.  (Craft with a
  very long magnetometer boom — MESSENGER, Magellan, Galileo — stay generic:
  the real GLB shrinks the body to a speck at icon scale.)
- **Solar-system positions are real.** Planets use JPL's low-precision
  Keplerian elements; the moons (`moon-elements.js`) and the probes
  (`probe-elements.js`) carry real osculating elements from **JPL Horizons**
  (ecliptic J2000, planet-centred), fetched by the `fetch-moon-elements` /
  `fetch-probe-elements` tools and propagated with the shared Kepler solver in
  `ephemeris.js`.  The major moons land within ~1° of Horizons — the tiny, fast-
  precessing inner moonlets within a few degrees.  The fetch derives each moon's
  precise mean-longitude rate in two steps (a short baseline pins an unambiguous
  coarse rate; a long baseline counted with *that* rate gives the precise period),
  because the raw osculating period mis-counts turns for fast moons over many
  orbits.  Probes get their real orbit shape + orientation (Juno's eccentric polar
  ellipse, etc.), eccentricity capped and periapsis anchored so it frames sensibly
  — re-sized to the planet on a **True scale** toggle; selecting a probe draws its
  real orbit ring.  Craft Horizons doesn't track keep a generic illustrative orbit.
- **Showpieces** (`SHOWPIECES` in `main.js`) — craft that never enter Earth's
  catalog because they don't orbit Earth.  Lagrange-point observatories (JWST,
  WMAP at L2; SOHO, DSCOVR, ACE at L1), deep-space probes (Voyager 1 & 2,
  Pioneer 10, New Horizons) and other heliocentric/solar craft (Parker Solar
  Probe, Spitzer, Kepler, Ulysses, Deep Space 1).  Each is its own entity (L1/L2 positioned off
  the live Sun direction; deep-space ones parked in a fixed far direction, real
  distance in the blurb) with a slow turntable, reachable by **search** (word-
  boundary matched) or a `#<id>` deep-link, and rendered only when you're near
  it.  All use real public-domain NASA models.
- The model entity's position/orientation are `CallbackProperty`s that
  propagate SGP4 at exact render time.  Don't switch them to imperative
  per-tick updates: Cesium's tracked-camera update runs before clock-tick
  listeners, so stepped positions lag the camera by one frame — at 200 m
  range and 7.6 km/s the model visibly tears.  Orientation is +X along
  velocity, +Z zenith.
5. **Desktop wrap** — `npm create tauri-app`, point it at this Vite
   project; you get a native menu-bar app for ~10 MB.
6. **Ground stations & passes** — ships now (legend → **Ground station**):
   drop a station on the globe and a worker predicts every pass over the next
   24 h.  Worth extending: a pass detail card (rise/peak/set azimuths, magnitude),
   sun-lit vs eclipsed passes for naked-eye visibility, and multiple saved
   stations.

## Data sources

- Element sets and SATCAT: [CelesTrak](https://celestrak.org) (Dr. T.S.
  Kelso).  Please respect their bandwidth — keep the cache TTL ≥ 2 h.
- Spacecraft 3D models: courtesy NASA (solarsystem.nasa.gov 3D resources
  and github.com/nasa/NASA-3D-Resources).  Spacecraft without a published
  model get a generated class-generic, not a real design.
- Globe imagery: Esri World Imagery (© Esri — Maxar, Earthstar
  Geographics, and the GIS User Community), streamed from
  server.arcgisonline.com with attribution displayed in-app.
- Lunar imagery: NASA/USGS LRO WAC Global Mosaic (303 ppd, ~100 m/px),
  streamed keylessly from NASA's Solar System Treks (trek.nasa.gov).
  The Moon is a *second* Viewer on the `Ellipsoid.MOON` globe — and the
  ellipsoid must be passed to the Viewer (`ellipsoid: Ellipsoid.MOON`),
  not just its `Globe`: `scene.ellipsoid` is what the camera controller
  collides against, so a Moon globe with an Earth `scene.ellipsoid`
  renders the right sphere but fences the camera off 6,378 km out and
  you can never reach the surface.  Earth's WGS84 math is untouched
  because the two scenes hold their own ellipsoids.
- Planet & Sun surface maps: [Solar System Scope](https://www.solarsystemscope.com/textures/)
  equirectangular textures (CC BY 4.0), fetched into `public/textures/planets/`
  by `tools/fetch-textures.mjs`.
- Moon surface maps: 17 of the major moons (the Galileans, the round Saturnian
  and Uranian moons, Triton, plus our Moon) carry real equirectangular maps —
  our Moon from Solar System Scope (CC BY 4.0), the rest compiled by
  [Steve Albers](https://stevealbers.net/albers/sos/sos.html) and
  [Björn Jónsson](https://bjj.mmedia.is/) from public-domain Voyager / Galileo /
  Cassini / Clementine imagery.  `tools/fetch-moon-textures.mjs` downloads and
  downscales them (2k JPG) into `public/textures/moons/`.  **Note:** the Albers /
  Jónsson maps are licensed for *personal, non-commercial* use — fine for this
  project, but swap them for the underlying public-domain USGS/NASA mosaics if
  you take it commercial.  The Martian moons, Titan (permanent haze) and the
  small irregular moons have no useful global map and stay flat-tinted.  Planet
  positions are computed locally from
  JPL's low-precision Keplerian elements (no service, no key); see
  `src/ephemeris.js`.
- Planet surface globes: NASA Solar System Treks tile pyramids — Mars (Viking
  MDIM2.1 color) and Mercury (MESSENGER MDIS) — zoomable to the surface, the
  same source and tiling as the Moon; Venus and the gas giants use their local
  equirectangular map as a single-tile globe.  Mars also layers the global
  **CTX mosaic** (~5 m/px) — the [Bruce Murray Laboratory](https://murray-lab.caltech.edu/CTX/)
  beta01 mosaic (NASA/JPL/MSSS · Caltech), streamed keylessly from Esri's
  `astro.arcgis.com` on the same Mars_2000 geographic tiling.
- Asteroid belt: ~3,200 real largest main-belt asteroids (H < 12.5) with
  osculating elements from NASA/JPL's
  [Small-Body Database](https://ssd-api.jpl.nasa.gov/) (fetched by
  `tools/fetch-asteroids.mjs` → `public/asteroids.json`), plus procedural fill to
  ~14k for density.  Jupiter Trojans: ~2,700 real largest members (H < 13.5)
  from the same database (`tools/fetch-trojans.mjs` → `public/trojans.json`), all
  real — no fill.  Hilda group: ~1,150 asteroids selected by the 3:2-resonance
  orbital signature (a ≈ 3.97 AU, e < 0.3, H < 15) from the same database
  (`tools/fetch-hildas.mjs` → `public/hildas.json`).  Asteroid families: member
  proper elements (a, e, sin i) for 14
  families from NASA PDS's [Nesvorný HCM Asteroid Families V2.0](https://sbnarchive.psi.edu/pds4/non_mission/ast.nesvorny.families_V2_0/)
  (Nesvorný 2024, doi:10.26033/5hyq-6k90; public domain), brightest ~600 each via
  `tools/fetch-families.mjs` → `public/families.json`.  Saturn's ring map: Solar
  System Scope (CC BY 4.0).
- Night sky: NASA SVS [Deep Star Map 2020](https://svs.gsfc.nasa.gov/4851)
  (Tycho-2 + Gaia DR2, with the Milky Way and Magellanic Clouds), the 8k EXR
  tone-mapped to `public/textures/starmap.jpg`.  Real star positions and
  colours, wrapped on a celestial sphere tilted by the obliquity so it sits
  correctly against the planets' ecliptic plane.
- Authoritative upstream: US Space Force 18th SDS via space-track.org
  (free account; needed only if you outgrow CelesTrak).
