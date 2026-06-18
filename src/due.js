// due.js
// Pure helpers for the `due` frontmatter field (Note Lifecycle, Part A). The
// field is a plain `YYYY-MM-DD` date string — the same value note-index.js
// already passes through to .wren-index.json. No I/O here; cards, the editor,
// and the desktop reminder all share these so the due/overdue rules stay in
// lockstep.

// Local "today" as YYYY-MM-DD. Date comparison stays in the user's local zone
// (a due date is a calendar day, not an instant).
export function todayStr(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Normalize a stored `due` value to YYYY-MM-DD, or '' if absent/unparseable.
// Accepts a bare date or any ISO timestamp (we keep only the date part).
export function normalizeDue(due) {
  if (typeof due !== 'string') return '';
  const head = due.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : '';
}

/**
 * Classify a due date relative to today.
 * @returns {'overdue'|'today'|'upcoming'|''} '' when there's no valid due date.
 */
export function dueStatus(due, now = new Date()) {
  const d = normalizeDue(due);
  if (!d) return '';
  const t = todayStr(now);
  if (d < t) return 'overdue';
  if (d === t) return 'today';
  return 'upcoming';
}

// Short human label for a due chip, e.g. "Overdue", "Due today", "Due Jun 20".
export function formatDueLabel(due, now = new Date()) {
  const status = dueStatus(due, now);
  if (!status) return '';
  if (status === 'overdue') return 'Overdue';
  if (status === 'today') return 'Due today';
  const d = normalizeDue(due);
  // Parse as local date (avoid the UTC shift `new Date('YYYY-MM-DD')` causes).
  const [y, m, day] = d.split('-').map(Number);
  const date = new Date(y, m - 1, day);
  const sameYear = date.getFullYear() === now.getFullYear();
  const label = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
  return `Due ${label}`;
}

// True when a note needs a nudge (due today or earlier). Used by the EXE
// reminder; archived notes never reach this (they're outside the indexed set).
export function isDueOrOverdue(due, now = new Date()) {
  const s = dueStatus(due, now);
  return s === 'overdue' || s === 'today';
}
