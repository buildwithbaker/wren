# Wren - list / editor performance harness

`scripts/perf-note-open.mjs` measures the note-open and save paths in a **real
Chromium** (not jsdom) against the shipped app on the local-folder backend. It
is a **manual** tool: no CI job, and `playwright-core` is deliberately **not** a
dependency of this repo.

**Refresh the numbers below at each release that touches the list or the editor**
(`src/ui/notes-list.js`, `compact-view.js`, `card-reconciler.js`,
`note-editor.js`, `editor.js`, `app-controller.js` open/save paths).

## Running it

1. Install `playwright-core` anywhere outside the repo and point at that folder:

   ```bash
   mkdir /tmp/pw && cd /tmp/pw && npm init -y && npm i playwright-core
   export PLAYWRIGHT_CORE=/tmp/pw        # the dir that contains node_modules/
   ```

2. It drives your installed **Chrome** (default) or **Edge** (`--browser=msedge`);
   nothing is downloaded.
3. Start the app, then run the script against it:

   ```bash
   npm run dev -- --port 5173            # dev server: per-stage timings
   node scripts/perf-note-open.mjs       # defaults to http://localhost:5173

   npm run build && npx vite preview --port 4173   # production build: totals + long tasks
   node scripts/perf-note-open.mjs http://localhost:4173
   ```

   Options: `--switches=30` (samples per section), `--browser=chrome|msedge`.

**Dev vs preview.** Against the Vite dev server the script rewrites the open-path
modules in flight (a `page.route` handler) to add `performance.now()` timers, so
it can report every stage. Against `preview` nothing is rewritten, so you get the
click-to-painted totals and the long-task counts only. Dev is a little slower in
absolute terms; compare like with like.

## What it does (no app changes)

- `page.addInitScript` stubs `window.showDirectoryPicker` to return an OPFS
  directory (`navigator.storage.getDirectory()`), so the real File System Access
  code path runs. The app launches in **Compact** view (editor hidden), so the
  script switches to **List** first - measuring a hidden editor is meaningless.
- **Fixture:** 500 notes of ~2 KB (frontmatter + two tags + headings, lists,
  tasks, links) and one 50 KB note, named `2026-10-22 - <title>.md` like real
  Wren files (so a save never triggers a rename).
- **Click to painted** = `click()` on a list card until the title, the
  ProseMirror content and the toolbar are present and visible, plus two
  `requestAnimationFrame`s (the second runs after the frame is painted).
- Sections: clean switches; the 50 KB note; switch away from a note with a
  pending edit; one post-save list update (edit, wait for the autosave); typing
  for 10 s with an autosave firing in each pause (Long Tasks API, tasks > 50 ms);
  Kanban `refresh()` and Compact `render()` (each view switch re-renders them).

## Budgets (500 notes)

| Measure | Budget |
|---|---|
| Click to painted, clean switch | p50 < 100 ms, p95 < 200 ms (24 / 27 ms baseline - must not get worse) |
| One post-save list update | p95 < 16 ms |
| Switch with a pending edit | p50 < 100 ms, p95 < 200 ms |
| Typing 10 s, autosave firing | no long task > 50 ms caused by the save path |

## Numbers - 2026-10-23, Chrome, 500 notes, p50 / p95 in ms

R3b replaced the per-save full rebuild of the sidebar list with keyed
reconciliation (`src/ui/card-reconciler.js`). Stage rows are from the dev server;
totals and long tasks were taken on both dev and the production build.

| Measure | Before | After |
|---|---|---|
| **One post-save list update** (`list render`) | 66.8 / 75.1 | **1.1 / 1.6** |
| **Switch with a pending edit** - click to painted (dev) | 190.4 / 199.3 | **37.1 / 45.1** |
| &nbsp;&nbsp;same, production build | 182.9 / 225.2 | **32.6 / 38.9** |
| &nbsp;&nbsp;`flush` (includes the save + list update) | 75.8 / 82.3 | 4.5 / 9.5 |
| &nbsp;&nbsp;layout flushed at the next layout-dependent call | 65.6 / 70.1 | 1.4 / 1.9 |
| **Long tasks > 50 ms, 30 idle autosaves** (dev) | 30, longest 78 ms | **0** |
| &nbsp;&nbsp;same, production build | 30, longest 85 ms | **0** |
| **Typing 10 s, autosave firing** (dev) | 10 tasks, longest 92 ms | **0** |
| &nbsp;&nbsp;same, production build | 11 tasks, longest 72 ms | **0** |
| Clean switch - click to painted (dev) | 25.2 / 27.8 | 25.1 / 29.0 (unchanged) |
| &nbsp;&nbsp;same, production build | 21.7 / 25.0 | 22.9 / 26.1 (unchanged) |
| 50 KB note - click to painted (dev) | 76.7 / 108.6 | 77.8 / 94.6 (unchanged) |
| Kanban `refresh()` per view switch | 15.3 / 23.4 | 15.9 / 19.3 (unchanged; not touched) |
| Compact `render()` per view switch / `loadNotes` | 34.6 / 43.7 | 39.2 / 42.8 (unchanged; not touched) |

Clean-switch stage breakdown (dev, unchanged by R3b): `readNote` 4 ms,
`parseNote` 0, `flush` 0, `teardownEditor` 0.4, `createEditor` 10, `createToolbar`
0.4. The 50 KB note spends ~43 ms in `createEditor`.

### Where the old cost was

No line in the render path reads layout. `notes-list.js` `render()` did
`scroll.replaceChildren()` and rebuilt every card (~1,500 nodes at 500 notes) on
every save; the browser then paid for style + layout of all of them at the **first
layout-dependent call afterwards**. On a switch that was `teardownEditor`
(`note-editor.js`: `editor.destroy()` and the `replaceChildren()` calls on the
focused editor), which is why it measured ~63 ms with no obvious cause. A probe
(`document.body.offsetHeight` right after `flush`) absorbs the same ~65 ms and
leaves `teardownEditor` at 0.4 ms. With the keyed render no node is rebuilt, so
there is no deferred layout to flush and nothing to defer to `requestAnimationFrame`.

### Compact view

`compact-view.js` still rebuilds on every `setNotes` (34-44 ms at 500 notes). It
is not called on a save (only on `loadNotes`, a remote-save refresh and a switch
into Compact) and stays under the 50 ms long-task line, so it was **not** changed.
Revisit if a save path ever starts calling it.

## Caveats

- OPFS stands in for the user's folder. The Tauri desktop file path goes through
  plugin IPC and is not measured here; confirm on a desktop smoke test.
- Timings vary a few ms run to run; judge changes of 10 % or more.
