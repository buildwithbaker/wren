# Wren Storage Layer (Phase 1)

Built 2026-05-27 as Phase 1 of cross-device Drive sync. Phase 1 is the
infrastructure pass: the storage layer is importable and testable but **not
wired into the UI** yet. Phase 2b will swap app-controller.js to import
from `src/storage/` instead of `src/notes-store.js`.

## Architecture

```
            UI (app-controller, notes-list, note-editor)
                              |
                              v
                +--------------------------+
                | StorageAdapter interface |
                +--------------------------+
                  /                      \
                 v                        v
       FileSystemAdapter             DriveAdapter
                 |                        |
                 v                        v
         notes-store.js              gisClient -> Drive REST v3
         (File System
          Access API)
```

Both adapters implement the same interface (see `src/storage/StorageAdapter.js`).
The active adapter is selected at startup based on user preference; Phase 1
defaults to FS unchanged, so existing installs keep working with no visible
diff.

## Default backend: local-first, Drive experimental (2026-06-17)

The intended storage model is **local by default, Drive opt-in and experimental**:

- **A fresh / unconfigured install resolves to the local FileSystem backend.**
  `resolveBackend()` returns `"fs"` when no backend has been explicitly stored —
  there is no longer a `null` "nothing chosen" return that routed toward a
  co-equal Drive prompt. A brand-new install with no directory handle defaults
  to `"fs"` *without* persisting it (the user's first real action — picking a
  folder or deliberately turning on Cloud sync — is what gets written).
- **Existing Drive users are never downgraded.** An explicit stored `"drive"`
  is honored verbatim. Only the unset case changed.
- **The fs-migration heuristic is preserved.** Unset + an existing directory
  handle still adopts and persists `"fs"` (the 2026-06-03 switch-snap-back fix
  depends on this).
- **Drive is presented as "Cloud sync (experimental)"** with a standing warning
  ("may not sync reliably across devices…") on every surface that can switch to
  it: the storage-choice onboarding (behind a deliberate collapsed disclosure),
  the Drive sign-in screen, and the backend popover (under an "Experimental"
  group). The "Use local files instead" escape is kept.
- **Switching local ⇄ Drive stays deterministic** via `setStoredBackend(target)`
  — never `clearStoredBackend()` for a switch, which is what caused the
  local→Drive snap-back the 2026-06-03 fix addressed.

Drive sync code is intentionally retained, not removed; this change is framing +
default-resolution only. The label/warning copy lives as two constants in
`src/app-controller.js` (`DRIVE_EXPERIMENTAL_LABEL` / `DRIVE_EXPERIMENTAL_WARNING`)
so the messaging cannot drift between surfaces.

## Native desktop folder adapter (Tauri, 2026-06-19)

The `fs` backend has **two implementations**, chosen at boot by
`chooseFsAdapter()` (`src/storage/activeAdapter.js`). `backendId()` is `'fs'`
for both — the `fs|drive` preference model is unchanged; this is purely a
different fs-family implementation:

- **`FileSystemAdapter`** — browser File System Access API (PWA, extension, and
  existing desktop users who already picked a folder). Unchanged.
- **`TauriFsAdapter`** (`src/storage/TauriFsAdapter.js`) — native filesystem via
  `@tauri-apps/plugin-fs` + `@tauri-apps/api/path`. Reads/writes
  `<Documents>/Wren Notes`, auto-created (recursive `mkdir`) on first launch.
  **No picker, no prompt.**

Selection rule (the only branch that changed):

| Runtime | Stored FS-Access handle? | Adapter |
|---|---|---|
| Tauri (desktop) | none (`getStoredDirHandle() === null`) | **TauriFsAdapter** — fresh install, auto `Documents/Wren Notes` |
| Tauri (desktop) | exists | `FileSystemAdapter` — ⚠ never relocate an existing user's chosen folder |
| PWA / extension | n/a | `FileSystemAdapter` — one-time picker (unchanged) |

