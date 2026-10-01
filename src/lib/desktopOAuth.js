// ── Desktop native OAuth (unplugged) ────────────────────────────────────────────────
//
// The desktop half of providerSession.js. Web uses Google Identity Services (a popup token
// client that can't run in WebView2); desktop uses Authorization Code + PKCE against a
// dedicated "Desktop app" OAuth client, catching the redirect on a loopback HTTP listener
// (Rust: start_oauth_listener / await_oauth_callback, RFC 8252). NO server, NO Supabase,
// NO secret beyond the installed-app client secret Google itself documents as non-confidential.
//
// Unlike web GIS, this holds a real refresh_token, so boot restore is genuinely SILENT
// (restoreSession below) — no popup, no re-consent, no third-party call until the token
// actually needs refreshing.
//
// Microsoft is deferred (matches web): the Rust azure_* helpers stay in lib.rs for later, but
// sign-in here is Google-only.

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { generateCodeVerifier, generateCodeChallenge } from './pkce.js';

// Desktop-app OAuth client under the same GCP project (oodbo-496808). "Public client" creds:
// Google's own docs say the secret for an installed app is not confidential (it's still required
// in the token request body). Safe to ship — this is NOT the web confidential client's secret.
const GOOGLE_DESKTOP_CLIENT_ID     = '489322279186-uohjunss357f33677mdrkvailuujbtm6.apps.googleusercontent.com';
const GOOGLE_DESKTOP_CLIENT_SECRET = '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';

export const PROVIDER_TOKENS_KEY = 'fwd:desktop-provider-tokens';

const AUTH_ENDPOINT  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// Both scopes are granted together at sign-in (one consent screen) so that publishing a share
// works without a second loopback round-trip. drive.appdata = the hidden sync folder the engine
// uses; drive.file = the narrow "only files this app creates" scope Option-B share writes to.
const SCOPE = 'openid email profile https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';

// Refresh a bit BEFORE the real expiry so an in-flight call never rides a token that dies.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// ── Token store (localStorage; survives relaunch — that's the point of the refresh token) ──────
function readTokens() {
  try { return JSON.parse(localStorage.getItem(PROVIDER_TOKENS_KEY) || 'null'); } catch { return null; }
}
function writeTokens(t) {
  try { localStorage.setItem(PROVIDER_TOKENS_KEY, JSON.stringify(t)); } catch {}
}
export function hasProviderSession()  { return !!readTokens(); }
export function clearProviderSession() { try { localStorage.removeItem(PROVIDER_TOKENS_KEY); } catch {} }
export function getProviderEmail()    { return readTokens()?.email || null; }
export function isSignedIn()          { return hasProviderSession(); }

// Decode the email claim out of an id_token (our own token — no verification needed, just read it).
function emailFromIdToken(idToken) {
  try {
    const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(payload))))?.email || null;
  } catch { return null; }
}

// ── OAuth code exchange / refresh (plain fetch — Google has no WebView Origin restriction) ─────
async function postToken(params) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams(params),
  });
  return res.json().catch(() => ({}));
}

// Refresh the Drive access token directly against Google, using the desktop client's own creds —
// no server, no web oauth_tokens table. A thrown error = the request itself failed (offline);
// a resolved body with .error (e.g. invalid_grant) = the refresh token is dead → needs re-auth.
async function refreshAccessToken(refreshToken) {
  const data = await postToken({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     GOOGLE_DESKTOP_CLIENT_ID,
    client_secret: GOOGLE_DESKTOP_CLIENT_SECRET,
  });
  if (data.error) return null;
  return data; // { access_token, expires_in, id_token?, ... }
}

// ── Public surface (mirrors providerSessionWeb.js shape, consumed via the dispatcher) ──────────

// Interactive sign-in. Opens the system browser to Google, catches the loopback redirect, exchanges
// the code, stores the token bundle, and returns the signed-in user. Throws if the user cancels.
export async function runGoogleSignIn(hint) {
  const verifier  = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state     = crypto.randomUUID();

  const port        = await invoke('start_oauth_listener');
  const redirectUri = `http://127.0.0.1:${port}/callback`;   // Google accepts any loopback port/path

  const authParams = new URLSearchParams({
    client_id:             GOOGLE_DESKTOP_CLIENT_ID,
    redirect_uri:          redirectUri,
    response_type:         'code',
    scope:                 SCOPE,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    state,
    access_type:           'offline',   // force a refresh_token
    prompt:                'consent',
    ...(hint ? { login_hint: hint } : {}),
  });
  await open(`${AUTH_ENDPOINT}?${authParams}`);

  const cb = await invoke('await_oauth_callback');
  if (cb.error)            throw new Error(`OAuth error: ${cb.error}`);
  if (!cb.code)            throw new Error('No authorization code received.');
  if (cb.state !== state)  throw new Error('OAuth state mismatch.');

  const data = await postToken({
    code:          cb.code,
    client_id:     GOOGLE_DESKTOP_CLIENT_ID,
    client_secret: GOOGLE_DESKTOP_CLIENT_SECRET,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code',
    code_verifier: verifier,
  });
  if (data.error)        throw new Error(data.error_description || data.error || 'Token exchange failed.');
  if (!data.access_token) throw new Error('Provider returned no access token.');

  const email = emailFromIdToken(data.id_token);
  writeTokens({
    provider:     'google',
    email,
    accessToken:  data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt:    new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString(),
  });
  return { provider: 'google', email };
}

// The one method desktopCloud needs: a currently-valid token bundle { provider, accessToken, ... }.
// Cached while fresh; silently refreshed otherwise. Throws 'no-provider-session' / 'needs_reauth'
// (the strings desktopCloud maps to CloudAuthError).
export async function getValidProviderToken() {
  const tokens = readTokens();
  if (!tokens) throw new Error('no-provider-session');

  const fresh = Date.now() < new Date(tokens.expiresAt).getTime() - EXPIRY_SKEW_MS;
  if (fresh) return tokens;

  if (!tokens.refreshToken) throw new Error('needs_reauth');
  const refreshed = await refreshAccessToken(tokens.refreshToken);   // throws → offline (transient)
  if (!refreshed?.access_token) throw new Error('needs_reauth');

  const next = {
    ...tokens,
    accessToken: refreshed.access_token,
    // Google usually omits a new refresh_token on refresh — keep the existing one.
    refreshToken: refreshed.refresh_token || tokens.refreshToken,
    email:        tokens.email || emailFromIdToken(refreshed.id_token),
    expiresAt:    new Date(Date.now() + (Number(refreshed.expires_in) || 3600) * 1000).toISOString(),
  };
  writeTokens(next);
  return next;
}

// Silent boot restore: if a refresh token is on disk and still valid, returns the user with NO
// popup and NO re-consent; throws otherwise (app stays guest). This is the desktop advantage over
// web GIS — a relaunch resumes the session on its own.
export async function restoreSession() {
  const { email } = await getValidProviderToken();   // refreshes if needed; throws if dead/offline
  return { provider: 'google', email: email || getProviderEmail() };
}

export function signOut() { clearProviderSession(); }
