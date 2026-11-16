import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Version + build id, baked into the bundle (src/version.js) and written to
// version.json beside it so a running copy can tell when a newer one is live.
// The build id is the commit: from CI's environment, else from git, else 'dev'.
const pkgVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
function buildId() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try { return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev'; }
  catch { return 'dev'; }
}

// satellite.js 7 re-exports a WebAssembly bulk-propagation API from its index
// (`export * from './wasm/index.js'`).  This app uses only the plain-JS SGP4
// functions, but that one line drags two Emscripten runtimes — about 250 kB, with
// top-level await and Node-only imports — into the main bundle and all three
// workers, and the build fails on the top-level await.  So that module is
// replaced with an empty one.  If a future version moves it, this stops
// matching and the build fails again, loudly, rather than shipping the lot.
const SATELLITE_INDEX = /node_modules\/satellite\.js\/dist\/index\.js$/;
const WASM_STUB = '\0orbital:no-satellite-wasm';
function noSatelliteWasm() {
  return {
    name: 'orbital-no-satellite-wasm',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './wasm/index.js' && importer && SATELLITE_INDEX.test(importer.replace(/\\/g, '/'))) return WASM_STUB;
      return null;
    },
    load(id) { return id === WASM_STUB ? 'export {};' : null; },
  };
}

const cesiumSource = 'node_modules/cesium/Build/Cesium';
const cesiumBaseUrl = 'cesiumStatic';

// Served at the domain root in dev, but under /orbital/ on GitHub Pages (a
// project site lives at <user>.github.io/<repo>/).  `base` flows into
// import.meta.env.BASE_URL — which every runtime asset path is prefixed with —
// and into CESIUM_BASE_URL, so Cesium finds its copied Workers/Assets either way.
export default defineConfig(({ command }) => {
  const base = command === 'build' ? '/orbital/' : '/';
  const build = command === 'build' ? buildId() : 'dev';
  return {
    base,
    define: {
      CESIUM_BASE_URL: JSON.stringify(`${base}${cesiumBaseUrl}`),
      __APP_VERSION__: JSON.stringify(pkgVersion),
      __APP_BUILD__: JSON.stringify(build),
    },
    plugins: [
      noSatelliteWasm(),
      {
        name: 'orbital-version-file',
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ version: pkgVersion, build })}\n` });
        },
      },
      viteStaticCopy({
        targets: [
          { src: `${cesiumSource}/ThirdParty`, dest: cesiumBaseUrl },
          { src: `${cesiumSource}/Workers`, dest: cesiumBaseUrl },
          { src: `${cesiumSource}/Assets`, dest: cesiumBaseUrl },
          { src: `${cesiumSource}/Widgets`, dest: cesiumBaseUrl },
        ],
      }),
    ],
    build: {
      chunkSizeWarningLimit: 6000,
    },
    // (plugins do not reach worker bundles unless listed here too)
    worker: { plugins: () => [noSatelliteWasm()] },
    // `npm run coverage`: which lines of src/ the unit tests execute.  It only
    // sees vitest — the two browser smoke suites exercise the UI modules
    // (main.js, solarsystem.js, …) that show as 0 % here.
    test: {
      coverage: { provider: 'v8', include: ['src/**/*.js'], reporter: ['text'], reportsDirectory: 'coverage' },
    },
  };
});
