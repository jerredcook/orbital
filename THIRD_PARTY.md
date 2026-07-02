# Third-party data, imagery & models

Orbital's code is MIT (see LICENSE); the assets and live data it uses are not.
Everything below keeps its own terms — check them before reusing any bundled
file outside this project, and note that **the Albers / Jónsson maps are
personal, non-commercial use only**.

## Bundled in the repo

| Asset | Source | Terms |
|---|---|---|
| Planet & Sun surface maps (`public/textures/planets/`, except below) | [Solar System Scope](https://www.solarsystemscope.com/textures/) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (resized) |
| Pluto, Ceres maps (`public/textures/planets/`), most moon maps (`public/textures/moons/`) | [Steve Albers' planetary maps](https://stevealbers.net/albers/sos/sos.html), compiled from public-domain NASA / JPL / USGS spacecraft imagery (Voyager, Galileo, Cassini, New Horizons, Dawn) | personal, **non-commercial** use |
| Callisto map | [Björn Jónsson](https://bjj.mmedia.is/) | personal, **non-commercial** use |
| Our Moon's map | Solar System Scope | CC BY 4.0 |
| Star map (`public/textures/starmap.jpg`) | [NASA SVS Deep Star Map 2020](https://svs.gsfc.nasa.gov/4851) (Tycho / Gaia DR2 data, ESA) | NASA media guidelines (public domain w/ attribution) |
| Spacecraft 3D models (`public/models/`) | [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources) and [science.nasa.gov](https://science.nasa.gov/3d-resources/) | public domain / NASA media guidelines (recompressed: Draco + WebP) |
| Fallback element set (`public/fallback/active.tle`) | [CelesTrak](https://celestrak.org/) | CelesTrak data, credit Dr. T.S. Kelso |
| Asteroid / Trojan / Hilda / family orbits (`public/*.json`) | JPL Small-Body Database / Horizons | public domain, credit NASA/JPL |

## Streamed at runtime

| Service | Used for | Terms |
|---|---|---|
| [CelesTrak](https://celestrak.org/) | live TLEs + SATCAT | be polite (rate limits); credit CelesTrak |
| [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) | all fetched orbital elements (via `tools/fetch-*-elements.mjs`) | public domain, credit NASA/JPL |
| Esri World Imagery | Earth base imagery | Esri terms of use, attributed on-screen |
| [NASA Solar System Treks](https://trek.nasa.gov/) | Mars / Mercury / Ceres / Moon surface tile pyramids | NASA media guidelines, attributed on-screen |
| Caltech Murray Lab / Esri | Mars CTX high-res mosaic | attributed on-screen |
| Cesium ion | Earth terrain/credit widget default | attributed on-screen |

## Libraries

| Library | License |
|---|---|
| [CesiumJS](https://cesium.com/platform/cesiumjs/) | Apache-2.0 |
| [satellite.js](https://github.com/shashwatak/satellite-js) | MIT |
| [Vite](https://vitejs.dev/) (build) | MIT |
| [Vitest](https://vitest.dev/) (tests) | MIT |
