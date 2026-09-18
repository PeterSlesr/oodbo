import React, { useState } from 'react';
import { readGuestDraftText } from '../lib/guestStore.js';
import { startProviderReauth } from '../lib/oauth.js';

export default function Auth({ onCancel }) {
  // Guest carry-over: a signing-up guest can copy their ephemeral draft (read
  // once from sessionStorage). Nothing guest-related is sent to any endpoint.
  const [guestText]           = useState(() => readGuestDraftText());
  const [guestCopied, setGuestCopied] = useState(false);

  function copyGuestText() {
    navigator.clipboard.writeText(guestText).then(() => {
      setGuestCopied(true);
      setTimeout(() => setGuestCopied(false), 2000);
    }).catch(() => {});
  }

  // Both sign-in and the reconnect banner share the same provider OAuth redirect (src/lib/oauth.js).
  const handleGoogle    = () => startProviderReauth('google');
  const handleMicrosoft = () => startProviderReauth('azure');

  return (
    <div style={s.wrap}>
      <div style={s.box}>
        <h1 style={s.brand}>oodbo.io</h1>
        <p style={s.sub}>draft without looking back</p>
        <div style={s.divider} />

        {/* Guest carry-over — copy your ephemeral draft before signing up */}
        {guestText && (
          <div style={s.guestCarry}>
            <p style={s.guestCarryText}>
              Your guest writing won't carry over to your account — copy it now to paste in after you sign up.
            </p>
            <button style={s.guestCarryBtn} onClick={copyGuestText}>
              {guestCopied ? 'Copied ✓' : 'Copy your guest writing'}
            </button>
          </div>
        )}

        {/* OAuth buttons */}
        <button style={s.oauthBtn} onClick={handleGoogle}>
          <svg style={s.oauthIcon} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Continue with Google
        </button>
        <button style={s.oauthBtn} onClick={handleMicrosoft}>
          <svg style={s.oauthIcon} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M11.5 2L2 7.5v9L11.5 22 21 16.5v-9L11.5 2zm0 2.18L19 8.09v7.82l-7.5 4.09L4 15.91V8.09l7.5-3.91z" fill="#00A4EF"/>
            <path d="M11.5 6L6 9v6l5.5 3 5.5-3V9L11.5 6z" fill="#00A4EF" opacity=".6"/>
          </svg>
          Continue with Microsoft
        </button>
        <p style={s.hint}>Web access uses your Google or Microsoft account.</p>

        {onCancel && (
          <>
            <div style={s.divider} />
            <button style={s.ghost} onClick={onCancel}>← back</button>
          </>
        )}
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
    maxWidth: 360,
  },
  brand: {
    fontFamily: 'Georgia, serif',
    fontSize: 28,
    fontWeight: 'normal',
    letterSpacing: '-0.02em',
    color: '#111',
    marginBottom: 4
  },
  sub: {
    fontFamily: 'Georgia, serif',
    fontSize: 11,
    color: '#888',
    fontStyle: 'italic',
    marginBottom: 0
  },
  divider: {
    borderTop: '1px solid #ddd6c9',
    margin: '20px 0'
  },
  guestCarry: {
    border: '1px solid #ddd6c9',
    background: '#fffdf8',
    padding: '12px 14px',
    marginBottom: 16,
  },
  guestCarryText: {
    fontFamily: 'Georgia, serif',
    fontSize: 12,
    fontStyle: 'italic',
    lineHeight: 1.5,
    color: '#555',
    margin: '0 0 10px',
  },
  guestCarryBtn: {
    fontFamily: 'Georgia, serif',
    fontSize: 13,
    width: '100%',
    padding: '8px 12px',
    background: '#111',
    color: '#fff',
    border: '1px solid #111',
    cursor: 'pointer',
  },
  oauthBtn: {
    fontFamily: 'Georgia, serif',
    fontSize: 13,
    width: '100%',
    padding: '9px 12px',
    background: '#fff',
    color: '#1f1f1f',
    border: '1px solid #ddd6c9',
    cursor: 'pointer',
    marginBottom: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    textAlign: 'left'
  },
  oauthIcon: {
    width: 16,
    height: 16,
    flexShrink: 0
  },
  ghost: {
    fontFamily: 'Georgia, serif',
    fontSize: 11,
    background: 'transparent',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    fontStyle: 'italic',
    padding: 0,
    marginTop: 4
  },
  hint: {
    fontFamily: 'Georgia, serif',
    fontSize: 11,
    color: '#888',
    fontStyle: 'italic',
    lineHeight: 1.6,
    marginTop: 4
  },
};
