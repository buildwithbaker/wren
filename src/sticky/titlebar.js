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

  // Right: close button (the native close went away with decorations:false).
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sc-sticky-close';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close window');
  close.innerHTML = closeIconSvg();
  close.addEventListener('click', () => onClose && onClose());

  bar.append(logo, close);
  return bar;
}
