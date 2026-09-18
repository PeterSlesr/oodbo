import React from 'react';

// Says, unmissably, that nothing is reaching the cloud right now.
//
// It's rendered as the first flex child of a page's root (both Home and Editor are
// height:100vh flex columns), so it PUSHES the page down rather than floating over it.
// That's deliberate: an overlay is something you learn to look past, and this is the one
// state where quiet is the wrong choice. Offline is when edits pile up unsent, and it's the
// main way a project ends up split into two versions to reconcile later. Better to take the
// 30 pixels.
//
// It stays reassuring rather than alarming — nothing is lost or at risk, the work is on the
// device and will go up on its own. Black-on-white is the loudest register this app has;
// red would claim an error that hasn't happened.
export default function OfflineBanner() {
  return (
    <div style={s.bar} role="status" aria-live="polite">
      <span style={s.dot} aria-hidden="true" />
      <span><strong style={s.strong}>Offline.</strong> Your writing is saved on this device and will sync when you reconnect.</span>
    </div>
  );
}

const s = {
  bar: {
    flexShrink: 0,               // never let the page squeeze it away
    background: '#111',
    color: '#f5f2eb',
    fontFamily: 'Georgia, serif',
    fontSize: 12.5,
    lineHeight: 1.4,
    padding: '7px 14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    textAlign: 'center',
  },
  strong: { fontWeight: 'normal', fontStyle: 'italic', color: '#fff', marginRight: 2 },
  dot: {
    width: 6, height: 6, borderRadius: '50%',
    background: '#e0b050', flexShrink: 0, display: 'inline-block',
  },
};
