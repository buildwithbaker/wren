import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The shipped desktop version, sourced from tauri.conf.json (the value baked
// into the built app and matched by the vX.Y.Z release tags). Exposed to the
// app as __APP_VERSION__ for the "Check for updates" comparison. Keep
// tauri.conf.json / package.json / manifest.json aligned on release.
const APP_VERSION = JSON.parse(
  readFileSync(resolve(__dirname, 'src-tauri/tauri.conf.json'), 'utf8')
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
  plugins: [coopHeadersPlugin()],
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
