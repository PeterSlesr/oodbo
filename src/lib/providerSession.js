// ── Provider session: the browser's direct line to the cloud provider ────────────
//
// The "unplugged" replacement for Supabase auth. No server, no secret, no oodbo account.
// For Google we use Google Identity Services (GIS): the browser asks GIS for an access
// token scoped to the hidden Drive appDataFolder, and GIS returns one directly (proven in
// public/spike.html). The sync engine only ever needs `getValidProviderAccessToken()` —
// exactly the shape `initSync({ getToken })` expects — so swapping this in for the old
// Supabase token is a seam change, not a rewrite.
//
// Token model (a real trait, not a bug): GIS hands back a ~1h access token and NO refresh
// token. We cache it and, when it nears expiry, ask GIS again — silently if the Google
// session is still alive, otherwise the caller surfaces a "reconnect". That is the whole
// cost of holding nothing (plan decision 01).
//
// Two scopes, kept separate on purpose:
//   SYNC  (drive.appdata) — granted at sign-in; the hidden per-app folder the engine uses.
//   SHARE (drive.file)    — the narrow "only files this app creates" scope, requested
//                           INCREMENTALLY the first time a user publishes a share, so a
//                           non-sharer never grants it.
//
// Microsoft is deferred (it uses MSAL.js, a separate library); this module is Google-only.

const GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  '489322279186-9jg8oj1e3o74d3v47gsvtlr326if4e51.apps.googleusercontent.com';

const SYNC_SCOPE  = 'openid email profile https://www.googleapis.com/auth/drive.appdata';
const SHARE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_SRC   = 'https://accounts.google.com/gsi/client';
const USERINFO  = 'https://www.googleapis.com/oauth2/v3/userinfo';

// Refresh a bit BEFORE the real expiry so an in-flight call never rides a token that dies.
const EXPIRY_SKEW_MS = 60_000;

// ── GIS library loader (injected once, on demand) ────────────────────────────────
let _gisPromise = null;
function loadGis() {
  if (_gisPromise) return _gisPromise;
  _gisPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const s = document.createElement('script');
    s.src = GIS_SRC; s.async = true; s.defer = true;
    s.onload = () => {
      if (window.google?.accounts?.oauth2) resolve();
      else reject(new Error('GIS loaded but oauth2 unavailable'));
    };
    s.onerror = () => reject(new Error('failed to load Google Identity Services'));
    document.head.appendChild(s);
  });
  return _gisPromise;
}

// ── In-memory token caches (never persisted; a reload re-requests silently) ────────
let _syncTok  = null;   // { accessToken, expiresAt } for SYNC_SCOPE
let _shareTok = null;   // { accessToken, expiresAt } for SHARE_SCOPE
let _email    = null;
let _inflight = null;   // dedupes concurrent silent sync refreshes

const isFresh = (t) => !!t && Date.now() < t.expiresAt - EXPIRY_SKEW_MS;

// One GIS token request for a given scope. `interactive` true = allow the account/consent
// popup (needs a user gesture); false = attempt a silent refresh and reject if UI is needed.
function requestToken({ interactive, scope }) {
  return new Promise((resolve, reject) => {
    loadGis().then(() => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope,
        callback: (resp) => {
          if (resp.error) { reject(new Error(resp.error)); return; }
          resolve({ accessToken: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 });
        },
        error_callback: (err) => reject(new Error(err?.type || 'gis_error')),
      });
      client.requestAccessToken(interactive ? {} : { prompt: '' });
    }).catch(reject);
  });
}

async function fetchEmail(accessToken) {
  const res = await fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`userinfo ${res.status}`);
  const d = await res.json();
  return d.email || null;
}

// ── Public surface ────────────────────────────────────────────────────────────────

// Interactive sign-in (call from a click). Pops Google account/consent for the SYNC scope,
// then resolves the signed-in user. Throws if the user cancels or something fails.
export async function signIn() {
  _syncTok = await requestToken({ interactive: true, scope: SYNC_SCOPE });
  _email = await fetchEmail(_syncTok.accessToken);
  return { provider: 'google', email: _email };
}

// The one method the sync engine needs: a currently-valid SYNC access token. Cached while
// fresh, else silently re-requested. Rejects if a silent refresh needs the user.
export async function getValidProviderAccessToken() {
  if (isFresh(_syncTok)) return _syncTok.accessToken;
  if (_inflight) return _inflight;
  _inflight = requestToken({ interactive: false, scope: SYNC_SCOPE })
    .then(async t => {
      // Guard: a refresh (silent or re-prompted) can come back for a DIFFERENT Google
      // account than the one we're signed in as. Never adopt it silently — that would run
      // account A's local data against account B's token. Halt sync instead; the reconnect
      // flow re-signs in explicitly (and swaps accounts cleanly via the owner guard).
      if (_email) {
        const who = await fetchEmail(t.accessToken).catch(() => null);
        if (who && who !== _email) throw new Error('account_changed');
      }
      _syncTok = t;
      return t.accessToken;
    })
    .finally(() => { _inflight = null; });
  return _inflight;
}

// A SHARE-scope (drive.file) token, for publishing/unpublishing shares. Requested
// interactively the first time (incremental consent, fired from a user's "share" click);
// cached and reused after. Separate from the sync token so non-sharers never grant it.
export async function getShareAccessToken() {
  if (isFresh(_shareTok)) return _shareTok.accessToken;
  _shareTok = await requestToken({ interactive: true, scope: SHARE_SCOPE });
  return _shareTok.accessToken;
}

// Best-effort silent restore on app boot: if the Google session is alive and previously
// granted, this returns the user with no popup; otherwise it throws and the app stays guest.
export async function restoreSession() {
  const accessToken = await getValidProviderAccessToken();
  if (!_email) _email = await fetchEmail(accessToken);
  return { provider: 'google', email: _email };
}

export function getUserEmail() { return _email; }
export function isSignedIn() { return !!_email; }

export async function signOut() {
  const tokens = [_syncTok?.accessToken, _shareTok?.accessToken].filter(Boolean);
  _syncTok = _shareTok = null;
  _email = null;
  if (window.google?.accounts?.oauth2?.revoke) {
    for (const t of tokens) { try { window.google.accounts.oauth2.revoke(t, () => {}); } catch {} }
  }
}
