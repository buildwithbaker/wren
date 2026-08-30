// save-queue.js
//
// Serializes async saves so consecutive or flushed saves never OVERLAP, and lets
// a flush await whatever write is currently in flight (audit S7). The editor's
// 500ms autosave debounce plus an explicit flush() (leaving a note, window close,
// tray Quit) could previously fire two doSave() calls that ran concurrently and
// interleaved their writes; this queue orders them into a single chain.
//
// `runSave` performs exactly one save and owns its own error handling — the queue
// only ORDERS calls and exposes whether one is in flight + a promise to await.

/**
 * @param {() => Promise<void>} runSave - performs one save (never rejects out).
 * @returns {{ enqueue: () => Promise<void>, settle: () => Promise<void>, isRunning: () => boolean }}
 */
export function createSaveQueue(runSave) {
  let chain = Promise.resolve();
  // Incremented SYNCHRONOUSLY on enqueue (not when the chained callback later
  // starts) so isRunning() reports true for the whole window a save is pending
  // or in flight — closing the cross-window-sync race hasPendingSave() guards.
  let pending = 0;

  // Append a save to the chain: it starts only after the previous one settles,
  // so two saves can never be in flight at once.
  function enqueue() {
    pending += 1;
    chain = chain.then(async () => {
      try {
        await runSave();
      } finally {
        pending -= 1;
      }
    });
    return chain;
  }

  return {
    enqueue,
    // Resolves once every save queued so far has finished — what flush() returns.
    settle: () => chain,
    isRunning: () => pending > 0,
  };
}
