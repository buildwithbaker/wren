// main.js - PWA entry point.
import '@/styles/style.css';
import { createApp } from './app-controller.js';
import { parseStickyParams } from './sticky/opener.js';

const root = document.getElementById('app');

// Sticky Float Phase 2: a `?note=<storageId>&wid=<wrenId>` query boots the
// minimal pop-out sticky shell instead of the full two-panel app. The Chrome
// extension popup loads extension/popup.js (never this file), so the sticky
// route can't be reached there; the chrome.runtime guard is belt-and-braces.
const isExtension =
  typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;

if (!isExtension && parseStickyParams(location.search)) {
  import('./sticky-app.js').then(({ createStickyApp }) => createStickyApp({ root }));
} else {
  createApp({
    root,
    enableServiceWorker: import.meta.env.PROD,
  });
}
