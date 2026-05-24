import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
