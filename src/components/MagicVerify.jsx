import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';

export default function MagicVerify() {
  const [error,        setError]        = useState('');
  const [returnToWord, setReturnToWord] = useState(false);
  const [bridgeSource, setBridgeSource] = useState('addin');

  useEffect(() => {
    const params      = new URLSearchParams(window.location.search);
    const token       = params.get('token');
    const source      = params.get('source');
    const addinBridge = params.get('addin_bridge');

    // ── Addin bridge mode ──────────────────────────────────────────────────────
    // After Supabase verifies the action_link for an addin user, it redirects
    // back here with ?addin_bridge=1. Session is already established — just
    // write the bridge and show "return to Word".
    if (addinBridge === '1') {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (!session) { window.location.replace('/'); return; }
        fetch('/api/auth/addin?action=session', {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization:  `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        })
          .catch(err => console.warn('Failed to write addin session bridge:', err))
          .finally(() => setReturnToWord(true));
      });
      return;
    }

    // ── Normal verification ────────────────────────────────────────────────────
    if (!token) {
      window.location.replace('/');
      return;
    }

    // Remove the token from the URL immediately so it doesn't linger in browser history
    window.history.replaceState(null, '', window.location.pathname);

    async function verify() {
      try {
        const res = await fetch('/api/auth/magic/verify', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token, source }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Verification failed');
        }

        const data = await res.json();

        // Word add-in / desktop app: session was created server-side and written
        // to the polling bridge. Just show a "return to the app" message — no
        // browser redirect needed.
        if (data.type === 'addin_session_created') {
          setBridgeSource(source === 'desktop' ? 'desktop' : 'addin');
          setReturnToWord(true);
          return;
        }

        // Web: redirect to Supabase's action_link to establish the browser session.
        window.location.replace(data.action_link);

      } catch (err) {
        console.error('Magic link error:', err);
        setError(err.message || 'Something went wrong. Please try again.');
      }
    }

    verify();
  }, []);

  if (returnToWord) {
    return (
      <div style={s.wrap}>
        <div style={s.box}>
          <h1 style={s.brand}>oodbo</h1>
          <div style={s.divider} />
          <p style={s.successTitle}>You're signed in.</p>
          <p style={s.successMsg}>
            {bridgeSource === 'desktop'
              ? 'Return to the oodbo desktop app — it will pick up your session automatically.'
              : 'Return to Word — the add-in will pick up your session automatically.'}
          </p>
          <p style={s.successHint}>You can close this tab.</p>
        </div>
      </div>
    );
  }

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
  successTitle: {
    fontFamily: 'Georgia, serif',
    fontSize: 18,
    fontWeight: 'normal',
    color: '#111',
    marginBottom: 10
  },
  successMsg: {
    fontFamily: 'Georgia, serif',
    fontSize: 14,
    color: '#444',
    marginBottom: 12,
    lineHeight: 1.6
  },
  successHint: {
    fontFamily: 'Georgia, serif',
    fontSize: 12,
    color: '#999',
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
