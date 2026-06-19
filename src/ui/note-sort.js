// note-sort.js
// Sort options for the sidebar List + Compact views. Pure comparators plus a
// localStorage-backed preference (`wren.sortBy`, same pattern as `wren.theme` /
// `wren.kanbanGroupBy`). The "Sort by" dropdown lives in the list head; both
// views call sortNotes() on their already-filtered array so they stay in
// lockstep. Kanban is unaffected (its columns stay alphabetical).

const SORT_KEY = 'wren.sortBy';
export const DEFAULT_SORT = 'modified';

// value → dropdown label. Order here is the dropdown order.
export const SORT_OPTIONS = [
  { value: 'modified', label: 'Date modified — newest first' },
  { value: 'due', label: 'Due date — soonest first' },
  { value: 'created', label: 'Date created — newest first' },
  { value: 'title', label: 'Title — A–Z' },
];

const VALID = new Set(SORT_OPTIONS.map((o) => o.value));

export function loadSortBy() {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return VALID.has(v) ? v : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

export function saveSortBy(value) {
  if (!VALID.has(value)) return;
  try {
    localStorage.setItem(SORT_KEY, value);
  } catch {
    /* ignore */
  }
}

// Descending compare for ISO/date strings — newest (largest) first. Missing
// values sort last either way.
function descTime(a, b) {
  const av = a || '';
  const bv = b || '';
  if (av === bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return av < bv ? 1 : -1;
}

const comparators = {
  modified: (a, b) => descTime(a.modified, b.modified),
  created: (a, b) => descTime(a.created, b.created),
  title: (a, b) =>
    (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }),
  // Soonest/overdue first (ascending date); notes with NO due date sort last.
  due: (a, b) => {
    const ad = a.due || '';
    const bd = b.due || '';
    if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
    if (ad) return -1; // a has a due date, b doesn't → a first
    if (bd) return 1; // b has a due date, a doesn't → b first
    return 0; // neither has a due date → keep incoming (modified) order
  },
};

// Returns a NEW sorted array; never mutates the input. Unknown sortBy falls
// back to the default. The sort is stable on modern engines, so the incoming
// order (typically modified-desc) is the tie-breaker.
export function sortNotes(notes, sortBy) {
  const cmp = comparators[sortBy] || comparators[DEFAULT_SORT];
  return [...(notes || [])].sort(cmp);
}
