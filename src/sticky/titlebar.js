// sticky/titlebar.js
// The slim custom title bar for a Tauri pop-out sticky window.
//
// The native OS title bar is removed (decorations:false in opener.js) so the
// window can show the Wren mark instead of the default window icon + title
// text. This bar therefore:
//   - shows the Wren logo ONLY (the same ./icon.svg mark used for the desktop
//     app icon in PR #45) — NO title text anywhere in the bar,
//   - is a Tauri drag region (data-tauri-drag-region) so the now-frameless
//     window can still be moved by dragging the bar,
//   - carries the close button that went away with the native decorations.
//
// The OS/taskbar title is set separately (not shown in the bar) — see
// sticky-app.js setDocTitle → getCurrentWindow().setTitle on rename.
//
// Browser PWA / extension stickies keep their native window chrome, so this bar
// is desktop-only: buildStickyTitleBar returns null unless running under Tauri
// (mirrors the Tauri-only pin button in src/ui/pin-button.js).
//
// Decision provenance: project-blueprints/wren/future-enhancements/sticky-float-sow.md (Phase 3b)

import { isTauri } from '../platform.js';

// Close glyph (lucide "x"). Inherits currentColor from the button.
function closeIconSvg() {
  return (
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  );
}

// Pushpin glyph (lucide "pin"). Filled when the window is pinned on top.
function pinIconSvg(on) {
  return (
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="${on ? 'currentColor' : 'none'}" ` +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="12" y1="17" x2="12" y2="22"/>' +
    '<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>' +
    '</svg>'
  );
}

// Set THIS window's always-on-top state (per-window; never touches the shared
// wren.win.pinned flag the main app uses). No-op / logged on failure.
async function setThisWindowOnTop(on) {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setAlwaysOnTop(!!on);
  } catch (err) {
    console.warn('Sticky pin toggle failed', err);
  }
}

/**
 * Build the slim sticky title bar: Wren logo (left) + drag region + close
 * button (right). Returns null outside Tauri so the browser PWA/extension keeps
 * its native window chrome and no close button is drawn.
 *
 * @param {{ onClose?: () => void }} [opts] - onClose fires when the close button
 *   is clicked (the caller closes the native window).
 * @returns {HTMLDivElement|null}
 */
export function buildStickyTitleBar({ onClose } = {}) {
  if (!isTauri()) return null;

  const bar = document.createElement('div');
  bar.className = 'sc-sticky-titlebar';
  // The whole bar is a Tauri drag region so the frameless window can be moved.
  bar.setAttribute('data-tauri-drag-region', '');

  // Left: the Wren mark only — no title text anywhere in the bar.
  const logo = document.createElement('img');
  logo.className = 'sc-sticky-logo';
  logo.src = './icon.svg';
  logo.alt = 'Wren';
  // Also a drag region so dragging from the logo moves the window too.
  logo.setAttribute('data-tauri-drag-region', '');

  // Right cluster: per-window pin (keep this note on top) + close.
  // A pop-out is created always-on-top, so the pin starts ON. Toggling flips
  // only THIS window — it does not persist to the shared main-window pin flag.
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'sc-sticky-pin';
  pin.title = 'Keep this note on top';
  pin.setAttribute('aria-label', 'Keep this note on top');
  pin.setAttribute('aria-pressed', 'true');
  pin.innerHTML = pinIconSvg(true);
  pin.addEventListener('click', () => {
    const next = pin.getAttribute('aria-pressed') !== 'true';
    pin.setAttribute('aria-pressed', next ? 'true' : 'false');
    pin.innerHTML = pinIconSvg(next);
    setThisWindowOnTop(next);
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sc-sticky-close';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close window');
  close.innerHTML = closeIconSvg();
  close.addEventListener('click', () => onClose && onClose());

  bar.append(logo, pin, close);
  return bar;
}
