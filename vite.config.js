import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const cesiumSource = 'node_modules/cesium/Build/Cesium';
const cesiumBaseUrl = 'cesiumStatic';

// Served at the domain root in dev, but under /orbital/ on GitHub Pages (a
// project site lives at <user>.github.io/<repo>/).  `base` flows into
// import.meta.env.BASE_URL — which every runtime asset path is prefixed with —
// and into CESIUM_BASE_URL, so Cesium finds its copied Workers/Assets either way.
export default defineConfig(({ command }) => {
  const base = command === 'build' ? '/orbital/' : '/';
  return {
    base,
    define: {
      CESIUM_BASE_URL: JSON.stringify(`${base}${cesiumBaseUrl}`),
    },
    plugins: [
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
  };
});
