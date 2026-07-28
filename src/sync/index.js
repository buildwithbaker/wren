// src/sync/index.js
// Public surface of the sync layer (metadata + conflict-file helpers).
// Phase 2b will add the sync runner and state machine on top of these.

export {
  SYNC_STATES,
  getSyncState,
  setSyncState,
  clearSyncState,
  getAllConflicted,
  getAllDirty,
} from './syncStateStore.js';

export { generateConflictFilename, getDeviceShortId, writeConflictCopy } from './conflictDetection.js';

// Live cross-window note sync (Sticky Float Phase 2).
export { createBroadcast, buildNoteSavedMessage, shouldIgnoreMessage } from './broadcast.js';
