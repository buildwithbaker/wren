// @vitest-environment jsdom
//
// Backfill coverage for the audit findings that round 1 fixed but closed on
// CODE REVIEW ONLY, because app-controller.js had no test harness at the time:
//
//  S1 (Critical) — every save was an unconditional last-write-wins. The
//      adapters' conditional-write support, ConflictError, and the whole
//      conflict-copy module shipped with zero callers, so editing a note in
//      Obsidian while Wren had it open meant Wren's next autosave silently
//      destroyed the external edit. The fix was to pass note.revision as
//      expectedRevision on every save path and to surface ConflictError.
//
//  S2 (High) — a rename with a sticky/second window open resurrected the old
//      file as a diverging duplicate, because on the FS backend the filename IS
//      the note's identity and the new id was never cascaded.
//
//  Conflict-copy path — the losing edit must be preserved as a
//      `.sync-conflict-<stamp>-<device>.md` file and the user told where it
//      went, never silently dropped. It must ALSO not fire when there is
//      nothing to preserve, or ordinary typing spawns junk side-files.
//
// These are the three the harness was built for. Verified as real regression
// tests by mutation (see the commit message).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountApp, frontmatterOf, cleanupApp } from './helpers/mount-app.js';

// A conflict the CONTROLLER will recognize. app.errors.ConflictError comes from
// the same mocked storage/index.js the controller imports — constructing one
// from the test file's own import yields a different class object, `instanceof`
// fails inside the controller, and the conflict falls through to the generic
// "Save failed" branch. That made an earlier draft of this file pass for the
// wrong reason.
function conflictError(app) {
  return new app.errors.ConflictError('Revision mismatch', {
    localRevision: 'rev-1',
    remoteRevision: 'rev-elsewhere',
  });
}

const NOTE = {
  id: '2026-07-01 - Groceries.md',
  wrenId: 'wren-groceriesxx',
  title: 'Groceries',
  body: 'milk',
  tags: [],
  created: '2026-07-01T00:00:00.000Z',
  modified: '2026-07-01T00:00:00.000Z',
};

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  // Close the mounted app's BroadcastChannel — otherwise its note-saved handler
  // keeps firing during later tests.
  cleanupApp();
  vi.useRealTimers();
});

async function openTheNote() {
  const app = await mountApp({ notes: [NOTE] });
  app.setView('list');
  await app.openNote(NOTE.id);
  return app;
}

describe('Saves are conditional, not last-write-wins (S1)', () => {
  it('passes the note revision as expectedRevision on an editor save', async () => {
    const app = await openTheNote();
    const seededRevision = (await app.adapter.readNote(NOTE.id)).revision;

    app.setTitle('Groceries and sundries');
    await app.waitFor(() => app.calls.writeNote.length > 0, { timeout: 4000 });

    const write = app.calls.writeNote[0];
    // The whole of S1: an undefined expectedRevision here means the adapter
    // writes unconditionally and an external edit is destroyed with no warning.
    expect(write.expectedRevision).toBe(seededRevision);
    expect(write.expectedRevision).not.toBeUndefined();
  });

  it('stamps human provenance on an editor save', async () => {
    const app = await openTheNote();
    app.setTitle('Retitled by a person');
    await app.waitFor(() => app.calls.writeNote.length > 0, { timeout: 4000 });
    const fm = frontmatterOf(app.calls.writeNote[0].content);
    expect(fm.last_edited_by).toBe('human');
  });
});

