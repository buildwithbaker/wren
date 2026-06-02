// note-index.js
//
// Pure builders for Wren's auto-generated note catalog (AI-readable layer,
// Phase 2). No I/O here except hashing (Web Crypto, in-memory) — these
// functions take the already-loaded, fully-parsed in-memory notes collection
// and return serializable artifacts. app-controller owns the debounce + the
// adapter.writeManagedFile() calls.
//
// Two artifacts are produced, both written into the notes-folder root and both
// treated as Wren-managed (regenerated automatically, excluded from the notes
// list via isReservedNoteName in notes-store.js):
//
//   .wren-index.json  machine-readable source of truth for AI tools / the
//                     future Wren MCP server. Stable schema (schemaVersion).
//   _index.md         human + AI readable markdown mirror (scannable table),
//                     for when an agent only has the folder, not the JSON.
//
// The in-memory note shape this consumes (built by app-controller) is:
//   { id, wrenId, filename|name, title, summary, due, tags, color,
//     created, modified, body, revision, contentHash, ... }
// where `id` is the STORAGE identity (FS filename / Drive opaque fileId) and
// `wrenId` is the logical id (frontmatter `id`, "wren-...").
//
// The .wren-index.json `notes[]` entry shape is FROZEN (the Wren MCP server
// depends on it): do not drop or rename keys. See buildIndexJson.

import { INBOX_DIR } from '../notes-store.js';

export const INDEX_JSON_NAME = '.wren-index.json';
export const INDEX_MD_NAME = '_index.md';

// Current .wren-index.json schema version. Bump when the `notes[]` entry shape
// changes in a non-additive way so consumers can branch on it.
//
// Phase 4 adds an OPTIONAL boolean `inbox: true` on staged (_inbox/) entries
// (absent on normal notes). Adding an optional field is backward-compatible, so
// the version stays at 1 — existing consumers that ignore unknown keys are
// unaffected.
export const INDEX_SCHEMA_VERSION = 1;

/**
 * Return a new array sorted by `modified` descending (newest first). Stable for
 * equal timestamps; never mutates the input. Missing timestamps sort last.
 */
function sortByModifiedDesc(notes) {
  return [...(notes || [])].sort((a, b) => {
    const am = a?.modified || '';
    const bm = b?.modified || '';
    return am < bm ? 1 : am > bm ? -1 : 0;
  });
}

// The human/back-end filename for a note. In-memory notes use `filename`;
// adapter listings use `name`. Fall back to the storage id (FS: that IS the
// filename; Drive: the opaque id, the best we have).
function fileNameOf(n) {
  return n?.name || n?.filename || n?.id || '';
}

function cleanTags(tags) {
  return Array.isArray(tags)
    ? tags.filter((t) => typeof t === 'string' && t.trim().length > 0)
    : [];
}

/**
 * Relative path from the notes-folder root to the note's file. For flat
 * top-level notes this equals `file`. Staged (`_inbox/`) notes carry
 * `inbox: true` and resolve to `_inbox/<file>`. An explicit `path`/`dir` is
 * honored if present. Always present so the MCP server can locate notes in
 * subfolders without scanning.
 */
function pathOf(n) {
  if (n?.path) return n.path;
  const file = fileNameOf(n);
  if (n?.inbox) return `${INBOX_DIR}/${file}`;
  if (n?.dir) return `${String(n.dir).replace(/\/+$/, '')}/${file}`;
  return file;
}

/**
 * Resolve a note's contentHash — a mandatory change-detection token for
 * optimistic-concurrency writes.
 *   - Drive: reuse the metadata token already on the note (contentHash holds
 *     md5Checksum; revision holds headRevisionId). Either uniquely identifies
 *     the current content; prefer contentHash, fall back to revision.
 *   - FS (and anything without a backend token): sha256 of the note BODY, as
 *     `sha256-<hex>`, so the hash changes iff the body changes.
 * Never returns empty: if hashing is unavailable for some reason we still emit
 * a `sha256-` token over the empty string rather than ''.
 */
async function contentHashOf(n, backendId) {
  if (backendId === 'drive') {
    const token = n?.contentHash || n?.revision || '';
    if (token) return String(token);
    // Fall through to body hashing if a Drive note somehow lacks both.
  }
  return sha256Hex(n?.body || '');
}

/**
 * `sha256-<hex>` of a string via Web Crypto (available in browsers and Node 18+
 * globalThis.crypto). Pure/in-memory — no file or network I/O.
 */
