// Regression (audit S9, S10, 2026-07-25):
//
//  S10 — a 401 that arrives on a RETRIED request (attempt > 0) used to fall
//        through shouldRetry() into a generic Error, so a dead Drive session
//        surfaced as "Save failed" instead of the Drive reconnect banner.
//        Every 401 after the single silent re-acquire must now be an
//        AdapterAuthError.
//
//  S9  — writeNote must always read-before-write when given an
//        expectedRevision. The old IF_MATCH_SUPPORTED probe could skip the
//        pre-fetch after a single 412, and could never learn the "unsupported"
//        answer, so it is gone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DriveAdapter } from '../src/storage/DriveAdapter.js';
import { AdapterAuthError, ConflictError } from '../src/storage/StorageAdapter.js';

const auth = vi.hoisted(() => ({ silentRefreshOk: true, refreshes: 0 }));

vi.mock('../src/oauth/gisClient.js', () => ({
  getAccessToken: () => 'test-token',
  requestAccessToken: async () => {
    auth.refreshes += 1;
    if (!auth.silentRefreshOk) throw new Error('consent required');
    return { token: 'test-token' };
  },
  initTokenClient: () => {},
}));

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers(),
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

/** An adapter that believes it is initialized, without touching the network. */
function readyAdapter() {
  const a = new DriveAdapter();
  a._folderId = 'folder-1';
  return a;
}

beforeEach(() => {
  auth.silentRefreshOk = true;
  auth.refreshes = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DriveAdapter 401 handling (S10)', () => {
  it('maps a 401 arriving after a 5xx retry to AdapterAuthError, not a generic Error', async () => {
    // attempt 0 -> 500 (retryable, bumps attempt to 1)
    // attempt 1 -> 401 (the bug: attempt !== 0, so the old code skipped the
    //                   auth branch entirely)
    // attempt 2 -> 401 again, after the one silent re-acquire is spent
    const statuses = [500, 401, 401];
    let i = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(statuses[Math.min(i++, statuses.length - 1)], { error: 'x' }))
    );

    // An unconditional write is exactly one _driveFetch, so the attempt
    // counter in the assertion below maps 1:1 onto the retry chain.
    const a = readyAdapter();
    const err = await a.writeNote('file-1', 'a').catch((e) => e);
    expect(err).toBeInstanceOf(AdapterAuthError);
    expect(err.recoverable).toBe(true);
  }, 20000);

  it('spends exactly one silent re-acquire per request before giving up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: 'unauthorized' }))
    );
    const a = readyAdapter();
    await expect(a.writeNote('file-1', 'a')).rejects.toBeInstanceOf(AdapterAuthError);
    // 401 -> one silent re-acquire -> retry -> 401 -> AdapterAuthError.
    // No second re-acquire, and no fall-through to the generic error path.
    expect(auth.refreshes).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('maps a failed silent re-acquire to AdapterAuthError', async () => {
    auth.silentRefreshOk = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: 'unauthorized' }))
    );
    const a = readyAdapter();
    await expect(a.writeNote('file-1', 'a')).rejects.toBeInstanceOf(AdapterAuthError);
    expect(auth.refreshes).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('DriveAdapter conditional write (S9)', () => {
  it('read-before-writes on every conditional write — no probe state to skip it', async () => {
    const calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        calls.push(String(url));
        if (String(url).includes('/upload/')) {
          return jsonResponse(200, { headRevisionId: 'rev-2' });
        }
        return jsonResponse(200, { headRevisionId: 'rev-1' });
      })
    );

    const a = readyAdapter();
    // Two conditional writes back to back. The old code would have been free to
    // skip the second pre-fetch had the probe flipped; it must not.
    await a.writeNote('file-1', 'a', 'rev-1');
    await a.writeNote('file-1', 'b', 'rev-1');

    const metaFetches = calls.filter((u) => !u.includes('/upload/'));
    const uploads = calls.filter((u) => u.includes('/upload/'));
    expect(metaFetches).toHaveLength(2);
    expect(uploads).toHaveLength(2);
  });

  it('throws ConflictError from the read-before-write comparison', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).includes('/upload/')) {
          throw new Error('upload should never be reached on a stale revision');
        }
        return jsonResponse(200, { headRevisionId: 'rev-9' });
      })
    );
    const a = readyAdapter();
    const err = await a.writeNote('file-1', 'a', 'rev-1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.remoteRevision).toBe('rev-9');
  });

  it('sends If-Match alongside the pre-fetch and maps a 412 to ConflictError', async () => {
    let sentIfMatch = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => {
        if (String(url).includes('/upload/')) {
          sentIfMatch = new Headers(opts.headers).get('If-Match');
          return jsonResponse(412, { error: 'precondition failed' });
        }
        return jsonResponse(200, { headRevisionId: 'rev-1' });
      })
    );
    const a = readyAdapter();
    const err = await a.writeNote('file-1', 'a', 'rev-1').catch((e) => e);
    expect(sentIfMatch).toBe('rev-1');
    expect(err).toBeInstanceOf(ConflictError);
  });

  it('does not attach If-Match when the caller supplies no expectation', async () => {
    let sentIfMatch = 'unset';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => {
        if (String(url).includes('/upload/')) {
          sentIfMatch = new Headers(opts.headers).get('If-Match');
          return jsonResponse(200, { headRevisionId: 'rev-2' });
        }
        throw new Error('no pre-fetch expected for an unconditional write');
      })
    );
    const a = readyAdapter();
    await a.writeNote('file-1', 'a');
    expect(sentIfMatch).toBeNull();
  });
});
