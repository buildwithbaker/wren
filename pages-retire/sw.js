// sw.js - KILL-SWITCH service worker for the retired GitHub Pages copy of Wren
// (https://buildwithbaker.github.io/wren/). Wren now lives at
// https://wren.buildwithbaker.io/.
//
// Installs of the old github.io build have a service worker registered at
// /wren/. The browser's update check requests /wren/sw.js and gets THIS file,
// which replaces the old worker, removes Wren's caches, unregisters itself and
// reloads any open Wren tabs so they come back with no worker at all.
//
// Deliberately NO request-intercepting handler: every request goes straight
// to the network.
//
// Cache Storage is per ORIGIN, and buildwithbaker.github.io hosts other apps.
// Only ever delete caches named 'wren-shell-*' - never another app's caches.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('wren-shell-')).map((k) => caches.delete(k)));
      await self.registration.unregister();
      const windows = await self.clients.matchAll({ type: 'window' });
      // navigate() rejects for a client this worker does not control; a tab
      // like that is already worker-free, so there is nothing to reload.
      await Promise.all(windows.map((client) => client.navigate(client.url).catch(() => {})));
    })()
  );
});
