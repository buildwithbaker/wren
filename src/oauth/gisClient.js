// gisClient.js
//
// Encapsulates the Google Identity Services (GIS) Token Model flow for Wren.
// All token state is in-memory only — by design, per KB Module 05 P1.2:
//
//   "Lowest XSS risk - nothing to exfiltrate from persistent storage. Aligns
//    with GIS's no-automatic-refresh design. Fast silent re-acquire via
//    prompt: '' makes the cost of in-memory acceptable."
//
// Page reloads drop the token; the caller calls requestAccessToken({silent:true})
// on resume to silently re-acquire one if the user has previously consented.
//
// Decision provenance: KB Module 05, P1.1 (Token Model), P1.2 (memory-only),
// P1.7 (CSP includes accounts.google.com), P2c.1 (popup-blocker backstop).

// OAuth Client ID for Wren. Web application, Authorized JavaScript origins:
//   http://localhost:5173, http://localhost, https://wren-ckn.pages.dev
//   (Cloudflare Pages production origin).
// Created in Google Cloud project "Wren" on 2026-05-26.
const DRIVE_CLIENT_ID =
  '1032576056803-k8kd3hb2lnl4u6qs6416q9rfdhhce9kk.apps.googleusercontent.com';

// drive.file is the non-sensitive scope: per-app folder + files the app
// created or files the user explicitly opened with the app. KB Module 05 P1.6
// is built on this scope choice (no CASA assessment, brand-verification path).
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

// Safety-net timeout if GIS itself hangs (never fires the error_callback).
// The original 4s was too aggressive — real first-time OAuth flows take
// 15-40s for users to navigate the account picker + "unverified app" warning
// + scope consent. GIS reliably fires error_callback within milliseconds of
// an actual popup block, so this timer doesn't need to compete with the
// real-world flow. 120s acts only as a "GIS hung" safety net.
const POPUP_BLOCKED_TIMEOUT_MS = 120_000;

// Safety margin used by getAccessToken(): consider the token expired this many
// ms BEFORE its real expiry to avoid using a token that dies mid-request.
const EXPIRY_SAFETY_MS = 60_000;

// ---- Module-level state (in-memory only) ----------------------------------

/** @type {Promise<void>|null} */
let loadPromise = null;
/** @type {any|null} GIS TokenClient instance */
let tokenClient = null;
/** @type {string|null} */
let currentAccessToken = null;
/** @type {number|null} ms timestamp */
let tokenExpiresAt = null;
/** @type {((token: string|null) => void)|null} */
let onTokenChangeCallback = null;
/** @type {{resolve: Function, reject: Function, timer: any}|null} */
let pendingRequest = null;

// ---- GIS script loader ----------------------------------------------------

/**
 * Lazy-load https://accounts.google.com/gsi/client by injecting a script tag.
 * Subsequent calls return the cached promise so the script is only fetched
 * once per page load.
 *
 * @returns {Promise<void>}
 */
export function loadGisScript() {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('GIS can only be loaded in a browser document'));
      return;
    }
    if (window.google?.accounts?.oauth2) {
      resolve();
      return;
    }
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('GIS script failed to load')), {
        once: true,
      });
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener(
      'error',
      () => {
        loadPromise = null; // allow a retry
        reject(new Error('GIS script failed to load'));
      },
      { once: true }
    );
    document.head.appendChild(script);
  });
  return loadPromise;
}

// ---- Token client ---------------------------------------------------------

/**
 * Initialize the GIS TokenClient. Idempotent: re-calls update the callback
 * but reuse the same underlying client.
 *
 * @param {{onTokenChange?: (token: string|null) => void}} [opts]
 */
export async function initTokenClient(opts = {}) {
  await loadGisScript();
  onTokenChangeCallback = opts.onTokenChange || null;
  if (tokenClient) return tokenClient;
  if (!window.google?.accounts?.oauth2) {
    throw new Error('google.accounts.oauth2 not available after script load');
  }
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: DRIVE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: handleTokenResponse,
    error_callback: handleTokenError,
  });
  return tokenClient;
}

function handleTokenResponse(resp) {
  clearPendingTimer();
  if (resp && resp.access_token) {
    currentAccessToken = resp.access_token;
    // expires_in is seconds.
    const expiresInMs = Number(resp.expires_in || 0) * 1000;
    tokenExpiresAt = expiresInMs > 0 ? Date.now() + expiresInMs : null;
    if (onTokenChangeCallback) {
      try {
        onTokenChangeCallback(currentAccessToken);
      } catch (e) {
        console.warn('onTokenChange handler threw', e);
      }
    }
    if (pendingRequest) {
      pendingRequest.resolve({ token: currentAccessToken, expiresAt: tokenExpiresAt });
      pendingRequest = null;
    }
  } else {
    // GIS sometimes calls the callback without an access_token when the user
    // dismisses the consent dialog. Treat as a soft failure.
    const err = new Error('GIS returned no access_token');
    err.code = 'no_token';
    if (pendingRequest) {
      pendingRequest.reject(err);
      pendingRequest = null;
    }
  }
}

