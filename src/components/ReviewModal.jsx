import React, { useState, useMemo, useRef, useEffect } from 'react';
import { alignChapters, buildHunks } from '../lib/docDiff.js';
import BodyScrollLock from '../lib/BodyScrollLock.jsx';

const ANNOTATION_LABEL = {
  onlyA:   { conflicted: 'only in this version', original: null },
  onlyB:   { conflicted: null, original: 'only in the other version' },
  changed: { conflicted: 'differs between versions', original: 'differs between versions' },
};

// Full-window three-pane document comparison (Doc A / Doc B / Redline), used
// from SyncConflictModal to let the user actually review what changed before
// picking a version — replaces the old cramped per-card "read full text"
// toggle. Structural pattern (fixed overlay, Georgia-serif inline styles, no
// CSS files) copied from FocusMode.jsx, the only other full-window takeover
// in this app.
//
// Navigation is hunk-based, not scroll-position-based: percentage scroll sync
// was considered and rejected, since it breaks the moment the two versions
// have a different number of chapters (which they will, whenever a whole
// chapter was added/removed). The diff computation itself defines where the
// panes line up, so "next/previous diff" scrolls all three panes to an exact,
// known position instead of guessing.
// `original` is the project that kept its id and title; `conflicted` is the fork that was
// split off it. That framing is used instead of "this device / elsewhere" for two reasons:
// it's what the homepage shows you, and — decisively — "this device" is NOT knowable. The
// fork is created on the diverging device but then syncs everywhere, so on the other device
// it IS the copy from elsewhere. Labelling it by device would tell one of the two devices
// the exact opposite of the truth, right above a "Keep this version" button.
//
// Direction: the original is the baseline and the conflicted copy is what diverged from it.
// So the original is rendered FIRST and read as the source; additions (green) are what the
// conflicted copy has, deletions (red) are what the original had and it dropped. Panes must
// stay in that order — laying the target out ahead of the source silently inverts how every
// colour reads.
export default function ReviewModal({ original, conflicted, onClose, onResolve, resolving }) {
  // alignChapters(A, B) treats B as the baseline/old side (see docDiff.js), so the original
  // goes in the B slot and the fork in A.
  const aligned = useMemo(() => alignChapters(conflicted, original), [conflicted, original]);
  const hunks   = useMemo(() => buildHunks(aligned), [aligned]);
  const [hunkIndex, setHunkIndex] = useState(0);

  const refsConflicted = useRef({});
  const refsOriginal   = useRef({});
  const refsRedline    = useRef({});

  function hunkKey(hunk) {
    if (hunk.kind === 'annotation') return `${hunk.chapterIndex}-annotation-${hunk.annotationId}`;
    return `${hunk.chapterIndex}-${hunk.kind}-${hunk.partIndexStart ?? ''}`;
  }

  function goToHunk(idx) {
    if (idx < 0 || idx >= hunks.length || hunks.length === 0) return;
    setHunkIndex(idx);
    const key = hunkKey(hunks[idx]);
    [refsConflicted, refsOriginal, refsRedline].forEach(refs => {
      refs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // Land on the first real difference on open, rather than the top of a
  // possibly-identical opening chapter.
  useEffect(() => {
    if (hunks.length > 0) {
      // Wait a tick for panes to mount before scrolling.
      const id = setTimeout(() => goToHunk(0), 50);
      return () => clearTimeout(id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowRight') { goToHunk(hunkIndex + 1); return; }
      if (e.key === 'ArrowLeft')  { goToHunk(hunkIndex - 1); return; }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunkIndex, hunks.length]);

  // Group hunks per chapter for O(1)-ish lookup while rendering each pane.
  const hunksByChapter = useMemo(() => {
    const map = new Map();
    hunks.forEach(h => {
      if (!map.has(h.chapterIndex)) map.set(h.chapterIndex, []);
      map.get(h.chapterIndex).push(h);
    });
    return map;
  }, [hunks]);

  function renderChangedChapter(ch, chapterIndex, mode, refs) {
    const parts = ch.parts || [];
    const chapterHunks = (hunksByChapter.get(chapterIndex) || []).filter(h => h.kind === 'changed');
    const elements = [];
    let i = 0;
    while (i < parts.length) {
      const hunk = chapterHunks.find(h => i >= h.partIndexStart && i <= h.partIndexEnd);
      if (hunk) {
        const key = hunkKey(hunk);
        const children = [];
        for (let j = hunk.partIndexStart; j <= hunk.partIndexEnd; j++) {
          const p = parts[j];
          // Diff direction: the original is the baseline, the conflicted copy is what
          // diverged from it. So "added" is text the conflicted copy has and the original
          // doesn't; "removed" is text the original has that the conflicted copy dropped.
          if (mode === 'conflicted' && p.removed) continue; // not in the fork
          if (mode === 'original'   && p.added)   continue; // not in the original
          const style = p.added ? s.added : p.removed ? s.removed : undefined;
          children.push(<span key={j} style={style}>{p.value}</span>);
        }
        elements.push(
          <span key={key} ref={el => { refs.current[key] = el; }} style={s.hunkAnchor}>
            {children}
          </span>
        );
        i = hunk.partIndexEnd + 1;
      } else {
        const p = parts[i];
        const skip = (mode === 'conflicted' && p.removed) || (mode === 'original' && p.added);
        if (!skip) elements.push(<span key={i}>{p.value}</span>);
        i++;
      }
    }
    return elements;
  }

  function renderAnnotations(ch, chapterIndex, mode, refs) {
    // Whole-chapter onlyIn chapters are already flagged at the chapter level —
    // just list that side's own annotations plainly, no per-item diff needed.
    if (ch.onlyIn) {
      const annotations = mode === 'conflicted' ? ch.annotationsA : ch.annotationsB;
      if (!annotations?.length) return null;
      return (
        <div style={s.annotationsBox}>
          {annotations.map(a => (
            <p key={a.id} style={s.annotationLine}>
              <span style={s.annotationAnchor}>{a.anchorText}</span> — {a.note}
            </p>
          ))}
        </div>
      );
    }

    const rows = (ch.annotationDiff || []).filter(row => (mode === 'conflicted' ? row.a : row.b));
    if (!rows.length) return null;
    return (
      <div style={s.annotationsBox}>
        {rows.map(row => {
          const ann   = mode === 'conflicted' ? row.a : row.b;
          const label = ANNOTATION_LABEL[row.kind]?.[mode];
          const key   = hunkKey({ chapterIndex, kind: 'annotation', annotationId: row.id });
          return (
            <p
              key={row.id}
              ref={label ? el => { refs.current[key] = el; } : undefined}
              style={label ? { ...s.annotationLine, ...s.annotationDiffLine } : s.annotationLine}
            >
              <span style={s.annotationAnchor}>{ann.anchorText}</span> — {ann.note}
              {label && <span style={s.annBadge}> · {label}</span>}
            </p>
          );
        })}
      </div>
    );
  }

  // Which merged entries belong in this pane. A section that moved exists in both versions,
  // but each side holds it at only ONE position — so each pane shows it once, at its own
  // position. Only the redline shows both, which is what makes the move legible there.
  function inPane(ch, mode) {
    if (mode === 'redline') return true;
    if (mode === 'conflicted') return ch.kind !== 'onlyB' && ch.kind !== 'movedFrom';
    return ch.kind !== 'onlyA' && ch.kind !== 'movedTo';
  }

  function renderPane(mode, refs) {
    const choice = mode === 'redline' ? 'both' : mode;
    // The project's own title is the label that matters: after a fork the two versions are
    // named differently ("X" vs "X (conflicted — …)"), and that name is what the homepage
    // shows, so it's how you actually tell them apart.
    const paneTitle = mode === 'conflicted' ? (conflicted?.title || 'Untitled')
                    : mode === 'original'   ? (original?.title   || 'Untitled')
                    : 'Redline (combined)';
    const paneSub   = mode === 'conflicted' ? 'the second version — changes shown against the original'
                    : mode === 'original'   ? 'the original — this is what the changes are measured from'
                    : 'both versions, changes marked';
    return (
      <div style={s.pane}>
        <div style={s.paneHeader}>
          <span style={s.paneHeadText}>
            <span style={s.paneTitle} title={paneTitle}>{paneTitle}</span>
            <span style={s.paneSub}>{paneSub}</span>
          </span>
          {onResolve && (
            <button style={s.paneResolveBtn} disabled={resolving} onClick={() => onResolve(choice)}>
              {mode === 'redline' ? 'Keep both' : 'Keep this version'}
            </button>
          )}
        </div>
        <div style={s.paneScroll}>
          {aligned.map((ch, chapterIndex) => {
            if (!inPane(ch, mode)) return null;

            const onlyBadge = ch.onlyIn && (
              <span style={s.onlyBadge}>
                {mode === 'redline'
                  ? (ch.onlyIn === 'A' ? 'only in the second version' : 'only in the original')
                  : 'not present in the other version'}
              </span>
            );

            const movedBadge = ch.moved && (
              <span style={ch.kind === 'movedFrom' ? s.movedFromBadge : s.movedToBadge}>
                {ch.kind === 'movedFrom' ? 'moved away from here' : 'moved here'}
              </span>
            );

            let body;
            if (ch.kind === 'onlyA' || ch.kind === 'onlyB') {
              const key = hunkKey({ chapterIndex, kind: ch.kind });
              const content = ch.kind === 'onlyA' ? ch.contentA : ch.contentB;
              body = <span ref={el => { refs.current[key] = el; }} style={s.onlyContent}>{content}</span>;
            } else if (ch.kind === 'movedFrom') {
              // The vacated position: the whole section struck out, exactly as a word
              // processor renders the "from" half of a move.
              const key = hunkKey({ chapterIndex, kind: 'movedFrom' });
              body = <span ref={el => { refs.current[key] = el; }} style={s.movedFromContent}>{ch.contentB}</span>;
            } else {
              body = renderChangedChapter(ch, chapterIndex, mode === 'redline' ? 'redline' : mode, refs);
            }

            const title = mode === 'original' || ch.kind === 'movedFrom'
              ? (ch.titleB ?? ch.titleA)
              : (ch.titleA ?? ch.titleB);

            // A moved section appears twice in the redline, so its id alone isn't a unique key.
            const blockKey = `${ch.chapterId}-${ch.kind}`;
            const movedToRef = ch.kind === 'movedTo'
              ? el => { refs.current[hunkKey({ chapterIndex, kind: 'movedTo' })] = el; }
              : undefined;

            return (
              <div
                key={blockKey}
                ref={movedToRef}
                style={ch.kind === 'movedTo' ? { ...s.chapterBlock, ...s.movedToBlock } : s.chapterBlock}
              >
                <p style={ch.kind === 'movedFrom' ? { ...s.chapterTitle, ...s.strike } : s.chapterTitle}>
                  {title || 'Untitled section'} {onlyBadge} {movedBadge}
                </p>
                <p style={s.chapterContent}>{body}</p>
                {mode !== 'redline' && ch.kind !== 'movedFrom' && renderAnnotations(ch, chapterIndex, mode, refs)}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={s.overlay}>
      <BodyScrollLock />
      <div style={s.toolbar}>
        <span style={s.brand}>Review</span>
        <span style={s.flex1} />
        <span style={s.counter}>
          {hunks.length === 0 ? 'No differences found' : `Difference ${hunkIndex + 1} of ${hunks.length}`}
        </span>
        <button style={s.navBtn} onClick={() => goToHunk(hunkIndex - 1)} disabled={hunkIndex <= 0}>← Previous</button>
        <button style={s.navBtn} onClick={() => goToHunk(hunkIndex + 1)} disabled={hunkIndex >= hunks.length - 1}>Next</button>
        <button style={s.closeBtn} onClick={onClose}>Close (Esc)</button>
      </div>
      {/* Source, then target, then the combined view. The original MUST come first: the diff
          measures everything from it, so putting the fork ahead of it makes every colour read
          backwards — you'd see the original's own text marked as deleted. */}
      <div style={s.panes}>
        {renderPane('original',   refsOriginal)}
        {renderPane('conflicted', refsConflicted)}
        {renderPane('redline',    refsRedline)}
      </div>
    </div>
  );
}

const s = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 950,
    display: 'flex',
    flexDirection: 'column',
    background: '#f5f2eb',
  },
  toolbar: {
    background: '#1f1f1f',
    color: '#f5f2eb',
    height: 44,
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    padding: '0 16px',
    gap: 10,
    fontFamily: 'Georgia, serif',
  },
  brand: { fontSize: 13, fontStyle: 'italic', color: '#aaa' },
  flex1: { flex: 1 },
  counter: { fontSize: 12, color: '#ccc', marginRight: 6 },
  navBtn: {
    fontFamily: 'Georgia, serif',
    fontSize: 12,
    background: 'transparent',
    border: '1px solid #555',
    color: '#f5f2eb',
    cursor: 'pointer',
    padding: '4px 10px',
  },
  closeBtn: {
    fontFamily: 'Georgia, serif',
    fontSize: 12,
    background: '#f5f2eb',
    border: '1px solid #f5f2eb',
    color: '#111',
    cursor: 'pointer',
    padding: '4px 10px',
    marginLeft: 6,
  },
  panes: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  pane: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid #ddd6c9',
    minWidth: 0,
  },
  paneHeader: {
    fontFamily: 'Georgia, serif',
    padding: '8px 16px',
    borderBottom: '1px solid #ddd6c9',
    background: '#faf8f2',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  paneHeadText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  paneTitle: {
    fontSize: 13, color: '#111',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  paneSub: { fontSize: 10.5, fontStyle: 'italic', color: '#999' },
  paneResolveBtn: {
    fontFamily: 'Georgia, serif',
    fontSize: 11,
    fontStyle: 'normal',
    background: '#fff',
    border: '1px solid #ddd6c9',
    color: '#111',
    cursor: 'pointer',
    padding: '3px 9px',
    whiteSpace: 'nowrap',
  },
  paneScroll: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 20px',
  },
  chapterBlock: { marginBottom: 24 },
  chapterTitle: {
    fontFamily: 'Georgia, serif',
    fontSize: 14,
    fontWeight: 'bold',
    color: '#111',
    marginBottom: 6,
  },
  chapterContent: {
    fontFamily: 'Georgia, serif',
    fontSize: 13,
    color: '#222',
    whiteSpace: 'pre-wrap',
    lineHeight: 1.7,
  },
  hunkAnchor: { scrollMarginTop: 60 },
  added: { background: '#d7f3d7', textDecoration: 'underline' },
  removed: { background: '#f8d7d7', textDecoration: 'line-through', opacity: 0.8 },
  onlyBadge: {
    fontFamily: 'Georgia, serif',
    fontSize: 10,
    fontStyle: 'italic',
    color: '#a06a1a',
    marginLeft: 8,
  },
  // A move reads as a deletion at the old position and an addition at the new one — same
  // red/green vocabulary as a word-level change, so it needs no separate explanation.
  movedFromBadge: {
    fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic', color: '#a05252', marginLeft: 8,
  },
  movedToBadge: {
    fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic', color: '#3f7a3f', marginLeft: 8,
  },
  movedFromContent: {
    scrollMarginTop: 60,
    background: '#f8d7d7',
    textDecoration: 'line-through',
    opacity: 0.8,
  },
  movedToBlock: {
    scrollMarginTop: 60,
    borderLeft: '3px solid #7ab87a',
    paddingLeft: 10,
    marginLeft: -13,
  },
  strike: { textDecoration: 'line-through', opacity: 0.8 },
  onlyContent: {
    scrollMarginTop: 60,
    background: '#fff6e0',
  },
  annotationsBox: {
    marginTop: 6,
    paddingLeft: 10,
    borderLeft: '2px solid #ddd6c9',
  },
  annotationLine: {
    fontFamily: 'Georgia, serif',
    fontSize: 11,
    color: '#666',
    fontStyle: 'italic',
    margin: '2px 0',
  },
  annotationAnchor: { color: '#333', fontStyle: 'normal' },
  annotationDiffLine: {
    scrollMarginTop: 60,
    background: '#fff6e0',
    borderRadius: 2,
    padding: '1px 4px',
    marginLeft: -4,
  },
  annBadge: {
    fontFamily: 'Georgia, serif',
    fontSize: 10,
    fontStyle: 'italic',
    color: '#a06a1a',
  },
};
