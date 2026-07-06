# Wren — Architecture Reference

Deep reference for how Wren is built, how it runs, and how to extend it. Pairs with [`STORAGE.md`](STORAGE.md) (the Drive-sync storage-layer deep dive) and the root [`CLAUDE.md`](../../CLAUDE.md) (build/deploy/do-not-touch quick rules). Last updated 2026-05-29.

---

## 1. What Wren is

Local-first sticky-notes app. Notes are plain `.md` files (YAML frontmatter + markdown body) stored in a folder the user picks on disk via the File System Access API — no account, no server, no cloud lock-in. Optionally, the chosen folder can sync to Google Drive (scope `drive.file`) for cross-device use.

Ships in **two forms that read/write the same folder and share the same code**:

- **PWA** — two-panel web app (list + editor), installable, works offline. Served at `https://wren.buildwithbaker.io` (the primary production origin), a custom domain on the `wren-ckn` Cloudflare Pages project (`https://wren-ckn.pages.dev` still resolves but is no longer canonical).
- **Chrome extension (MV3)** — single-panel popup. Tiptap is bundled locally because MV3 forbids CDN/inline scripts.

The single most important architectural fact: **`src/` is shared verbatim between both targets.** The PWA entry (`src/main.js`) and the extension entry (`extension/popup.js`) both call `createApp()` from `src/app-controller.js`. The only layout difference is CSS — the `<=640px` rules in `src/styles/style.css` collapse the two-panel layout to the single-panel popup automatically at the popup's ~400px width.

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Build | [Vite](https://vitejs.dev/) 5 | Two configs: `vite.config.js` (PWA) and `vite.config.extension.js` (MV3) |
| Editor | [Tiptap](https://tiptap.dev/) v2 (ProseMirror) | Bundled locally; MV3 CSP forbids remote/inline scripts |
| Markdown round-trip | `tiptap-markdown` 0.8.10 | Runs with `html: true` so text color/highlight (which markdown can't express) round-trip as inline HTML |
| Local storage | File System Access API | Directory handle persisted in IndexedDB (`scrybe` DB), not localStorage — handles aren't serializable |
| Optional sync | Google Drive REST v3 + Google Identity Services (GIS) | `drive.file` scope, public web client ID, Token Model (no client secret) |
| Runtime | Vanilla ES modules | No framework. UI built with imperative DOM modules under `src/ui/` |
| Node | 20 (see `.nvmrc`) | |

Lint is `npm run lint` (**eslint**, flat config in `eslint.config.js`); CI runs `npm run lint --if-present`, which now executes it.

---

## 3. Directory & file map

```
wren/
  index.html                    PWA app shell (CSP meta, theme bootstrap, mounts #app)
  vite.config.js                PWA build → dist/ (base './', COOP dev-header plugin)
  vite.config.extension.js      MV3 build → dist-extension/ (stable asset filenames, no module-preload polyfill)
  package.json                  scripts: dev / build:pwa / build:ext / build / preview / icons
  scripts/gen-icons.mjs         generates icon PNGs from source SVG (runs before build)

  src/
    main.js                     PWA entry → createApp({ root, enableServiceWorker: PROD })
    app-controller.js           ★ THE orchestrator (~43KB). createApp() — boot, screens, CRUD bridge, all wiring
    notes-store.js              File System Access layer + note parse/serialize + IndexedDB migrations + CARD_COLORS
    editor.js                   Tiptap editor factory
    theme.js                    light/dark theme (localStorage 'wren.theme')

    storage/                    Pluggable storage backends (Phase 2b — Drive sync)
      StorageAdapter.js         interface contract, ADAPTER_TYPES, ConflictError, AdapterAuthError, NoBackendConfiguredError
      FileSystemAdapter.js      FS backend (wraps notes-store operations)
      DriveAdapter.js           Drive REST v3 backend (folder bootstrap, retries, conflict detection)
      activeAdapter.js          resolveBackend() + getActiveAdapter() factory
      backendPreference.js      IndexedDB 'storageBackend' key ("fs" | "drive")
      index.js                  re-exports the public surface

    oauth/
      gisClient.js              GIS Token Model client, in-memory token, popup-blocker backstop, isIosStandalonePwa()
      index.js                  re-exports

    sync/                       Per-note sync metadata + conflict naming (Drive)
      syncStateStore.js         IndexedDB 'sync_state' object store
      conflictDetection.js      Syncthing-style conflict filenames + stable device id
      index.js                  re-exports

    tags/
      tag-parser.js             namespace:value tag model — isValidTag, parseTag, getAllNamespaces, getAllTags,
                                groupNotesByNamespace, addTagToNote, removeTagFromNote

    ui/                         Imperative DOM view modules (no framework)
      notes-list.js             sidebar list + search + tag filter
      note-editor.js            editor pane (wraps editor.js; 500ms debounced autosave)
      kanban-view.js            board grouped by tag namespace; HTML5 drag-and-drop
      toolbar.js                editor toolbar
      tag-editor.js             tag add/remove UI
      color-picker.js           note color picker
      note-editor / notes-list use note.id (not note.filename) as the identifier
      dialog.js                 confirmDialog()
      format.js                 small formatting helpers

    styles/style.css            ★ ALL styles (~33KB). Two-panel desktop + <=640px single-panel popup layout

  public/                       Copied to PWA published root by Vite
    manifest.json               PWA manifest (id '/?app=wren', scope './', theme #8B5E3C)
    sw.js                       service worker (PROD only)
    privacy.html                privacy policy (required for OAuth consent screen)
    icon-*.png, icon.svg, og-card.png, apple-touch-icon-180.png

  extension/                    MV3 target
    popup.html                  popup shell → popup.js
    popup.js                    extension entry → createApp() (mirrors main.js)
    popup.css                   popup-specific chrome
    public/
      manifest.json             MV3 manifest (action popup, background service-worker.js)
      service-worker.js         extension background worker
      icon-16/32/48/128.png, icon.svg

  dist/                         GENERATED — PWA build output (never edit by hand)
  dist-extension/               GENERATED — unpacked extension (never edit by hand)
  docs/internal/
    architecture.md             this file
    STORAGE.md                  storage-layer / Drive-sync deep dive (phase log + decisions)
```

---

## 4. How it boots (control flow)

**PWA:** `index.html` mounts `<div id="app">`, runs an inline theme-bootstrap snippet (reads `wren.theme` from localStorage to avoid a flash), then loads `src/main.js` as a module. `main.js` imports the stylesheet and calls:

```js
createApp({ root: document.getElementById('app'), enableServiceWorker: import.meta.env.PROD });
```

**Extension:** `extension/popup.html` → `popup.js` → the same `createApp()`. Service worker stays disabled (the extension has its own background `service-worker.js`).

**Inside `createApp()` (`app-controller.js`):**

1. `initTheme()` and capture `beforeinstallprompt` for the in-app Install button.
2. Resolve the storage backend via `resolveBackend()` / `getActiveAdapter()`. For existing FS users this defaults to FS unchanged. New users with no stored preference hit `NoBackendConfiguredError`, which routes to the storage-choice onboarding screen (`renderStorageChoice` — two cards: local folder vs Drive).
3. If Drive: `renderDriveSignIn` (GIS sign-in, iOS double-tap priming modal, popup-blocker backstop).
4. Once an adapter is live, `listNotes()` populates the sidebar; selecting a note loads it into the editor.

**The CRUD bridge:** the StorageAdapter interface speaks **raw markdown text**. The UI consumes a **parsed-note object** (`{ id, title, color, tags, body, ... }`). `app-controller` is the bridge: it parses on read (`parseNote`) and serializes on write (`serializeNote`), both from `notes-store.js`. Autosave is a 500ms debounce in `note-editor.js` that fires writes through the active adapter.

---

## 5. Note file format

Each note is a `.md` file: YAML frontmatter + markdown body.

```markdown
---
title: My note
color: amber
created: 2026-05-27T14:30:22.000Z
updated: 2026-05-27T15:01:10.000Z
tags: ["project:wren", "status:active"]
---

Body markdown here. Because markdown has no syntax for text color or
highlight, tiptap-markdown runs with html:true so those round-trip as
inline HTML.
```

- **Colors** are defined in `CARD_COLORS` (`notes-store.js`): `default, slate, amber, red, green, rose, purple`, each with a `bg` hex.
- **Tags** are an optional JSON array of `namespace:value` strings (first colon splits). Tags without a colon fall under pseudo-namespace `_uncategorized`. The `tags:` line is only written when non-empty. Parsing is defensive — missing/malformed → `[]`. All tag logic lives in `src/tags/tag-parser.js`.

---

## 6. Storage layer (the pluggable backend)

Both backends implement the same interface (`src/storage/StorageAdapter.js`):

```
            UI (app-controller, notes-list, note-editor)
                              |
                +--------------------------+
                | StorageAdapter interface |  (speaks raw .md text)
                +--------------------------+
                  /                      \
       FileSystemAdapter             DriveAdapter
                 |                        |
       File System Access API     gisClient → Drive REST v3
```

- **IndexedDB database is `scrybe`, version 2.** Store `handles` (v1) persists the `FileSystemDirectoryHandle` under key `notesDir`. Store `sync_state` (v2, keyed by `noteId`) holds per-note Drive sync metadata. Migrations are additive and guarded by `contains()` checks — see `applyScrybeMigrations()` in `notes-store.js`.
- **Drive identity:** GIS Token Model, in-memory token (page reload drops it; `requestAccessToken({silent:true})` re-acquires silently after first consent). The folder is found-or-created with an `appProperties.wrenAppFolder=1` marker so it survives renames.
- **Conflict copies** follow Syncthing convention: `note.md → note.sync-conflict-20260527-143022-abc1234.md`, where the suffix is the first 7 chars of a stable per-device UUID stored in IndexedDB.

See [`STORAGE.md`](STORAGE.md) for the full phase log, decisions (KB Module 05 references), retry/backoff behavior, and the two pending empirical probes (Q1 `If-Match` support, Q2 `drive.file` foreign-file visibility).

**Current state (per STORAGE.md):** single-device Drive round-trip works (Phase 2b.1). Multi-device pull-on-resume, conflict detection/badges, and a sync runner are **not yet shipped** (Phase 2b.2 / 2c). On Drive, last-write-wins; earlier content is recoverable from Drive's revision history but not the Wren UI.

---

## 7. How to add new things (extension points)

**Add a new UI view module** → `src/ui/`. Follow the factory pattern the others use (`create<Name>(deps)` returning an element + an update method). Wire it into `app-controller.js`. View mode persists to localStorage (`wren.viewMode`); the List|Kanban toggle lives in the **sidebar header** (the editor fills the main panel and has no header bar).

**Add a new note color** → append to `CARD_COLORS` in `notes-store.js` (`{ id, label, bg }`). The color picker (`src/ui/color-picker.js`) renders from this array.

**Add a new tag operation** → `src/tags/tag-parser.js`. Keep tag helpers here, not in `StorageAdapter.js`. Same-namespace replacement semantics already exist in `addTagToNote`.

**Add a new storage backend** → implement the `StorageAdapter` interface, export it from `src/storage/index.js`, and add a branch in `resolveBackend()` / `getActiveAdapter()`. The interface is async-by-default with an `expectedRevision` parameter so backends can do conditional writes.

**Add a markdown/editor capability** → Tiptap extension in `editor.js`. If it produces formatting markdown can't express, confirm `tiptap-markdown`'s `html:true` round-trips it (that's why color/highlight work).

**File-placement rule (root is locked):** Do not add files to the repo root. New JS → `src/` (UI in `src/ui/`, storage in `src/storage/`, sync in `src/sync/`, oauth in `src/oauth/`, tags in `src/tags/`); new CSS → `src/styles/`; new image/icon → `public/`; build script → `scripts/`; planning/spec doc → `docs/internal/`. This is the Build with Baker Repo Standard v2.0 permitted-root-files rule.

---

## 8. Build, run, deploy

```bash
npm install
npm run dev        # Vite dev server (PWA) at localhost:5173
npm run preview    # serves the production build — the ONLY way to exercise the
                   #   production service worker (SW is enabled only when PROD)
npm run build      # gen-icons + builds dist/ (PWA) and dist-extension/ (MV3)
```

- `npm run build` runs `scripts/gen-icons.mjs` first, then both Vite builds.
- **PWA deploy:** Cloudflare Pages project `wren-ckn` auto-builds from `main` via Cloudflare's Git integration. Build command `npm run build`, output dir `dist/`, configured **in the Cloudflare dashboard, not in this repo.** There is no GitHub Actions deploy workflow.
- **Extension deploy:** load `dist-extension/` unpacked in Chrome, or zip it for the Chrome Web Store.

---

## 9. Conventions

- **ES modules only** (`import`/`export`), never `require()`. 2-space indent (`.editorconfig`).
- **Barrel files** (`src/*/index.js`) re-export each subsystem's public surface so imports read `import { DriveAdapter } from '../storage'` rather than reaching into deep paths.
- **localStorage keys are namespaced** `wren.*`: `wren.theme`, `wren.viewMode`, `wren.filterTags`, `wren.kanbanGroupBy`. (The directory handle is in IndexedDB, not here.)
- **CSS is single-file and responsive-by-breakpoint** — there is no separate extension layout; `<=640px` rules in `style.css` produce the popup view.
- **Identifier in the UI is `note.id`** (FS: the filename; Drive: the Drive file ID). The old `note.filename` FS-ism was removed.

---

## 10. Gotchas / do-not-touch

- **`dist/` and `dist-extension/` are generated** — never hand-edit.
- **`public/sw.js` and `public/manifest.json` location is load-bearing.** Vite copies `public/` to the published root; a service worker MUST live at the published root or its scope silently shrinks.
- **OAuth Client ID in `src/oauth/gisClient.js` is a PUBLIC web client ID** and is safe in version control. Its Authorized JavaScript origins are registered in Google Cloud (project "Wren"): `http://localhost:5173`, `http://localhost`, `https://wren.buildwithbaker.io` (primary production origin), and `https://wren-ckn.pages.dev` (the underlying Cloudflare Pages project domain, still registered). Do not add an origin or change the flow without updating that registration or OAuth login breaks. **There is no client secret** in this repo (GIS Token Model is public-client only) — if one ever appears, stop and rotate it.
- **`DRIVE_SCOPE` is `drive.file` (non-sensitive).** Widening it triggers Google's CASA/brand-verification path — don't change casually.
- **CSP meta in `index.html` is load-bearing for Drive** — `connect-src www.googleapis.com` is mandatory (Wren's Drive REST calls land there) even though it's not in the GIS docs. `style-src 'unsafe-inline'` is required by Tiptap/ProseMirror runtime style mutations.
- **Dev-server COOP header** (`vite.config.js` `coopHeadersPlugin`) lets the GIS OAuth popup post back to the opener. Production hosting can't set per-request headers; the popup-blocker backstop in `gisClient.js` compensates.
- **Extension build disables the module-preload polyfill** (`modulePreload:{polyfill:false}`) so no inline `<script>` is injected — also forbidden by MV3 CSP.
```
