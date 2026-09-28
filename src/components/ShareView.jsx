import React, { useEffect, useState } from 'react';
import { fetchPublicSnapshot, driveViewUrl } from '../lib/share.js';

// Public read-only viewer for a shared piece (route: /s/<fileId>). Fetches the public JSON
// snapshot straight from the writer's Drive with the browser API key (no sign-in), and renders
// it as our own page — so we control the look (CRT styling comes in the aesthetic pass). A
// "Hosted at …" line makes clear the content lives in the writer's own Drive, not on our site.
export default function ShareView({ fileId }) {
  const [state, setState] = useState({ loading: true });

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

  if (state.loading) {
    return <div style={s.page}><p style={s.muted}>Loading…</p></div>;
  }
  if (state.error || !state.snap) {
    return (
      <div style={s.page}>
        <div style={s.article}>
          <p style={s.muted}>This shared piece isn’t available. It may have been unpublished by its author.</p>
        </div>
      </div>
    );
  }

  const { snap } = state;
  const sections = Array.isArray(snap.sections) ? snap.sections : [];

  return (
    <div style={s.page}>
      <article style={s.article}>
        <h1 style={s.title}>{snap.title || 'Untitled'}</h1>
        <div style={s.rule} />
        {sections.map((sec, i) => (
          <section key={i} style={s.section}>
            {sec.title ? <h2 style={s.h2}>{sec.title}</h2> : null}
            {sec.content ? <div style={s.content}>{sec.content}</div> : null}
          </section>
        ))}
        <footer style={s.footer}>
          <p style={s.byline}>
            written by a human at{' '}
            <a href="https://write.mercoogs.com" style={s.link}>write.mercoogs.com</a>
          </p>
          <p style={s.hosted}>
            Hosted at{' '}
            <a href={driveViewUrl(fileId)} target="_blank" rel="noopener noreferrer" style={s.link}>{driveViewUrl(fileId)}</a>
            {snap.author ? <> · in the Drive of {snap.author}</> : null}
          </p>
        </footer>
      </article>
    </div>
  );
}

// Plain parchment styling for now — replaced by the CRT/phosphor look in the aesthetic pass.
const s = {
  page:    { minHeight: '100%', background: '#f5f2eb', color: '#1f1f1f', padding: '48px 20px', display: 'flex', justifyContent: 'center' },
  article: { maxWidth: 680, width: '100%', fontFamily: 'Georgia, "Times New Roman", serif' },
  title:   { fontSize: 30, fontWeight: 'normal', margin: '0 0 12px', lineHeight: 1.2 },
  rule:    { height: 1, background: '#ddd6c9', margin: '0 0 28px' },
  section: { margin: '0 0 24px' },
  h2:      { fontSize: 20, fontWeight: 'normal', fontStyle: 'italic', margin: '24px 0 8px' },
  // Preserve the writer's line breaks exactly as typed (matches the editor). pre-wrap keeps
  // single and double newlines and still wraps long lines.
  content: { fontSize: 17, lineHeight: 1.7, color: '#2b2620', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  p:       { fontSize: 17, lineHeight: 1.7, margin: '0 0 14px', color: '#2b2620' },
  footer:  { marginTop: 40, paddingTop: 16, borderTop: '1px solid #ddd6c9' },
  byline:  { fontSize: 13, fontStyle: 'italic', color: '#6b6459', margin: '0 0 4px' },
  hosted:  { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, color: '#8a847a', margin: 0, wordBreak: 'break-all' },
  link:    { color: '#2a7f81' },
  muted:   { fontFamily: 'Georgia, serif', fontStyle: 'italic', color: '#8a847a' },
};