function handleTokenError(err) {
  clearPendingTimer();
  if (pendingRequest) {
    pendingRequest.reject(err instanceof Error ? err : new Error(JSON.stringify(err)));
    pendingRequest = null;
  }
}

function clearPendingTimer() {
  if (pendingRequest && pendingRequest.timer) {
    clearTimeout(pendingRequest.timer);
    pendingRequest.timer = null;
  }
}

/**
 * Request an access token. Must be called from inside a user gesture for
 * non-silent requests, or the browser will block the popup.
 *
 * @param {{silent?: boolean}} [opts]
 * @returns {Promise<{token: string, expiresAt: number|null}>}
 */
export async function requestAccessToken({ silent = false } = {}) {
  if (!tokenClient) {
    await initTokenClient({ onTokenChange: onTokenChangeCallback || undefined });
  }
  if (pendingRequest) {
    return new Promise((resolve, reject) => {
      // Chain onto the existing request rather than spawning a second popup.
      const original = pendingRequest;
      pendingRequest = {
        resolve: (value) => {
          original.resolve(value);
          resolve(value);
        },
        reject: (e) => {
          original.reject(e);
          reject(e);
        },
        timer: original.timer,
      };
    });
  }

  return new Promise((resolve, reject) => {
    pendingRequest = {
      resolve,
      reject,
      timer: setTimeout(() => {
        if (pendingRequest) {
          pendingRequest.reject(
            Object.assign(new Error('GIS popup blocked or no response'), {
              code: 'popup_blocked',
            })
          );
          pendingRequest = null;
        }
      }, POPUP_BLOCKED_TIMEOUT_MS),
    };
    try {
      // prompt: '' means "silent" — uses an existing session without popup.
      // prompt: 'consent' forces the consent screen (incremental auth, account picker).
      tokenClient.requestAccessToken({ prompt: silent ? '' : 'consent' });
    } catch (err) {
      clearPendingTimer();
      pendingRequest = null;
      reject(err);
    }
  });
}

/**
 * Return the in-memory access token if it is still valid (with the safety
 * margin). Does NOT trigger a new request.
 *
 * @returns {string|null}
 */
export function getAccessToken() {
  if (!currentAccessToken) return null;
  if (tokenExpiresAt !== null && Date.now() >= tokenExpiresAt - EXPIRY_SAFETY_MS) {
    return null;
  }
  return currentAccessToken;
}

/**
 * Revoke the current token at Google and clear in-memory state.
 *
 * @returns {Promise<void>}
 */
export async function revokeToken() {
  const tok = currentAccessToken;
  currentAccessToken = null;
  tokenExpiresAt = null;
  if (onTokenChangeCallback) {
    try {
      onTokenChangeCallback(null);
    } catch {
      /* ignore */
    }
  }
  if (!tok) return;
  if (!window.google?.accounts?.oauth2?.revoke) return;
  await new Promise((resolve) => {
    try {
      window.google.accounts.oauth2.revoke(tok, () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * True when an unexpired access token is held in memory.
 *
 * @returns {boolean}
 */
export function isSignedIn() {
  return getAccessToken() !== null;
}

/**
 * True when the page is running as an installed iOS PWA (or iPadOS PWA).
 *
 * Used by Phase 2b.1's renderDriveSignIn to gate the double-tap confirmation
 * modal (Decision P2c.1): iOS treats `requestAccessToken()` as a popup attempt
 * even when fired from a click handler unless the user-activation chain is
 * primed with a second explicit gesture inside a confirm dialog.
 *
 * iPad on iPadOS 13+ defaults to a desktop user-agent, so the legacy
 * /iPhone|iPad/ check misses it. We additionally accept a Macintosh UA that
 * has touch (maxTouchPoints > 1) — that combination is uniquely iPad.
 *
 * @returns {boolean}
 */
export function isIosStandalonePwa() {
  if (typeof window === 'undefined') return false;
  const standalone = window.navigator.standalone === true;
  if (!standalone) return false;
  const ua = window.navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+: UA says "Macintosh" but the device has touch.
  if (/Macintosh/.test(ua) && (window.navigator.maxTouchPoints || 0) > 1) return true;
  return false;
}

/**
 * Test-only / debug accessor. Returns a snapshot of the in-memory state.
 * Not exported through the barrel; reach via gisClient.js directly.
 */
export function _debugState() {
  return {
    hasTokenClient: !!tokenClient,
    hasToken: !!currentAccessToken,
    expiresAt: tokenExpiresAt,
    expiresInMs: tokenExpiresAt ? tokenExpiresAt - Date.now() : null,
    clientId: DRIVE_CLIENT_ID,
    scope: DRIVE_SCOPE,
  };
}