async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text == null ? '' : text));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256-${hex}`;
}

/**
 * Build the machine-readable index object. ASYNC because each note's
 * contentHash may require hashing the body (Web Crypto is async).
 *
 * The `notes[]` entry shape is FROZEN (the Wren MCP server depends on it). All
 * keys are always present (stable schema) — empty optionals are '' or [], never
 * omitted — so consumers can rely on the shape without existence checks. Note
 * BODIES are never stored; `summary` is the only content field.
 *
 *   wrenId      logical id (frontmatter `id`, "wren-...")
 *   storageId   note.id — FS filename / Drive opaque fileId
 *   path        relative path from notes root (flat note => same as file)
 *   file        note.name || note.id — human filename
 *   title, summary, due, tags, color
 *   created     ISO 8601
 *   updated     canonical last-modified ISO (mapped from note.modified); the
 *               field the MCP server's staleness check compares to file mtime
 *   contentHash mandatory change-detection token (see contentHashOf)
 *   inbox       OPTIONAL boolean — present and `true` only for staged (_inbox/)
 *               notes; absent on normal notes (do not assume false-vs-absent).
 *
 * Pass the combined collection (main notes + inbox notes flagged `inbox:true`).
 *
 * @param {Array<Object>} notes      fully-parsed in-memory notes
 * @param {string} backendId         adapter.backendId() ('fs' | 'drive')
 * @returns {Promise<{schemaVersion:number, generatedAt:string, backend:string,
 *            count:number, notes:Array<Object>}>}
 */
export async function buildIndexJson(notes, backendId) {
  const sorted = sortByModifiedDesc(notes);
  const entries = await Promise.all(
    sorted.map(async (n) => {
      const entry = {
        wrenId: n.wrenId || '',
        storageId: n.id || '',
        path: pathOf(n),
        file: fileNameOf(n),
        title: n.title || '',
        summary: n.summary || '',
        due: n.due || '',
        tags: cleanTags(n.tags),
        color: n.color || 'default',
        created: n.created || '',
        updated: n.modified || '',
        contentHash: await contentHashOf(n, backendId),
      };
      // Additive optional flag — only on staged notes, so normal entries are
      // byte-for-byte unchanged from the pre-Phase-4 schema.
      if (n.inbox) entry.inbox = true;
      return entry;
    })
  );
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    backend: backendId || '',
    count: sorted.length,
    notes: entries,
  };
}

/**
 * Escape a value for safe inclusion in a single markdown table cell:
 * collapse newlines to spaces and escape pipes so they don't split the column.
 * Backslashes are escaped first so an existing "\|" in the source can't combine
 * with our pipe-escape into a malformed sequence.
 */
function escapeCell(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

const TABLE_HEADER = [
  '| Updated | Title | Tags | Due | Summary | File | wrenId |',
  '| --- | --- | --- | --- | --- | --- | --- |',
];

function tableRow(n) {
  const cells = [
    escapeCell(n.modified),
    escapeCell(n.title),
    escapeCell(cleanTags(n.tags).join(', ')),
    escapeCell(n.due),
    escapeCell(n.summary),
    escapeCell(fileNameOf(n)),
    escapeCell(n.wrenId),
  ];
  return `| ${cells.join(' | ')} |`;
}

/**
 * Build the human + AI readable markdown mirror: an auto-generated banner, a
 * small metadata block, then the main notes table (one row per note, newest
 * first). Staged (`_inbox/`) notes are listed under a separate
 * "## Inbox (pending review)" heading BELOW the main table, never mixed into it.
 * An empty folder yields a valid header plus "No notes yet." and count 0 —
 * intentional, not a placeholder.
 *
 * Pass the combined collection (main + inbox notes flagged `inbox:true`); they
 * are partitioned here.
 *
 * @param {Array<Object>} notes
 * @param {string} backendId
 * @returns {string} markdown
 */
export function buildIndexMarkdown(notes, backendId) {
  const sorted = sortByModifiedDesc(notes);
  const main = sorted.filter((n) => !n.inbox);
  const inbox = sorted.filter((n) => n.inbox);

  const lines = [
    '<!-- AUTO-GENERATED by Wren — do not edit by hand. -->',
    '<!-- Regenerated on every note change; manual edits will be overwritten. -->',
    '',
    '# Wren Note Index',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Notes: ${main.length}`,
    `- Inbox (pending review): ${inbox.length}`,
    `- Backend: ${backendId || ''}`,
    '',
  ];

  if (main.length === 0) {
    lines.push('No notes yet.', '');
  } else {
    lines.push(...TABLE_HEADER);
    for (const n of main) lines.push(tableRow(n));
    lines.push('');
  }

  if (inbox.length > 0) {
    lines.push(
      '## Inbox (pending review)',
      '',
      'AI-captured notes staged in `_inbox/`. Promote or discard them in Wren.',
      '',
      ...TABLE_HEADER
    );
    for (const n of inbox) lines.push(tableRow(n));
    lines.push('');
  }

  return lines.join('\n');
}
