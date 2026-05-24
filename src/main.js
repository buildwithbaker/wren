// main.js - PWA entry point.
import '../style.css';
import { createApp } from './app-controller.js';

createApp({
  root: document.getElementById('app'),
  enableServiceWorker: import.meta.env.PROD,
});
