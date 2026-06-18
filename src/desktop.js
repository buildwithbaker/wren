// desktop.js
// Tauri desktop integration for quick-capture: global hotkeys, the tray's
// "New note" event bridge, and the launch-at-login toggle. EVERY export is a
// safe no-op in the browser PWA / MV3 extension — nothing here ever runs (or
// throws) outside Tauri, so there are no dead controls in the web build. The
// Tauri-only plugin modules are dynamically imported INSIDE isTauri() guards so
// the browser bundle never even loads them.
//
// Division of labor with the Rust side (src-tauri/src/lib.rs): the tray icon +
// menu, hide-to-tray, and plugin initialization live in Rust; the actual hotkey
// combos are registered HERE so they can be rebound and fail soft without a
// recompile.

import { isTauri } from './platform.js';
import { isDueOrOverdue, todayStr } from './due.js';

// Tray "New note" emits this; we listen and run the same handleNew() the in-app
// button does. Must match EVENT_NEW_NOTE in src-tauri/src/lib.rs.
const EVENT_NEW_NOTE = 'wren://new-note';

// Accelerator strings in Tauri's format. CmdOrCtrl → Ctrl on Windows/Linux,
// Cmd on macOS. Chosen to avoid the common OS/browser combos.
export const DEFAULT_HOTKEYS = Object.freeze({
  newNote: 'CmdOrCtrl+Alt+N',
  toggle: 'CmdOrCtrl+Alt+W',
});

const HOTKEY_KEYS = {
  newNote: 'wren.hotkey.newNote',
  toggle: 'wren.hotkey.toggle',
};
const AUTOSTART_FALLBACK_KEY = 'wren.autostart'; // mirror, for UI optimism only

/** Human-readable accelerator, e.g. "CmdOrCtrl+Alt+N" → "Ctrl+Alt+N". */
export function humanizeHotkey(accel) {
  if (!accel) return '';
  return accel
    .replace(/CmdOrCtrl|CommandOrControl/gi, 'Ctrl')
    .replace(/\bCommand\b|\bCmd\b/gi, 'Cmd')
    .replace(/\bControl\b/gi, 'Ctrl')
    .replace(/\+/g, '+');
}

/** Read the stored accelerator for a slot, falling back to the default. */
export function getHotkey(which) {
  try {
    return localStorage.getItem(HOTKEY_KEYS[which]) || DEFAULT_HOTKEYS[which];
  } catch {
    return DEFAULT_HOTKEYS[which];
  }
}

function storeHotkey(which, accel) {
  try {
    localStorage.setItem(HOTKEY_KEYS[which], accel);
  } catch {
    /* ignore */
  }
}

// Bring the main window forward (it may be hidden in the tray or minimized).
async function showSelf() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.setFocus();
  } catch (err) {
    console.warn('showSelf failed', err);
  }
}

// Toggle the current window's visibility (the global show/hide hotkey). The
// tray's "Show / hide all" covers every window natively; the hotkey toggles the
// main window, which is the common case.
async function toggleSelf() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    if (await w.isVisible()) {
      await w.hide();
    } else {
      await w.show();
      await w.unminimize();
      await w.setFocus();
    }
  } catch (err) {
    console.warn('toggleSelf failed', err);
  }
}

/**
 * Wire up all desktop quick-capture integration. Returns a control object the
 * settings UI uses. In the browser this returns a disabled stub immediately —
 * the caller renders no desktop controls when `enabled` is false.
 *
 * @param {{ onNewNote: () => void }} deps
 * @returns {Promise<{
 *   enabled: boolean,
 *   warnings: string[],
 *   getHotkey?: (which: string) => string,
 *   rebindHotkey?: (which: string, accel: string) => Promise<boolean>,
 *   isAutostartEnabled?: () => Promise<boolean>,
 *   setAutostart?: (on: boolean) => Promise<boolean>,
 * }>}
 */
