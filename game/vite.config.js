import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

// The game lives in game/, the mascot asset is built into ../dist/kubara.glb and
// imported with `?url` (src/main.js), so the dev server needs to read one level up.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  publicDir: false,
  server: {
    port: 5173,
    fs: { allow: [projectRoot] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0, // keep kubara.glb as its own file
    chunkSizeWarningLimit: 1200,
  },
});
