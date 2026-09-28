import React, { useEffect, useState } from 'react';
import { fetchPublicSnapshot, driveViewUrl } from '../lib/share.js';

// Public read-only viewer for a shared piece (route: /s/<fileId>). Fetches the public JSON
// snapshot straight from the writer's Drive with the browser API key (no sign-in), and renders
// it as our own page. Layout: sticky full-width header + footer, a scrollable middle with a
// left section nav (table of contents) that jumps to each section. A "Hosted at …" line makes
// clear the content lives in the writer's own Drive, not on our site. (CRT styling: design pass.)
export default function ShareView({ fileId }) {
  const [state, setState] = useState({ loading: true });
  const [wide, setWide]   = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 820 : true));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await fetchPublicSnapshot(fileId);
        if (!cancelled) setState({ loading: false, snap });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: String(e?.message || e) });
      }
    })();
    return () => { cancelled = true; };
  }, [fileId]);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 820);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const jumpTo = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (state.loading) {
    return <div style={s.page}><div style={s.center}><p style={s.muted}>Loading…</p></div></div>;
  }
  if (state.error || !state.snap) {
    return (
      <div style={s.page}>
        <div style={s.center}><p style={s.muted}>This shared piece isn’t available. It may have been unpublished by its author.</p></div>
      </div>
    );
  }

  const { snap } = state;
  const sections = Array.isArray(snap.sections) ? snap.sections : [];
  const showToc  = wide && sections.length > 1;

  return (
    <div style={s.page}>
      {/* Sticky, full-breadth header */}
      <header style={s.header}>
        <span style={s.brand}>Forward&nbsp;Only</span>
        <span style={s.headerTitle}>{snap.title || 'Untitled'}</span>
      </header>

      <div style={s.body}>
        {/* Left section nav (table of contents) */}
        {showToc && (
          <nav style={s.toc} aria-label="Sections">
            {sections.map((sec, i) => (
              <button key={i} style={s.tocItem} onClick={() => jumpTo(`sec-${i}`)}>
                {sec.title || `Section ${i + 1}`}
              </button>
            ))}
          </nav>
        )}

        {/* Scrollable content */}
        <main style={s.scroll}>
          <article style={s.article}>
            <h1 style={s.title}>{snap.title || 'Untitled'}</h1>
            <div style={s.rule} />
            {sections.map((sec, i) => (
              <section key={i} id={`sec-${i}`} style={s.section}>
                {sec.title ? <h2 style={s.h2}>{sec.title}</h2> : null}
                {sec.content ? <div style={s.content}>{sec.content}</div> : null}
              </section>
            ))}
          </article>
        </main>
      </div>

      {/* Sticky, full-breadth footer */}
      <footer style={s.footer}>
        <span style={s.byline}>
          written by a human at <a href="https://write.mercoogs.com" style={s.link}>write.mercoogs.com</a>
        </span>
        <span style={s.hosted}>
          Hosted at <a href={driveViewUrl(fileId)} target="_blank" rel="noopener noreferrer" style={s.link}>{driveViewUrl(fileId)}</a>
          {snap.author ? <> · in the Drive of {snap.author}</> : null}
        </span>
      </footer>
    </div>
  );
}

// Plain parchment styling for now — replaced by the CRT/phosphor look in the aesthetic pass.
const s = {
  page:        { height: '100%', display: 'flex', flexDirection: 'column', background: '#f5f2eb', color: '#1f1f1f', fontFamily: 'Georgia, "Times New Roman", serif' },
  center:      { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 20px' },

  header:      { flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: 16, padding: '12px 24px', borderBottom: '1px solid #ddd6c9', background: '#f5f2eb' },
  brand:       { fontStyle: 'italic', fontSize: 16, color: '#8a847a', letterSpacing: '-0.02em', flexShrink: 0 },
  headerTitle: { fontSize: 13, color: '#6b6459', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

  body:        { flex: 1, display: 'flex', minHeight: 0 },
  toc:         { flexShrink: 0, width: 220, overflowY: 'auto', padding: '28px 12px 28px 24px', borderRight: '1px solid #ddd6c9', display: 'flex', flexDirection: 'column', gap: 2 },
  tocItem:     { textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', fontSize: 13, color: '#6b6459', padding: '5px 6px', borderRadius: 2, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis' },

  scroll:      { flex: 1, overflowY: 'auto', minWidth: 0 },
  article:     { maxWidth: 680, margin: '0 auto', padding: '40px 24px 80px' },
  title:       { fontSize: 30, fontWeight: 'normal', margin: '0 0 12px', lineHeight: 1.2 },
  rule:        { height: 1, background: '#ddd6c9', margin: '0 0 28px' },
  section:     { margin: '0 0 24px', scrollMarginTop: 16 },
  h2:          { fontSize: 20, fontWeight: 'normal', fontStyle: 'italic', margin: '24px 0 8px' },
  content:     { fontSize: 17, lineHeight: 1.7, color: '#2b2620', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },

  footer:      { flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 16px', padding: '10px 24px', borderTop: '1px solid #ddd6c9', background: '#f5f2eb' },
  byline:      { fontSize: 13, fontStyle: 'italic', color: '#6b6459' },
  hosted:      { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, color: '#8a847a', wordBreak: 'break-all' },
  link:        { color: '#2a7f81' },
  muted:       { fontStyle: 'italic', color: '#8a847a' },
};
