// pin-button.js
// Shared factory for the always-on-top ("pin") toggle button. Used by both the
// Compact view top bar and the Expanded view sidebar header, so the two stay in
// sync via a single implementation. Desktop (Tauri) only — returns null in the
// browser PWA / extension so no button renders and no window API is called.

import { isTauri } from '../platform.js';
import { isPinned, setPinned } from '../tauri-window.js';

// Pushpin glyph (lucide "pin"). Filled when on, outline when off.
function pinSvg(on) {
  const fill = on ? 'currentColor' : 'none';
  return (
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    '<line x1="12" y1="17" x2="12" y2="22"/>' +
    '<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>' +
    '</svg>'
  );
}

/**
 * Create a pin toggle button wired to the window always-on-top state.
 * @returns {{ element: HTMLButtonElement, sync: () => void } | null}
 *   null when not running under Tauri (button must not render in the PWA).
 */
export function createPinButton() {
  if (!isTauri()) return null;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sc-compact-pin';
  btn.title = 'Keep window on top';
  btn.setAttribute('aria-label', 'Keep window on top');

  const render = (on) => {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.innerHTML = pinSvg(on);
  };
  render(isPinned());

  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-pressed') !== 'true';
    render(next);
    setPinned(next);
  });

  // sync() re-reads the persisted flag so a button that wasn't visible when the
  // pin was toggled (the other view's button) reflects the current state when
  // its view becomes active again.
  return { element: btn, sync: () => render(isPinned()) };
}
