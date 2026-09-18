import React from 'react';
import { startProviderReauth } from '../lib/oauth.js';
import { PAYMENTS_LIVE } from '../lib/constants.js';

// The auth counterpart to OfflineBanner. The provider (Drive/OneDrive) token was revoked or expired,
// so sync has HALTED and — unlike offline — cannot resume on its own: it needs re-authorization. So
// this banner is ACTIONABLE (a Reconnect button) and red (an error the user must clear).
//
// One component, platform-split by IS_TAURI on the SECONDARY control:
//   • Web — a link to the desktop app (/download), which runs local-only, for people who'd rather
//     not connect a cloud drive. Web has NO dismiss: the cloud is the web's store, so without it
//     nothing persists and the banner must keep nagging.
//   • Desktop — a "Not now" dismiss (when onReconnect's owner passes onDismiss): keep the provider
//     for auth, turn cloud storage off, run local-only (durable on disk). A footer link reconnects.
const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

export default function ReconnectBanner({ provider, onReconnect = null, onDismiss = null }) {
  const name = provider === 'azure' ? 'Microsoft' : 'Google';
  const reconnect = () => (onReconnect ? onReconnect(provider) : startProviderReauth(provider));
  return (
    <div style={s.bar} role="alert">
      <span style={s.dot} aria-hidden="true" />
      <span>
        <strong style={s.strong}>Storage disconnected.</strong> Reconnect your {name} account and allow file access to resume syncing.
      </span>
      <button style={s.btn} onClick={reconnect}>Reconnect</button>
      {IS_TAURI
        ? (onDismiss && <button style={s.alt} onClick={onDismiss}>Not now</button>)
        : (PAYMENTS_LIVE && <a style={s.alt} href="/download" target="_blank" rel="noopener noreferrer">Stay disconnected with the desktop app</a>)}
    </div>
  );
}

const s = {
  bar: {
    flexShrink: 0,               // never let the page squeeze it away
    background: '#7a1f1f',
    color: '#fdeaea',
    fontFamily: 'Georgia, serif',
    fontSize: 12.5,
    lineHeight: 1.4,
    padding: '7px 14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    textAlign: 'center',
    flexWrap: 'wrap',
  },
  strong: { fontWeight: 'normal', fontStyle: 'italic', color: '#fff', marginRight: 2 },
  dot: {
    width: 6, height: 6, borderRadius: '50%',
    background: '#e07050', flexShrink: 0, display: 'inline-block',
  },
  btn: {
    fontFamily: 'Georgia, serif', fontSize: 12.5,
    background: '#fff', color: '#7a1f1f',
    border: '1px solid #fff', borderRadius: 2,
    padding: '3px 10px', cursor: 'pointer', flexShrink: 0,
  },
  alt: {
    fontFamily: 'Georgia, serif', fontSize: 12.5,
    background: 'transparent', color: '#fdeaea',
    border: '1px solid rgba(255,255,255,0.4)', borderRadius: 2,
    padding: '3px 10px', cursor: 'pointer', flexShrink: 0,
    textDecoration: 'none',
  },
};
