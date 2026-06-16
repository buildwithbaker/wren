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
