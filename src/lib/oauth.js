// Shared provider OAuth redirect — used by the sign-in screen (Auth.jsx) and the reconnect
// banner (spec §10 / issue #2). A full-page redirect out to Google/Microsoft and back to
// /auth/callback; on return the app boots fresh with new provider tokens, the engine re-inits
// (providerHalted cleared) and sync resumes. `provider` is 'google' | 'azure' (== user.provider).
// CSRF: `state` must be an unguessable per-attempt nonce, remembered here and verified on the
// callback (AuthCallback), so a callback can only be processed for a flow THIS browser started —
// closing the login-CSRF hole where a constant state let an attacker's auth code be replayed onto
// a victim. The provider travels in the state prefix ("<provider>.<nonce>") so the callback still
// knows which provider without a second lookup. Mirrors the pattern already used by the Word add-in
// (public/addin-auth.html) and desktop (desktopOAuth.js, which additionally uses PKCE as a public
// client — not needed here, where the code exchange is server-side with a client secret).
export const OAUTH_STATE_KEY = 'fwd:oauth_state';

function makeOAuthState(provider) {
  const nonce = (globalThis.crypto?.randomUUID?.() || (Math.random().toString(36).slice(2) + Date.now()));
  try { sessionStorage.setItem(OAUTH_STATE_KEY, nonce); } catch {}
  return `${provider}.${nonce}`;
}

export function startProviderReauth(provider) {
  const origin = window.location.origin;
  const state  = makeOAuthState(provider);
  if (provider === 'azure') {
    const params = new URLSearchParams({
      client_id:     import.meta.env.VITE_AZURE_CLIENT_ID,
      redirect_uri:  `${origin}/auth/callback`,
      response_type: 'code',
      scope:         'openid email profile Files.ReadWrite.AppFolder offline_access',
      state,
    });
    window.location.href = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
    return;
  }
  const params = new URLSearchParams({
    client_id:     import.meta.env.VITE_GOOGLE_CLIENT_ID,
    redirect_uri:  `${origin}/auth/callback`,
    response_type: 'code',
    scope:         'openid email profile https://www.googleapis.com/auth/drive.appdata',
    access_type:   'offline',
    prompt:        'consent',   // always issues a refresh token, even on repeat consents
    state,
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
