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
// jsdom ships no IndexedDB, and Wren uses it for the stored folder handle, the
// per-note sync state, and the stable device id that names conflict copies.
// Without a real implementation the conflict-copy path fails at
// getDeviceShortId() and the app falls back to "a conflict copy could not be
// written" — so the test would pass for the wrong reason.
import 'fake-indexeddb/auto';
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
      // Tests set adapter.failNextWriteWith to simulate the other writer
      // winning the race (a ConflictError from a conditional write). It may be
      // an Error, or a function (id, attemptedContent) => Error — the function
      // form lets a test decide what the winner left on disk based on what we
      // just tried to write.
      if (adapter.failNextWriteWith) {
        const spec = adapter.failNextWriteWith;
        adapter.failNextWriteWith = null;
        throw typeof spec === 'function' ? spec(id, content) : spec;
      }
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
    // FS semantics: the filename IS the id, so a rename changes the note's
    // identity and the controller has to cascade the new id (audit S2). A fake
    // that returned the old id would quietly skip that whole code path.
    async renameNote(id, desiredName) {
      calls.renameNote.push({ id, desiredName });
      const f = files.get(id);
      if (!f) return { id, name: desiredName };
      files.delete(id);
      const revision = `rev-${rev++}`;
      files.set(desiredName, { ...f, name: desiredName, revision });
      return { id: desiredName, name: desiredName, revision };
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

// Every mounted app opens a BroadcastChannel and subscribes to note-saved
// messages (the cross-window sticky sync). document.body.replaceChildren()
// does not close it, so without this a previous test's controller keeps
// listening and runs its handlers — against a torn-down DOM and a stale
// adapter — every time a later test saves. That showed up as BroadcastChannel
// errors in stderr and as a conflict test that passed alone and timed out in
// the file. Track the channels so each mount can shut the old ones down.
const openChannels = new Set();
let channelPatched = false;

function trackBroadcastChannels() {
  if (channelPatched || typeof globalThis.BroadcastChannel !== 'function') return;
  channelPatched = true;
  const Native = globalThis.BroadcastChannel;
  class TrackedBroadcastChannel extends Native {
    constructor(name) {
      super(name);
      openChannels.add(this);
    }
    close() {
      openChannels.delete(this);
      return super.close();
    }
  }
  globalThis.BroadcastChannel = TrackedBroadcastChannel;
}

/**
 * Shut down anything a previously mounted app left running. Called at the top
 * of mountApp; also exported so a test file can put it in afterEach.
 */
export function cleanupApp() {
  for (const ch of openChannels) {
    try {
      ch.close();
    } catch {
      /* already closed */
    }
  }
  openChannels.clear();
}

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
  cleanupApp();
  trackBroadcastChannels();
  stubBrowserGaps();
  pendingAdapter = adapter || createFakeAdapter(notes);

  const { createApp } = await import('../../src/app-controller.js');
  // Resolve the error classes through the SAME mocked storage/index.js the
  // controller imports. A test that constructs ConflictError from its own
  // import can get a different class object — the mock factory's
  // importOriginal() graph is not always the one a plain import() returns —
  // and then `err instanceof ConflictError` inside the controller is false, so
  // the conflict silently falls through to the generic "Save failed" branch
  // and the test passes for the wrong reason. Hand tests the real ones.
  const { ConflictError, AdapterAuthError } = await import('../../src/storage/index.js');
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
    cleanup: cleanupApp,
    /** Error classes from the controller's own module graph. */
    errors: { ConflictError, AdapterAuthError },
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
    /** Open a note from the sidebar and wait for the editor to mount. */
    async openNote(id) {
      const card = document.querySelector(`.sc-card[data-id="${id}"] .sc-card-open`);
      if (!card) throw new Error(`no sidebar card for "${id}"`);
      card.click();
      const pm = await waitFor(() => document.querySelector('.ProseMirror'));
      if (!pm) throw new Error('editor never mounted');
      return pm;
    },
    /** Retitle the open note, which is what triggers a debounced save. */
    setTitle(text) {
      const input = document.querySelector('.sc-title-input');
      if (!input) throw new Error('no title input — is a note open?');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input;
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
