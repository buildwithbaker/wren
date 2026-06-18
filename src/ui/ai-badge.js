// ai-badge.js
// Shared AI-provenance badge for note cards (list / compact / kanban) and the
// open-note panel. A note is "AI" when it was created OR last edited by the AI
// (MCP v2.1 stamps created_by / last_edited_by = 'ai'). Legacy/app notes have
// no provenance and must never show the badge.

/**
 * True when the note's provenance marks it as AI-created or AI-edited. Defensive
 * against absent fields: anything other than the literal 'ai' is not AI.
 *
 * @param {{createdBy?: string, lastEditedBy?: string}} note
 * @returns {boolean}
 */
export function isAiNote(note) {
  if (!note) return false;
  return note.createdBy === 'ai' || note.lastEditedBy === 'ai';
}

/**
 * Build the subtle "AI" chip element. Caller decides placement; this only makes
 * the node. Inert (no listeners) — it's a marker, not a control.
 *
 * @returns {HTMLSpanElement}
 */
export function buildAiBadge() {
  const badge = document.createElement('span');
  badge.className = 'sc-ai-badge';
  badge.textContent = 'AI';
  badge.title = 'Created or last edited by AI';
  badge.setAttribute('aria-label', 'Created or last edited by AI');
  return badge;
}
