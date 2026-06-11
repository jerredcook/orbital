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

No API keys or accounts are required.  The globe uses Cesium's bundled
offline Natural Earth II imagery.  If you later want photographic
satellite imagery, create a free Cesium Ion account and set
`Ion.defaultAccessToken` in `src/main.js`.

## Controls

| Action | Input |
|---|---|
| Rotate globe | left-drag |
| Zoom | scroll / pinch |
| Tilt | middle-drag or ctrl-drag |
| Select satellite | click a point |
| Search | `/` or click the search box (name or NORAD ID) |
| Deselect / close | `Esc` or click empty space |
| Time warp | − / + buttons, NOW to return to real time |
| Conjunctions | legend toggle — every pair now within 5/10/25 km; click a list row to fly there |
| Screening | select a satellite → "Screen close approaches" — its passes within 25 km over the next 24 h |
| See the spacecraft | select → Follow → scroll in; inside 150 km the dot becomes a 3D model |

## Architecture

```
index.html                  UI shell (top bar, legend, info panel, time bar)
src/style.css               dark telemetry theme
src/main.js                 Cesium scene, picking, selection, UI wiring
src/swarm.js                custom GPU point-cloud primitive (one draw call)
src/data.js                 CelesTrak fetch + TLE/SATCAT parsing + caching
src/decode.js               SATCAT owner & launch-site code expansion
src/propagator.worker.js    SGP4 for the full catalog, off the main thread
src/tca.worker.js           closest-approach search for conjunction pairs
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

## Roadmap (good Claude Code sessions)

1. **More debris** — the full SATCAT DEB population via space-track.org
   GP data (~25k more objects).  The swarm renderer won't blink; the
   SGP4 worker may want batching by then.
2. **More real models** — the mapping in `modelUriFor` is NORAD-ID and
   name-pattern based; NASA/ESA publish more spacecraft glTFs (Aqua,
   Terra, JWST…) that can drop straight into `public/models/`.
3. **Auto-refresh** — re-fetch element sets on the cache TTL and diff the
   catalog: new NORAD IDs = launches, dropped IDs = decays.  Toast the
   changes ("3 objects added since yesterday").
4. **All-vs-all screening** — per-target screening exists; the full
   SOCRATES-style catalog × catalog sweep is ~18k targets × the same
   pipeline.  Needs smarter sieving (orbit-path/MOID filter after the
   band filter) and probably batching across several workers.

Design notes for the 3D close-up view:

- **Selected satellite renders as a 3D model inside 150 km** (`Follow`,
  then scroll in).  ISS and Hubble use NASA's published glTFs; everything
  else gets a class-appropriate generic from `tools/make-models.mjs`
  (bus-with-wings, Starlink flat-panel, spent stage, debris shard) picked
  by NORAD ID / name pattern in `modelUriFor`.
- The model entity's position/orientation are `CallbackProperty`s that
  propagate SGP4 at exact render time.  Don't switch them to imperative
  per-tick updates: Cesium's tracked-camera update runs before clock-tick
  listeners, so stepped positions lag the camera by one frame — at 200 m
  range and 7.6 km/s the model visibly tears.  Orientation is +X along
  velocity, +Z zenith.
5. **Desktop wrap** — `npm create tauri-app`, point it at this Vite
   project; you get a native menu-bar app for ~10 MB.
6. **Ground stations & passes** — satvis (github.com/Flowm/satvis) has a
   good reference implementation for pass prediction.

## Data sources

- Element sets and SATCAT: [CelesTrak](https://celestrak.org) (Dr. T.S.
  Kelso).  Please respect their bandwidth — keep the cache TTL ≥ 2 h.
- ISS and Hubble 3D models: courtesy NASA (solarsystem.nasa.gov 3D
  resources).  Other spacecraft models are generated, not real designs.
- Authoritative upstream: US Space Force 18th SDS via space-track.org
  (free account; needed only if you outgrow CelesTrak).
