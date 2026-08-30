// @vitest-environment jsdom
//
// Regression (audit S12, 2026-07-25): a Kanban drag is a human edit, but
// handleKanbanMove wrote the moved note WITHOUT stamping last_edited_by /
// last_edited the way handleSave does. An AI-edited note therefore kept its
// "edited by AI" badge and last-updated attribution after a person had moved
// its card — provenance silently going stale on the one interaction that has
// no other trace.
//
// This is the first test to drive app-controller.js end to end. The handlers
// there decide what actually gets written, and until now none of them were
// reachable: boot() bails to "browser not supported" in jsdom, then to
// storage-choice with no ready adapter. tests/helpers/mount-app.js closes that
// gap by booting the real controller against a fake StorageAdapter.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Importing the harness installs the storage mocks it needs (top-level
// vi.mock, hoisted by vitest ahead of app-controller's import).
import { mountApp, frontmatterOf } from './helpers/mount-app.js';

const AI_NOTE = {
  id: 'ai-note.md',
  wrenId: 'wren-aiaiaiaiaiai',
  title: 'Drafted by the assistant',
  body: 'AI wrote this.',
  tags: ['status:todo'],
  created: '2026-07-01T00:00:00.000Z',
  modified: '2026-07-02T00:00:00.000Z',
  createdBy: 'ai',
  lastEditedBy: 'ai',
  lastEdited: '2026-07-02T00:00:00.000Z',
};

// Human-CREATED but AI-last-edited. This is the fixture where S12 is
// user-visible: isAiNote() is `createdBy === 'ai' || lastEditedBy === 'ai'`, so
// once a human moves this card the badge must disappear. (AI_NOTE above keeps
// its badge forever via created_by — that is by design, not a bug.)
const AI_EDITED_NOTE = {
  id: 'ai-edited.md',
  wrenId: 'wren-aiediteddddd',
  title: 'Human note the assistant touched',
  body: 'AI last edited this.',
  tags: ['status:todo'],
  created: '2026-07-01T00:00:00.000Z',
  modified: '2026-07-02T00:00:00.000Z',
  createdBy: 'human',
  lastEditedBy: 'ai',
  lastEdited: '2026-07-02T00:00:00.000Z',
};

const OTHER_NOTE = {
  id: 'other.md',
  wrenId: 'wren-otherotherx',
  title: 'Already in doing',
  body: 'human note',
  tags: ['status:doing'],
  created: '2026-07-01T00:00:00.000Z',
  modified: '2026-07-01T00:00:00.000Z',
};

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

async function mountBoard() {
  const app = await mountApp({ notes: [AI_NOTE, AI_EDITED_NOTE, OTHER_NOTE] });
  app.setView('kanban');
  await app.waitFor(() => app.card('ai-note.md'));
  return app;
}

/** Drive a move through the keyboard affordance the board actually ships. */
async function moveViaMenu(app, noteId, columnLabel) {
  app.card(noteId).querySelector('.sc-kanban-card-move').click();
  const item = await app.waitFor(() =>
    Array.from(document.querySelectorAll('.sc-kanban-movemenu-item')).find(
      (i) => i.textContent === columnLabel
    )
  );
  if (!item) throw new Error(`no "${columnLabel}" column in the move menu`);
  item.click();
  return app.waitFor(() => app.calls.writeNote.length > 0);
}

describe('Kanban move stamps human provenance (S12)', () => {
  it('writes last_edited_by: human over an AI note', async () => {
    const app = await mountBoard();
    await moveViaMenu(app, 'ai-note.md', 'doing');

    expect(app.calls.writeNote).toHaveLength(1);
    const write = app.calls.writeNote[0];
    expect(write.id).toBe('ai-note.md');

    const fm = frontmatterOf(write.content);
    expect(fm.last_edited_by).toBe('human');
    // created_by is deliberately preserved — an AI-CREATED note keeps its badge
    // even after a human edits it. Only the last-editor flips.
    expect(fm.created_by).toBe('ai');
    // last_edited must advance past the AI's stamp, not stay frozen.
    expect(fm.last_edited).toBeTruthy();
    expect(new Date(fm.last_edited).getTime()).toBeGreaterThan(
      new Date(AI_NOTE.lastEdited).getTime()
    );
    expect(fm.last_edited).toBe(fm.modified);
  });

  it('actually performs the move it is stamping', async () => {
    const app = await mountBoard();
    await moveViaMenu(app, 'ai-note.md', 'doing');
    const fm = frontmatterOf(app.calls.writeNote[0].content);
    expect(JSON.parse(fm.tags)).toContain('status:doing');
    expect(JSON.parse(fm.tags)).not.toContain('status:todo');
  });

  it('passes the revision it just read, so a concurrent write still conflicts', async () => {
    const app = await mountBoard();
    await moveViaMenu(app, 'ai-note.md', 'doing');
    // The provenance stamp must not have cost the optimistic-concurrency gate.
    expect(app.calls.writeNote[0].expectedRevision).toBeTruthy();
  });

  it('updates the in-memory note too, so the badge clears without a reload', async () => {
    const app = await mountBoard();
    // Badge is present before the move (human-created, AI-last-edited).
    expect(app.card('ai-edited.md').querySelector('.sc-ai-badge')).toBeTruthy();

    await moveViaMenu(app, 'ai-edited.md', 'doing');

    // The badge reads the IN-MEMORY note. Stamping only the file on disk would
    // leave "AI" on screen until the next reload — which is exactly how this
    // regression would have gone unnoticed.
    const cleared = await app.waitFor(
      () => app.card('ai-edited.md') && !app.card('ai-edited.md').querySelector('.sc-ai-badge')
    );
    expect(cleared).toBeTruthy();
    expect(frontmatterOf(app.calls.writeNote[0].content).last_edited_by).toBe('human');
  });

  it('keeps the badge on an AI-CREATED note — created_by is never clobbered', async () => {
    const app = await mountBoard();
    await moveViaMenu(app, 'ai-note.md', 'doing');
    // Still AI, because it was AI-authored. Only the last-editor flipped.
    const stillBadged = await app.waitFor(
      () => app.card('ai-note.md')?.querySelector('.sc-ai-badge')
    );
    expect(stillBadged).toBeTruthy();
  });

  it('does not write at all when the card is dropped back in its own column', async () => {
    const app = await mountBoard();
    // 'todo' is AI_NOTE's current column, so the menu must not offer it...
    app.card('ai-note.md').querySelector('.sc-kanban-card-move').click();
    const labels = Array.from(document.querySelectorAll('.sc-kanban-movemenu-item')).map(
      (i) => i.textContent
    );
    expect(labels).not.toContain('todo');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // ...and nothing was persisted.
    expect(app.calls.writeNote).toHaveLength(0);
  });
});

describe('The harness reaches the controller it claims to (meta)', () => {
  it('boots the real app shell against the fake adapter', async () => {
    const app = await mountApp({ notes: [AI_NOTE] });
    expect(app.app).toBeTruthy();
    expect(document.querySelectorAll('.sc-card')).toHaveLength(1);
    expect(app.calls.writeNote).toHaveLength(0);
    // Provenance survived the load path, which is what makes the S12
    // assertions meaningful rather than vacuous.
    expect(app.app.querySelector('.sc-ai-badge')).toBeTruthy();
  });
});
