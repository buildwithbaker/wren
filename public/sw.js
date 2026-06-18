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

// Bump on every release that adds/changes routable pages so the activate
// handler purges stale per-URL entries (e.g. an app-shell that was cached under
// /guide.html before that page existed). v2: site nav + /guide page.
const CACHE = 'wren-shell-v2';
const APP_SHELL = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
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
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.status === 200 && fresh.type === 'basic') {
            cache.put(request, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await cache.match(request);
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
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            cache.put(request, response.clone());
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
