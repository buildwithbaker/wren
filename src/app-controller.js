// app-controller.js
// Shared orchestration for both the PWA (two-panel on desktop) and the Chrome
// extension popup (single-panel; the <=640px layout in style.css kicks in
// automatically at the popup's 400px width). Entry points pass a mount root.

import {
  isSupported,
  getStoredDirHandle,
  queryPermission,
  requestPermission,
  pickDirectory,
  listNotes,
  readNote,
  writeNote,
  createNote,
  deleteNote,
  exportNoteDownload,
} from './notes-store.js';
import { createNotesList } from './ui/notes-list.js';
import { createNoteEditor } from './ui/note-editor.js';

const KOFI = 'https://ko-fi.com/abaker421';

export function createApp({ root, enableServiceWorker = false }) {
  let dirHandle = null;
  let notes = [];
  let list = null;
  let noteEditor = null;
  let appEl = null;

  boot();

  async function boot() {
    if (!isSupported()) return renderUnsupported();
    const handle = await getStoredDirHandle();
    if (!handle) return renderOnboarding();
    const perm = await queryPermission(handle);
    if (perm === 'granted') {
      dirHandle = handle;
      await renderApp();
    } else {
      renderReconnect(handle);
    }
  }

  /* ---- Screens --------------------------------------------------------- */

  function screenShell(innerNode) {
    root.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'sc-app';
    const screen = document.createElement('div');
    screen.className = 'sc-screen';
    screen.style.gridColumn = '1 / -1';
    screen.appendChild(innerNode);
    wrap.appendChild(screen);
    root.append(wrap, buildFooter());
  }

  function renderUnsupported() {
    const card = document.createElement('div');
    card.className = 'sc-screen-card';
    card.innerHTML = `
      <img src="./icon.svg" alt="Wren" />
      <h1>Browser not supported</h1>
      <p>Wren needs the <strong>File System Access API</strong> to read and write
      notes on your PC. Use Chrome, Edge, or another Chromium browser on desktop.</p>`;
    screenShell(card);
  }

  function renderOnboarding() {
    const card = document.createElement('div');
    card.className = 'sc-screen-card';
    card.innerHTML = `
      <img src="./icon.svg" alt="Wren" />
      <h1>Welcome to Wren</h1>
      <p>Choose a folder where your notes will live as Markdown
      (<code>.md</code>) files. They stay on your computer and are never uploaded.</p>`;
    const btn = document.createElement('button');
    btn.className = 'sc-btn sc-btn--primary';
    btn.textContent = 'Choose notes folder';
    btn.addEventListener('click', async () => {
      try {
        dirHandle = await pickDirectory();
        await renderApp();
      } catch (err) {
        if (err?.name !== 'AbortError') alert('Could not open that folder. Please try again.');
      }
    });
    card.appendChild(btn);
    screenShell(card);
  }

  function renderReconnect(handle) {
    const card = document.createElement('div');
    card.className = 'sc-screen-card';
    card.innerHTML = `
      <img src="./icon.svg" alt="Wren" />
      <h1>Reconnect your notes folder</h1>
      <p>Your browser needs you to confirm access to your notes folder again.</p>`;
    const grant = document.createElement('button');
    grant.className = 'sc-btn sc-btn--primary';
    grant.textContent = 'Grant access';
    grant.addEventListener('click', async () => {
      const perm = await requestPermission(handle);
      if (perm === 'granted') {
        dirHandle = handle;
        await renderApp();
      }
    });
    const choose = document.createElement('button');
    choose.className = 'sc-btn sc-btn--ghost';
    choose.style.marginLeft = '8px';
    choose.textContent = 'Choose a different folder';
    choose.addEventListener('click', async () => {
      try {
        dirHandle = await pickDirectory();
        await renderApp();
      } catch (err) {
        if (err?.name !== 'AbortError') alert('Could not open that folder.');
      }
    });
    card.append(grant, choose);
    screenShell(card);
  }

  /* ---- Main app -------------------------------------------------------- */

  async function renderApp() {
    root.replaceChildren();

    appEl = document.createElement('div');
    appEl.className = 'sc-app';
    appEl.dataset.view = 'list';

    const sidebar = document.createElement('aside');
    sidebar.className = 'sc-sidebar';
    sidebar.appendChild(buildBrand());

    list = createNotesList({
      onSelect: (filename) => openNote(filename),
      onNew: () => handleNew(),
    });
    sidebar.appendChild(list.element);

    const main = document.createElement('main');
    main.className = 'sc-main';
    noteEditor = createNoteEditor({
      onSave: handleSave,
      onDelete: handleDelete,
      onExport: (note) => exportNoteDownload(note),
      onBack: () => {
        appEl.dataset.view = 'list';
        list.setActive(null);
      },
      showBack: true,
    });
    main.appendChild(noteEditor.element);

    appEl.append(sidebar, main);
    root.append(appEl, buildFooter());

    await loadNotes();
  }

  async function loadNotes() {
    try {
      notes = await listNotes(dirHandle);
    } catch (err) {
      console.error('Failed to read notes folder', err);
      notes = [];
    }
    list.setNotes(notes);
  }

  async function openNote(filename, { focusTitle = false } = {}) {
    let fresh;
    try {
      fresh = await readNote(dirHandle, filename);
    } catch {
      await loadNotes();
      return;
    }
    const idx = notes.findIndex((n) => n.filename === filename);
    if (idx !== -1) notes[idx] = fresh;
    await noteEditor.openNote(fresh, { focusTitle });
    list.setActive(filename);
    appEl.dataset.view = 'editor';
  }

  async function handleNew() {
    try {
      const note = await createNote(dirHandle);
      notes.unshift(note);
      list.setNotes(notes);
      await openNote(note.filename, { focusTitle: true });
    } catch (err) {
      console.error('Could not create note', err);
      alert('Could not create a new note in the folder.');
    }
  }

  async function handleSave(note) {
    await writeNote(dirHandle, note);
    notes.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    list.setNotes(notes);
    list.setActive(note.filename);
  }

  async function handleDelete(note) {
    try {
      await deleteNote(dirHandle, note.filename);
    } catch (err) {
      console.error('Delete failed', err);
      alert('Could not delete the note file.');
      return;
    }
    notes = notes.filter((n) => n.filename !== note.filename);
    list.setNotes(notes);
    noteEditor.clear();
    list.setActive(null);
    appEl.dataset.view = 'list';
  }

  /* ---- Chrome ---------------------------------------------------------- */

  function buildBrand() {
    const brand = document.createElement('div');
    brand.className = 'sc-brand';
    brand.innerHTML = `<img src="./icon.svg" alt="" /><span class="sc-brand-name">Wren</span>`;
    return brand;
  }

  function buildFooter() {
    const footer = document.createElement('footer');
    footer.className = 'sc-footer';
    footer.innerHTML = `
      <a href="${KOFI}" target="_blank" rel="noopener">Build with Baker</a>
      <span class="sc-footer-dot">·</span>
      <a href="${KOFI}" target="_blank" rel="noopener">Support on Ko-fi ♥</a>`;
    return footer;
  }

  /* ---- Service worker -------------------------------------------------- */
  if (enableServiceWorker && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
    });
  }
}
