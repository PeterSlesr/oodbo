import React, { useState } from 'react';
import ReviewModal from './ReviewModal.jsx';
import BodyScrollLock from '../lib/BodyScrollLock.jsx';

// Resolution chooser for a row-4 fork (spec §8.2). Ported from the desktop's
// SyncConflictModal, minus everything desktop-specific: that version had to fetch and
// re-parse the cloud copy itself (driveFetch / IS_TAURI / its own XML parser). Here
// fork-first has already put BOTH versions on disk as local projects before any UI exists,
// so this just takes two project objects — no fetching, no parsing, nothing to load.
//
// Because both versions are already durable, this is presentation only: a crash mid-decision
// loses nothing, "decide later" is always legitimate, and Keep sends the loser to the bin
// (resurrectable) rather than deleting it.
//
// Review is the desktop's full-window three-pane redline (ReviewModal + docDiff), which is
// what DECISION 3 held back pending evidence. It aligns chapters by stable id, so a moved
// chapter still matches instead of reading as a delete+add — the failure mode the spec was
// actually worried about.
//
// The two versions are named the original and the second version, NOT "this device" and
// "elsewhere". The fork syncs to every device, so on the device that didn't create it, it IS
// the copy from elsewhere — device framing would tell one of the two devices the exact
// reverse of the truth, directly above a button that discards a version.

const wordCount = (p) => (p?.chapters || []).reduce(
  (sum, ch) => sum + (ch.content || '').trim().split(/\s+/).filter(Boolean).length, 0);

const lastEdit = (p) => {
  const ts = (p?.chapters || []).reduce((m, c) => (c.updatedAt || '') > m ? (c.updatedAt || '') : m, '');
  if (!ts) return 'unknown time';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
};

function VersionCard({ label, project, onKeep, disabled }) {
  const n = (project?.chapters || []).length;
  return (
    <div style={s.card}>
      <p style={s.cardLabel}>{label}</p>
      <p style={s.cardTitle}>{project?.title || 'Untitled'}</p>
      <p style={s.cardMeta}>{n} section{n === 1 ? '' : 's'} · {wordCount(project).toLocaleString()} words</p>
      <p style={s.cardMeta}>last updated {lastEdit(project)}</p>
      <button style={s.keepBtn} onClick={onKeep} disabled={disabled}>Keep this version</button>
    </div>
  );
}

export default function ConflictDialog({ original, conflicted, onResolve, onLater }) {
  const [reviewing, setReviewing] = useState(false);
  const [resolving, setResolving] = useState(false);

  async function choose(choice) {
    setResolving(true);
    await onResolve(choice);
    setResolving(false);
  }

  // Full-window redline — both versions are already local, so there's nothing to load first.
  if (reviewing) {
    return (
      <ReviewModal
        original={original}
        conflicted={conflicted}
        onClose={() => setReviewing(false)}
        onResolve={choose}
        resolving={resolving}
      />
    );
  }

  return (
    <div style={s.wrap}>
      <BodyScrollLock />
      <div style={s.box}>
        <h1 style={s.brand}>oodbo</h1>
        <p style={s.sub}>
          This project was edited in two places before they could sync — pick which version to keep.
          Both are already saved, so nothing is lost either way.
        </p>
        <div style={s.divider} />

        {/* Original first — it's the version the changes are measured from, and the order
            has to match the redline's or the two tell different stories. */}
        <div style={s.cards}>
          <VersionCard label="The original"   project={original}   onKeep={() => choose('original')}   disabled={resolving} />
          <VersionCard label="Second version" project={conflicted} onKeep={() => choose('conflicted')} disabled={resolving} />
        </div>

        <button style={s.reviewBtn} onClick={() => setReviewing(true)} disabled={resolving}>
          Review both versions side by side
        </button>

        <button style={s.bothBtn} onClick={() => choose('both')} disabled={resolving}>
          Keep both — they stay as two separate projects
        </button>
        <p style={s.hint}>Recommended if you're not sure. The version you don't keep goes to the bin, not away.</p>

        <button style={s.later} onClick={onLater} disabled={resolving}>Decide later</button>
      </div>
    </div>
  );
}

const s = {
  wrap: {
    position: 'fixed', inset: 0, zIndex: 900, overflowY: 'auto',
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#f5f2eb', padding: 20,
  },
  box:   { width: '100%', maxWidth: 640 },
  brand: { fontFamily: 'Georgia, serif', fontSize: 28, fontWeight: 'normal', letterSpacing: '-0.02em', color: '#111', marginBottom: 4 },
  sub:   { fontFamily: 'Georgia, serif', fontSize: 13, color: '#666', fontStyle: 'italic', lineHeight: 1.6 },
  divider: { borderTop: '1px solid #ddd6c9', margin: '16px 0' },
  cards: { display: 'flex', gap: 16, flexWrap: 'wrap' },
  card:  { flex: '1 1 260px', border: '1px solid #ddd6c9', background: '#fff', padding: '14px 16px' },
  cardLabel: { fontFamily: 'Georgia, serif', fontSize: 11, color: '#888', fontStyle: 'italic', marginBottom: 4 },
  cardTitle: { fontFamily: 'Georgia, serif', fontSize: 16, color: '#111', marginBottom: 6 },
  cardMeta:  { fontFamily: 'Georgia, serif', fontSize: 12, color: '#666', marginBottom: 2 },
  reviewBtn: { fontFamily: 'Georgia, serif', fontSize: 13, width: '100%', padding: '9px 12px', background: '#faf8f2', color: '#111', border: '1px solid #ddd6c9', cursor: 'pointer', marginTop: 16 },
  keepBtn:   { fontFamily: 'Georgia, serif', fontSize: 13, width: '100%', padding: '8px 12px', background: '#111', color: '#fff', border: '1px solid #111', cursor: 'pointer' },
  bothBtn:   { fontFamily: 'Georgia, serif', fontSize: 13, width: '100%', padding: '9px 12px', background: '#fff', color: '#111', border: '1px solid #111', cursor: 'pointer', marginTop: 16 },
  hint:      { fontFamily: 'Georgia, serif', fontSize: 11, color: '#999', fontStyle: 'italic', marginTop: 6, textAlign: 'center' },
  later:     { fontFamily: 'Georgia, serif', fontSize: 11.5, color: '#999', fontStyle: 'italic', background: 'none', border: 'none', cursor: 'pointer', display: 'block', margin: '14px auto 0' },
};
