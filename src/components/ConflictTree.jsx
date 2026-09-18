import React from 'react';

const wordCount = (p) => (p?.chapters || []).reduce(
  (sum, ch) => sum + (ch.content || '').trim().split(/\s+/).filter(Boolean).length, 0);

// The inline panel that opens under a conflicted project's row when its dot is clicked.
//
// It gathers the whole conflict in one place — the original at the trunk, every fork of it as
// a branch — instead of leaving the halves scattered across a list sorted by title and date.
// One fork is the common case (a plain trunk-and-one-branch); two branches only appear when
// two devices each forked the same project before either synced, and showing the real tree is
// what stops the count from lying ("2 versions" when there are three).
//
// Resolution is outside-in: each branch is settled on its own against the trunk through the
// two-way compare, and the tree shrinks by one each time until a single project is left and
// the dot clears. Nothing new to learn — a branch is exactly the pairwise decision that
// already exists, just reached from here.
export default function ConflictTree({ original, forks }) {
  const total = forks.length + 1;
  return (
    <div style={s.panel}>
      <div style={s.head}>
        <span style={s.dot} aria-hidden="true" />
        <span style={s.headText}>{original?.title || 'Untitled'} — {total} versions</span>
      </div>

      <div style={s.trunk}>
        <span style={s.glyph}>●</span>
        <span style={s.name}>{original?.title || 'Untitled'}</span>
        <span style={s.meta}>the original · {wordCount(original).toLocaleString()} words</span>
      </div>

      {forks.map((f, i) => {
        const last = i === forks.length - 1;
        return (
          <div key={f.project.id} style={s.branch}>
            <span style={s.glyph}>{last ? '└─' : '├─'}</span>
            <span style={s.name}>{f.branchLabel}</span>
            <span style={s.meta}>{wordCount(f.project).toLocaleString()} words</span>
            <span style={s.spacer} />
            <button style={s.compareBtn} onClick={() => f.onCompare()}>Compare ↔</button>
          </div>
        );
      })}
    </div>
  );
}

const s = {
  panel: {
    background: '#f6efd9',
    border: '1px solid #e6d9a8',
    borderRadius: 3,
    padding: '12px 14px',
    margin: '2px 0 6px',
  },
  head: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 },
  dot: { width: 7, height: 7, borderRadius: '50%', background: '#C88A15', flexShrink: 0 },
  headText: { fontFamily: 'Georgia, serif', fontSize: 13, color: '#8a6d1f', fontWeight: 'bold' },
  trunk: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' },
  branch: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', paddingLeft: 14 },
  glyph: { fontFamily: 'monospace', fontSize: 13, color: '#b09a5a' },
  name: { fontFamily: 'Georgia, serif', fontSize: 13, color: '#3a3320' },
  meta: { fontFamily: 'Georgia, serif', fontSize: 11, color: '#9a8a5a', fontStyle: 'italic' },
  spacer: { flex: 1 },
  compareBtn: {
    fontFamily: 'Georgia, serif', fontSize: 12, background: '#fff', border: '1px solid #ddd6c9',
    color: '#111', cursor: 'pointer', padding: '3px 10px', whiteSpace: 'nowrap',
  },
};
