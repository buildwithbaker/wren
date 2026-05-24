// popup.js - Chrome extension popup entry point.
// Single-panel UI: the <=640px layout in style.css applies at the 400px popup
// width, so the shared controller's two-panel app collapses automatically.
import '@/styles/style.css';
import './popup.css';
import { createApp } from '@/app-controller.js';

createApp({
  root: document.getElementById('app'),
  enableServiceWorker: false, // the extension has its own MV3 service worker
});
