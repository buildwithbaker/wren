// note-search.js
// Shared text-search predicate for note lists (sidebar list + compact view).
// Matches a note's title or start-of-note preview (firstLine) against a query,
// case-insensitively. Extracted from notes-list.js so the compact view reuses
// the exact same matching shape rather than drifting its own copy.

/**
 * @param {{ title?: string, firstLine?: string }} note
 * @param {string} query  raw user query (trimmed + lowercased internally)
 * @returns {boolean} true when the note matches (an empty query matches all)
 */
export function noteMatchesQuery(note, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const title = (note?.title || '').toLowerCase();
  const preview = (note?.firstLine || '').toLowerCase();
  return title.includes(q) || preview.includes(q);
}
