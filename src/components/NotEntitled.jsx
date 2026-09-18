import React from 'react';

// Single-tier web checkout (mirrors TestHome's LS_OODBO / Editor's LS_WEB).
const LS_OODBO = 'https://oodbo.lemonsqueezy.com/checkout/buy/3229a629-9112-4867-a4c1-e9e510a544b1';

// Shown when a signed-in WEB user has no active license (no account row, or
// paid=false). Web is paid-only; desktop and Word have their own free tiers,
// so App only renders this off the desktop runtime and when payments are live.
export default function NotEntitled({ email, onSignOut }) {
  const checkoutUrl = email
    ? `${LS_OODBO}?checkout[email]=${encodeURIComponent(email)}`
    : LS_OODBO;

  return (
    <div style={s.wrap}>
      <div style={s.box}>
        <h1 style={s.brand}>oodbo.io</h1>
        <p style={s.sub}>draft without looking back</p>
        <div style={s.divider} />

        <p style={s.title}>No active license on this account</p>
        <p style={s.body}>
          You're signed in as <strong>{email}</strong>, but this account doesn't have a paid oodbo license yet.
          The web app requires a one-time purchase — which also unlocks the option to sync to cloud, export projects, and the Word add-in.
        </p>

        <a href={checkoutUrl} target="_blank" rel="noopener noreferrer" style={s.primary}>Get oodbo</a>

        <p style={s.hint}>
          Already purchased? Make sure you bought with <strong>{email}</strong> — your license binds to that address.
        </p>

        <div style={s.divider} />

        <p style={s.body}>
          Not ready to buy? The <strong>desktop app</strong> has a free tier — write forward on Windows,
          stored locally on your computer, no purchase needed. Cloud sync and export come with the upgrade.
        </p>
        <a href="/download" style={s.secondary}>Get the free desktop app</a>

        <div style={s.divider} />
        <button style={s.ghost} onClick={onSignOut}>Use a different account</button>
      </div>
    </div>
  );
}

const s = {
  wrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f2eb', padding: '20px' },
  box: { width: '100%', maxWidth: 360 },
  brand: { fontFamily: 'Georgia, serif', fontSize: 28, fontWeight: 'normal', letterSpacing: '-0.02em', color: '#111', marginBottom: 4 },
  sub: { fontFamily: 'Georgia, serif', fontSize: 11, color: '#888', fontStyle: 'italic', marginBottom: 0 },
  divider: { borderTop: '1px solid #ddd6c9', margin: '20px 0' },
  title: { fontFamily: 'Georgia, serif', fontSize: 16, color: '#111', marginBottom: 8 },
  body: { fontFamily: 'Georgia, serif', fontSize: 13, color: '#555', lineHeight: 1.6, marginBottom: 16 },
  primary: {
    fontFamily: 'Georgia, serif', fontSize: 13, display: 'block', textAlign: 'center',
    textDecoration: 'none', width: '100%', padding: '10px 12px', background: '#111',
    color: '#fff', border: '1px solid #111', cursor: 'pointer', boxSizing: 'border-box',
  },
  secondary: {
    fontFamily: 'Georgia, serif', fontSize: 13, display: 'block', textAlign: 'center',
    textDecoration: 'none', width: '100%', padding: '10px 12px', background: '#fff',
    color: '#111', border: '1px solid #111', cursor: 'pointer', boxSizing: 'border-box',
  },
  hint: { fontFamily: 'Georgia, serif', fontSize: 11, color: '#888', fontStyle: 'italic', lineHeight: 1.6, marginTop: 12 },
  ghost: { fontFamily: 'Georgia, serif', fontSize: 11, background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', fontStyle: 'italic', padding: 0 },
};
