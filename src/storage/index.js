// src/storage/index.js
// Public surface of the storage layer. Phase 2b's app-controller refactor
// imports from here rather than reaching into individual files.

export {
  ADAPTER_TYPES,
  ConflictError,
  AdapterAuthError,
  NoBackendConfiguredError,
} from './StorageAdapter.js';
export { FileSystemAdapter } from './FileSystemAdapter.js';
export { DriveAdapter } from './DriveAdapter.js';
export {
  getStoredBackend,
  setStoredBackend,
  clearStoredBackend,
} from './backendPreference.js';
export { resolveBackend, getActiveAdapter } from './activeAdapter.js';