describe('A losing save is preserved as a conflict copy, never dropped', () => {
  it('writes a .sync-conflict copy holding the losing text and names it in a toast', async () => {
    const app = await openTheNote();

    // Someone else (Obsidian, another device, the MCP) wrote the note first, so
    // our conditional write comes back as a conflict. Also change what is on
    // disk, or the "nothing to preserve" guard correctly skips the copy.
    app.adapter._files.set(NOTE.id, {
      ...app.adapter._files.get(NOTE.id),
      content: app.adapter._files
        .get(NOTE.id)
        .content.replace('milk', 'bread — written by the other editor'),
      revision: 'rev-elsewhere',
    });
    app.adapter.failNextWriteWith = conflictError(app);

    app.setTitle('My losing edit');
    const copy = await app.waitFor(
      () => app.calls.writeNote.find((w) => w.id.includes('.sync-conflict-')),
      { timeout: 4000 }
    );

    expect(copy).toBeTruthy();
    // Syncthing-style naming: base.sync-conflict-YYYYMMDD-HHMMSS-<7 char id>.md
    expect(copy.id).toMatch(/^2026-07-01 - Groceries\.sync-conflict-\d{8}-\d{6}-[0-9a-f]{7}\.md$/);
    // The copy holds OUR text — the edit that lost — not the winner's.
    expect(copy.content).toContain('My losing edit');
    // Empty expectedRevision is the create-intent signal to the FS adapter.
    expect(copy.expectedRevision).toBe('');

    // The user is told where it went, with a one-click way to open it.
    const toast = await app.waitFor(() => document.querySelector('.sc-toast'));
    expect(toast.textContent).toContain('.sync-conflict-');
    expect(toast.querySelector('.sc-toast-action')?.textContent).toBe('Open');
  });

  it('does NOT spawn a copy when the losing edit has nothing to preserve', async () => {
    // The conflict is real (the revision moved), but the winner left exactly
    // what we were trying to write — our earlier save landed, or the other
    // writer saved the same thing. There is nothing of ours to preserve, and
    // writing a side file here is how a user ends up with junk they think ate
    // their work.
    const app = await openTheNote();
    app.adapter.failNextWriteWith = (id, attemptedContent) => {
      app.adapter._files.set(id, {
        ...app.adapter._files.get(id),
        content: attemptedContent,
        revision: 'rev-elsewhere',
      });
      return conflictError(app);
    };

    app.setTitle('Groceries — same on both sides');
    await app.waitFor(() => app.calls.writeNote.length > 0, { timeout: 4000 });
    // Give the conflict handler room to (not) write a copy.
    await new Promise((r) => setTimeout(r, 250));

    expect(app.calls.writeNote.filter((w) => w.id.includes('.sync-conflict-'))).toHaveLength(0);
    expect(app.calls.createNote.filter((c) => c.id.includes('.sync-conflict-'))).toHaveLength(0);
  });
});

describe('A rename cascades its new id instead of leaving a duplicate (S2)', () => {
  it('adopts the new filename as the note id everywhere', async () => {
    const app = await openTheNote();

    app.setTitle('Shopping list');
    await app.waitFor(() => app.calls.renameNote.length > 0, { timeout: 4000 });

    const rename = app.calls.renameNote[0];
    expect(rename.id).toBe(NOTE.id);
    expect(rename.desiredName).toBe('2026-07-01 - Shopping list.md');

    // On the FS backend the filename IS the identity. If the new id is not
    // cascaded, the old id lives on in the model and the next save recreates
    // the old file alongside the new one — the diverging duplicate in S2.
    const newId = '2026-07-01 - Shopping list.md';
    const cardAdopted = await app.waitFor(() =>
      document.querySelector(`.sc-card[data-id="${newId}"]`)
    );
    expect(cardAdopted).toBeTruthy();
    expect(document.querySelector(`.sc-card[data-id="${NOTE.id}"]`)).toBeNull();
    expect(document.querySelectorAll('.sc-card')).toHaveLength(1);
  });

  it('leaves exactly one file on the backend after a rename', async () => {
    const app = await openTheNote();
    app.setTitle('Shopping list');
    await app.waitFor(() => app.calls.renameNote.length > 0, { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 250));

    const noteFiles = Array.from(app.adapter._files.keys()).filter((k) => k.endsWith('.md'));
    expect(noteFiles).toEqual(['2026-07-01 - Shopping list.md']);
  });
});
