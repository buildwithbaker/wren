import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The shipped version, single-sourced from package.json (scripts/sync-version.mjs
// keeps tauri.conf.json / Cargo.toml / the extension manifest aligned and fails
// the build on drift). Exposed to the app as __APP_VERSION__ for the "Check for
// updates" comparison and stamped into the service-worker cache name.
const APP_VERSION = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf8')
).version;

// Inject Cross-Origin-Opener-Policy on dev-server responses so the GIS OAuth
// popup can post back to the opener without being blocked by the default
// COOP. Production hosting (GitHub Pages) cannot set headers per-request;
// the popup-blocker backstop in src/oauth/gisClient.js compensates there.
// Decision provenance: KB Module 05, P1.7.
function coopHeadersPlugin() {
  return {
    name: 'wren-coop-headers',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
        next();
      });
    },
  };
}

// public/sw.js is copied verbatim by Vite, so its cache name can't use the
// __APP_VERSION__ define (that only rewrites bundled JS). Instead the source
// carries a __SW_VERSION__ placeholder that this plugin rewrites in the emitted
// dist/sw.js after the bundle is written — tying the SW cache name to the build
// version so every release purges the previous install's cache automatically.
function stampServiceWorkerVersion(version) {
  return {
    name: 'wren-sw-version',
    apply: 'build',
    closeBundle() {
      const swPath = resolve(__dirname, 'dist/sw.js');
      let src;
      try {
        src = readFileSync(swPath, 'utf8');
      } catch {
        return; // no sw.js emitted — nothing to stamp
      }
      if (!src.includes('__SW_VERSION__')) return;
      writeFileSync(swPath, src.replaceAll('__SW_VERSION__', version));
    },
  };
}

// PWA build. Outputs the deployable app shell to dist/.
export default defineConfig({
  root: __dirname,
  base: './',
  publicDir: resolve(__dirname, 'public'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [coopHeadersPlugin(), stampServiceWorkerVersion(APP_VERSION)],
  // When running inside `tauri dev`, Vite watches the project root. Without this
  // ignore it tries to watch src-tauri/target/*.dll while cargo is writing them
  // and crashes with EBUSY on Windows. Harmless for plain `npm run dev`.
  server: {
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
});
