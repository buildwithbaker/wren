// main.js - PWA entry point.
import '@/styles/style.css';
import { createApp } from './app-controller.js';

createApp({
  root: document.getElementById('app'),
  enableServiceWorker: import.meta.env.PROD,
});
