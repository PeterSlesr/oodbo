import React, { useState, useEffect, useRef } from 'react';

const REPORT_CATS = [
  { value: 'csam',        label: 'Child sexual abuse material (CSAM)' },
  { value: 'threats',     label: 'Threats of violence' },
  { value: 'harassment',  label: 'Harassment or bullying' },
  { value: 'hate_speech', label: 'Hate speech' },
  { value: 'doxxing',     label: 'Doxxing / sharing private information' },
  { value: 'copyright',   label: 'Copyright infringement' },
  { value: 'other',       label: 'Other' },
];

const HEADER_H = 72;

export default function SharedViewer({ id }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  // Show section nav only when viewport is wide enough to not overlap content
  const [wide, setWide] = useState(() => window.innerWidth >= 1000);

  // Menu + report form state
  const [menuOpen,          setMenuOpen]          = useState(false);
  const [copied,            setCopied]            = useState(false);
  const [reportOpen,        setReportOpen]        = useState(false);
  const [reportCat,         setReportCat]         = useState('');
  const [reportDetails,     setReportDetails]     = useState('');
  const [reportDone,        setReportDone]        = useState(false);
  const [reported,          setReported]          = useState(false);
  const [reportError,       setReportError]       = useState('');
  const [reportSubmitting,  setReportSubmitting]  = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const check = () => setWide(window.innerWidth >= 1000);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  function copyLink() {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
    setMenuOpen(false);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function openReport() {
    setMenuOpen(false);
    setReportOpen(true);
  }

  async function submitReport() {
    if (!reportCat) return;
    if (reportCat === 'other' && !reportDetails.trim()) {
      setReportError('Please describe the issue.');
      return;
    }
    setReportSubmitting(true);
    setReportError('');
    try {
      const res = await fetch('/api/report', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareId:  id,
          category: reportCat,
          details:  reportDetails.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setReportError(d.error || 'Something went wrong. Please try again.');
      } else {
        setReported(true);
        setReportDone(true);
      }
    } catch {
      setReportError('Network error. Please try again.');
    }
    setReportSubmitting(false);
  }

  // Prevent search engines from indexing shared pages
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name    = 'robots';
    meta.content = 'noindex,nofollow';
    document.head.appendChild(meta);
    const style = document.createElement('style');
    style.textContent = '@keyframes fadeOutToast { 0%,60%{opacity:1} 100%{opacity:0} }';
    document.head.appendChild(style);
    return () => { document.head.removeChild(meta); document.head.removeChild(style); };
  }, []);

  // SharedViewer needs normal document scroll
  useEffect(() => {
    const els = [document.documentElement, document.body, document.getElementById('root')];
    els.forEach(el => { if (el) el.style.overflow = 'auto'; });
    return () => els.forEach(el => { if (el) el.style.overflow = ''; });
  }, []);

  useEffect(() => {
    fetch(`/api/share?id=${encodeURIComponent(id)}`)
      .then(r => {
        if (r.status === 404) { setMissing(true); setLoading(false); return null; }
        if (!r.ok) throw new Error('fetch failed');
        return r.json();
      })
      .then(d => {
        if (d) {
          document.title = `${d.title || 'Untitled'} — oodbo`;
          setData(d);
        }
        setLoading(false);
      })
      .catch(() => { setMissing(true); setLoading(false); });
  }, [id]);

  if (loading) return null;

  if (missing) {
    return (
      <div style={s.page}>
        <header style={s.header}>
          <a href="https://www.oodbo.io" target="_blank" rel="noopener noreferrer" style={s.logo}>oodbo</a>
        </header>
        <div style={s.content}>
          {reported && <p style={s.reportedMsg}>Report submitted. Thank you.</p>}
          <p style={s.notFound}>This link is no longer available.</p>
        </div>
        <footer style={s.footer}>
          <a href="/" target="_blank" rel="noopener noreferrer" style={s.footerCta}>oodbo — draft without looking back</a>
        </footer>
      </div>
    );
  }

  const { title, content, updatedAt } = data;
  const chapters = content?.chapters?.length
    ? content.chapters
    : content?.content !== undefined
      ? [{ id: 'single', title: '', content: content.content, level: 1 }]
      : [];

  // Only show nav for chapters that have titles
  const navChapters = chapters.filter(ch => ch.title);
  const showNav = wide && navChapters.length > 1;

  return (
    <div style={s.page}>
      <header style={s.header}>
        <a href="https://www.oodbo.io" target="_blank" rel="noopener noreferrer" style={s.logo}>oodbo</a>

        {/* Title + date absolutely centered so logo width doesn't shift it */}
        <div style={s.headerCenter}>
          <span style={s.headerTitle}>{title || 'Untitled'}</span>
          {updatedAt && (
            <span style={s.headerDate}> · updated {new Date(updatedAt).toLocaleString()}</span>
          )}
        </div>
      </header>

      {/* Fixed section navigation — only on wide viewports with multiple titled chapters */}
      {showNav && (
        <nav style={s.sectionNav}>
          <p style={s.sectionNavHead}>sections</p>
          {navChapters.map((ch, i) => (
            <a
              key={ch.id || i}
              href={`#ch-${ch.id || chapters.indexOf(ch)}`}
              style={s.sectionNavLink}
            >
              {ch.title}
            </a>
          ))}
        </nav>
      )}

      <div style={s.content}>
        {chapters.map((ch, i) => (
          <div key={ch.id || i} id={`ch-${ch.id || i}`} style={s.chapter}>
            {ch.title && (chapters.length > 1 || ch.level > 1) && (
              <h2 style={{
                ...s.chapterTitle,
                fontSize: ch.level === 1 ? 20 : ch.level === 2 ? 17 : 15,
                marginTop: i === 0 ? 0 : 40,
              }}>{ch.title}</h2>
            )}
            <div style={s.body}>
              {(ch.content || '').split('\n').filter(p => p.trim()).map((para, j) => (
                <p key={j} style={s.para}>{para}</p>
              ))}
            </div>
          </div>
        ))}
      </div>

      <footer style={s.footer}>
        {/* Left: ... menu */}
        <div style={{ position: 'relative' }} ref={menuRef}>
          {reportDone ? (
            <span style={s.reportConfirm}>Report submitted. Thank you.</span>
          ) : (
            <button style={s.menuBtn} onClick={() => setMenuOpen(o => !o)}>···</button>
          )}
          {menuOpen && (
            <div style={s.menuDropdown}>
              <button style={s.menuItem} onClick={copyLink}>Copy link</button>
              <a href="mailto:hello@oodbo.io" style={s.menuItem} onClick={() => setMenuOpen(false)}>Contact us</a>
              <button style={{ ...s.menuItem, color: '#999' }} onClick={openReport}>Report this page</button>
            </div>
          )}
        </div>
        {/* Right: brand */}
        <div style={s.footerRight}>
          {/* No-AI mark. The circle+slash is decorative (aria-hidden, unselectable); an in-place,
              transparent, selectable "no AI" overlays it so any copy — the whole page OR just the
              badge — carries the meaning instead of a bare, misleading "AI". */}
          <span style={{ position: 'relative', display: 'inline-flex', width: 24, height: 24, flexShrink: 0 }}>
            <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>
              <circle cx="12" cy="12" r="10" fill="none" stroke="#bbb" strokeWidth="1.5"/>
              <line x1="4.5" y1="4.5" x2="19.5" y2="19.5" stroke="#bbb" strokeWidth="1.5"/>
              <text x="12" y="17" textAnchor="middle" fontFamily="Georgia, serif" fontSize="16" fill="#bbb">AI</text>
            </svg>
            <span style={{ position: 'absolute', inset: 0, color: 'transparent', overflow: 'hidden', fontSize: 12, lineHeight: '24px', whiteSpace: 'nowrap' }}>no AI </span>
          </span>
          <a href="https://www.oodbo.io" target="_blank" rel="noopener noreferrer" style={s.footerBrand}>written by a human with oodbo</a>
        </div>
      </footer>

      {/* Copy link toast */}
      {copied && (
        <div style={s.toast}>Link copied to clipboard</div>
      )}

      {/* Report form — fixed bottom-sheet (own scroll) so the sticky footer never covers the
          Submit button, and the page behind doesn't scroll oddly under it. */}
      {reportOpen && !reportDone && (
        <div style={s.reportBackdrop} onClick={() => { setReportOpen(false); setReportCat(''); setReportDetails(''); setReportError(''); }}>
        <div style={s.reportPanel} onClick={e => e.stopPropagation()}>
          <p style={s.reportHeading}>Report this page</p>
          {REPORT_CATS.map(({ value, label }) => (
            <label key={value} style={s.radioRow}>
              <input
                type="radio"
                name="report-cat"
                value={value}
                checked={reportCat === value}
                onChange={() => setReportCat(value)}
                style={{ marginRight: 8, accentColor: '#888' }}
              />
              <span style={s.radioLabel}>{label}</span>
            </label>
          ))}
          <textarea
            value={reportDetails}
            onChange={e => setReportDetails(e.target.value)}
            placeholder={reportCat === 'other'
              ? 'Please describe the issue (required)'
              : 'Additional details (optional)'}
            style={s.reportTextarea}
            rows={3}
          />
          {reportError && <p style={s.reportErrorText}>{reportError}</p>}
          <div style={s.reportActions}>
            <button
              style={{ ...s.reportSubmitBtn, opacity: (!reportCat || reportSubmitting) ? 0.5 : 1 }}
              disabled={!reportCat || reportSubmitting}
              onClick={submitReport}>
              {reportSubmitting ? 'Submitting…' : 'Submit report'}
            </button>
            <button style={s.reportCancelBtn} onClick={() => { setReportOpen(false); setReportCat(''); setReportDetails(''); setReportError(''); }}>
              Cancel
            </button>
          </div>
        </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = {
  page: {
    minHeight: '100vh',
    background: '#f5f2eb',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'Georgia, serif',
  },
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    padding: '0 24px',
    height: HEADER_H,
    borderBottom: '1px solid #ddd6c9',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    background: '#f5f2eb',
  },
  // Absolutely centered so logo width has no effect
  headerCenter: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'baseline',
    gap: 0,
    maxWidth: 'calc(100vw - 160px)',
    overflow: 'hidden',
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: 'normal',
    color: '#111',
    letterSpacing: '-0.02em',
    lineHeight: 1.3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  headerDate: {
    fontSize: 11,
    color: '#aaa',
    fontStyle: 'italic',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  logo: {
    fontSize: 15,
    fontStyle: 'italic',
    color: '#888',
    letterSpacing: '-0.01em',
    textDecoration: 'none',
    position: 'relative', // sits above the absolute centerpiece in z-order
    zIndex: 1,
  },
  // Fixed left section nav — only rendered on wide viewports
  sectionNav: {
    position: 'fixed',
    top: HEADER_H + 32,
    left: 24,
    zIndex: 5,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    maxWidth: 160,
  },
  sectionNavHead: {
    fontSize: 10,
    color: '#bbb',
    fontStyle: 'italic',
    letterSpacing: '0.05em',
    textTransform: 'lowercase',
    margin: '0 0 6px',
  },
  sectionNavLink: {
    fontSize: 12,
    color: '#999',
    fontStyle: 'italic',
    textDecoration: 'none',
    lineHeight: 1.5,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'block',
  },
  content: {
    flex: 1,
    maxWidth: 640,
    width: '100%',
    margin: '0 auto',
    padding: '36px 24px 64px',
    boxSizing: 'border-box',
  },
  chapter: {
    marginBottom: 8,
    scrollMarginTop: HEADER_H + 24,
  },
  chapterTitle: {
    fontWeight: 'normal',
    color: '#111',
    letterSpacing: '-0.01em',
    margin: '0 0 14px',
    lineHeight: 1.4,
  },
  body: {
    fontSize: 16,
    lineHeight: 1.85,
    color: '#1f1f1f',
  },
  para: {
    margin: '0 0 18px',
  },
  reportedMsg: {
    fontSize: 13,
    color: '#5a8a5a',
    fontStyle: 'italic',
    paddingTop: 48,
    margin: '0 0 8px',
  },
  notFound: {
    fontSize: 14,
    color: '#888',
    fontStyle: 'italic',
    paddingTop: 16,
    margin: '0 0 16px',
  },
  tryLink: {
    fontFamily: 'Georgia, serif',
    fontSize: 13,
    color: '#111',
    fontStyle: 'italic',
  },
  footer: {
    position: 'sticky',
    bottom: 0,
    zIndex: 10,
    padding: '14px 24px',
    borderTop: '1px solid #ddd6c9',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
    background: '#f5f2eb',
  },
  footerLeft: {
    display: 'flex',
    alignItems: 'center',
  },
  footerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  footerBrand: {
    fontSize: 11,
    color: '#aaa',
    fontStyle: 'italic',
    textDecoration: 'none',
  },
  toast: {
    position: 'fixed',
    bottom: 72,
    left: 24,
    background: '#111',
    color: '#f5f2eb',
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 13,
    padding: '9px 20px',
    zIndex: 100,
    pointerEvents: 'none',
    animation: 'fadeOutToast 2s ease forwards',
  },
  menuBtn: {
    fontFamily: 'Georgia, serif',
    fontSize: 16,
    color: '#bbb',
    background: 'none',
    border: 'none',
    padding: '0 4px',
    cursor: 'pointer',
    letterSpacing: 2,
  },
  menuDropdown: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    marginBottom: 8,
    background: '#fff',
    border: '1px solid #ddd6c9',
    padding: '4px 0',
    minWidth: 160,
    zIndex: 20,
    display: 'flex',
    flexDirection: 'column',
  },
  menuItem: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 13,
    color: '#444',
    background: 'none',
    border: 'none',
    padding: '8px 16px',
    cursor: 'pointer',
    textAlign: 'left',
    textDecoration: 'none',
    display: 'block',
  },
  reportConfirm: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 11,
    color: '#888',
  },
  reportBtn: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 11,
    color: '#bbb',
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
  },
  reportBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.28)',
    zIndex: 40,
  },
  reportPanel: {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
    background: '#f5f2eb',
    borderTop: '1px solid #ddd6c9',
    padding: '20px 24px 24px',
    maxHeight: '80vh',
    overflowY: 'auto',
    boxShadow: '0 -8px 30px rgba(0,0,0,0.15)',
    boxSizing: 'border-box',
  },
  reportHeading: {
    fontSize: 13,
    fontStyle: 'italic',
    color: '#888',
    margin: '0 0 12px',
  },
  radioRow: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: 6,
    cursor: 'pointer',
  },
  radioLabel: {
    fontSize: 13,
    color: '#444',
    lineHeight: 1.4,
  },
  reportTextarea: {
    fontFamily: 'Georgia, serif',
    fontSize: 13,
    width: '100%',
    maxWidth: 560,
    border: '1px solid #ddd6c9',
    borderRadius: 4,
    padding: '7px 10px',
    marginTop: 10,
    resize: 'vertical',
    background: '#fff',
    color: '#111',
    boxSizing: 'border-box',
    outline: 'none',
  },
  reportErrorText: {
    fontSize: 12,
    color: '#c0392b',
    fontStyle: 'italic',
    margin: '6px 0 0',
  },
  reportActions: {
    display: 'flex',
    gap: 10,
    marginTop: 12,
    alignItems: 'center',
  },
  reportSubmitBtn: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 13,
    background: '#111',
    color: '#f5f2eb',
    border: 'none',
    borderRadius: 4,
    padding: '7px 16px',
    cursor: 'pointer',
  },
  reportCancelBtn: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 13,
    background: 'none',
    color: '#888',
    border: 'none',
    padding: '7px 4px',
    cursor: 'pointer',
  },
};
