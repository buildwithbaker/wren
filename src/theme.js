// theme.js
// Manual theme override on top of prefers-color-scheme.
// States: 'system' | 'light' | 'dark'. Stored in localStorage under 'wren.theme'.

const STORAGE_KEY = 'wren.theme';
const VALID = new Set(['system', 'light', 'dark']);

export function getStoredTheme() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return VALID.has(raw) ? raw : 'system';
}

export function setStoredTheme(theme) {
  if (!VALID.has(theme)) theme = 'system';
  if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, theme);
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
