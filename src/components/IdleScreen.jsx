import React, { useMemo } from 'react';
import { WRITING_QUOTES } from '../lib/quotes.js';

// Full-screen ambient "limbo" shown after a long idle on the homepage (see Home.jsx).
// It mirrors the sync/loading screen — a single writing quote over the CRT field — but
// without the "syncing" line, and with the site wordmark where a logo would sit. Purely
// decorative; Home owns the wake/return-and-sweep on the next interaction.
export default function IdleScreen() {
  const scheme = (() => { try { return localStorage.getItem('fwd:crt-scheme') || 'green'; } catch { return 'green'; } })();
  const q = useMemo(() => WRITING_QUOTES[Math.floor(Math.random() * WRITING_QUOTES.length)], []);

  return (
    <div data-scheme={scheme} className="crt-scanlines crt-vignette" style={s.page} aria-hidden="true">
      <span style={s.brand}>write.mercoogs.com</span>
      <blockquote style={s.quote}>
        <p style={s.quoteText}>“{q.text}”</p>
        <footer style={s.quoteAttr}>{q.attr}</footer>
      </blockquote>
    </div>
  );
}

const s = {
  page: {
    position: 'fixed', inset: 0, zIndex: 850,
    background: 'var(--bg)', color: 'var(--tx)', fontFamily: 'var(--fm)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    padding: '0 28px', cursor: 'default',
  },
  brand: {
    fontFamily: 'var(--fm)', fontSize: 13, letterSpacing: '0.12em',
    color: 'var(--tx-dim)', marginBottom: 'clamp(36px, 8vh, 72px)',
  },
  quote: { margin: 0, maxWidth: 560, textAlign: 'center' },
  quoteText: {
    margin: 0, fontFamily: 'var(--fm)', fontSize: 'clamp(17px, 4.2vw, 22px)',
    lineHeight: 1.6, color: 'var(--tx)', textShadow: 'var(--glow)',
  },
  quoteAttr: { marginTop: 18, fontSize: 13, letterSpacing: '0.05em', color: 'var(--tx-faint)' },
};
