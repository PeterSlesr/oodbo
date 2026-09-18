import React from 'react';

// Landing page for the desktop app's native OAuth loopback redirect
// (Google/Microsoft → http://127.0.0.1:{port}/callback, caught by the Rust
// listener in src-tauri/src/lib.rs, which then 302s the browser here purely
// for a readable confirmation — the actual code exchange already happened
// locally in the desktop app before this page ever loads).
export default function DesktopOAuthComplete() {
  return (
    <div style={s.wrap}>
      <div style={s.box}>
        <h1 style={s.brand}>oodbo</h1>
        <div style={s.divider} />
        <p style={s.successTitle}>You're signed in.</p>
        <p style={s.successMsg}>
          Return to the oodbo desktop app — it will pick up your session automatically.
        </p>
        <p style={s.successHint}>You can close this tab.</p>
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
  }
};
