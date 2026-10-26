// @vitest-environment jsdom
//
// X1.1 - a stored FileSystemDirectoryHandle whose folder is gone (moved,
// deleted, recreated) still answers queryPermission() with 'granted', so
// isReady() passed and boot() rendered the normal app over a handle on which
// every operation throws NotFoundError ("No notes yet", every create failing).
//
//   - boot() now probes the handle (first step of entries()) before renderApp
//     and routes a failure to the reconnect screen with the real error text.
//   - Inside Tauri, when <Documents>/Wren Notes exists, that screen offers an
//     explicit "Use Documents\Wren Notes" button; ONLY the click clears the dead
//     notesDir key and boots TauriFsAdapter.
//   - A healthy handle still boots FileSystemAdapter (never-relocate).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountApp, createFakeAdapter, cleanupApp } from './helpers/mount-app.js';
import { FileSystemAdapter } from '../src/storage/FileSystemAdapter.js';
import { probeFsAdapter } from '../src/storage/activeAdapter.js';
import * as notesStore from '../src/notes-store.js';

const native = vi.hoisted(() => ({ adapter: null, folderExists: true }));
const tauri = vi.hoisted(() => ({ on: false }));

vi.mock('../src/platform.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isTauri: () => tauri.on,
}));
vi.mock('../src/storage/TauriFsAdapter.js', async (importOriginal) => ({
  ...(await importOriginal()),
  // `new TauriFsAdapter()` yields the test's fake native adapter.
  TauriFsAdapter: class TauriFsAdapter {
    constructor() {
      return native.adapter;
    }
  },
  nativeNotesFolderExists: async () => native.folderExists,
}));

function notFound() {
  return new DOMException('A requested file or directory could not be found.', 'NotFoundError');
}

/** A FileSystemAdapter-shaped fake: ready by permission, but with a dead handle. */
function deadHandleAdapter() {
  const a = createFakeAdapter([]);
  a.listNotes = vi.fn(a.listNotes);
  a.probe = vi.fn(async () => {
    throw notFound();
  });
  return a;
}

const NOTE = {
  id: 'n.md',
  wrenId: 'wren-nnnnnnnnnnnn',
  title: 'Existing note',
  body: 'hi',
  tags: [],
};

beforeEach(() => {
  document.body.replaceChildren();
  tauri.on = false;
  native.adapter = null;
  native.folderExists = true;
  vi.restoreAllMocks();
});
afterEach(() => cleanupApp());

describe('FileSystemAdapter.probe', () => {
  function adapterWith(handle) {
    const a = new FileSystemAdapter();
    a._dirHandle = handle;
    return a;
  }

  it('rejects with the real NotFoundError when entries() rejects', async () => {
    const a = adapterWith({
      entries: async () => {
        throw notFound();
      },
    });
    await expect(a.probe()).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('rejects when the first iterator step throws', async () => {
    const a = adapterWith({
      entries: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw notFound();
            },
          };
        },
      }),
    });
    await expect(a.probe()).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('resolves for a healthy handle (empty folder and non-empty folder)', async () => {
    const make = (items) => ({
      entries: () =>
        (async function* () {
          for (const i of items) yield i;
        })(),
    });
    await expect(adapterWith(make([])).probe()).resolves.toBeUndefined();
    await expect(adapterWith(make([['a.md', {}]])).probe()).resolves.toBeUndefined();
  });

  it('probeFsAdapter is a no-op for adapters without a probe (native, Drive)', async () => {
    await expect(probeFsAdapter({})).resolves.toBeUndefined();
  });
});

describe('boot() with a dead FS-Access handle', () => {
  it('routes to the reconnect screen with the real error text, not renderApp', async () => {
    const adapter = deadHandleAdapter();
    await mountApp({ adapter });
    const text = document.body.textContent;
    expect(text).toContain('Can’t open your notes folder');
    expect(document.querySelector('[data-fs-probe-error]').textContent).toContain('NotFoundError');
    expect(document.querySelector('[data-fs-probe-error]').textContent).toContain(
      'could not be found'
    );
    // The normal app never rendered: no list pane, and the notes were never listed.
    expect(document.querySelector('.sc-sidebar, .sc-list, .sc-card')).toBeNull();
    expect(adapter.listNotes).not.toHaveBeenCalled();
    expect(adapter.probe).toHaveBeenCalledTimes(1);
  });

  it('outside Tauri there is no "Use Documents" button', async () => {
    await mountApp({ adapter: deadHandleAdapter() });
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector('[data-use-native-folder]')).toBeNull();
  });

  it('in Tauri, offers the button but does NOT switch or clear anything on its own', async () => {
    tauri.on = true;
    const clear = vi.spyOn(notesStore, 'clearStoredDirHandle');
    const nativeAdapter = createFakeAdapter([NOTE]);
    native.adapter = nativeAdapter;
    const app = await mountApp({ adapter: deadHandleAdapter() });
    const btn = await app.waitFor(() => document.querySelector('[data-use-native-folder]'));
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Use Documents\\Wren Notes');
    expect(clear).not.toHaveBeenCalled();
    expect(document.querySelector('.sc-card')).toBeNull();
  });

  it('in Tauri, hides the button when <Documents>/Wren Notes does not exist', async () => {
    tauri.on = true;
    native.folderExists = false;
    await mountApp({ adapter: deadHandleAdapter() });
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector('[data-use-native-folder]')).toBeNull();
  });

  it('clicking the button clears notesDir and boots TauriFsAdapter', async () => {
    tauri.on = true;
    const order = [];
    const clear = vi
      .spyOn(notesStore, 'clearStoredDirHandle')
      .mockImplementation(async () => void order.push('clear'));
    const nativeAdapter = createFakeAdapter([NOTE]);
    const init = nativeAdapter.initialize;
    nativeAdapter.initialize = vi.fn(async () => {
      order.push('init');
      return init();
    });
    native.adapter = nativeAdapter;

    const app = await mountApp({ adapter: deadHandleAdapter() });
    const btn = await app.waitFor(() => document.querySelector('[data-use-native-folder]'));
    // The desktop integration renderApp() sets up under Tauri is not under test.
    tauri.on = false;
    btn.click();

    const card = await app.waitFor(() => document.querySelector('.sc-card'));
    expect(card).not.toBeNull();
    expect(clear).toHaveBeenCalledTimes(1);
    // Native folder is booted first, so a failure leaves the saved handle intact.
    expect(order).toEqual(['init', 'clear']);
    expect(document.body.textContent).toContain('Existing note');
  });
});

describe('boot() with a healthy FS-Access handle (never-relocate preserved)', () => {
  it('renders the app on the FileSystemAdapter and clears nothing', async () => {
    const clear = vi.spyOn(notesStore, 'clearStoredDirHandle');
    const adapter = createFakeAdapter([NOTE]);
    adapter.probe = vi.fn(async () => {});
    const app = await mountApp({ notes: [], adapter });
    await app.waitFor(() => document.querySelector('.sc-card'));
    expect(document.body.textContent).toContain('Existing note');
    expect(adapter.probe).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
    expect(document.querySelector('[data-fs-probe-error]')).toBeNull();
  });
});
