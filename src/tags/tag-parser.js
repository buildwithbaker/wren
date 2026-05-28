// tag-parser.js
//
// Tag-parsing utilities shared by the list-view filter (Phase B) and the
// Kanban view (Phase C). Tags are colon-namespaced strings stored in each
// note's YAML frontmatter under a `tags: [...]` array (parsed/serialized in
// src/notes-store.js).
//
// Tag syntax:
//   "namespace:value"  e.g. "status:todo", "priority:high"
//   "value"            e.g. "important" — namespace defaults to _uncategorized
//   "ns:val:with:colons" — only the FIRST colon splits, rest stays in value
//
// Decision provenance: project-blueprints/wren/future-enhancements/kanban-view-sow.md

/**
 * Parse a tag string into {namespace, value, raw}.
 *
 *   parseTag("status:todo")          → {namespace:"status", value:"todo",  raw:"status:todo"}
 *   parseTag("important")            → {namespace:"_uncategorized", value:"important", raw:"important"}
 *   parseTag("link:https://x.com")   → {namespace:"link", value:"https://x.com", raw:"link:https://x.com"}
 *
 * Returns null for non-strings, empty strings, or whitespace-only input.
 *
 * @param {string} tag
 * @returns {{namespace: string, value: string, raw: string}|null}
 */
export function parseTag(tag) {
  if (typeof tag !== 'string' || !tag.trim()) {
    return null;
  }
  const trimmed = tag.trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) {
    return { namespace: '_uncategorized', value: trimmed, raw: trimmed };
  }
  return {
    namespace: trimmed.substring(0, colonIdx).trim(),
    value: trimmed.substring(colonIdx + 1).trim(),
    raw: trimmed,
  };
}

/**
 * Validate a tag string. Returns true if the tag is non-empty, has no
 * leading/trailing whitespace, contains no newlines or double-quotes
 * (which would break the JSON-encoded frontmatter array), and has a
 * non-empty value after parsing.
 *
 * @param {string} tag
 * @returns {boolean}
 */
export function isValidTag(tag) {
  if (typeof tag !== 'string') return false;
  if (tag !== tag.trim()) return false;
  if (!tag) return false;
  if (/[\n"]/.test(tag)) return false;
  const parsed = parseTag(tag);
  return parsed !== null && parsed.value.length > 0;
}

/**
 * Distinct namespaces across all notes' tags, alphabetically sorted.
 * Always includes "_uncategorized" if any notes have un-namespaced tags.
 *
 * @param {Array<{tags?: string[]}>} notes
 * @returns {string[]}
 */
export function getAllNamespaces(notes) {
  const set = new Set();
  for (const note of notes || []) {
    const tags = note.tags || [];
    for (const tag of tags) {
      const parsed = parseTag(tag);
      if (parsed) set.add(parsed.namespace);
    }
  }
  return Array.from(set).sort();
}

/**
 * Distinct tags (raw strings) across all notes, alphabetically sorted.
 * Used by the list-view filter dropdown to populate options.
 *
 * @param {Array<{tags?: string[]}>} notes
 * @returns {string[]}
 */
export function getAllTags(notes) {
  const set = new Set();
  for (const note of notes || []) {
    const tags = note.tags || [];
    for (const tag of tags) {
      if (isValidTag(tag)) set.add(tag);
    }
  }
  return Array.from(set).sort();
}

/**
 * Group notes by their value within a chosen namespace. Returns a Map keyed
 * by the value (column header in Kanban). Notes lacking any tag in the
 * chosen namespace land under "_untagged".
 *
 * The map is iteration-stable: "_untagged" is inserted first so it always
 * appears as the rightmost column when callers iterate in insertion order.
 * (Kanban CSS can override visual order if preferred.)
 *
 * @param {Array<{tags?: string[]}>} notes
 * @param {string} namespace
 * @returns {Map<string, Array<Object>>}
 */
export function groupNotesByNamespace(notes, namespace) {
  const groups = new Map();
  groups.set('_untagged', []);
  for (const note of notes || []) {
    const tags = note.tags || [];
    let placed = false;
    for (const tag of tags) {
      const parsed = parseTag(tag);
      if (parsed && parsed.namespace === namespace) {
        if (!groups.has(parsed.value)) groups.set(parsed.value, []);
        groups.get(parsed.value).push(note);
        placed = true;
        break;
      }
    }
    if (!placed) groups.get('_untagged').push(note);
  }
  return groups;
}

/**
 * Pure helper: add a tag to a note, replacing any existing tag in the same
 * namespace. E.g. adding "status:doing" to a note with "status:todo" yields
 * a new note with "status:doing" only — no duplicate status.
 *
 * Returns a NEW note object; never mutates the input.
 *
 * @param {{tags?: string[]}} note
 * @param {string} newTag
 * @returns {Object} new note with updated tags
 */
export function addTagToNote(note, newTag) {
  const parsed = parseTag(newTag);
  if (!parsed) return note;
  const currentTags = note.tags || [];
  const filtered = currentTags.filter((t) => {
    const tp = parseTag(t);
    return !tp || tp.namespace !== parsed.namespace;
  });
  return { ...note, tags: [...filtered, parsed.raw] };
}

/**
 * Pure helper: remove a specific tag (exact string match) from a note.
 * Returns a NEW note object; never mutates the input.
 *
 * @param {{tags?: string[]}} note
 * @param {string} tagToRemove
 * @returns {Object} new note with updated tags
 */
export function removeTagFromNote(note, tagToRemove) {
  const currentTags = note.tags || [];
  return { ...note, tags: currentTags.filter((t) => t !== tagToRemove) };
}
