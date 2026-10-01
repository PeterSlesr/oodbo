// ── providerSession: one token surface, two implementations ───────────────────────────
//
// The app (App.jsx / Editor.jsx / Home.jsx) imports signIn / getValidProviderAccessToken /
// getShareAccessToken / signOut / restoreSession from here and never learns which platform it's on.
//   · WEB  → Google Identity Services popup token client (providerSessionWeb.js).
//   · DESKTOP (Tauri) → Authorization Code + PKCE on a loopback listener (desktopOAuth.js),
//     which holds a real refresh token and can restore the session silently on boot.
// Both are backendless (direct to Google, no server, no Supabase).
//
// The desktop impl is loaded with a dynamic import() so the web bundle never pulls in the
// @tauri-apps/* modules it depends on.

import { IS_TAURI } from './platform.js';
import * as web from './providerSessionWeb.js';

let _desktopPromise = null;
const desktop = () => (_desktopPromise ??= import('./desktopOAuth.js'));

// Interactive sign-in from a click → { provider, email }.
export async function signIn(hint) {
  if (IS_TAURI) return (await desktop()).runGoogleSignIn(hint);
  return web.signIn(hint);
}

// A currently-valid Drive (sync-scope) access token as a STRING — the shape the sync engine's
// getToken contract and webCloud expect. (On desktop, sync uses createDesktopCloud, which sources
// its own token bundle directly; this string path is still here for symmetry / any direct caller.)
export async function getValidProviderAccessToken() {
  if (IS_TAURI) return (await (await desktop()).getValidProviderToken()).accessToken;
  return web.getValidProviderAccessToken();
}

// A token with drive.file scope for publishing shares. On web this triggers incremental consent the
// first time; on desktop the scope was granted at sign-in, so the same provider token already covers it.
export async function getShareAccessToken() {
  if (IS_TAURI) return (await (await desktop()).getValidProviderToken()).accessToken;
  return web.getShareAccessToken();
}

// Best-effort silent restore on boot. Desktop resolves from the stored refresh token (no popup);
// web can only resolve if the GIS session is alive (usually throws → app stays guest).
export async function restoreSession() {
  if (IS_TAURI) return (await desktop()).restoreSession();
  return web.restoreSession();
}

export async function signOut() {
  if (IS_TAURI) return (await desktop()).signOut();
  return web.signOut();
}
