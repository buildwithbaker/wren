// Native window sizing for the Tauri desktop shell (T2).
//
// The EXE opens small (Compact landing) and grows to the full app when the user
// expands, shrinking back on return to Compact. Each function no-ops unless
// running inside Tauri (see isTauri), so the browser PWA and the MV3 extension
// never touch a window-size API — they import this module but every call
// returns early.
//
// Per-view remembered size: the user's manual resize is persisted PER VIEW
// (compact vs expanded) in localStorage, so dragging the Compact window to a
// new size doesn't fight the Expanded size and vice-versa. A view with no
// remembered size falls back to its preset.

import { isTauri } from './platform.js';

// Landing/preset sizes (logical px). Compact is the small launch size; expanded
// is the full two-panel app.
export const WINDOW_PRESETS = {
  compact: { w: 380, h: 780 },
  expanded: { w: 1200, h: 820 },
};

// localStorage slots (namespaced wren.* like the rest of the app).
export const WINDOW_LS_KEYS = {
  compact: 'wren.win.compact',
  expanded: 'wren.win.expanded',
};

// localStorage key for the whole-window always-on-top ("pin") flag.
export const WINDOW_PINNED_KEY = 'wren.win.pinned';

// Minimum width to restore an EXPANDED window at. A remembered width below this
// (the user dragged the full app very narrow once) would reopen with the
// two-panel UI — view switcher, sidebar — unusably cramped or clipped, trapping
// them (audit U1/U2). Compact keeps its own small preset and is exempt.
export const MIN_EXPANDED_WIDTH = 700;

// Map any view identifier ('list' | 'kanban' | 'compact') to a window slot.
// Only Compact is small; every full mode shares the expanded slot.
export function slotForView(view) {
  return view === 'compact' ? 'compact' : 'expanded';
}

// True when a value looks like a usable {w,h} size.
function isValidSize(size) {
  return (
    !!size &&
    Number.isFinite(size.w) &&
    Number.isFinite(size.h) &&
    size.w > 0 &&
    size.h > 0
  );
}

/**
 * Pure size resolution: the remembered size when valid, otherwise the slot's
 * preset. Exported for unit testing without touching localStorage or Tauri.
 * @param {'compact'|'expanded'} slot
 * @param {{w:number,h:number}|null|undefined} remembered
 * @returns {{w:number,h:number}}
 */
export function resolveWindowSize(slot, remembered) {
  if (isValidSize(remembered)) {
    const w = Math.round(remembered.w);
    const h = Math.round(remembered.h);
    // Clamp the expanded slot up to MIN_EXPANDED_WIDTH so a too-narrow remembered
    // size can't reopen the full app in an unusable width.
    return { w: slot === 'expanded' ? Math.max(w, MIN_EXPANDED_WIDTH) : w, h };
  }
  const preset = WINDOW_PRESETS[slot] || WINDOW_PRESETS.expanded;
  return { ...preset };
}

// Read the remembered {w,h} for a slot from localStorage. Defensive: any
// parse/shape failure returns null (→ caller falls back to the preset).
export function readRememberedSize(slot) {
  try {
    const raw = localStorage.getItem(WINDOW_LS_KEYS[slot]);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidSize(parsed) ? { w: parsed.w, h: parsed.h } : null;
  } catch {
    return null;
  }
}

// Persist the remembered {w,h} for a slot. Best-effort; never throws.
export function writeRememberedSize(slot, size) {
  if (!isValidSize(size)) return;
  try {
    localStorage.setItem(
      WINDOW_LS_KEYS[slot],
      JSON.stringify({ w: Math.round(size.w), h: Math.round(size.h) })
    );
  } catch {
    /* ignore */
  }
}

/**
 * Resize the native window to the given view's slot, using the remembered size
 * if present else the preset. No-op outside Tauri.
 * @param {'compact'|'expanded'|'list'|'kanban'} view
 */
export async function applyWindowSize(view) {
  if (!isTauri()) return;
  const slot = slotForView(view);
  const { w, h } = resolveWindowSize(slot, readRememberedSize(slot));
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const { LogicalSize } = await import('@tauri-apps/api/dpi');
    await getCurrentWindow().setSize(new LogicalSize(w, h));
  } catch (err) {
    console.warn('applyWindowSize failed', err);
  }
}

let resizeUnlisten = null;

/**
 * Subscribe once to the native resize event and persist the user's manual size
 * into the active view's slot (debounced). This is what makes manual resizes
 * stick PER VIEW. No-op outside Tauri; safe to call more than once (dedupes).
 * @param {() => string} getView returns the live view ('list'|'kanban'|'compact')
 * @param {number} debounceMs
 * @returns {Promise<() => void>} an unlisten function
 */
export async function watchResize(getView, debounceMs = 400) {
  if (!isTauri()) return () => {};
  if (resizeUnlisten) return resizeUnlisten;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    let timer = null;
    const unlisten = await win.onResized(({ payload }) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          // payload is a PhysicalSize; convert to logical px so it round-trips
          // with applyWindowSize's LogicalSize.
          const factor = await win.scaleFactor();
          const size = {
            w: Math.round(payload.width / factor),
            h: Math.round(payload.height / factor),
          };
          writeRememberedSize(slotForView(getView()), size);
        } catch (err) {
          console.warn('persist resize failed', err);
        }
      }, debounceMs);
    });
    resizeUnlisten = unlisten;
    return unlisten;
  } catch (err) {
    console.warn('watchResize failed', err);
    return () => {};
  }
}

/* ---- Always-on-top ("pin") ------------------------------------------- */

/**
 * Whether the window is pinned (always-on-top) per the persisted flag.
 * Defaults to false. Pure read of localStorage — safe outside Tauri.
 * @returns {boolean}
 */
export function isPinned() {
  try {
    return localStorage.getItem(WINDOW_PINNED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Set the whole-window always-on-top state and persist it. Persists the flag
 * even outside Tauri (harmless), but only calls the native API when isTauri().
 * @param {boolean} on
 */
export async function setPinned(on) {
  const next = !!on;
  try {
    localStorage.setItem(WINDOW_PINNED_KEY, next ? 'true' : 'false');
  } catch {
    /* ignore */
  }
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setAlwaysOnTop(next);
  } catch (err) {
    console.warn('setPinned failed', err);
  }
}

/**
 * On launch, reconcile the native window's always-on-top state with the stored
 * flag. No-op outside Tauri.
 */
export async function applyPinnedAtBoot() {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setAlwaysOnTop(isPinned());
  } catch (err) {
    console.warn('applyPinnedAtBoot failed', err);
  }
}
