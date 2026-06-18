// Runtime platform detection.
//
// Wren's `src/` is shared verbatim between the PWA, the MV3 extension, and (as
// of the Tauri shell) a native desktop window. `isTauri()` lets later code
// branch on whether it is running inside the Tauri WebView2 webview.
//
// T1 only DEFINES this probe — nothing branches on it yet. Tauri injects
// `window.__TAURI_INTERNALS__` into every webview it owns; in a plain browser
// (PWA) or the extension popup that global is absent.

/**
 * @returns {boolean} true when running inside a Tauri webview.
 */
export function isTauri() {
  return !!window.__TAURI_INTERNALS__;
}

/**
 * Open a URL in the user's default system browser.
 *
 * In the browser PWA/extension this is a normal new-tab `window.open`. Inside
 * the Tauri desktop app a plain link would navigate (or spawn) a webview, so we
 * route through the Tauri opener plugin to launch the system browser and leave
 * the app window untouched.
 *
 * @param {string} url
 */
export async function openExternal(url) {
  if (isTauri()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    } catch (err) {
      console.warn('openExternal (Tauri) failed', err);
    }
  }
  window.open(url, '_blank', 'noopener');
}
