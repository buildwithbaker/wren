import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
