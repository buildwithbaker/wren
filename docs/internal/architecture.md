# Wren — Architecture Reference

Deep reference for how Wren is built, how it runs, and how to extend it. Pairs with [`STORAGE.md`](STORAGE.md) (the Drive-sync storage-layer deep dive) and the root [`CLAUDE.md`](../../CLAUDE.md) (build/deploy/do-not-touch quick rules). Last updated 2026-10-23 (v1.2.7).

---

## 1. What Wren is

Local-first sticky-notes app. Notes are plain `.md` files (YAML frontmatter + markdown body) stored in a folder on disk — no account, no server, no cloud lock-in. **Local storage is the default.** Optionally, the notes can live in Google Drive instead (scope `drive.file`); that path is labelled **experimental** in the UI and is never what a new install lands on.

Ships in **three forms that share one codebase and read/write the same kind of folder**:

- **PWA** — two-panel web app (list + editor), installable, works offline. Served at `https://wren.buildwithbaker.io` (the primary production origin), a custom domain on the `wren-9p5` Cloudflare Pages project (`https://wren-9p5.pages.dev` is that project's own domain, not the canonical one). Uses the File System Access API (Chromium browsers).
- **Windows desktop app (Tauri 2)** — the same web bundle in a native shell (`src-tauri/`): a small always-on-top-capable main window that opens in Compact view, tray icon with hide-to-tray, global hotkeys, launch-at-login, due-date reminders, and **tear-off sticky notes** (each a native always-on-top window). A fresh install stores notes in `<Documents>/Wren Notes` with no folder picker. Built as an unsigned NSIS installer by `.github/workflows/tauri-release.yml` when a `v*` tag is pushed and published as a GitHub Release asset; the app's "Check for updates" reads `releases/latest` (`RELEASES_API` in `app-controller.js`).
- **Chrome extension (MV3)** — single-panel popup. **Built but parked:** it still builds into `dist-extension/` and is loaded unpacked; it is not published to the Chrome Web Store (see README).

A separate repo, **`buildwithbaker/wren-mcp`**, is a local stdio MCP server that lets an AI assistant read and write the same notes folder. It consumes this repo's AI-readable layer (stable `wren-...` frontmatter ids, the frozen `.wren-index.json` catalog, the `_inbox/` staging folder) and is released independently.

The single most important architectural fact: **`src/` is shared verbatim by every form.** The PWA entry (`src/main.js`), the extension entry (`extension/popup.js`) and the desktop webviews all run the same code; the desktop shell just loads `dist/`. `main.js` and `popup.js` call `createApp()` from `src/app-controller.js`; a `?note=<storageId>&wid=<wrenId>` query on the PWA/desktop URL boots the pop-out sticky shell (`createStickyApp()` in `src/sticky-app.js`) instead. The only layout difference between the full app and the popup is CSS — the `<=640px` rules in `src/styles/style.css` collapse the two-panel layout to the single-panel popup automatically at the popup's ~400px width. Platform-specific behaviour is gated by `isTauri()` (`src/platform.js`); every desktop-only call is a no-op in the browser.

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Build | [Vite](https://vitejs.dev/) 8 | Two configs: `vite.config.js` (PWA; also the bundle the desktop shell loads) and `vite.config.extension.js` (MV3) |
| Editor | [Tiptap](https://tiptap.dev/) v3 (ProseMirror) | Bundled locally; MV3 CSP forbids remote/inline scripts |
| Markdown round-trip | `tiptap-markdown` 0.9 (markdown-it 14) | Runs with `html: true` so text color/highlight (which markdown can't express) round-trip as inline HTML |
| Local storage | File System Access API (browser); Tauri `plugin-fs` (desktop fresh installs) | Directory handle persisted in IndexedDB (`scrybe` DB), not localStorage — handles aren't serializable |
| Optional sync | Google Drive REST v3 + Google Identity Services (GIS) | `drive.file` scope, public web client ID, Token Model (no client secret) |
| Runtime | Vanilla ES modules | No framework. UI built with imperative DOM modules under `src/ui/` |
| Desktop shell | [Tauri](https://tauri.app/) 2 (Rust crate in `src-tauri/`) | Windows NSIS target; plugins: fs, opener, global-shortcut, autostart, notification, single-instance, log. Tauri crates and `@tauri-apps/*` packages are upgraded by hand, together |
| Tests | [Vitest](https://vitest.dev/) 5 + jsdom + fake-indexeddb | `tests/`; run in CI. Some tests opt into jsdom per file |
| Node | 22 (see `.nvmrc`; `engines` is `>=22`, CI uses 22) | |

Lint is `npm run lint` (**eslint**, flat config in `eslint.config.js`). CI (`.github/workflows/ci.yml`, required check `build`) runs lint, `npm run build` and `npm test` on every PR.

---

## 3. Directory & file map

```
wren/
  index.html                    PWA app shell (CSP meta, theme bootstrap, mounts #app)
  vite.config.js                PWA build → dist/ (base './', COOP dev-header plugin, SW version stamp)
  vite.config.extension.js      MV3 build → dist-extension/ (stable asset filenames, no module-preload polyfill)
  eslint.config.js              eslint flat config
  package.json                  scripts: dev / build / build:pwa / build:ext / preview / tauri / lint / test / version:sync
  .nvmrc                        Node 22

  scripts/
    gen-icons.mjs               generates icon PNGs from source SVG (runs before build)
    sync-version.mjs            package.json `version` is the single source; `npm run version:sync` writes
                                tauri.conf.json, Cargo.toml, Cargo.lock (wren entry) and the extension manifest;
                                the plain `node scripts/sync-version.mjs` check mode runs at the start of `npm run build`
    perf-note-open.mjs          manual real-Chromium perf harness (note open / save path); see docs/internal/perf.md
    gen-og-card.py              regenerates public/og-card.png

  src/
    main.js                     PWA/desktop entry → createApp(), or createStickyApp() when the URL has ?note=
    app-controller.js           ★ THE orchestrator (very large). createApp() — boot, screens, view modes, CRUD bridge,
                                inbox/archive/trash flows, update check, all wiring
    sticky-app.js               pop-out sticky shell (own boot, slim editor, remembers its window geometry)
    notes-store.js              File System Access layer + note parse/serialize + IndexedDB migrations + CARD_COLORS
    editor.js                   Tiptap editor factory (+ tiptap-markdown)
    theme.js                    light/dark theme (localStorage 'wren.theme')
    due.js                      pure helpers for the `due` frontmatter field (status, labels)
    platform.js                 isTauri(), openExternal()
    desktop.js                  Tauri-only quick-capture: global hotkeys, tray "New note" bridge, launch-at-login,
                                due reminders (every export is a no-op outside Tauri)
    tauri-window.js             native window sizing per view (Compact vs Expanded), always-on-top pin

    storage/                    Pluggable storage backends
      StorageAdapter.js         interface contract, ADAPTER_TYPES, ConflictError, AdapterAuthError
      FileSystemAdapter.js      browser File System Access backend (PWA / extension / existing desktop users)
      TauriFsAdapter.js         native desktop backend (Tauri plugin-fs); fresh installs use <Documents>/Wren Notes
      DriveAdapter.js           Drive REST v3 backend (experimental; folder bootstrap, retries, conflict detection)
      activeAdapter.js          resolveBackend() (defaults to 'fs'), chooseFsAdapter(), getActiveAdapter()
      backendPreference.js      IndexedDB 'storageBackend' key ("fs" | "drive")
      index.js                  re-exports the public surface

    oauth/
      gisClient.js              GIS Token Model client, in-memory token, popup-blocker backstop, isIosStandalonePwa()
      index.js                  re-exports

    sync/                       Per-note sync metadata, conflict naming, cross-window messaging
      syncStateStore.js         IndexedDB 'sync_state' object store
      conflictDetection.js      Syncthing-style conflict filenames + stable device id; writeConflictCopy()
      broadcast.js              BroadcastChannel('wren-notes'): live note refresh between the main window and stickies

    sticky/                     Pop-out sticky windows (browser popups and native Tauri windows)
      opener.js                 route/URL/label builders; openSticky() (window.open, or openStickyTauri() on desktop)
      geometry.js               per-device window position/size memory (localStorage); on Tauri it converts the native
                                window's physical position/size to logical px (physicalToLogicalGeometry)
      registry.js               which stickies are open, so the main app can offer to restore them
      titlebar.js               slim custom title bar for the frameless Tauri sticky

    ai/                         AI-readable layer, written into the notes folder
      note-index.js             builds .wren-index.json (frozen schema) and _index.md
      ai-contract-doc.js        the versioned README-for-AI.md template

    tags/
      tag-parser.js             namespace:value tag model — isValidTag, parseTag, getAllNamespaces, getAllTags,
                                groupNotesByNamespace, addTagToNote, removeTagFromNote

    ui/                         Imperative DOM view modules (no framework)
      notes-list.js             sidebar list + search + tag filter + sort; uses card-reconciler
      card-reconciler.js        keyed reuse of note cards (one element per note id + a signature of what the card
                                shows) so a save updates one card instead of rebuilding all of them
      compact-view.js           Compact mode: narrow mini-card stack (the desktop app's landing layout)
      kanban-view.js            board grouped by tag namespace; HTML5 drag-and-drop
      note-editor.js            editor pane (wraps editor.js; 500ms debounced autosave, serialized by save-queue)
      save-queue.js             serializes async saves so a flush never overlaps an in-flight write
      toolbar.js                editor toolbar
      tag-editor.js             tag add/remove UI with autocomplete
      color-picker.js           note color picker
      archive-panel.js          Archive dialog (notes in _archive/)
      desktop-panel.js          "Keyboard shortcuts & desktop" dialog (hotkeys, launch at login)
      pin-button.js             always-on-top toggle (desktop only)
      dialog.js                 confirmDialog(); focus-trap.js keeps focus inside modals
      note-sort.js, note-search.js   sort options + the shared search predicate (list and compact)
      tag-chips.js, due-chip.js, ai-badge.js   small shared card parts
      format.js                 small formatting helpers
      (note-editor and notes-list identify a note by note.id, not note.filename)

    styles/style.css            ★ ALL styles. Two-panel desktop + <=640px single-panel popup layout

  public/                       Copied to the PWA published root by Vite
    manifest.json               PWA manifest
    sw.js                       service worker (PROD only; cache name stamped with the app version at build)
    _headers                    Cloudflare Pages security headers (CSP, HSTS, ...)
    download.html, guide.html, mcp.html, privacy.html, signing.html   static site pages
                                (+ site-nav.css, 404.html, robots.txt, sitemap.xml, theme-init.js)
    icon-*.png, icon.svg, og-card.png, apple-touch-icon-180.png

  pages-retire/                 permanent GitHub Pages service-worker kill-switch for the retired /wren/ copy
                                (deployed only by the manual .github/workflows/pages-retire.yml)

  extension/                    MV3 target (parked: built, not published)
    popup.html, popup.js, popup.css   popup shell → createApp()
    public/manifest.json, service-worker.js, icon-16/48/128.png, icon.svg

  src-tauri/                    Tauri 2 desktop crate (Windows NSIS)
    src/lib.rs, main.rs         tray + menu, hide-to-tray, single instance, window reveal, quit-time save flush
    tauri.conf.json             window, CSP, bundle (version kept in sync by scripts/sync-version.mjs)
    capabilities/default.json   permissions for the `main` and `sticky-*` windows
    Cargo.toml, Cargo.lock, build.rs, icons/

  tests/                        Vitest suite (+ tests/helpers/mount-app.js)
  .github/workflows/            ci.yml (lint + build + test; required check `build`),
                                tauri-release.yml (tag v* → NSIS installer → GitHub Release),
                                pages-retire.yml (manual);  .github/dependabot.yml
  dist/                         GENERATED — PWA build output (never edit by hand)
  dist-extension/               GENERATED — unpacked extension (never edit by hand)
  docs/README-for-AI.md         repo reference copy of the contract doc (live template: src/ai/ai-contract-doc.js)
  docs/internal/
    architecture.md             this file
    STORAGE.md                  storage-layer / Drive-sync deep dive (phase log + decisions; historical)
    perf.md                     perf harness, budgets and dated before/after numbers
    code-signing.md             code-signing status, SignPath answers, go-live checklist
```

---

## 4. How it boots (control flow)

**PWA / desktop webview:** `index.html` mounts `<div id="app">`, runs an inline theme-bootstrap snippet (reads `wren.theme` from localStorage to avoid a flash), then loads `src/main.js` as a module. `main.js` imports the stylesheet and, unless the URL carries a `?note=` sticky param, calls:

```js
createApp({ root: document.getElementById('app'), enableServiceWorker: import.meta.env.PROD });
```

With `?note=<storageId>&wid=<wrenId>` it dynamically imports `sticky-app.js` and boots the pop-out sticky shell instead (its own, much smaller boot: resolve the adapter, read that one note, open the slim editor, remember window geometry).

**Extension:** `extension/popup.html` → `popup.js` → the same `createApp()`. The page service worker stays disabled (the extension has its own background `service-worker.js`).

**Desktop window:** the Tauri main window is created hidden (`"visible": false` in `tauri.conf.json`); the frontend calls `revealWindow()` once it has mounted, with a Rust-side fallback timer so a broken bundle can never leave an invisible process.

**Inside `createApp()` → `boot()` (`app-controller.js`):**

1. `initTheme()` and capture `beforeinstallprompt` for the in-app Install button.
2. `resolveBackend()` (`storage/activeAdapter.js`) reads the stored preference. **Unset means local (`'fs'`).** An explicit stored `'drive'` is honored verbatim (existing Drive users are never downgraded). If an unset install already has a saved directory handle, `'fs'` is persisted (migration); a brand-new install is *not* persisted until the user acts. (`NoBackendConfiguredError` no longer exists — it was removed in #120; `resolveBackend()` always returns `'fs'` or `'drive'`, so `boot()` has no "no backend" case.)
3. **Local (`'fs'`):** `chooseFsAdapter()` picks the adapter — on Tauri with no stored directory handle, the native `TauriFsAdapter` (opens straight into `<Documents>/Wren Notes`, no picker); otherwise `FileSystemAdapter`. If the browser lacks the File System Access API (and it is not the native adapter), `renderUnsupported()` offers experimental Drive. After `initialize()`: ready → `renderApp()`; a stored-but-lapsed handle → `renderFsReconnect()`; an unreadable handle store → reconnect/retry (never storage-choice, which would overwrite the real handle); no handle at all → `renderStorageChoice()` (two cards, local folder as the primary path and Drive labelled experimental).
4. **Drive (`'drive'`):** silent token re-acquire, then `DriveAdapter.initialize()` → `renderApp()`. Failures route to `renderDriveResume()` (one-tap resume) or `renderDriveSignIn()` (GIS sign-in, iOS double-tap priming modal, popup-blocker backstop).
5. `renderApp()` builds the sidebar, editor, Kanban and Compact surfaces and populates them from `listNotes()`. There are three view modes — **List**, **Kanban** and **Compact**. Only List/Kanban are persisted (`wren.viewMode`); Compact is a session-only landing layer applied on every launch (the desktop window resizes to match). Selecting a note loads it into the editor.

**The CRUD bridge:** the StorageAdapter interface speaks **raw markdown text**. The UI consumes a **parsed-note object** (`{ id, wrenId, title, color, tags, body, ... }`). `app-controller` is the bridge: it parses on read (`parseNote`) and serializes on write (`serializeNote`), both from `notes-store.js`. Autosave is a 500ms debounce in `note-editor.js` whose writes go through a serialized save queue to the active adapter (`handleSave`). A save updates the sidebar via `list.setNotes(notes)`, which reconciles cards by id rather than rebuilding them (`ui/card-reconciler.js`), then regenerates the AI index and notifies other windows over the `wren-notes` BroadcastChannel.

---

## 5. Note file format

Each note is a `.md` file: YAML frontmatter + markdown body.

```markdown
---
id: wren-k3x9a1b2c4d5
title: "My note"
created: 2026-05-27T14:30:22.000Z
modified: 2026-05-27T15:01:10.000Z
color: amber
due: "2026-06-01"
tags: ["project:wren", "status:active"]
---

Body markdown here. Because markdown has no syntax for text color or
highlight, tiptap-markdown runs with html:true so those round-trip as
inline HTML.
```

- **Frontmatter keys** (written by `serializeNote`, `notes-store.js`): `id` (the stable logical id, `wren-…`, stamped on first save), `title` (JSON-quoted), `created`, `modified`, `color`; written only when set: `due` (`YYYY-MM-DD`), `summary`, the provenance trio `created_by` / `last_edited_by` / `last_edited` (`ai` or `human`; stamped by the app and by wren-mcp), `tags`, and the per-note display toggles `hide_due` / `hide_tags`. The `.wren-index.json` catalog built from these is a frozen cross-repo contract.
- **Colors** are defined in `CARD_COLORS` (`notes-store.js`): `default, slate, amber, red, green, rose, purple`, each with a `bg` hex.
- **Tags** are an optional JSON array of `namespace:value` strings (first colon splits). Tags without a colon fall under pseudo-namespace `_uncategorized`. The `tags:` line is only written when non-empty. Parsing is defensive — missing/malformed → `[]`. All tag logic lives in `src/tags/tag-parser.js`.

---

## 6. Storage layer (the pluggable backend)

All backends implement the same interface (`src/storage/StorageAdapter.js`):

```
            UI (app-controller, notes-list, note-editor)
                              |
                +--------------------------+
                | StorageAdapter interface |  (speaks raw .md text)
                +--------------------------+
                  /            |            \
       FileSystemAdapter  TauriFsAdapter   DriveAdapter
                 |             |                 |
       File System Access   Tauri plugin-fs   gisClient → Drive REST v3
       API (browser)        (desktop, native)   (experimental)
```

`FileSystemAdapter` and `TauriFsAdapter` are the two **local** (`backendId() === 'fs'`) implementations, with the same semantics: top-level-only note scans, reserved Wren-managed files (`.wren-index.json`, `_index.md`, `README-for-AI.md`, `tasks.md`) excluded from listings, the file's mtime as its revision with `ConflictError` on a conditional-write mismatch, and the `_inbox/` (staged drafts), `_archive/` and `.trash/` (soft delete) subfolder conventions. `chooseFsAdapter()` picks between them (see section 4) and never relocates an existing desktop user's notes.

- **IndexedDB database is `scrybe`, version 2.** Store `handles` (v1) persists the `FileSystemDirectoryHandle` under key `notesDir`. Store `sync_state` (v2, keyed by `noteId`) holds per-note Drive sync metadata. Migrations are additive and guarded by `contains()` checks — see `applyScrybeMigrations()` in `notes-store.js`.
- **Drive identity:** GIS Token Model, in-memory token (page reload drops it; `requestAccessToken({silent:true})` re-acquires silently after first consent). The folder is found-or-created with an `appProperties.wrenAppFolder=1` marker so it survives renames.
- **Conflict copies** (written by `handleSaveConflict` → `writeConflictCopy` when a conditional write finds the note changed underneath it) follow Syncthing convention: `note.md → note.sync-conflict-20260527-143022-abc1234.md`, where the suffix is the first 7 chars of a stable per-device UUID stored in IndexedDB.

See [`STORAGE.md`](STORAGE.md) for the full phase log, decisions (KB Module 05 references), retry/backoff behavior, and the empirical probes (Q1 `If-Match` support — closed 2026-07-27 as unanswerable by self-probe; Q2 `drive.file` foreign-file visibility — still open).

**Current state:** every save passes the note's known revision to `adapter.writeNote`. On a mismatch the adapter throws `ConflictError`, the losing text is kept as a `.sync-conflict-…` copy, the winner is reloaded, and the user gets a toast with an Open action. Open windows stay in sync through the `wren-notes` BroadcastChannel (`sync/broadcast.js`). **Not shipped** (STORAGE.md Phase 2b.2 / 2c): a Drive sync runner, pull-on-resume from other devices, and conflict badges or a dedicated conflict view — on Drive, an edit made on another device only appears on the next reload.

---

## 7. How to add new things (extension points)

**Add a new UI view module** → `src/ui/`. Follow the factory pattern the others use (`create<Name>(deps)` returning an element + an update method). Wire it into `app-controller.js`. View mode persists to localStorage (`wren.viewMode`, List or Kanban only — Compact is session-only); the List|Kanban toggle lives in the **sidebar header** and Compact has its own button. A surface that shows note cards and re-renders on every save should reuse `ui/card-reconciler.js` rather than rebuild its cards.

**Add a new note color** → append to `CARD_COLORS` in `notes-store.js` (`{ id, label, bg }`). The color picker (`src/ui/color-picker.js`) renders from this array.

**Add a new tag operation** → `src/tags/tag-parser.js`. Keep tag helpers here, not in `StorageAdapter.js`. Same-namespace replacement semantics already exist in `addTagToNote`.

**Add a new storage backend** → implement the `StorageAdapter` interface, export it from `src/storage/index.js`, and add a branch in `resolveBackend()` / `chooseFsAdapter()` / `getActiveAdapter()`. The interface is async-by-default with an `expectedRevision` parameter so backends can do conditional writes.

**Add a markdown/editor capability** → Tiptap extension in `editor.js`. If it produces formatting markdown can't express, confirm `tiptap-markdown`'s `html:true` round-trips it (that's why color/highlight work).

**File-placement rule (root is locked):** Do not add files to the repo root. New JS → `src/` (UI in `src/ui/`, storage in `src/storage/`, sync in `src/sync/`, oauth in `src/oauth/`, sticky windows in `src/sticky/`, AI layer in `src/ai/`, tags in `src/tags/`); new CSS → `src/styles/`; new image/icon → `public/`; build script → `scripts/`; planning/spec doc → `docs/internal/`. This is the Build with Baker Repo Standard v2.0 permitted-root-files rule.

---

## 8. Build, run, deploy

```bash
npm install
npm run dev        # Vite dev server (PWA) at localhost:5173
npm run preview    # serves the production build — the ONLY way to exercise the
                   #   production service worker (SW is enabled only when PROD)
npm run build      # version check + gen-icons + builds dist/ (PWA) and dist-extension/ (MV3)
npm run lint && npm test
npm run tauri dev  # desktop shell against the dev server (needs the Rust toolchain)
```

- `npm run build` runs `scripts/sync-version.mjs` (check mode; fails on version drift), then `scripts/gen-icons.mjs`, then both Vite builds.
- **Versioning:** `package.json` `version` is the single source. After changing it, run `npm run version:sync` to write `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (the `wren` entry) and `extension/public/manifest.json`.
- **PWA deploy:** Cloudflare Pages project `wren-9p5` (Cloudflare account bakeradm6@gmail.com) auto-builds from `main` via Cloudflare's Git integration. Build command `npm run build`, output dir `dist/`, configured **in the Cloudflare dashboard, not in this repo.** There is no GitHub Actions deploy workflow.
- **Desktop release:** push a `v*` tag. `.github/workflows/tauri-release.yml` (Windows runner, `tauri-action`) builds the unsigned NSIS installer and publishes it as a GitHub Release. Branch protection guards `main`, not tags. Signing is wired but inert (`SIGNING_ENABLED` unset) — see `code-signing.md`.
- **Extension:** parked. `dist-extension/` is loaded unpacked in Chrome; it is not published to the Chrome Web Store.
- **Perf:** `scripts/perf-note-open.mjs` (manual) measures the note-open and save paths; see [`perf.md`](perf.md).

---

## 9. Conventions

- **ES modules only** (`import`/`export`), never `require()`. 2-space indent (`.editorconfig`).
- **Barrel files** (`src/*/index.js`) re-export each subsystem's public surface so imports read `import { DriveAdapter } from '../storage'` rather than reaching into deep paths.
- **localStorage keys are namespaced** `wren.*` — e.g. `wren.theme`, `wren.viewMode`, `wren.filterTags`, `wren.sortBy`, `wren.kanbanGroupBy`, `wren.formatCollapsed`, `wren.win.*` (desktop window sizes and pin), `wren.hotkey.*`, `wren.stickies.open`, `wren.sticky.geom.<id>`. (The directory handle and the `storageBackend` preference are in IndexedDB, not here.)
- **CSS is single-file and responsive-by-breakpoint** — there is no separate extension layout; `<=640px` rules in `style.css` produce the popup view.
- **Identifier in the UI is `note.id`** (FS: the filename; Drive: the Drive file ID). On the local backends a title change renames the file, so `note.id` changes on save and the open note, list and sync state follow it (`syncBackendFilename`). The stable identity is `note.wrenId` (the frontmatter `id`).

---

## 10. Gotchas / do-not-touch

- **`dist/` and `dist-extension/` are generated** — never hand-edit.
- **`public/sw.js` and `public/manifest.json` location is load-bearing.** Vite copies `public/` to the published root; a service worker MUST live at the published root or its scope silently shrinks.
- **OAuth Client ID in `src/oauth/gisClient.js` is a PUBLIC web client ID** and is safe in version control. Verified in the Google Cloud console on 2026-10-23 (project "Wren", OAuth client "Wren Web Client"): the Authorized JavaScript origins are exactly four — `http://localhost:5173`, `http://localhost`, `https://wren.buildwithbaker.io` (primary production origin) and `https://wren-9p5.pages.dev` (the production Pages project's own domain) — and there is exactly one Authorized redirect URI, `https://wren.buildwithbaker.io`. The retired `https://wren-ckn.pages.dev` is in neither list. Do not add an origin or change the flow without updating that registration or OAuth login breaks. **There is no client secret** in this repo (GIS Token Model is public-client only) — if one ever appears, stop and rotate it.
- **`DRIVE_SCOPE` is `drive.file` (non-sensitive).** Widening it triggers Google's CASA/brand-verification path — don't change casually.
- **CSP meta in `index.html` is load-bearing for Drive** — `connect-src www.googleapis.com` is mandatory (Wren's Drive REST calls land there) even though it's not in the GIS docs. `style-src 'unsafe-inline'` is required by Tiptap/ProseMirror runtime style mutations.
- **Dev-server COOP header** (`vite.config.js` `coopHeadersPlugin`) lets the GIS OAuth popup post back to the opener. Production hosting can't set per-request headers; the popup-blocker backstop in `gisClient.js` compensates.
- **Extension build disables the module-preload polyfill** (`modulePreload:{polyfill:false}`) so no inline `<script>` is injected — also forbidden by MV3 CSP.