export async function setupDesktopIntegration({ onNewNote }) {
  if (!isTauri()) {
    return { enabled: false, warnings: [] };
  }

  const warnings = [];

  // The tray "New note" item shows the window (Rust side) then emits this; run
  // the same new-note handler the in-app + button does.
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen(EVENT_NEW_NOTE, () => onNewNote?.());
  } catch (err) {
    console.warn('tray new-note listener failed', err);
  }

  // Register the two global hotkeys. Each registration is independent and fails
  // SOFT — a combo already owned by another app logs a warning (surfaced in the
  // settings panel) and never crashes the app.
  await registerHotkey('newNote', getHotkey('newNote'), async () => {
    await showSelf();
    onNewNote?.();
  }, warnings);
  await registerHotkey('toggle', getHotkey('toggle'), () => toggleSelf(), warnings);

  return {
    enabled: true,
    warnings,
    getHotkey,
    async rebindHotkey(which, accel) {
      const handler =
        which === 'newNote'
          ? async () => {
              await showSelf();
              onNewNote?.();
            }
          : () => toggleSelf();
      const prev = getHotkey(which);
      // Unregister the old combo first so it's freed even if the new one fails.
      await unregisterHotkey(prev);
      const localWarnings = [];
      const ok = await registerHotkey(which, accel, handler, localWarnings);
      if (ok) {
        storeHotkey(which, accel);
        return true;
      }
      // New combo rejected — restore the previous one so the user isn't left
      // with no shortcut at all.
      await registerHotkey(which, prev, handler, []);
      return false;
    },
    async isAutostartEnabled() {
      try {
        const { isEnabled } = await import('@tauri-apps/plugin-autostart');
        return await isEnabled();
      } catch (err) {
        console.warn('autostart isEnabled failed', err);
        try {
          return localStorage.getItem(AUTOSTART_FALLBACK_KEY) === 'true';
        } catch {
          return false;
        }
      }
    },
    async setAutostart(on) {
      try {
        const mod = await import('@tauri-apps/plugin-autostart');
        if (on) await mod.enable();
        else await mod.disable();
        try {
          localStorage.setItem(AUTOSTART_FALLBACK_KEY, on ? 'true' : 'false');
        } catch {
          /* ignore */
        }
        return true;
      } catch (err) {
        console.warn('setAutostart failed', err);
        return false;
      }
    },
  };
}

// Register a single global shortcut, returning true on success. Failures (combo
// owned by another app, plugin error) are non-fatal: logged + pushed to
// `warnings` for the settings UI, never thrown.
async function registerHotkey(which, accel, handler, warnings) {
  try {
    const gs = await import('@tauri-apps/plugin-global-shortcut');
    // Avoid a double-register error on a re-run / hot reload.
    try {
      if (await gs.isRegistered(accel)) await gs.unregister(accel);
    } catch {
      /* ignore — isRegistered/unregister are best-effort here */
    }
    await gs.register(accel, (event) => {
      // The handler fires on both key-down and key-up; act on press only.
      if (event && event.state && event.state !== 'Pressed') return;
      handler();
    });
    return true;
  } catch (err) {
    console.warn(`global shortcut "${accel}" (${which}) not registered`, err);
    warnings.push(
      `Couldn't register ${humanizeHotkey(accel)} — another app may already use it.`
    );
    return false;
  }
}

async function unregisterHotkey(accel) {
  try {
    const gs = await import('@tauri-apps/plugin-global-shortcut');
    if (await gs.isRegistered(accel)) await gs.unregister(accel);
  } catch (err) {
    console.warn('unregister failed', err);
  }
}

// Once-per-calendar-day guard so focus/launch don't nag repeatedly.
const DUE_NOTIFIED_KEY = 'wren.due.notifiedDate';

/**
 * Fire a desktop notification when notes are due today / overdue (Note
 * Lifecycle A3, EXE-only). No-op in the browser PWA — the cards already carry
 * the visual treatment, and no notification API is touched. At most one
 * notification per calendar day; permission denial degrades silently.
 *
 * @param {Array<{due?: string, title?: string}>} notes - the live (top-level) notes
 */
export async function maybeNotifyDueNotes(notes) {
  if (!isTauri()) return; // PWA: visual-only, never call the notification API
  try {
    const due = (notes || []).filter((n) => isDueOrOverdue(n?.due));
    if (due.length === 0) return;

    const today = todayStr();
    let last = '';
    try {
      last = localStorage.getItem(DUE_NOTIFIED_KEY) || '';
    } catch {
      /* ignore */
    }
    if (last === today) return; // already nudged today

    const mod = await import('@tauri-apps/plugin-notification');
    let granted = await mod.isPermissionGranted();
    if (!granted) {
      const perm = await mod.requestPermission();
      granted = perm === 'granted';
    }
    if (!granted) return; // denial → degrade silently

    try {
      localStorage.setItem(DUE_NOTIFIED_KEY, today);
    } catch {
      /* ignore */
    }
    const count = due.length;
    const first = due[0];
    const heading = count === 1 ? '1 note due' : `${count} notes due`;
    const body =
      count === 1
        ? first.title || 'Untitled'
        : `Including "${first.title || 'Untitled'}"`;
    mod.sendNotification({ title: `Wren — ${heading}`, body });
  } catch (err) {
    console.warn('due notification failed', err);
  }
}
