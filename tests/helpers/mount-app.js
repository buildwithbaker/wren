// Test harness: boot the real app-controller in a headless DOM against a
// fake StorageAdapter, and hand back the mounted DOM plus a record of every
// adapter call.
//
// Why this exists: app-controller.js owns the handlers that decide what
// actually gets WRITTEN — provenance stamping, conflict routing, index
// regeneration — and none of it was reachable from a test. boot() bails to the
// "browser not supported" screen in jsdom (no File System Access API) and then
// to storage-choice (no ready adapter), so nothing past renderApp() ever ran.
// Every audit finding in a handler had to be closed on code review alone.
//
// The harness mocks exactly two module boundaries:
//   - src/notes-store.js  -> isSupported() true, so boot() doesn't bail early.
//   - src/storage/index.js -> resolveBackend()/chooseFsAdapter() hand back the
//     fake adapter below.
// Everything above those (the controller, the views, serializeNote, the tag
// parser) is the real code under test.
//
// Usage — importing this module installs the mocks (the vi.mock calls below
// are top-level and vitest hoists them ahead of the test file's imports):
//
//   import { mountApp, frontmatterOf } from './helpers/mount-app.js';
//   const app = await mountApp({ notes: [...] });
import { vi } from 'vitest';

vi.mock('../../src/notes-store.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // jsdom has no File System Access API; without this boot() renders the
    // "browser not supported" screen and the app shell never mounts.
    isSupported: () => true,
    getStoredDirHandle: async () => ({}),
  };
});

vi.mock('../../src/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveBackend: async () => actual.ADAPTER_TYPES.FS,
    chooseFsAdapter: async () => pendingAdapter,
  };
});

/** Serialize a note fixture into Wren's on-disk .md text. */
export function noteFixtureToMarkdown(n) {
  const lines = ['---', `id: ${n.wrenId || ''}`, `title: ${JSON.stringify(n.title || '')}`];
  lines.push(`created: ${n.created || '2026-07-01T00:00:00.000Z'}`);
  lines.push(`modified: ${n.modified || '2026-07-01T00:00:00.000Z'}`);
  lines.push(`color: ${n.color || 'default'}`);
  if (n.tags?.length) lines.push(`tags: ${JSON.stringify(n.tags)}`);
  if (n.createdBy) lines.push(`created_by: ${n.createdBy}`);
  if (n.lastEditedBy) lines.push(`last_edited_by: ${n.lastEditedBy}`);
  if (n.lastEdited) lines.push(`last_edited: ${n.lastEdited}`);
  lines.push('---', '', n.body || '');
  return lines.join('\n');
}

/**
 * An in-memory StorageAdapter. Records every mutating call on `.calls` so a
 * test can assert on exactly what the controller tried to persist.
 */
