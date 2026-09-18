import { describe, it, expect } from 'vitest';
import { alignChapters, diffChapterContent, buildHunks, movedChapterIds } from './docDiff.js';

// DECISION 3 held the redline back until it could be stress-tested — specifically against
// moved-and-edited paragraphs, the case where a naive diff turns one small edit into a
// whole-chapter delete+add and misleads someone into the wrong "Keep" click. These are that
// evidence.

const ch = (id, content, title = id) => ({ id, title, content, annotations: [] });
const proj = (...chapters) => ({ id: 'p1', title: 'T', chapters });

describe('alignChapters — matches by stable id, not position', () => {
  it('a MOVED chapter is still MATCHED by id, however it gets presented', () => {
    // A move is *shown* as a delete + an add, but it must never be *aligned* as one: both
    // entries carry the section's text from both sides, so a real edit inside a moved
    // section can still be diffed word by word instead of reading as a whole rewrite.
    const a = proj(ch('c2', 'second'), ch('c1', 'first'));   // reordered on this device
    const b = proj(ch('c1', 'first'),  ch('c2', 'second'));
    const aligned = alignChapters(a, b);
    const moved = aligned.filter(x => x.moved);
    expect(moved.map(x => x.kind).sort()).toEqual(['movedFrom', 'movedTo']);
    // Never reported as unique to a side — that's the delete+add trap.
    expect(aligned.every(x => x.onlyIn === null)).toBe(true);
    moved.forEach(x => { expect(x.contentA).not.toBeNull(); expect(x.contentB).not.toBeNull(); });
  });

  it('a chapter only on one side is flagged, not diffed against nothing', () => {
    const aligned = alignChapters(proj(ch('c1', 'x'), ch('c9', 'new here')), proj(ch('c1', 'x')));
    expect(aligned.find(x => x.chapterId === 'c9').onlyIn).toBe('A');
  });

  it('a chapter only in the other version is appended, not lost', () => {
    const aligned = alignChapters(proj(ch('c1', 'x')), proj(ch('c1', 'x'), ch('c9', 'theirs only')));
    expect(aligned.find(x => x.chapterId === 'c9').onlyIn).toBe('B');
  });
});

// Direction is the whole meaning of a redline: get it backwards and every colour lies —
// the original's own text reads as deleted, and someone discards the wrong version. The
// SECOND argument is the baseline being measured FROM (the original); the first is what
// diverged from it (the conflicted copy).
describe('diffChapterContent — direction: second arg is the baseline', () => {
  it('added = in the diverged copy; removed = was in the baseline and is now gone', () => {
    const parts = diffChapterContent('the quick brown fox', 'the quick fox');
    expect(parts.some(p => p.added && p.value.includes('brown'))).toBe(true);
    expect(parts.some(p => p.removed)).toBe(false);
  });

  it('is NOT symmetric — swapping the arguments inverts every mark', () => {
    // The bug this guards: the redline laid the fork out ahead of the original while the
    // maths measured from the original, so the layout and the colours told opposite stories.
    const forward = diffChapterContent('the quick brown fox', 'the quick fox');   // word added
    const swapped = diffChapterContent('the quick fox', 'the quick brown fox');   // word removed
    expect(forward.some(p => p.added   && p.value.includes('brown'))).toBe(true);
    expect(swapped.some(p => p.removed && p.value.includes('brown'))).toBe(true);
    expect(swapped.some(p => p.added)).toBe(false);
  });

  it('preserves whitespace/newlines verbatim (prose, not code)', () => {
    const parts = diffChapterContent('a\n\nb', 'a\n\nb');
    expect(parts.map(p => p.value).join('')).toBe('a\n\nb');
    expect(parts.some(p => p.added || p.removed)).toBe(false);
  });
});