`TauriFsAdapter` mirrors `FileSystemAdapter`'s semantics exactly so the
AI-readable index + MCP keep working: top-level-only note scans, the reserved
managed files (`.wren-index.json`, `README-for-AI.md`, `_index.md`, `tasks.md`)
excluded from listings, mtime-as-revision with `ConflictError` on
conditional-write mismatch, and the `_inbox/` (staging) / `_archive/` (archive) /
`.trash/` (soft-delete) subfolder conventions. Subfolder moves use
write-new-then-delete-old (no native `rename`), matching `FileSystemAdapter` and
keeping the fs permission set to read/write/remove.

The native Tauri plugin modules are imported **lazily** (dynamic `import()`
inside the adapter's async methods), so the file loads cleanly in the
PWA/extension bundle and under vitest, where those native modules can't run. The
real fs calls only execute inside Tauri (the adapter is only instantiated when
`isTauri()`).

**Tauri wiring:** `tauri-plugin-fs` is registered in `src-tauri/src/lib.rs`;
`src-tauri/capabilities/default.json` grants the fs action permissions
(`read-dir`, `read-text-file`, `write-text-file`, `mkdir`, `remove`, `exists`,
`stat`) plus an `fs:scope` allowing `$DOCUMENT/Wren Notes` and
`$DOCUMENT/Wren Notes/**`. ⚠ A missing/unscoped fs scope = silent read
failures, so the scope must track the notes-folder path.

> **Not yet shipped:** a "Change folder…" control (Tauri dialog plugin) to move
> off the default `Documents/Wren Notes` path. Deferred — an arbitrary picked
> folder would fall outside the fs scope above and read-fail silently, so it
> needs a runtime scope grant before it's safe. The default path is the only
> supported native location for now.

### File map

| File | Purpose |
|---|---|
| `src/storage/StorageAdapter.js` | JSDoc-typed interface contract, `ADAPTER_TYPES`, `ConflictError`, `AdapterAuthError` |
| `src/storage/FileSystemAdapter.js` | Refactor of `notes-store.js` operations into the adapter shape |
| `src/storage/DriveAdapter.js` | Drive REST v3 implementation, folder bootstrap, retries |
| `src/oauth/gisClient.js` | GIS Token Model client, in-memory token storage, popup-blocker backstop |
| `src/sync/syncStateStore.js` | IndexedDB `sync_state` store for per-note sync metadata |
| `src/sync/conflictDetection.js` | Syncthing-style conflict filenames + stable device id |

`src/storage/index.js` and `src/oauth/index.js` re-export each module's public
surface so imports look like `import { DriveAdapter } from '../storage';`
rather than reaching deep. There is no `src/sync/index.js`: every consumer
imports `syncStateStore.js` / `conflictDetection.js` / `broadcast.js` directly,
so the barrel was removed (2026-07-27) rather than left as a zero-importer
file.

## Decisions (KB Module 05 references)

- **Token Model + in-memory storage** (P1.1, P1.2). Page-reloads drop the token;
  `requestAccessToken({silent: true})` re-acquires silently if the user has
  previously consented.
- **Adapter interface with `expectedRevision` parameter** (P1.3). The interface
  is intentionally async-by-default so backends can do conditional writes.
- **Find-or-create folder with `appProperties.wrenAppFolder=1` marker** (P1.4).
  Survives renames and resists same-name collisions with unrelated user folders.
- **`headRevisionId` as the revision identifier** (P2b.4). Stable, server-managed,
  changes on every content change but not on metadata-only changes.
- **Truncated exponential backoff with jitter on 429 / 5xx / quota 403** (P1.8).
  Honors `Retry-After` if present; capped at 5 attempts, 60s max delay.
- **Read-before-write conflict detection, with `If-Match` as a second line of
  defence** (P2b.3). The read-before-write comparison is unconditional for any
  write that supplies an `expectedRevision`; the `If-Match` header rides along
  and turns a race between the pre-fetch and the upload into a 412. See
  [Empirical Q1](#empirical-questions) for why the old runtime probe was
  removed.
- **Separate IndexedDB object store for sync metadata** (P2b.5). Migration
  bumps the `scrybe` database from v1 to v2; the existing `handles` store is
  preserved untouched.

## Pre-flight (already complete)

1. Google Cloud project "Wren" exists.
2. OAuth Client ID `1032576056803-k8kd3hb2lnl4u6qs6416q9rfdhhce9kk.apps.googleusercontent.com`
   is configured with Authorized JavaScript origins:
   - `http://localhost:5173`
   - `http://localhost`
   - `https://buildwithbaker.github.io`
3. Privacy policy URL drafted (required for the consent screen even
   pre-verification).
4. CSP meta added to `index.html` covering `accounts.google.com/gsi/*` and
   `www.googleapis.com`.

Verification (P1.6, brand-only — `drive.file` is non-sensitive so no CASA) is
deferred until Phase 2c is shipping on a stable domain.

## Conflict-file naming

Per Decision P2b.2, conflict copies follow the Syncthing convention:

```
note.md  ->  note.sync-conflict-20260527-143022-abc1234.md
```

where `abc1234` is the first 7 chars of a stable per-device UUID stored in
the `handles` IndexedDB store under key `wrenDeviceId`. `getDeviceShortId()`
generates the UUID on first call and persists it.

## Empirical questions

KB Module 05 flags four open questions. Phase 1 addresses Q1 and Q2; Q3 and
Q4 are mobile-only and land in Phase 2c.

### Q1 — Does Drive `files.update` honor `If-Match: <headRevisionId>` for blob content?

**Status: closed as unanswerable by self-probe (2026-07-27).**

`DriveAdapter.writeNote` used to carry a module-level `IF_MATCH_SUPPORTED`
tri-state flag that was supposed to learn the answer at runtime and then skip
the read-before-write pre-fetch. It could only ever move in one direction:

- A 412 proves `If-Match` was honored, so the flag could be set to `true`.
- A 200 proves nothing. A server that silently ignores `If-Match` returns 200,
  and so does a server that honors it when the revision genuinely matches. The
  flag therefore had no path to `false`, and the "unsupported" branch it
  guarded (`IF_MATCH_SUPPORTED !== false`) was unreachable dead state.

The flag, its test-only accessor `_ifMatchSupportedState()`, and the console
probe recipe are gone. `writeNote` now always read-before-writes when given an
`expectedRevision` and always attaches `If-Match`; a 412 is still mapped to
`ConflictError`, it is just treated as a bonus rather than as evidence to
optimize on. If the pre-fetch ever needs to be dropped for cost reasons, that
has to be settled against Drive's published semantics, not by a self-probe.

### Q2 — Does moving a foreign file into "Wren Notes" grant access under `drive.file`?

**Test procedure:**

1. From `drive.google.com`, drag a file Wren did NOT create into the Wren
   Notes folder (e.g. a screenshot or a random `.md`).
2. From the Wren dev console:

   ```js
   const { DriveAdapter } = await import('./storage/DriveAdapter.js');
   const a = new DriveAdapter();
   await a.initialize();
   const notes = await a.listNotes();
   console.log(notes.map((n) => n.id + ' ' + n.title));
   ```

3. The foreign file should NOT appear (per documented `drive.file` behavior:
   the scope grants access only to files the app created or files the user
   explicitly opens with the app via Drive's picker).

**Outcome (pending Adam's test):** `_____________`

Expected: foreign file not visible. If it IS visible, the scope is broader
than documented and we should reconsider what we surface in `listNotes`.

### Q3 — iOS PWA OAuth redirect re-enters the PWA (post 16.4)?

Deferred to Phase 2c. Requires a real iPhone with iOS 17+.

### Q4 — Chrome Android WebAPK opens Custom Tab or Auth Tab for accounts.google.com?

Deferred to Phase 2c. Requires `chrome://inspect` during a real OAuth flow.

## What Phase 1 does NOT do

- Does not change `src/app-controller.js` or any UI module. The existing app
  still imports from `src/notes-store.js` exactly as before.
- Does not show a "Sign in to Drive" button.
- Does not make Drive the default storage.
- Does not run a continuous sync loop.
- Does not surface conflicts in the UI.

All of those are Phase 2b. The existing app is functionally unchanged from
the user's perspective after Phase 1 ships.

## Phase 2b.1 Status (UI wiring, single-device Drive)

Shipped: the storage layer is now wired into the UI. End users can pick Drive
on first launch, sign in via GIS, and have notes round-trip through
`DriveAdapter` end-to-end on a single device.

### What 2b.1 added

- `src/storage/backendPreference.js` — IndexedDB-backed `storageBackend` key
  (`"fs" | "drive"`), with `getStoredBackend` / `setStoredBackend` /
  `clearStoredBackend` exports.
- `src/storage/activeAdapter.js` — `resolveBackend()` (applies the
  fs-migration heuristic for existing users) and `getActiveAdapter()` factory.
- `StorageAdapter.js` gains `NoBackendConfiguredError` so the boot path can
  branch into the storage-choice onboarding cleanly.
- `FileSystemAdapter` gains a uniform `createNote(content, hint)` method that
  matches the existing `DriveAdapter.createNote` signature. The old
  `slugify` helper is now exported from `notes-store.js` for reuse.
- `gisClient` exports `isIosStandalonePwa()` (with iPadOS 13+ desktop-UA
  workaround: also matches Macintosh UA + `maxTouchPoints > 1`).
- `app-controller.js` now imports from `src/storage/` instead of
  `src/notes-store.js` directly. Boot routes between FS / Drive based on
  stored backend. The adapter interface speaks raw markdown; app-controller
  bridges to the parsed-note shape the UI consumes (parse on read, serialize
  on write).
- New screens: `renderStorageChoice` (two-card onboarding) and
  `renderDriveSignIn` (with iOS double-tap modal per P2c.1 and the
  popup-blocker backstop already present in `gisClient`).
- Sidebar gains a backend indicator chip with a popover for "Switch backend"
  and (Drive only) "Disconnect Drive."
- Drive-disconnected banner + per-write toast (Decision P2c.5). Banner is
  driven by the `onTokenChange` callback in `gisClient`.
- `notes-list.js` renamed `note.filename` → `note.id` to remove the FS-ism
  leak. `note-editor.js` was already field-name-agnostic.

### What 2b.1 explicitly does NOT do (handed to 2b.2)

- Does not pull changes from Drive on app resume (`visibilitychange`). The
  app only fetches `listNotes` from Drive once at boot; concurrent edits on
  another device will not be visible until the next reload.
- Does not detect conflicts. If two devices write the same note
  concurrently, last write to Drive wins; the earlier write's content is
  recoverable from Drive's revision history but not from the Wren UI.
- Does not run a debounced auto-pull. Auto-push is preserved (note-editor's
  500 ms debounce on save events still fires writes through the adapter).
- Does not show conflict badges, conflict toasts, or a dedicated
  conflict-resolution view.

### Design calls baked into 2b.1

- **Sidebar preview on Drive backend uses eager-load (N+1 reads on first
  list).** Acceptable for single-device scope; will be optimized in 2b.2
  when the sync runner introduces a content cache.
- **`createNote` lives on the adapter interface** with a uniform
  `(content, hint)` signature. FS slugifies the title hint; Drive ignores
  the hint and lets Drive assign its own file id.
- **Identifier in the UI is `note.id`** (was `note.filename`). For FS the
  id is the filename; for Drive it's the Drive file ID.

### Known gaps that did NOT block 2b.1

- The backend chip popover would ideally show the signed-in Google account's
  email, but `drive.file` scope does not include profile info. Adding the
  `userinfo.email` scope broadens the consent screen; we deferred that
  decision to Phase 2c when the consent screen is being re-reviewed for
  Google brand verification anyway.
- Empirical Q1 is closed (see above); Q2 is still pending. The
  conflict-detection path is no longer unreachable: `handleSave`,
  `handleKanbanMove`, and the sticky save path all pass `expectedRevision`, so
  read-before-write runs on every conditional write today.

## Phase 2b stub list

Concrete files Phase 2b will add or change:

- `src/sync/syncStateMachine.js` (new) — per-note state model
- `src/sync/conflictResolver.js` (new) — wraps `generateConflictFilename` with
  the write-the-conflict-copy + flip-state logic
- `src/sync/syncRunner.js` (new) — periodic pull + push driver
- `src/app-controller.js` (modify) — swap imports from `./notes-store.js`
  to `./storage/`; add adapter selection logic; wire a "Sign in to Drive"
  button into the onboarding screen
- `src/ui/notes-list.js` (modify) — add "Conflict" badge rendering
- `src/ui/conflict-view.js` (new) — dedicated view for active conflicts

## Phase 2c stub list

- iOS double-tap priming modal (P2c.1)
- `manifest.json` updates: `launch_handler.route_to`, stable `id` (P2c.2)
- `visibilitychange` -> silent token refresh (P2c.3)
- Real-device test matrix execution (P2c.4)
- "Drive disconnected" banner state (P2c.5)

## Phase A — Tags backend (2026-05-27)

- YAML frontmatter now supports optional `tags: [...]` array
- Tag syntax: `namespace:value` colon-delimited (first colon splits)
- Tags without `:` go under pseudo-namespace `_uncategorized`
- Validation in `src/tags/tag-parser.js` — `isValidTag()`, `parseTag()`, `getAllNamespaces()`, `getAllTags()`, `groupNotesByNamespace()`
- Helpers (also in `tag-parser.js`, not `StorageAdapter.js`): `addTagToNote()` (replaces same-namespace), `removeTagFromNote()`
- Parse: `tags` read as JSON array of strings; missing/malformed → `[]` (defensive)
- Serialize: `tags` line written only when non-empty (keeps tag-less frontmatter clean)
- app-controller bridge (loadNotes / openNote / handleNew) carries `tags` through the parse→object→serialize round-trip
- No UI changes yet (Phase B delivers the list filter, Phase C the Kanban view)

## Phase B — List view tag filter (2026-05-27)

- `src/ui/notes-list.js`: tag-filter affordance above the search bar — chips for
  selected tags (click × to remove) + a dropdown to add more
- AND-filter semantics: a note must contain *every* selected tag to show
- Persisted in `localStorage` under `wren.viewMode`-adjacent key `wren.filterTags`
- Hidden entirely when no tags exist anywhere and nothing is selected
- Filter-specific empty state with a "Clear filter" button

## Phase C — Kanban view (2026-05-27)

- `src/ui/kanban-view.js`: board grouped by tag namespace; `createKanbanView({ getNotes, onNoteOpen, onNewNote, onMoveNote })`
- View-toggle (List | Kanban) lives in the **sidebar header** (SOW said "main
  panel header," but the editor fills the main panel and has no header bar —
  sidebar placement is the consistent home; decision confirmed with Adam)
- Kanban fills the main panel; sidebar (list + filter) stays visible (confirmed)
- Group-by dropdown (namespaces from `getAllNamespaces`), persisted to `wren.kanbanGroupBy`
- Columns: tag values alphabetically, `_untagged` catch-all last (empty `_untagged` hidden)
- Cards: note color bg, 2-line title clamp, 1-line preview, click → open in editor (switches to List view per SOW v1 decision)
- Drag-and-drop (C2): HTML5 DnD; dropping a card into a column re-tags via
  `addTagToNote` (replaces same-namespace); dropping into `_untagged` *removes*
  the namespace tag (SOW's handler didn't special-case this — fixed)
- View mode persisted to `wren.viewMode`; forced to List below 640px (extension
  popup is out of scope per SOW); toggle hidden below 640px
- Keyboard: Ctrl/Cmd+1 → List, Ctrl/Cmd+2 → Kanban (caveat: Ctrl+1/2 are
  browser tab-switch keys in a normal tab; harmless in the standalone PWA window)
- localStorage keys kept namespaced: `wren.viewMode`, `wren.kanbanGroupBy`, `wren.filterTags`
