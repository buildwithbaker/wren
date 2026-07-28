// theme.js
// Manual theme override on top of prefers-color-scheme.
// States: 'system' | 'light' | 'dark'. Stored in localStorage under 'wren.theme'.

const STORAGE_KEY = 'wren.theme';
const VALID = new Set(['system', 'light', 'dark']);

// localStorage.getItem throws, not returns null, when storage is unavailable:
// Chrome/Firefox block it outright when third-party cookies are disabled for
// the origin, Safari throws in some private-browsing configurations, and an
// over-quota profile can too. getStoredTheme() runs on the boot path (initTheme
// + the footer's theme button), so an unguarded throw took the whole app down
// before first paint (audit U21).
export function getStoredTheme() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return 'system';
  }
  return VALID.has(raw) ? raw : 'system';
}

export function setStoredTheme(theme) {
  if (!VALID.has(theme)) theme = 'system';
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage blocked — the theme still applies for this session, it just
    // won't survive a reload. Failing the write must not fail the toggle.
  }
  applyTheme(theme);
}

export function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  const current = getStoredTheme();
  const next = order[(order.indexOf(current) + 1) % order.length];
  setStoredTheme(next);
  return next;
}

export function initTheme() {
  applyTheme(getStoredTheme());
}
