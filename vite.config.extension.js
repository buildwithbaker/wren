import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Match vite.config.js: define __APP_VERSION__ so the shared app bundle never
// carries a dangling global (the update check itself is desktop-only).
const APP_VERSION = JSON.parse(
  readFileSync(resolve(__dirname, 'src-tauri/tauri.conf.json'), 'utf8')
).version;

// Chrome Extension (MV3) build. Bundles Tiptap locally into the popup so no
// remote/CDN code is loaded (MV3 CSP forbids it). Module-preload polyfill is
// disabled so no inline <script> is injected (also forbidden by MV3 CSP).
export default defineConfig({
  root: resolve(__dirname, 'extension'),
  base: './',
  publicDir: resolve(__dirname, 'extension/public'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    outDir: resolve(__dirname, 'dist-extension'),
    emptyOutDir: true,
    target: 'es2020',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: resolve(__dirname, 'extension/popup.html'),
      output: {
        // Stable, predictable filenames inside the unpacked extension.
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
