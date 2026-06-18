// broadcast.js
// Thin wrapper over BroadcastChannel('wren-notes') for live cross-window note
// sync (Sticky Float Phase 2). Every window (the main app and each pop-out
// sticky) posts after a successful save; peers re-read the note. Last-write-
// wins — there is no conflict UI, consistent with Drive Phase 2b.1 semantics.
//
// Each window stamps its messages with a random per-window instanceId so a
// window can ignore the echo of its own post. Browsers without BroadcastChannel
// (older Safari, some embedded webviews) degrade to a silent no-op rather than
// throwing — the app still works, just without live cross-window refresh.
//
// Decision provenance: project-blueprints/wren/future-enhancements/sticky-float-sow.md (Phase 2)

const CHANNEL_NAME = 'wren-notes';

/**
 * Build the canonical `note-saved` message payload. Pure (no I/O) so the shape
 * is unit-testable. Carries both identities: `id` (storage id — FS filename /
 * Drive fileId) and `wrenId` (the stable logical id) so a peer can match the
 * note however it tracks it.
 *
 * @param {{id?: string, wrenId?: string, modified?: string}} note
 * @param {string} source - the posting window's instanceId
 */
export function buildNoteSavedMessage(note, source) {
  return {
    type: 'note-saved',
    id: note?.id || '',
    wrenId: note?.wrenId || '',
    modified: note?.modified || '',
    source,
  };
}

/**
 * Whether a received message originated from this same window (the Broadcast
 * channel echoes posts to every listener, including the sender). Pure helper —
 * also guards against malformed/foreign messages. Returns true (= ignore) for
 * anything that isn't a well-formed `note-saved` from another window.
 *
 * @param {*} msg
 * @param {string} instanceId
 */
export function shouldIgnoreMessage(msg, instanceId) {
  if (!msg || typeof msg !== 'object') return true;
  if (msg.type !== 'note-saved') return true;
  return msg.source === instanceId;
}

// Random per-window id. crypto.randomUUID where available; Math.random fallback
// keeps the wrapper working in test/Node contexts without crypto.
function makeInstanceId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `win-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Open the shared notes channel. Returns:
 *   - instanceId: this window's id (exposed for tests / debugging)
 *   - postNoteSaved(note): broadcast that `note` was just saved
 *   - onNoteSaved(handler): register a handler; it receives every peer's
 *     note-saved message (own echoes already filtered out). Returns an
 *     unsubscribe function.
 *   - close(): tear down the channel
 *
 * When BroadcastChannel is unavailable every method is a safe no-op and
 * onNoteSaved's unsubscribe is a no-op too.
 */
export function createBroadcast() {
  const instanceId = makeInstanceId();
  const supported = typeof BroadcastChannel !== 'undefined';
  /** @type {BroadcastChannel|null} */
  const channel = supported ? new BroadcastChannel(CHANNEL_NAME) : null;
  /** @type {Set<(msg: object) => void>} */
  const handlers = new Set();

  if (channel) {
    channel.onmessage = (event) => {
      const msg = event.data;
      if (shouldIgnoreMessage(msg, instanceId)) return;
      for (const handler of handlers) {
        try {
          handler(msg);
        } catch (err) {
          console.warn('note-saved handler threw', err);
        }
      }
    };
  }

  return {
    instanceId,
    postNoteSaved(note) {
      if (!channel) return;
      try {
        channel.postMessage(buildNoteSavedMessage(note, instanceId));
      } catch (err) {
        // postMessage can throw on un-cloneable data; our payload is plain, so
        // this is defensive only.
        console.warn('Could not post note-saved', err);
      }
    },
    onNoteSaved(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      handlers.clear();
      if (channel) channel.close();
    },
  };
}
