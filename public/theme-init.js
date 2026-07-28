// Pre-paint theme bootstrap. Reads the saved theme and sets data-theme on the
// document element before first paint to avoid a light/dark flash on load.
//
// Kept as a self-hosted external file (not an inline <script>) so the strict CSP
// script-src 'self' allows it without an inline hash. An inline snippet here was
// refused by the CSP on every load (script-src-elem), so the pre-paint never ran
// in production — this file fixes that. It is copied to the published root by
// Vite (public/ is copied verbatim) and cached by the service worker.
(function () {
  try {
    var t = localStorage.getItem('wren.theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch {
    /* theme is a nicety; ignore storage/DOM errors and paint the default */
  }
})();
