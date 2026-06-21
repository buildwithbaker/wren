// desktop-panel.js
// The in-app "Keyboard shortcuts & desktop" help dialog. It documents the FULL
// shortcut set (in-app + global) on every platform, and — only inside the Tauri
// desktop app — adds the launch-at-startup toggle and rebindable global
// hotkeys. In the browser the desktop section is omitted entirely (no dead
// controls); the shortcut reference still shows, with the global ones labeled
// "desktop app only".

import { humanizeHotkey, getHotkey, DEFAULT_HOTKEYS } from '../desktop.js';

// The in-app shortcuts, documented here and mirrored on public/guide.html.
const IN_APP_SHORTCUTS = [
  ['Ctrl + 1', 'List view'],
  ['Ctrl + 2', 'Kanban view'],
  ['Ctrl + 3', 'Compact view'],
  ['Ctrl + B', 'Bold (in the editor)'],
  ['Ctrl + I', 'Italic (in the editor)'],
  ['Ctrl + U', 'Underline (in the editor)'],
];

function row(combo, label) {
  const tr = document.createElement('div');
  tr.className = 'sc-kbd-row';
  const k = document.createElement('kbd');
  k.className = 'sc-kbd';
  k.textContent = combo;
  const d = document.createElement('span');
  d.className = 'sc-kbd-desc';
  d.textContent = label;
  tr.append(k, d);
  return tr;
}

function sectionHeading(text) {
  const h = document.createElement('h3');
  h.className = 'sc-help-subhead';
  h.textContent = text;
  return h;
}

/**
 * Open the shortcuts + desktop help dialog.
 *
 * @param {{ desktop?: { enabled: boolean, warnings?: string[],
 *   getHotkey?: Function, rebindHotkey?: Function,
 *   isAutostartEnabled?: Function, setAutostart?: Function } | null }} [opts]
 */
export function openShortcutsDialog({ desktop = null } = {}) {
  const enabled = !!(desktop && desktop.enabled);
  // Remember what had focus so we can restore it on close (WCAG SC 2.4.3).
  const lastFocused = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'sc-overlay';

  const modal = document.createElement('div');
  modal.className = 'sc-modal sc-help-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Keyboard shortcuts and desktop settings');

  const title = document.createElement('h2');
  title.className = 'sc-modal-title';
  title.textContent = 'Keyboard shortcuts';
  modal.appendChild(title);

  // ---- In-app shortcuts (always) ------------------------------------------
  modal.appendChild(sectionHeading('In the app'));
  const inApp = document.createElement('div');
  inApp.className = 'sc-kbd-table';
  for (const [combo, label] of IN_APP_SHORTCUTS) inApp.appendChild(row(combo, label));
  modal.appendChild(inApp);

  // ---- Global shortcuts (always documented, desktop-only in effect) -------
  modal.appendChild(sectionHeading('Global — desktop app only'));
  const globalTable = document.createElement('div');
  globalTable.className = 'sc-kbd-table';
  const readHotkey = (which) =>
    enabled && desktop.getHotkey ? desktop.getHotkey(which) : getHotkey(which) || DEFAULT_HOTKEYS[which];
  globalTable.appendChild(row(humanizeHotkey(readHotkey('newNote')), 'New note from anywhere'));
  globalTable.appendChild(row(humanizeHotkey(readHotkey('toggle')), 'Show / hide Wren'));
  modal.appendChild(globalTable);
  if (!enabled) {
    const note = document.createElement('p');
    note.className = 'sc-help-note';
    note.textContent =
      'The global hotkeys, system tray, and launch-at-startup work in the Wren desktop app for Windows.';
    modal.appendChild(note);
  }

  // ---- Desktop controls (Tauri only) --------------------------------------
  if (enabled) {
    modal.appendChild(sectionHeading('Desktop'));

    // Launch at startup toggle.
    const startupRow = document.createElement('label');
    startupRow.className = 'sc-help-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = true; // enabled once we read the current state
    const cbText = document.createElement('span');
    cbText.textContent = 'Launch Wren at startup';
    startupRow.append(cb, cbText);
    modal.appendChild(startupRow);
    if (desktop.isAutostartEnabled) {
      desktop
        .isAutostartEnabled()
        .then((on) => {
          cb.checked = !!on;
          cb.disabled = false;
        })
        .catch(() => {
          cb.disabled = false;
        });
    }
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      const ok = desktop.setAutostart ? await desktop.setAutostart(cb.checked) : false;
      if (!ok) cb.checked = !cb.checked; // revert on failure
      cb.disabled = false;
    });

    // Rebindable global hotkeys.
    const rebindWrap = document.createElement('div');
    rebindWrap.className = 'sc-help-rebinds';
    rebindWrap.appendChild(buildRebind('newNote', 'New note', desktop));
    rebindWrap.appendChild(buildRebind('toggle', 'Show / hide', desktop));
    modal.appendChild(rebindWrap);

    // Soft-failure warnings (combo owned by another app).
    if (Array.isArray(desktop.warnings) && desktop.warnings.length) {
      const warn = document.createElement('p');
      warn.className = 'sc-help-warn';
      warn.textContent = desktop.warnings.join(' ');
      modal.appendChild(warn);
    }
  }

  // ---- Close --------------------------------------------------------------
  const actions = document.createElement('div');
  actions.className = 'sc-modal-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sc-btn sc-btn--primary';
  close.textContent = 'Done';
  actions.appendChild(close);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  close.focus();

  function cleanup() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (lastFocused && typeof lastFocused.focus === 'function') {
      try {
        lastFocused.focus();
      } catch {
        /* element gone from the DOM — nothing to restore */
      }
    }
  }
  function onKey(e) {
    if (e.key === 'Escape') cleanup();
  }
  close.addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKey);
}

