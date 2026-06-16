// sw.js - Wren PWA service worker.
// Caches the app shell so Wren loads offline. Notes themselves live on the
// user's disk via the File System Access API and never touch this cache.

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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

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
