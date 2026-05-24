// service-worker.js - Wren extension background.
// Required by the MV3 manifest, but intentionally near-empty: all of Wren's
// logic runs in the popup (document context, where the File System Access API
// and IndexedDB are available). The service worker only handles install.

chrome.runtime.onInstalled.addListener(() => {
  // No-op. The chosen notes folder handle is persisted in IndexedDB from the
  // popup; nothing needs to run here while the popup is closed.
});
