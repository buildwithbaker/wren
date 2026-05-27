// conflictDetection.js
//
// Conflict-file naming + stable device identity. Used by the sync runner
// (Phase 2b) to mint conflict-copy files when an optimistic write fails.
//
// Decision provenance: KB Module 05, P2b.2 (Syncthing-style infix).
//   note.md -> note.sync-conflict-YYYYMMDD-HHMMSS-{deviceShortId}.md

import { openScrybeDb } from '../notes-store.js';

// Device ID lives in the same 'handles' store under a distinct key. Cheap to
// share; avoids creating a third object store just for one row.
const DEVICE_ID_KEY = 'wrenDeviceId';
const HANDLES_STORE = 'handles';
const DEVICE_SHORT_LEN = 7;

// ---- Public API --------------------------------------------------------

/**
 * Build a Syncthing-style conflict-copy filename.
 *
 *   base.md           ->  base.sync-conflict-YYYYMMDD-HHMMSS-abc1234.md
 *   base.markdown     ->  base.sync-conflict-YYYYMMDD-HHMMSS-abc1234.markdown
 *   no-extension      ->  no-extension.sync-conflict-YYYYMMDD-HHMMSS-abc1234
 *
 * @param {string} originalName
 * @param {string} deviceShortId - 7-char id, e.g. from getDeviceShortId()
 * @param {Date} [now] - injectable for tests
 * @returns {string}
 */
export function generateConflictFilename(originalName, deviceShortId, now = new Date()) {
  const stamp = formatTimestamp(now);
  const id = (deviceShortId || 'unknown').slice(0, DEVICE_SHORT_LEN);
  const dot = originalName.lastIndexOf('.');
  if (dot <= 0) {
    return `${originalName}.sync-conflict-${stamp}-${id}`;
  }
  const base = originalName.slice(0, dot);
  const ext = originalName.slice(dot); // includes the leading dot
  return `${base}.sync-conflict-${stamp}-${id}${ext}`;
}

/**
 * Returns the 7-char stable device id, generating + persisting one on first
 * call. The full UUID is stored so a future Wren version could surface the
 * full id if needed; only the truncated prefix appears in filenames.
 *
 * @returns {Promise<string>}
 */
export async function getDeviceShortId() {
  const existing = await readDeviceRecord();
  if (existing && typeof existing.shortId === 'string' && existing.shortId.length >= DEVICE_SHORT_LEN) {
    return existing.shortId.slice(0, DEVICE_SHORT_LEN);
  }
  const full = generateUuidV4();
  const shortId = full.replace(/-/g, '').slice(0, DEVICE_SHORT_LEN);
  await writeDeviceRecord({ fullId: full, shortId, createdAt: new Date().toISOString() });
  return shortId;
}

// ---- Internal ----------------------------------------------------------

function formatTimestamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function generateUuidV4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Minimal v4 fallback (good enough for a device id, not for cryptographic use).
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20)
  );
}

async function readDeviceRecord() {
  const db = await openScrybeDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLES_STORE, 'readonly');
      const req = tx.objectStore(HANDLES_STORE).get(DEVICE_ID_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function writeDeviceRecord(value) {
  const db = await openScrybeDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLES_STORE, 'readwrite');
      tx.objectStore(HANDLES_STORE).put(value, DEVICE_ID_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
