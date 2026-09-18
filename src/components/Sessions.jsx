import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase.js';

async function getToken() {
  const stored = sessionStorage.getItem('fwd:session');
  if (stored) return stored;
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 2)   return 'just now';
  if (hours < 1)   return `${mins}m ago`;
  if (days  < 1)   return `${hours}h ago`;
  if (days  < 30)  return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function Sessions({ currentSessionId, th, onClose }) {
  const [sessions,  setSessions]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [revoking,  setRevoking]  = useState(false);
  const [revoked,   setRevoked]   = useState(false);

  useEffect(() => {
    getToken().then(tok => {
      if (!tok) { setLoading(false); return; }
      fetch('/api/auth/sessions', { headers: { Authorization: `Bearer ${tok}` } })
        .then(r => r.json())
        .then(d => { setSessions(d.sessions ?? []); setLoading(false); })
        .catch(() => setLoading(false));
    });
  }, []);

  async function revokeOthers() {
    setRevoking(true);
    const tok = await getToken();
    if (tok) {
      const params = new URLSearchParams({ all_others: '1' });
      if (currentSessionId) params.set('current_id', currentSessionId);
      await fetch(`/api/auth/sessions?${params}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${tok}` },
      }).catch(() => {});
    }
    setSessions(s => currentSessionId ? s.filter(x => x.id === currentSessionId) : []);
    setRevoking(false);
    setRevoked(true);
  }

  const others = sessions.filter(s => s.id !== currentSessionId);

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={{ ...s.panel, background: th.pageBg, borderLeft: `1px solid ${th.chromeBorder}` }}
           onClick={e => e.stopPropagation()}>

        <div style={s.header}>
          <span style={{ ...s.title, color: th.text }}>Active sessions</span>
          <button style={{ ...s.closeBtn, color: th.chromeMuted }} onClick={onClose}>✕</button>
        </div>

        {loading ? (
          <p style={{ ...s.empty, color: th.chromeFaint }}>Loading…</p>
        ) : sessions.length === 0 ? (
          <p style={{ ...s.empty, color: th.chromeFaint }}>No sessions found.</p>
        ) : (
          <ul style={s.list}>
            {sessions.map(session => {
              const isCurrent = session.id === currentSessionId;
              return (
                <li key={session.id} style={s.item}>
                  <span style={{ ...s.label, color: th.text }}>
                    {session.device_label || 'Unknown device'}
                    {isCurrent && <span style={{ ...s.tag, background: th.chromeBorder, color: th.chromeMuted }}> this device</span>}
                  </span>
                  <span style={{ ...s.meta, color: th.chromeFaint }}>
                    signed in {timeAgo(session.created_at)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {others.length > 0 && !revoked && (
          <div style={s.footer}>
            <button
              style={{ ...s.revokeAll, color: th.chromeMuted, borderColor: th.chromeBorder, opacity: revoking ? 0.4 : 1 }}
              disabled={revoking}
              onClick={revokeOthers}
            >
              {revoking ? 'Signing out…' : 'Log out all other devices'}
            </button>
          </div>
        )}

        {revoked && (
          <p style={{ ...s.empty, color: th.chromeFaint }}>Other devices have been signed out.</p>
        )}

        {others.length > 0 && (
          <p style={{ ...s.note, color: th.chromeFaint }}>
            Other devices are signed out immediately.
          </p>
        )}
      </div>
    </div>
  );
}

const s = {
  overlay:   { position: 'fixed', inset: 0, zIndex: 900, display: 'flex', justifyContent: 'flex-end' },
  panel:     { width: 300, height: '100%', overflowY: 'auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 0 },
  header:    { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title:     { fontFamily: 'Georgia, serif', fontSize: 15, fontWeight: 'normal' },
  closeBtn:  { fontFamily: 'Georgia, serif', fontSize: 16, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 },
  list:      { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 },
  item:      { display: 'flex', flexDirection: 'column', gap: 2 },
  label:     { fontFamily: 'Georgia, serif', fontSize: 12 },
  tag:       { fontFamily: 'Georgia, serif', fontSize: 10, padding: '1px 5px', borderRadius: 3, marginLeft: 6 },
  meta:      { fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic' },
  footer:    { marginTop: 24, paddingTop: 16 },
  revokeAll: { fontFamily: 'Georgia, serif', fontSize: 11, background: 'transparent', border: '1px solid', padding: '6px 10px', cursor: 'pointer', width: '100%', fontStyle: 'italic' },
  empty:     { fontFamily: 'Georgia, serif', fontSize: 12, fontStyle: 'italic', marginTop: 8 },
  note:      { fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic', marginTop: 8 },
};
