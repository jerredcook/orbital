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

## Architecture

```
index.html                  UI shell (top bar, legend, info panel, time bar)
src/style.css               dark telemetry theme
src/main.js                 Cesium scene, picking, selection, UI wiring
src/swarm.js                custom GPU point-cloud primitive (one draw call)
src/data.js                 CelesTrak fetch + TLE/SATCAT parsing + caching
src/decode.js               SATCAT owner & launch-site code expansion
src/propagator.worker.js    SGP4 for the full catalog, off the main thread
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

## Roadmap (good Claude Code sessions)

1. **More debris** — the full SATCAT DEB population via space-track.org
   GP data (~25k more objects).  The swarm renderer won't blink; the
   SGP4 worker may want batching by then.
2. **3D models on zoom** — load a glTF of the ISS (NASA publishes one)
   and a generic bus-with-panels model; swap point → model when camera
   distance < ~100 km from the selected object.
3. **Auto-refresh** — re-fetch element sets on the cache TTL and diff the
   catalog: new NORAD IDs = launches, dropped IDs = decays.  Toast the
   changes ("3 objects added since yesterday").
4. **Conjunction view** — highlight pairs within N km (the fun one).
5. **Desktop wrap** — `npm create tauri-app`, point it at this Vite
   project; you get a native menu-bar app for ~10 MB.
6. **Ground stations & passes** — satvis (github.com/Flowm/satvis) has a
   good reference implementation for pass prediction.

## Data sources

- Element sets and SATCAT: [CelesTrak](https://celestrak.org) (Dr. T.S.
  Kelso).  Please respect their bandwidth — keep the cache TTL ≥ 2 h.
- Authoritative upstream: US Space Force 18th SDS via space-track.org
  (free account; needed only if you outgrow CelesTrak).
