// sticky/opener.js
// Pop-out window plumbing (Sticky Float Phase 2): build the sticky route URL,
// build the window.open feature string from remembered geometry, and open (or
// focus) a sticky window.
//
// The window is opened with a STABLE name ('wren-sticky-<wrenId>') so that
// re-opening an already-open sticky focuses the existing window instead of
// spawning a duplicate. Untagged/legacy notes (no wrenId) fall back to keying
// the name by storage id.
//
// The URL/name/feature builders are pure (unit-testable); openSticky performs
// the side-effecting window.open + geometry lookup.
//
// Decision provenance: project-blueprints/wren/future-enhancements/sticky-float-sow.md (Phase 2)

import { loadGeometry } from './geometry.js';
import { isTauri } from '../platform.js';

const DEFAULT_W = 320;
const DEFAULT_H = 360;
const CASCADE_STEP = 28;

/**
 * Parse the sticky-route query string into { storageId, wrenId }, or null when
 * there is no `note` param (i.e. boot the normal full app). Pure.
 *
 * @param {string} search - location.search, e.g. "?note=a.md&wid=wren-123"
 */
export function parseStickyParams(search) {
  const params = new URLSearchParams(search || '');
  const storageId = params.get('note');
  if (!storageId) return null;
  return { storageId, wrenId: params.get('wid') || '' };
}

/**
 * Build the sticky-route URL for a note. Both ids are URL-encoded. `base`
 * defaults to the current document URL (its path is preserved; the query is
 * replaced). Pure when `base` is supplied. Returns an absolute URL string.
 *
 * @param {string} storageId
 * @param {string} wrenId
 * @param {string} [base] - absolute base URL (defaults to location.href)
 */
export function buildStickyUrl(storageId, wrenId, base) {
  const href = base || (typeof location !== 'undefined' ? location.href : 'http://localhost/');
  const url = new URL(href);
  url.search = '';
  url.searchParams.set('note', storageId);
  if (wrenId) url.searchParams.set('wid', wrenId);
  return url.toString();
}

/**
 * The stable window target name used to dedupe pop-outs. Keyed by wrenId when
 * present, else by storage id. Pure.
 */
export function stickyWindowName(wrenId, storageId) {
  return `wren-sticky-${wrenId || storageId || ''}`;
}

/**
 * The Tauri WebviewWindow label used to dedupe native sticky windows. Keyed by
 * wrenId when present, else the storage id. Tauri v2 labels must match
 * /^[a-zA-Z0-9\-/:_]+$/, so any other character (spaces, dots, '@' in a legacy
 * filename id) is replaced with '_'. Pure.
 */
export function stickyWindowLabel(wrenId, storageId) {
  const raw = String(wrenId || storageId || '');
  const safe = raw.replace(/[^a-zA-Z0-9\-_]/g, '_');
  return `sticky-${safe}`;
}

/**
 * Build a window.open feature string from explicit geometry. `popup=yes` asks
 * the browser for a chromeless-ish window. Pure.
 *
 * @param {{x:number,y:number,w:number,h:number}} geom
 */
export function buildStickyFeatures({ x, y, w, h }) {
  return [
    'popup=yes',
    `width=${Math.round(w)}`,
    `height=${Math.round(h)}`,
    `left=${Math.round(x)}`,
    `top=${Math.round(y)}`,
  ].join(',');
}

/**
 * Resolve the geometry to open a sticky at: remembered geometry if present,
 * else a default-sized window cascade-offset from the opener window. Reads
 * window globals, so not pure — exposed mainly for openSticky's use.
 *
 * @param {string} wrenId
 * @param {string} storageId
 * @param {number} cascadeIndex - 0-based; offsets defaults so a batch of
 *   restores/opens don't stack exactly on top of each other
 */
export function resolveStickyGeometry(wrenId, storageId, cascadeIndex = 0) {
  const remembered = loadGeometry(wrenId, storageId);
  if (remembered) return remembered;
  const offset = CASCADE_STEP * (cascadeIndex + 1);
  const baseX = (typeof window !== 'undefined' ? window.screenX || 0 : 0) + offset;
  const baseY = (typeof window !== 'undefined' ? window.screenY || 0 : 0) + offset;
  return { x: baseX, y: baseY, w: DEFAULT_W, h: DEFAULT_H };
}

/**
 * Open (or focus) a sticky window for a note.
 *
 * Returns the opened Window, the focused existing Window, or null when the
 * browser blocked the popup. The caller shows the popup-blocked toast on null.
 *
 * @param {{id: string, wrenId?: string}} note
 * @param {{ cascadeIndex?: number }} [opts]
 * @returns {Window|null}
 */
export function openSticky(note, { cascadeIndex = 0 } = {}) {
  const storageId = note.id;
  const wrenId = note.wrenId || '';

  // Tauri desktop (Phase 3b): open the same sticky route in a native,
  // always-on-top WebviewWindow instead of a browser popup. Returns a truthy
  // sentinel synchronously so the caller's popup-blocked-toast logic treats it
  // as opened (the async creation/focus happens in openStickyTauri).
  if (isTauri()) {
    openStickyTauri(note, { cascadeIndex });
    return { tauri: true };
  }

  const url = buildStickyUrl(storageId, wrenId);
  const name = stickyWindowName(wrenId, storageId);
  const geom = resolveStickyGeometry(wrenId, storageId, cascadeIndex);
  const features = buildStickyFeatures(geom);

  const win = window.open(url, name, features);
  if (win) {
    try {
      win.focus();
    } catch {
      /* focus can throw if the window is cross-process mid-open; harmless */
    }
  }
  return win || null;
}

/**
 * Tauri-only sticky opener: create (or focus) an always-on-top WebviewWindow
 * loading the same sticky route + shell. Label-based dedupe mirrors the Phase 2
 * named-window behaviour. Async and fire-and-forget from openSticky; errors are
 * logged, never thrown.
 *
 * @param {{id: string, wrenId?: string, title?: string}} note
 * @param {{ cascadeIndex?: number }} [opts]
 */
export async function openStickyTauri(note, { cascadeIndex = 0 } = {}) {
  const storageId = note.id;
  const wrenId = note.wrenId || '';
  const label = stickyWindowLabel(wrenId, storageId);
  const url = buildStickyUrl(storageId, wrenId);
  const geom = resolveStickyGeometry(wrenId, storageId, cascadeIndex);
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    // Dedupe: focus an already-open sticky for this note rather than duplicate.
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.setFocus();
      return existing;
    }
    const win = new WebviewWindow(label, {
      url,
      title: note.title || 'Wren note',
      alwaysOnTop: true,
      // No native title bar: the OS bar would show the default window icon and
      // the title text. The sticky shell draws its own slim bar (Wren logo +
      // close, no text — see src/sticky/titlebar.js). The OS/taskbar title is
      // still set (here, and live on rename via getCurrentWindow().setTitle).
      decorations: false,
      // Disable Tauri's native OS drag-drop interception so in-app HTML5
      // drag-and-drop (e.g. Kanban card moves) works inside the sticky webview.
      dragDropEnabled: false,
      width: Math.round(geom.w),
      height: Math.round(geom.h),
      x: Math.round(geom.x),
      y: Math.round(geom.y),
    });
    win.once('tauri://error', (e) => console.warn('Sticky window error', label, e?.payload ?? e));
    return win;
  } catch (err) {
    console.warn('openStickyTauri failed', err);
    return null;
  }
}