// A single rebindable hotkey row: shows the current combo + a "Change…" button
// that captures the next modifier+key chord and re-registers it (fail-soft).
function buildRebind(which, label, desktop) {
  const wrap = document.createElement('div');
  wrap.className = 'sc-rebind-row';
  const name = document.createElement('span');
  name.className = 'sc-rebind-label';
  name.textContent = label;
  const combo = document.createElement('kbd');
  combo.className = 'sc-kbd';
  combo.textContent = humanizeHotkey(desktop.getHotkey ? desktop.getHotkey(which) : getHotkey(which));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sc-btn sc-btn--ghost sc-rebind-btn';
  btn.textContent = 'Change…';

  let capturing = false;
  function onCapture(e) {
    e.preventDefault();
    e.stopPropagation();
    // Ignore lone modifier presses — wait for a real key.
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const accel = accelFromEvent(e);
    stopCapture();
    if (!accel) {
      combo.textContent = humanizeHotkey(desktop.getHotkey(which));
      return;
    }
    btn.textContent = 'Saving…';
    desktop.rebindHotkey(which, accel).then((ok) => {
      btn.textContent = 'Change…';
      if (ok) {
        combo.textContent = humanizeHotkey(accel);
      } else {
        combo.textContent = humanizeHotkey(desktop.getHotkey(which));
        combo.classList.add('sc-kbd--err');
        setTimeout(() => combo.classList.remove('sc-kbd--err'), 1500);
      }
    });
  }
  function stopCapture() {
    capturing = false;
    btn.textContent = 'Change…';
    btn.classList.remove('is-capturing');
    document.removeEventListener('keydown', onCapture, true);
  }
  btn.addEventListener('click', () => {
    if (capturing) {
      stopCapture();
      return;
    }
    capturing = true;
    btn.textContent = 'Press keys…';
    btn.classList.add('is-capturing');
    document.addEventListener('keydown', onCapture, true);
  });

  wrap.append(name, combo, btn);
  return wrap;
}

// Build a Tauri accelerator string from a keydown event. Requires at least one
// modifier plus a non-modifier key; returns '' for an unusable combo.
function accelFromEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CmdOrCtrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (parts.length === 0) return ''; // require a modifier (global hotkeys need one)

  let key = e.key;
  if (key.length === 1) {
    key = key.toUpperCase();
  } else if (/^F\d{1,2}$/.test(key)) {
    // function keys pass through
  } else {
    return ''; // unsupported main key
  }
  parts.push(key);
  return parts.join('+');
}
