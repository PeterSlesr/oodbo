import React, { useEffect, useRef, useState } from 'react';
import { fetchPublicSnapshot, driveViewUrl } from '../lib/share.js';

const SCHEMES = [['green', '◉ GREEN'], ['amber', '◉ AMBER'], ['dark', '◉ DARK'], ['light', '◉ LIGHT'], ['parchment', '◉ PARCHMENT']];

// Public read-only viewer for a shared piece (route: /s/<fileId>). Fetches the public JSON
// snapshot straight from the writer's Drive with the browser API key (no sign-in), and renders
// it as our own page in the CRT/phosphor look. Layout: full-width terminal header + status-bar
// footer, a scrollable middle with a left section nav (table of contents) that jumps to each
// section. A "hosted at …" line makes clear the content lives in the writer's own Drive.
export default function ShareView({ fileId }) {
  const [state, setState] = useState({ loading: true });
  const [wide, setWide]   = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 820 : true));
  const [scheme, setScheme] = useState(() => {
    try { return localStorage.getItem('fwd:crt-scheme') || 'green'; } catch { return 'green'; }
  });
  const pickScheme = (v) => {
    setScheme(v);
    try { localStorage.setItem('fwd:crt-scheme', v); } catch {}
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);
  const curLabel = (SCHEMES.find((x) => x[0] === scheme) || SCHEMES[0])[1];

  useEffect(() => {
    let cancelled = false;
    // DEV-only design mock (localhost /s/demo) so the full layout can be previewed without a
    // real published Drive file. Stripped from production builds (import.meta.env.DEV is false).
    if (import.meta.env.DEV && fileId === 'demo') {
      setState({ loading: false, snap: {
        title: 'The Lighthouse Keeper',
        author: 'writer@example.com',
        sections: [
          { title: 'One',   content: 'The lamp had not gone out in forty years.\nHe intended to keep it that way, storm or no storm.\n\nÉ, ñ, ü, ø — accented latin still renders in the pixel font.' },
          { title: 'Two',   content: 'By morning the sea had flattened to a sheet of hammered tin.\nHe wrote it all down, and did not look back.' },
          { title: 'Fallback', content: 'Кириллица · 中文 · العربية — non-Latin falls back to a clean monospace.' },
        ],
      } });
      return () => { cancelled = true; };
    }
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

  const pageClass = 'crt-scanlines crt-vignette';

  if (state.loading) {
    return (
      <div className={pageClass} data-scheme={scheme} style={s.page}>
        <div style={s.center}><p style={s.boot}>LOADING<span className="crt-caret" /></p></div>
      </div>
    );
  }
  if (state.error || !state.snap) {
    return (
      <div className={pageClass} data-scheme={scheme} style={s.page}>
        <div style={s.center}>
          <p style={s.errTitle}>// SIGNAL LOST //</p>
          <p style={s.muted}>This shared piece isn’t available. It may have been unpublished by its author.</p>
        </div>
      </div>
    );
  }

  const { snap } = state;
  const sections = Array.isArray(snap.sections) ? snap.sections : [];
  const showToc  = wide && sections.length > 1;

  return (
    <div className={pageClass} data-scheme={scheme} style={s.page}>
      {/* Full-breadth terminal header */}
      <header style={s.header}>
        <span style={s.brand}>FORWARD&nbsp;ONLY</span>
        <span style={s.slash}>//</span>
        <span style={s.headerTitle}>{(snap.title || 'Untitled').toUpperCase()}</span>
        <span style={s.tools} ref={menuRef}>
          <button className="crt-tog" aria-haspopup="listbox" aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((o) => !o)}>{curLabel}&nbsp;▾</button>
          {menuOpen && (
            <div className="crt-menu" role="listbox">
              {SCHEMES.map(([val, label]) => (
                <button key={val} role="option" aria-selected={scheme === val}
                        className={`crt-menu-item${scheme === val ? ' on' : ''}`}
                        onClick={() => { pickScheme(val); setMenuOpen(false); }}>{label}</button>
              ))}
            </div>
          )}
        </span>
      </header>

      <div style={s.body}>
        {/* Left section nav (table of contents) */}
        {showToc && (
          <nav style={s.toc} aria-label="Sections">
            <p style={s.tocLabel}>// SECTIONS</p>
            {sections.map((sec, i) => (
              <button key={i} className="crt-toc-item" onClick={() => jumpTo(`sec-${i}`)}>
                ▸ {sec.title || `Section ${i + 1}`}
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

      {/* Full-breadth status-bar footer */}
      <footer style={s.footer}>
        <span style={s.byline}>
          WRITTEN BY A HUMAN AT <a href="https://write.mercoogs.com" className="crt-link">write.mercoogs.com</a>
        </span>
        <span style={s.hosted}>
          HOSTED AT <a href={driveViewUrl(fileId)} target="_blank" rel="noopener noreferrer" className="crt-link">{driveViewUrl(fileId)}</a>
          {snap.author ? <> · IN THE DRIVE OF {snap.author}</> : null}
        </span>
      </footer>
    </div>
  );
}

const s = {
  page:        { position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--tx)', fontFamily: 'var(--fm)', fontSize: 14 },
  center:      { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '0 24px', textAlign: 'center' },
  boot:        { fontFamily: 'var(--fd)', fontSize: 26, letterSpacing: '0.15em', color: 'var(--ph)', textShadow: 'var(--glow)' },
  errTitle:    { fontFamily: 'var(--fd)', fontSize: 24, letterSpacing: '0.12em', color: 'var(--ph)', textShadow: 'var(--glow)' },

  header:      { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', borderBottom: '1px solid var(--bd)', background: 'var(--bg2)' },
  brand:       { fontFamily: 'var(--fd)', fontSize: 22, letterSpacing: '0.15em', color: 'var(--ph)', textShadow: 'var(--glow)', whiteSpace: 'nowrap' },
  slash:       { color: 'var(--tx-faint)', fontSize: 12 },
  headerTitle: { flex: 1, minWidth: 0, fontSize: 12, letterSpacing: '0.06em', color: 'var(--tx-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tools:       { position: 'relative', display: 'flex', gap: 4, flexShrink: 0 },

  body:        { flex: 1, display: 'flex', minHeight: 0 },
  toc:         { flexShrink: 0, width: 230, overflowY: 'auto', padding: '18px 10px 24px 16px', borderRight: '1px solid var(--bd)', display: 'flex', flexDirection: 'column', gap: 2, background: 'var(--bg)' },
  tocLabel:    { fontSize: 10, letterSpacing: '0.12em', color: 'var(--tx-faint)', margin: '0 0 8px 6px' },

  scroll:      { flex: 1, overflowY: 'auto', minWidth: 0 },
  article:     { maxWidth: 720, margin: '0 auto', padding: '40px 28px 96px' },
  title:       { fontFamily: 'var(--fd)', fontSize: 40, fontWeight: 'normal', letterSpacing: '0.06em', lineHeight: 1.1, color: 'var(--ph)', textShadow: 'var(--glow)', margin: '0 0 14px' },
  rule:        { height: 1, background: 'var(--bd)', margin: '0 0 28px' },
  section:     { margin: '0 0 26px', scrollMarginTop: 16 },
  h2:          { fontFamily: 'var(--fd)', fontSize: 26, fontWeight: 'normal', letterSpacing: '0.05em', color: 'var(--ph)', textShadow: 'var(--glow)', margin: '26px 0 10px' },
  content:     { fontSize: 15.5, lineHeight: 1.85, color: 'var(--tx)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },

  footer:      { flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 16px', padding: '8px 16px', borderTop: '1px solid var(--bd)', background: 'var(--bg2)' },
  byline:      { fontSize: 11, letterSpacing: '0.05em', color: 'var(--tx-dim)' },
  hosted:      { fontSize: 10, letterSpacing: '0.03em', color: 'var(--tx-faint)', wordBreak: 'break-all' },
  muted:       { color: 'var(--tx-dim)', fontSize: 13, maxWidth: 460, lineHeight: 1.6 },
};