describe('buildHunks — only the differences are reviewable', () => {
  it('identical versions produce NO hunks (nothing to review)', () => {
    const same = () => proj(ch('c1', 'the same words'), ch('c2', 'also same'));
    expect(buildHunks(alignChapters(same(), same()))).toHaveLength(0);
  });

  it('THE STRESS CASE: a chapter moved AND edited gives ONE edit hunk, not a delete+add', () => {
    // c1 was reordered to the end AND had a word changed. A position-based diff would call
    // this "chapter deleted + chapter added" and drown the real edit.
    const a = proj(ch('c2', 'unchanged text'), ch('c1', 'the quick brown fox'));
    const b = proj(ch('c1', 'the quick red fox'), ch('c2', 'unchanged text'));
    const aligned = alignChapters(a, b);
    const hunks   = buildHunks(aligned);

    expect(aligned.every(x => x.onlyIn === null)).toBe(true);   // the move did NOT read as add/remove
    // Exactly one CONTENT hunk — the real edit — not a whole-chapter rewrite. (The reorder
    // also gets its own 'moved' stop; that's reported separately and on purpose.)
    const changed = hunks.filter(h => h.kind === 'changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ chapterId: 'c1' });
  });

  it('nearby edits merge into a single stop instead of fragmenting', () => {
    const a = proj(ch('c1', 'alpha ONE beta TWO gamma'));
    const b = proj(ch('c1', 'alpha one beta two gamma'));
    // Two changes separated by one short unchanged word (< MERGE_GAP_WORDS) → one hunk.
    expect(buildHunks(alignChapters(a, b))).toHaveLength(1);
  });

  it('edits far apart stay separate stops', () => {
    const filler = Array(30).fill('word').join(' ');
    const a = proj(ch('c1', `START ${filler} END`));
    const b = proj(ch('c1', `start ${filler} end`));
    expect(buildHunks(alignChapters(a, b)).length).toBeGreaterThan(1);
  });

  it('a whole chapter present on only one side gets its own stop', () => {
    const hunks = buildHunks(alignChapters(proj(ch('c1', 'x'), ch('c9', 'brand new')), proj(ch('c1', 'x'))));
    expect(hunks).toEqual([expect.objectContaining({ chapterId: 'c9', kind: 'onlyA' })]);
  });
});

// Section order is inside the canonical hash, so a pure reorder is a genuine divergence that
// can cause a fork on its own — but it's invisible to a word diff. If it isn't surfaced, two
// really-different versions review as identical and you choose blind. A move is shown the way
// a word processor shows one: struck out where it was, added where it landed.
describe('reordered sections are a real difference', () => {
  it('a pure reorder (no text change) still produces a stop', () => {
    const a = proj(ch('c1', 'one'), ch('c2', 'two'), ch('c3', 'three'));
    const b = proj(ch('c3', 'three'), ch('c1', 'one'), ch('c2', 'two'));   // c3 pulled to the top
    const hunks = buildHunks(alignChapters(a, b));
    expect(hunks.length).toBeGreaterThan(0);                                // NOT "no differences"
    expect(hunks.some(h => h.kind === 'movedFrom')).toBe(true);
    expect(hunks.some(h => h.kind === 'movedTo')).toBe(true);
  });

  it('shows the move as a delete where it was and an add where it landed', () => {
    // c1 dragged to the end. The vacated slot is a deletion, the new slot an addition, and
    // they appear in that order — the deletion sits back at the top where c1 used to be.
    const a = proj(ch('c2', 'two'), ch('c3', 'three'), ch('c1', 'one'));
    const b = proj(ch('c1', 'one'), ch('c2', 'two'), ch('c3', 'three'));
    const aligned = alignChapters(a, b);
    expect(aligned.map(x => `${x.chapterId}:${x.kind}`)).toEqual([
      'c1:movedFrom',   // struck out at its old position, ahead of c2
      'c2:paired',
      'c3:paired',
      'c1:movedTo',     // added at its new position, after c3
    ]);
  });

  it('each pane can render its OWN section order', () => {
    // The bug this replaced: every pane rendered one list built in A's order, so B's pane
    // showed B's sections in A's order and a move was invisible however it was badged.
    const a = proj(ch('c2', 'two'), ch('c1', 'one'));
    const b = proj(ch('c1', 'one'), ch('c2', 'two'));
    const aligned = alignChapters(a, b);
    const inA = aligned.filter(x => x.kind !== 'onlyB' && x.kind !== 'movedFrom').map(x => x.chapterId);
    const inB = aligned.filter(x => x.kind !== 'onlyA' && x.kind !== 'movedTo').map(x => x.chapterId);
    expect(inA).toEqual(['c2', 'c1']);   // this device's own order
    expect(inB).toEqual(['c1', 'c2']);   // the other version's own order
  });

  it('flags only what actually moved, not everything after it', () => {
    // Inserting c0 at the top shifts every later index by one. Index-comparison would call
    // the whole document moved; relative order is untouched, so nothing should be flagged.
    const a = proj(ch('c0', 'new'), ch('c1', 'one'), ch('c2', 'two'), ch('c3', 'three'));
    const b = proj(ch('c1', 'one'), ch('c2', 'two'), ch('c3', 'three'));
    expect([...movedChapterIds(a.chapters, b.chapters)]).toEqual([]);
    expect(alignChapters(a, b).filter(x => x.moved)).toHaveLength(0);
  });

  it('names the section that moved, not its neighbours', () => {
    // c1 dragged to the end: c2/c3 keep their relative order, only c1 really moved.
    const a = proj(ch('c2', 'two'), ch('c3', 'three'), ch('c1', 'one'));
    const b = proj(ch('c1', 'one'), ch('c2', 'two'), ch('c3', 'three'));
    expect([...movedChapterIds(a.chapters, b.chapters)]).toEqual(['c1']);
  });

  it('a section moved AND edited reports the move and the edit, and diffs the words', () => {
    // Three sections, so the mover is unambiguous: c2/c3 keep their relative order and only
    // c1 travelled. (With a bare two-section swap, "which one moved" is genuinely undecidable
    // — either reading is correct — so don't assert a side there.)
    const a = proj(ch('c2', 'two'), ch('c3', 'three'), ch('c1', 'the quick brown fox'));
    const b = proj(ch('c1', 'the quick red fox'), ch('c2', 'two'), ch('c3', 'three'));
    const kinds = buildHunks(alignChapters(a, b)).filter(h => h.chapterId === 'c1').map(h => h.kind);
    expect(kinds).toContain('movedFrom');
    expect(kinds).toContain('movedTo');
    // The edit is still ONE word-level hunk at the landing site — not a whole-section rewrite.
    expect(kinds.filter(k => k === 'changed')).toHaveLength(1);
  });

  it('identical order flags nothing', () => {
    const same = () => proj(ch('c1', 'one'), ch('c2', 'two'));
    expect([...movedChapterIds(same().chapters, same().chapters)]).toEqual([]);
    expect(alignChapters(same(), same()).every(x => x.kind === 'paired')).toBe(true);
  });
});
