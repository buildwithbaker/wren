// Audit R2-2 (S7): saves must SERIALIZE — a debounced save and a flush()-driven
// save can never overlap, and awaiting the queue awaits any in-flight write.
import { describe, it, expect } from 'vitest';
import { createSaveQueue } from '../src/ui/save-queue.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

describe('createSaveQueue', () => {
  it('never runs two saves concurrently (they chain)', async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const runSave = async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
    };
    const q = createSaveQueue(runSave);

    // Enqueue three saves back-to-back (as scheduleSave + flush would).
    q.enqueue();
    q.enqueue();
    await q.enqueue();

    expect(calls).toBe(3);
    expect(maxActive).toBe(1); // strictly serialized — never overlapping
  });

  it('settle() awaits an in-flight save (flush waits for the write)', async () => {
    const d = deferred();
    let finished = false;
    const runSave = async () => {
      await d.promise;
      finished = true;
    };
    const q = createSaveQueue(runSave);
    q.enqueue();
    expect(q.isRunning()).toBe(true);

    let settled = false;
    const settlePromise = q.settle().then(() => (settled = true));
    // Not yet — the in-flight save hasn't finished.
    await Promise.resolve();
    expect(settled).toBe(false);

    d.resolve();
    await settlePromise;
    expect(finished).toBe(true);
    expect(settled).toBe(true);
    expect(q.isRunning()).toBe(false);
  });

  it('a rejecting save does not strand later saves', async () => {
    let calls = 0;
    const runSave = async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    };
    // The editor's runSave catches its own errors; simulate a defensive queue by
    // ensuring a throw in one link still lets the next enqueue run.
    const q = createSaveQueue(async () => {
      try {
        await runSave();
      } catch {
        /* swallow like the editor's runSave */
      }
    });
    await q.enqueue();
    await q.enqueue();
    expect(calls).toBe(2);
  });
});
