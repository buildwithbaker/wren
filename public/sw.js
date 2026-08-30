// sw.js - Wren PWA service worker.
// Caches the app shell so Wren loads offline. Notes themselves live on the
// user's disk via the File System Access API and never touch this cache.
//
// Cache strategy:
//   - Install-critical, unhashed files (the HTML document and manifest.json)
//     use NETWORK-FIRST. These define the installed app's identity and icons,
//     so a stale copy makes Chrome/Edge install with the wrong (browser)
//     icon and launch in a tab instead of a standalone window. Network-first
//     means a returning visitor always installs from the current manifest.
//   - Everything else (Vite content-hashed assets, icons) uses
//     stale-while-revalidate for speed; hashed filenames make stale-serving
//     safe because the name changes whenever the content changes.
//
// Bump CACHE whenever the app shell, manifest, or icon set changes so the
// activate step purges the previous cache for every existing install.

// The cache name is derived from the build version, NOT hand-bumped: the build
// stamps __SW_VERSION__ with the package version (see stampServiceWorkerVersion
// in vite.config.js), so every release ships a fresh cache name and the activate
// handler purges the previous install's cache automatically. Left unstamped in
// dev, which is harmless because the SW is only registered in production builds.
const CACHE = 'wren-shell-__SW_VERSION__';
const APP_SHELL = ['./', './index.html', './manifest.json', './icon.svg', './theme-init.js'];

// Cap on stale-while-revalidate (runtime) entries kept per cache version, so a
// long-lived install doesn't accumulate unbounded hashed assets within v2.
const MAX_RUNTIME_ENTRIES = 60;
// App-shell entries are never pruned; only runtime/hashed assets are trimmed.
const PROTECTED = new Set(APP_SHELL.map((p) => new URL(p, self.location).href));

// True for hashed build assets (Vite emits them under /assets/). These are the
// URLs Cloudflare Pages' SPA fallback will answer with 200 text/html once the
// file is deleted on a new deploy — the exact response that must never be
// cached or served in place of the real JS/CSS.
function isAssetRequest(url) {
  return url.pathname.includes('/assets/') || /\.(?:js|mjs|css)$/.test(url.pathname);
}

// True if a response (fresh or cached) is an HTML document. Used to detect the
// SPA-fallback poisoning described above: an asset URL answered with HTML.
function isHtmlResponse(response) {
  const type = response && response.headers && response.headers.get('content-type');
  return !!type && type.includes('text/html');
}

// Cache key for a request. Navigations are keyed by path only so cache-busting
// query strings (e.g. ?_cb=...) can't spawn one cache entry per URL — every
// navigation to a given page collapses to a single, reusable entry.
function cacheKeyFor(request, url) {
  if (request.mode === 'navigate') {
    return new Request(url.origin + url.pathname, { headers: request.headers });
  }
  return request;
}

// Drop the oldest non-shell entries once the runtime set exceeds the cap.
// cache.keys() preserves insertion order, so the front of the list is oldest.
async function trimCache(cache, max) {
  const keys = await cache.keys();
  const prunable = keys.filter((req) => !PROTECTED.has(req.url));
  const overflow = prunable.length - max;
  for (let i = 0; i < overflow; i++) {
    await cache.delete(prunable[i]);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(APP_SHELL).catch((err) => {
          // Don't fail the install if a shell asset is briefly unavailable, but
          // never swallow it silently — a persistently failing precache is a
          // real deploy problem worth seeing in the console.
          console.error('[wren-sw] precache failed', err);
        })
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isInstallCritical(request, url) {
  return request.mode === 'navigate' || url.pathname.endsWith('/manifest.json');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network-first for the document and manifest so the installed app always
  // picks up the current icons and identity. Falls back to cache when offline.
  if (isInstallCritical(request, url)) {
    // Key navigations by path so ?_cb= and other query noise don't create a
    // fresh cache entry per request.
    const key = cacheKeyFor(request, url);
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.status === 200 && fresh.type === 'basic') {
            cache.put(key, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await cache.match(key);
          if (cached) return cached;
          if (request.mode === 'navigate') {
            return (await cache.match('./index.html')) || Response.error();
          }
          return Response.error();
        }
      })
    );
    return;
  }

  // Stale-while-revalidate: serve cache fast, refresh in the background.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      let cached = await cache.match(request);
      // A previous deploy can leave a poisoned entry: Cloudflare Pages' SPA
      // fallback answers a deleted /assets/*.js|css with 200 text/html, which
      // an earlier SW may have cached under the asset URL. Serving it blanks
      // the app (an HTML doc parsed as a module). Treat it as a miss and evict.
      if (cached && isAssetRequest(url) && isHtmlResponse(cached)) {
        await cache.delete(request);
        cached = null;
      }
      const network = fetch(request)
        .then((response) => {
          // Never cache an HTML-typed response for an asset URL — that is the
          // SPA-fallback poisoning above. Let it pass through (the module load
          // will fail loudly) but keep it out of the cache.
          const poisoned = isAssetRequest(url) && isHtmlResponse(response);
          if (response && response.status === 200 && response.type === 'basic' && !poisoned) {
            cache.put(request, response.clone()).then(() => trimCache(cache, MAX_RUNTIME_ENTRIES)).catch(() => {});
          }
          return response;
        })
        .catch(() => null);

      if (cached) return cached;

      const fresh = await network;
      if (fresh) return fresh;

      // Offline navigation fallback to the app shell.
      if (request.mode === 'navigate') {
        return (await cache.match('./index.html')) || Response.error();
      }
      return Response.error();
    })
  );
});
