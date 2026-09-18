import React, { useState, useEffect } from 'react';

const SESSION_KEY = 'oodbo:admin';

const CAT = {
  csam:        'CSAM',
  threats:     'Threats',
  harassment:  'Harassment',
  hate_speech: 'Hate speech',
  doxxing:     'Doxxing',
  copyright:   'Copyright',
  other:       'Other',
};

export default function Admin() {
  const [secret,      setSecret]      = useState(() => sessionStorage.getItem(SESSION_KEY) || '');
  const [pwInput,     setPwInput]     = useState('');
  const [pwError,     setPwError]     = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [tab,         setTab]         = useState('reports');  // 'reports' | 'shares'
  const [reports,     setReports]     = useState([]);
  const [filter,      setFilter]      = useState('pending');
  const [expanded,    setExpanded]    = useState(null);       // reportId with content visible
  const [shareCache,  setShareCache]  = useState({});         // shareId → content | 'loading' | null
  const [working,     setWorking]     = useState(null);       // reportId currently being actioned
  const [confirming,  setConfirming]  = useState(null);       // { reportId, verdict, notes } | null
  const [allShares,   setAllShares]   = useState([]);         // shared_pages list
  const [sharesLoaded, setSharesLoaded] = useState(false);
  const [query,       setQuery]       = useState('');         // search filter (shared across tabs)

  // The global CSS locks html/body/root to overflow:hidden for the editor.
  // Admin needs normal document scroll — override on mount, restore on unmount.
  useEffect(() => {
    const els = [document.documentElement, document.body, document.getElementById('root')];
    els.forEach(el => { if (el) el.style.overflow = 'auto'; });
    return () => els.forEach(el => { if (el) el.style.overflow = ''; });
  }, []);

  // Prevent crawlers from indexing the admin page
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name    = 'robots';
    meta.content = 'noindex,nofollow';
    document.head.appendChild(meta);
    return () => document.head.removeChild(meta);
  }, []);

  // Auto-load if we already have a secret in sessionStorage
  useEffect(() => { if (secret) loadReports(secret); }, []);

  async function handleLogin(e) {
    e.preventDefault();
    const s = pwInput.trim();
    if (!s) return;
    setLoading(true);
    setPwError(false);
    const res = await fetch('/api/report', {
      headers: { Authorization: `Bearer ${s}` },
    });
    if (res.status === 403 || res.status === 401) {
      setPwError(true);
      setLoading(false);
      return;
    }
    const { reports: data } = await res.json();
    sessionStorage.setItem(SESSION_KEY, s);
    setSecret(s);
    setReports(data ?? []);
    setLoading(false);
  }

  async function loadReports(tok = secret) {
    setLoading(true);
    const res = await fetch('/api/report', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) { sessionStorage.removeItem(SESSION_KEY); setSecret(''); setLoading(false); return; }
    const { reports: data } = await res.json();
    setReports(data ?? []);
    setLoading(false);
  }

  async function loadShareContent(shareId) {
    if (shareCache[shareId] !== undefined) return;
    setShareCache(c => ({ ...c, [shareId]: 'loading' }));
    try {
      const res = await fetch(`/api/report?shareId=${encodeURIComponent(shareId)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (!res.ok) throw new Error('not found');
      const d = await res.json();
      setShareCache(c => ({ ...c, [shareId]: d }));
    } catch {
      setShareCache(c => ({ ...c, [shareId]: null }));
    }
  }

  async function loadAllShares() {
    if (sharesLoaded) return;
    setLoading(true);
    const res = await fetch('/api/report?view=shares', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (res.ok) {
      const { shares: data } = await res.json();
      setAllShares(data ?? []);
      setSharesLoaded(true);
    }
    setLoading(false);
  }

  async function applyVerdict(reportId, v, notes = '') {
    setWorking(reportId);
    await fetch('/api/report', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body:    JSON.stringify({ id: reportId, verdict: v, verdictNotes: notes }),
    });
    await loadReports();
    setWorking(null);
  }

  const counts = {
    pending:   reports.filter(r => !r.verdict).length,
    dismissed: reports.filter(r => r.verdict === 'dismissed').length,
    blocked:   reports.filter(r => r.verdict === 'blocked').length,
    all:       reports.length,
  };

  const q = query.trim().toLowerCase();

  const visible = reports.filter(r => {
    const statusMatch =
      filter === 'all'     ? true :
      filter === 'pending' ? !r.verdict :
      r.verdict === filter;
    if (!statusMatch) return false;
    if (!q) return true;
    return (
      (r.owner_email    || '').toLowerCase().includes(q) ||
      (r.share_title    || '').toLowerCase().includes(q) ||
      (r.category       || '').toLowerCase().includes(q) ||
      (r.reporter_email || '').toLowerCase().includes(q) ||
      (r.details        || '').toLowerCase().includes(q)
    );
  });

  const visibleShares = allShares.filter(share => {
    if (!q) return true;
    return (
      (share.owner_email    || '').toLowerCase().includes(q) ||
      (share.title          || '').toLowerCase().includes(q) ||
      (share.id             || '').toLowerCase().includes(q) ||
      (share.inactive_reason|| '').toLowerCase().includes(q)
    );
  });

  // Not authenticated yet — show password prompt
  if (!secret) {
    return (
      <div style={s.page}>
        <header style={s.header}>
          <a href="/" style={s.logo}>oodbo</a>
          <span style={s.headerSep}>·</span>
          <span style={s.headerTitle}>reports</span>
        </header>
        <div style={s.loginWrap}>
          <form onSubmit={handleLogin} style={s.loginForm}>
            <input
              type="password"
              value={pwInput}
              onChange={e => setPwInput(e.target.value)}
              placeholder="admin secret"
              autoFocus
              style={{ ...s.pwInput, borderColor: pwError ? '#c0392b' : '#ddd6c9' }}
            />
            {pwError && <p style={s.pwError}>Wrong secret.</p>}
            <button type="submit" disabled={loading} style={s.pwBtn}>
              {loading ? 'Checking…' : 'Enter'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={s.page}>
        <p style={s.centred}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <header style={s.header}>
        <a href="/" style={s.logo}>oodbo</a>
        <span style={s.headerSep}>·</span>
        <span style={s.headerTitle}>admin</span>
      </header>

      <div style={s.body}>
        {/* Top-level tab switcher */}
        <div style={s.topTabs}>
          <button
            style={{ ...s.topTab, ...(tab === 'reports' ? s.topTabActive : {}) }}
            onClick={() => setTab('reports')}>
            reports
            {counts.pending > 0 && <span style={s.pendingDot}>{counts.pending}</span>}
          </button>
          <button
            style={{ ...s.topTab, ...(tab === 'shares' ? s.topTabActive : {}) }}
            onClick={() => { setTab('shares'); loadAllShares(); }}>
            share links
          </button>
        </div>

        {/* Search bar — shared across both tabs */}
        <div style={s.searchWrap}>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="filter by owner, title, category…"
            style={s.searchInput}
          />
          {query && (
            <button style={s.searchClear} onClick={() => setQuery('')}>×</button>
          )}
        </div>

        {/* ── Reports tab ── */}
        {tab === 'reports' && (
          <>
            <div style={s.tabs}>
              {['pending', 'dismissed', 'blocked', 'all'].map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  style={{ ...s.tab, ...(filter === f ? s.tabActive : {}) }}>
                  {f}
                  <span style={s.tabCount}>{counts[f]}</span>
                </button>
              ))}
            </div>

            {visible.length === 0 && (
              <p style={s.empty}>{q ? 'No matches.' : `No ${filter === 'all' ? '' : filter} reports.`}</p>
            )}

            {visible.map(r => {
              const isOpen     = expanded === r.id;
              const shareData  = shareCache[r.share_id];
              const isCsam     = r.category === 'csam';

              return (
                <div key={r.id} style={s.card}>
                  <div style={s.cardTop}>
                    <span style={{ ...s.catBadge, background: isCsam ? '#7d1a1a' : '#8b6f47' }}>
                      {CAT[r.category] || r.category}
                    </span>
                    {r.verdict && (
                      <span style={{
                        ...s.verdictBadge,
                        color: r.verdict === 'dismissed' ? '#888' : '#c0392b',
                      }}>
                        {r.verdict}
                      </span>
                    )}
                    <span style={s.date}>
                      {new Date(r.created_at).toLocaleDateString('en-GB', {
                        day: 'numeric', month: 'short', year: 'numeric',
                      })}
                    </span>
                  </div>

                  <div style={s.meta}>
                    <MetaRow label="title"    val={r.share_title || '—'} />
                    <MetaRow label="owner"    val={r.owner_email} />
                    {r.details        && <MetaRow label="details"  val={r.details} />}
                    {r.reporter_email && <MetaRow label="reporter" val={r.reporter_email} />}
                    {r.verdict_notes  && <MetaRow label="notes"    val={r.verdict_notes} />}
                  </div>

                  <button style={s.previewToggle}
                    onClick={() => {
                      if (isOpen) { setExpanded(null); return; }
                      setExpanded(r.id);
                      loadShareContent(r.share_id);
                    }}>
                    {isOpen ? 'hide content ↑' : 'view content ↓'}
                  </button>

                  {isOpen && (
                    <div style={s.preview}>
                      {shareData === 'loading' && <p style={s.previewMsg}>Loading…</p>}
                      {shareData === null       && <p style={s.previewMsg}>Content unavailable.</p>}
                      {shareData && shareData !== 'loading' && (() => {
                        const chapters = shareData.content?.chapters?.length
                          ? shareData.content.chapters
                          : [{ content: shareData.content?.content || '' }];
                        return (
                          <>
                            <p style={s.previewTitle}>{shareData.title || 'Untitled'}</p>
                            {chapters.map((ch, i) => (
                              <div key={i}>
                                {ch.title && <p style={{ ...s.previewText, fontStyle: 'italic' }}>{ch.title}</p>}
                                <p style={s.previewText}>
                                  {(ch.content || '').slice(0, 600)}
                                  {(ch.content || '').length > 600 ? '…' : ''}
                                </p>
                              </div>
                            ))}
                          </>
                        );
                      })()}
                    </div>
                  )}

                  {!r.verdict && confirming?.reportId !== r.id && (
                    <div style={s.actions}>
                      <button disabled={working === r.id} style={{ ...s.btn, ...s.btnDismiss }}
                        onClick={() => setConfirming({ reportId: r.id, verdict: 'dismissed', notes: '' })}>
                        Dismiss
                      </button>
                      <button disabled={working === r.id} style={{ ...s.btn, ...s.btnBlock }}
                        onClick={() => setConfirming({ reportId: r.id, verdict: 'blocked', notes: '' })}>
                        Block
                      </button>
                      <button disabled={working === r.id} style={{ ...s.btn, ...s.btnCsam }}
                        onClick={() => setConfirming({ reportId: r.id, verdict: 'blocked', notes: 'CSAM — to be reported to NCMEC' })}>
                        CSAM / NCMEC
                      </button>
                    </div>
                  )}

                  {!r.verdict && confirming?.reportId === r.id && (
                    <div style={s.confirmPanel}>
                      <p style={s.confirmLabel}>
                        <strong>{confirming.verdict === 'dismissed' ? 'Dismiss' : 'Block'}</strong>
                        {' — '}notes to owner
                        <span style={s.confirmOptional}>(optional — included in email)</span>
                      </p>
                      <textarea
                        rows={2}
                        value={confirming.notes}
                        onChange={e => setConfirming(c => ({ ...c, notes: e.target.value }))}
                        placeholder="e.g. 'no policy violation found' or leave blank"
                        style={s.confirmTextarea}
                      />
                      <div style={s.confirmActions}>
                        <button
                          disabled={working === r.id}
                          style={{ ...s.btn, ...(confirming.verdict === 'dismissed' ? s.btnDismiss : s.btnBlock) }}
                          onClick={async () => {
                            await applyVerdict(confirming.reportId, confirming.verdict, confirming.notes);
                            setConfirming(null);
                          }}>
                          {working === r.id ? 'Saving…' : 'Confirm'}
                        </button>
                        <button style={s.confirmCancel} onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* ── Shares tab ── */}
        {tab === 'shares' && (
          <>
            {loading && <p style={s.empty}>Loading…</p>}
            {!loading && visibleShares.length === 0 && (
              <p style={s.empty}>{allShares.length === 0 ? 'No share links yet.' : 'No matches.'}</p>
            )}
            {visibleShares.map(share => (
              <div key={share.id} style={s.card}>
                <div style={s.cardTop}>
                  <span style={{
                    ...s.statusDot,
                    background: share.active ? '#5a8a5a' : '#c0392b',
                  }} />
                  <span style={s.shareTitle}>{share.title || 'Untitled'}</span>
                  {!share.active && share.inactive_reason && (
                    <span style={s.inactiveReason}>{share.inactive_reason}</span>
                  )}
                  <span style={s.date}>
                    {new Date(share.created_at).toLocaleDateString('en-GB', {
                      day: 'numeric', month: 'short', year: 'numeric',
                    })}
                  </span>
                </div>
                <div style={s.meta}>
                  <MetaRow label="owner" val={share.owner_email} />
                  <MetaRow label="id"    val={
                    share.active
                      ? <a href={`/s/${share.id}`} target="_blank" rel="noopener noreferrer"
                          style={s.shareLink}>{share.id}</a>
                      : <span style={{ color: '#bbb' }}>{share.id}</span>
                  } />
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function MetaRow({ label, val }) {
  return (
    <div style={s.metaRow}>
      <span style={s.metaLabel}>{label}</span>
      <span style={s.metaVal}>{val}</span>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = {
  page: {
    minHeight: '100vh',
    background: '#f5f2eb',
    fontFamily: 'Georgia, serif',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    padding: '0 24px',
    height: 44,
    borderBottom: '1px solid #ddd6c9',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: '#f5f2eb',
    flexShrink: 0,
  },
  logo: {
    fontSize: 15,
    fontStyle: 'italic',
    color: '#888',
    letterSpacing: '-0.01em',
    textDecoration: 'none',
  },
  headerSep:   { color: '#ccc', fontSize: 14 },
  headerTitle: { fontSize: 13, color: '#aaa', fontStyle: 'italic' },
  body: {
    flex: 1,
    maxWidth: 720,
    width: '100%',
    margin: '0 auto',
    padding: '32px 24px 80px',
    boxSizing: 'border-box',
  },
  centred: {
    textAlign: 'center',
    color: '#888',
    fontStyle: 'italic',
    paddingTop: 80,
    fontSize: 14,
    margin: 0,
  },
  loginWrap: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    alignItems: 'stretch',
    width: 240,
  },
  pwInput: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 14,
    padding: '8px 12px',
    border: '1px solid #ddd6c9',
    borderRadius: 4,
    background: '#fff',
    color: '#111',
    outline: 'none',
  },
  pwError: {
    fontSize: 12,
    color: '#c0392b',
    fontStyle: 'italic',
    margin: 0,
  },
  pwBtn: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 13,
    background: '#111',
    color: '#f5f2eb',
    border: 'none',
    borderRadius: 4,
    padding: '8px 0',
    cursor: 'pointer',
  },
  searchWrap: {
    position: 'relative',
    marginBottom: 20,
  },
  searchInput: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 13,
    width: '100%',
    padding: '7px 32px 7px 12px',
    border: '1px solid #ddd6c9',
    borderRadius: 4,
    background: '#fff',
    color: '#111',
    outline: 'none',
    boxSizing: 'border-box',
  },
  searchClear: {
    position: 'absolute',
    right: 8,
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'none',
    border: 'none',
    fontSize: 16,
    color: '#bbb',
    cursor: 'pointer',
    lineHeight: 1,
    padding: '0 2px',
  },
  topTabs: {
    display: 'flex',
    gap: 0,
    marginBottom: 28,
    borderBottom: '1px solid #ddd6c9',
  },
  topTab: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 14,
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    padding: '8px 18px 8px 0',
    marginBottom: -1,
    cursor: 'pointer',
    color: '#aaa',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  topTabActive: {
    color: '#111',
    borderBottomColor: '#111',
  },
  pendingDot: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#c0392b',
    color: '#fff',
    fontSize: 10,
    fontStyle: 'normal',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    padding: '0 4px',
  },
  statusDot: {
    display: 'inline-block',
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
    marginTop: 1,
  },
  shareTitle: {
    fontSize: 14,
    color: '#111',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  inactiveReason: {
    fontSize: 11,
    color: '#c0392b',
    fontFamily: 'system-ui, sans-serif',
    fontStyle: 'normal',
    flexShrink: 0,
  },
  shareLink: {
    color: '#5a6a8a',
    fontSize: 12,
    wordBreak: 'break-all',
    fontFamily: 'system-ui, sans-serif',
    fontStyle: 'normal',
  },
  tabs: {
    display: 'flex',
    gap: 4,
    marginBottom: 28,
    flexWrap: 'wrap',
  },
  tab: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 13,
    background: 'none',
    border: '1px solid #ddd6c9',
    borderRadius: 4,
    padding: '5px 12px',
    cursor: 'pointer',
    color: '#888',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  tabActive: {
    background: '#e8e3d9',
    color: '#111',
    borderColor: '#c8bfb0',
  },
  tabCount: {
    fontSize: 11,
    color: '#bbb',
    fontStyle: 'normal',
  },
  empty: {
    fontStyle: 'italic',
    color: '#aaa',
    fontSize: 14,
    padding: '16px 0',
    margin: 0,
  },
  card: {
    background: '#fff',
    border: '1px solid #ddd6c9',
    borderRadius: 6,
    padding: '14px 16px',
    marginBottom: 10,
  },
  cardTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  catBadge: {
    display: 'inline-block',
    color: '#fff',
    fontSize: 11,
    fontFamily: 'system-ui, sans-serif',
    fontStyle: 'normal',
    fontWeight: 600,
    padding: '2px 7px',
    borderRadius: 3,
    letterSpacing: '0.03em',
  },
  verdictBadge: {
    fontSize: 12,
    fontFamily: 'system-ui, sans-serif',
    fontStyle: 'normal',
  },
  date: {
    marginLeft: 'auto',
    fontSize: 11,
    color: '#bbb',
    fontFamily: 'system-ui, sans-serif',
    fontStyle: 'normal',
    whiteSpace: 'nowrap',
  },
  meta: {
    marginBottom: 8,
  },
  metaRow: {
    display: 'flex',
    gap: 10,
    fontSize: 13,
    marginBottom: 3,
    alignItems: 'flex-start',
  },
  metaLabel: {
    color: '#bbb',
    minWidth: 54,
    fontStyle: 'italic',
    flexShrink: 0,
  },
  metaVal: {
    color: '#444',
    wordBreak: 'break-all',
  },
  previewToggle: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 12,
    color: '#aaa',
    background: 'none',
    border: 'none',
    padding: '2px 0 6px',
    cursor: 'pointer',
    display: 'block',
  },
  preview: {
    background: '#faf8f4',
    border: '1px solid #e8e3d9',
    borderRadius: 4,
    padding: '12px 14px',
    marginBottom: 10,
    maxHeight: 280,
    overflowY: 'auto',
  },
  previewMsg: {
    fontSize: 13,
    color: '#aaa',
    fontStyle: 'italic',
    margin: 0,
  },
  previewTitle: {
    fontSize: 15,
    fontWeight: 'normal',
    color: '#111',
    margin: '0 0 8px',
  },
  previewText: {
    fontSize: 13,
    lineHeight: 1.7,
    color: '#444',
    margin: '0 0 6px',
  },
  actions: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 4,
    paddingTop: 4,
  },
  btn: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 13,
    padding: '6px 14px',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
  },
  btnDismiss: {
    background: '#e8e3d9',
    color: '#555',
  },
  btnBlock: {
    background: '#c0392b',
    color: '#fff',
  },
  btnCsam: {
    background: '#7d1a1a',
    color: '#fff',
  },
  confirmPanel: {
    marginTop: 10,
    background: '#faf8f4',
    border: '1px solid #e8e3d9',
    borderRadius: 4,
    padding: '12px 14px',
  },
  confirmLabel: {
    fontSize: 13,
    color: '#555',
    margin: '0 0 8px',
    fontStyle: 'normal',
  },
  confirmOptional: {
    fontSize: 12,
    color: '#aaa',
    fontStyle: 'italic',
    marginLeft: 6,
  },
  confirmTextarea: {
    fontFamily: 'Georgia, serif',
    fontSize: 13,
    width: '100%',
    border: '1px solid #ddd6c9',
    borderRadius: 4,
    padding: '6px 10px',
    resize: 'vertical',
    background: '#fff',
    color: '#111',
    boxSizing: 'border-box',
    outline: 'none',
    display: 'block',
    marginBottom: 10,
  },
  confirmActions: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  confirmCancel: {
    fontFamily: 'Georgia, serif',
    fontStyle: 'italic',
    fontSize: 13,
    background: 'none',
    color: '#aaa',
    border: 'none',
    padding: '6px 4px',
    cursor: 'pointer',
  },
};
