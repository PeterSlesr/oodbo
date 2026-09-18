import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { OAUTH_STATE_KEY } from '../lib/oauth.js';

export default function AuthCallback() {
  const [error, setError] = useState('');

  useEffect(() => {
    const params   = new URLSearchParams(window.location.search);
    const code     = params.get('code');
    // state is "<provider>.<nonce>" — provider tells us which exchange; nonce is the CSRF token.
    const rawState = params.get('state') || '';
    const dot      = rawState.indexOf('.');
    const provider = dot > 0 ? rawState.slice(0, dot) : rawState;   // 'google' | 'azure'
    const nonce    = dot > 0 ? rawState.slice(dot + 1) : '';
    const savedNonce = (() => { try { return sessionStorage.getItem(OAUTH_STATE_KEY); } catch { return null; } })();
    try { sessionStorage.removeItem(OAUTH_STATE_KEY); } catch {}   // one-time use

    // No code — someone navigated here directly
    if (!code || !provider) {
      window.location.replace('/');
      return;
    }

    // CSRF (login-CSRF defense): only exchange a code for a flow THIS browser started. A missing or
    // mismatched nonce means the callback wasn't initiated here — refuse rather than sign in.
    if (!nonce || !savedNonce || nonce !== savedNonce) {
      setError('Sign-in could not be verified. Please start again from the sign-in screen.');
      return;
    }

    async function exchange() {
      try {
        // Step 1: exchange auth code for id_token server-side
        const res = await fetch('/api/auth/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, provider, redirectUri: `${window.location.origin}/auth/callback` })
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Token exchange failed');
        }

        const { id_token, access_token, refresh_token, expires_in } = await res.json();

        // Step 2: sign into Supabase using the id_token
        const { error: signInError } = await supabase.auth.signInWithIdToken({
          provider,
          token: id_token
        });

        if (signInError) throw signInError;

        // Step 3: store Drive/OneDrive tokens for cloud sync
        if (access_token) {
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            await fetch('/api/auth/store-tokens', {
              method:  'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization:  `Bearer ${session.access_token}`,
              },
              body: JSON.stringify({ provider, access_token, refresh_token, expires_in }),
            }).catch(e => console.warn('Failed to store tokens:', e));
          }
        }

        // Step 4: session established — App.jsx onAuthStateChange fires, then we navigate home
        window.location.replace('/');

      } catch (err) {
        console.error('Auth callback error:', err);
        setError(err.message || 'Something went wrong. Please try again.');
      }
    }

    exchange();
  }, []);

  if (error) {
    return (
      <div style={s.wrap}>
        <div style={s.box}>
          <h1 style={s.brand}>oodbo</h1>
          <div style={s.divider} />
          <p style={s.errorTitle}>Sign-in failed</p>
          <p style={s.errorMsg}>{error}</p>
          <a href="/" style={s.btn}>← Try again</a>
        </div>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <div style={s.box}>
        <h1 style={s.brand}>oodbo</h1>
        <div style={s.divider} />
        <p style={s.signing}>Signing you in…</p>
      </div>
    </div>
  );
}

const s = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f5f2eb',
    padding: '20px'
  },
  box: {
    width: '100%',
    maxWidth: 360
  },
  brand: {
    fontFamily: 'Georgia, serif',
    fontSize: 28,
    fontWeight: 'normal',
    letterSpacing: '-0.02em',
    color: '#111',
    marginBottom: 4
  },
  divider: {
    borderTop: '1px solid #ddd6c9',
    margin: '20px 0'
  },
  signing: {
    fontFamily: 'Georgia, serif',
    fontSize: 14,
    color: '#888',
    fontStyle: 'italic'
  },
  errorTitle: {
    fontFamily: 'Georgia, serif',
    fontSize: 16,
    color: '#111',
    marginBottom: 8
  },
  errorMsg: {
    fontFamily: 'Georgia, serif',
    fontSize: 13,
    color: '#a03030',
    marginBottom: 20,
    lineHeight: 1.5
  },
  btn: {
    fontFamily: 'Georgia, serif',
    fontSize: 13,
    color: '#111',
    textDecoration: 'none',
    fontStyle: 'italic'
  }
};
