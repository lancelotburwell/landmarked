import { defineConfig, type Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Served from the domain root (Vercel). The GitHub Pages workflow builds with BASE=/landmarked/.
const base = process.env.BASE ?? '/';
const cesium = 'node_modules/cesium/Build/Cesium';

// Stamps a build id into dist/sw.js so each deploy gets a fresh cache.
function stampServiceWorker(): Plugin {
  return {
    name: 'stamp-sw',
    apply: 'build',
    closeBundle() {
      const file = resolve(__dirname, 'dist/sw.js');
      if (!existsSync(file)) return;
      const id = Date.now().toString(36);
      writeFileSync(file, readFileSync(file, 'utf8').replace('__BUILD_ID__', id));
    },
  };
}

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    assetsInlineLimit: 0,
  },
  plugins: [
    // Only the static folders CesiumWidget needs at runtime.
    viteStaticCopy({
      targets: ['Workers', 'ThirdParty', 'Assets', 'Widgets'].map((d) => ({
        src: `${cesium}/${d}/**/*`,
        rename: { stripBase: 4 },
        dest: 'cesium',
      })),
    }),
    stampServiceWorker(),
  ],
});