export function createFakeAdapter(noteFixtures = []) {
  const files = new Map(); // id -> { content, revision, name }
  const managed = new Map();
  const calls = { writeNote: [], createNote: [], renameNote: [], deleteNote: [], archiveNote: [] };
  let rev = 1;

  for (const n of noteFixtures) {
    files.set(n.id, {
      content: noteFixtureToMarkdown(n),
      revision: `rev-${rev++}`,
      name: n.id,
      modified: n.modified || '2026-07-01T00:00:00.000Z',
    });
  }

  const adapter = {
    backendId: () => 'fs',
    async initialize() {},
    async isReady() {
      return true;
    },
    async listNotes() {
      return Array.from(files.entries()).map(([id, f]) => ({
        id,
        name: f.name,
        modified: f.modified,
        revision: f.revision,
      }));
    },
    async readNote(id) {
      const f = files.get(id);
      if (!f) throw new Error(`no such note: ${id}`);
      return { content: f.content, revision: f.revision, name: f.name };
    },
    async writeNote(id, content, expectedRevision) {
      calls.writeNote.push({ id, content, expectedRevision });
      const f = files.get(id) || { name: id };
      const revision = `rev-${rev++}`;
      files.set(id, { ...f, content, revision, modified: new Date().toISOString() });
      return { revision };
    },
    async createNote(content, hint = {}) {
      const id = `new-${rev}.md`;
      calls.createNote.push({ id, content, hint });
      const revision = `rev-${rev++}`;
      files.set(id, { content, revision, name: id, modified: new Date().toISOString() });
      return { id, revision, name: id };
    },
    async renameNote(id, desiredName) {
      calls.renameNote.push({ id, desiredName });
      return { id, name: desiredName };
    },
    async deleteNote(id) {
      calls.deleteNote.push({ id });
      files.delete(id);
    },
    async archiveNote(id) {
      calls.archiveNote.push({ id });
      files.delete(id);
    },
    async unarchiveNote() {},
    async listArchiveNotes() {
      return [];
    },
    async listInboxNotes() {
      return [];
    },
    async promoteInboxNote() {},
    async discardInboxNote() {},
    async readManagedFile(name) {
      return managed.get(name) ?? null;
    },
    async writeManagedFile(name, content) {
      managed.set(name, content);
    },
    // Test-only accessors.
    _files: files,
    _managed: managed,
    calls,
  };
  return adapter;
}

let pendingAdapter = null;

function stubBrowserGaps() {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }
  // The editor and index writer touch these; jsdom ships neither.
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
  }
  if (!globalThis.crypto?.subtle) {
    // buildIndexJson hashes note bodies; a deterministic stand-in is fine — no
    // assertion in this harness depends on the digest value.
    const enc = new TextEncoder();
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        ...globalThis.crypto,
        randomUUID: () => '00000000-0000-4000-8000-000000000000',
        getRandomValues: (arr) => arr.fill(7),
        subtle: {
          async digest(_alg, data) {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            let h = 0;
            for (const b of bytes) h = (h * 31 + b) >>> 0;
            return enc.encode(String(h).padStart(32, '0')).buffer.slice(0, 32);
          },
        },
      },
    });
  }
}

async function waitFor(predicate, { timeout = 2000, step = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

/**
 * Boot the app against a fake adapter and wait for the shell to render.
 *
 * @param {{ notes?: Array<Object>, adapter?: Object }} [opts]
 * @returns {Promise<{adapter, root, app, setView, card, waitFor, calls}>}
 */
export async function mountApp({ notes = [], adapter } = {}) {
  stubBrowserGaps();
  pendingAdapter = adapter || createFakeAdapter(notes);

  const { createApp } = await import('../../src/app-controller.js');
  const root = document.createElement('div');
  document.body.appendChild(root);
  createApp({ root, enableServiceWorker: false });

  const app = await waitFor(() => document.querySelector('.sc-app'));
  if (!app) throw new Error('app shell never rendered');
  // Wait for the first note hydration pass to land in the sidebar.
  if (notes.length) {
    await waitFor(() => document.querySelectorAll('.sc-card').length >= notes.length);
  }

  return {
    adapter: pendingAdapter,
    calls: pendingAdapter.calls,
    root,
    app,
    waitFor,
    /** Click the sidebar List|Kanban toggle. */
    setView(mode) {
      const btn = document.querySelector(`.sc-viewtoggle button[data-mode="${mode}"]`);
      if (!btn) throw new Error(`no view-toggle button for "${mode}"`);
      btn.click();
    },
    /** The Kanban card element for a note id. */
    card(id) {
      return document.querySelector(`.sc-kanban-card[data-id="${id}"]`);
    },
  };
}

/** Parse the frontmatter of a serialized note into a plain object. */
export function frontmatterOf(markdown) {
  const m = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (val.startsWith('"')) {
      try {
        val = JSON.parse(val);
      } catch {
        /* leave raw */
      }
    }
    out[key] = val;
  }
  return out;
}
