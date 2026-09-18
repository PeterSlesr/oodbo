import { diffWordsWithSpace } from 'diff';

// Align chapters between two versions of a project by their stable id (ids
// are generated once and preserved across saves/syncs, so they survive a
// fork). Chapters present in both get diffed against each other; a chapter
// only present in one version is shown as wholly unique to that side rather
// than diffed against nothing. B-only chapters are appended after A's own
// order — true positional interleaving of a chapter absent from one side is
// inherently ambiguous, not worth over-engineering.
// Longest common subsequence of two id lists — the ids that kept their relative order.
function lcsIds(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keep = new Set();
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { keep.add(a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return keep;
}

// Which chapters were REORDERED between the two versions.
//
// Reordering sections is a real difference — chapter order is part of the project's identity
// and is inside the canonical hash, so a pure reorder can itself cause a fork. It's invisible
// to a word-level diff, so without this the review would show "no differences" for two
// genuinely different versions and you'd pick blind.
//
// Comparing raw indices is useless: insert one chapter at the top and every later index
// shifts, flagging the whole document as moved. Instead take the ids common to both sides in
// each side's own order — chapters in the longest common subsequence kept their relative
// order, and the remainder are the ones that actually moved.
export function movedChapterIds(chaptersA, chaptersB) {
  const inA = new Set((chaptersA || []).map(c => c.id));
  const inB = new Set((chaptersB || []).map(c => c.id));
  const a = (chaptersA || []).filter(c => inB.has(c.id)).map(c => c.id);
  const b = (chaptersB || []).filter(c => inA.has(c.id)).map(c => c.id);
  const keep = lcsIds(a, b);
  return new Set(a.filter(id => !keep.has(id)));
}

// Aligns the two versions into ONE merged reading order.
//
// `kind` is what each entry is:
//   'paired'    — in both, same relative order. Diff its text.
//   'movedFrom' — a moved section shown at the position it USED to hold (renders as a delete).
//   'movedTo'   — the same section at the position it now holds  (renders as an add).
//   'onlyA' / 'onlyB' — present in one version only.
//
// A move therefore appears TWICE, which is the point: a section that changed position is
// shown struck out where it was and added where it landed, the way a word processor's
// redline does. Crucially this is a matter of PRESENTATION only — both entries still carry
// contentA AND contentB, because they're still matched by stable id. That's what keeps a
// section that was moved *and* edited showing its one real word-level edit rather than a
// whole-section rewrite, which is the failure mode this alignment exists to prevent.
//
// The merged order is built off the LCS anchors: sections that kept their relative order
// pin the two sequences together, and everything else is emitted around them — the baseline
// side (B) first, so removals read before additions.
export function alignChapters(projectA, projectB) {
  const chaptersA = projectA?.chapters || [];
  const chaptersB = projectB?.chapters || [];
  const mapA = new Map(chaptersA.map(ch => [ch.id, ch]));
  const mapB = new Map(chaptersB.map(ch => [ch.id, ch]));
  const idsA = chaptersA.map(ch => ch.id);
  const idsB = chaptersB.map(ch => ch.id);

  const anchors = lcsIds(idsA.filter(id => mapB.has(id)), idsB.filter(id => mapA.has(id)));

  const entry = (id, kind) => {
    const chA = mapA.get(id) || null;
    const chB = mapB.get(id) || null;
    return {
      chapterId:    id,
      kind,
      titleA:       chA ? chA.title : null,
      titleB:       chB ? chB.title : null,
      contentA:     chA ? chA.content : null,
      contentB:     chB ? chB.content : null,
      annotationsA: chA?.annotations || [],
      annotationsB: chB?.annotations || [],
      moved:        kind === 'movedFrom' || kind === 'movedTo',
      onlyIn:       kind === 'onlyA' ? 'A' : kind === 'onlyB' ? 'B' : null,
    };
  };

  const aligned = [];
  let i = 0, j = 0;
  while (i < idsA.length || j < idsB.length) {
    // Everything B holds before the next shared anchor: gone from A, or moved away from here.
    while (j < idsB.length && !anchors.has(idsB[j])) {
      aligned.push(entry(idsB[j], mapA.has(idsB[j]) ? 'movedFrom' : 'onlyB'));
      j++;
    }
    // Then everything A holds before that same anchor: new, or moved to here.
    while (i < idsA.length && !anchors.has(idsA[i])) {
      aligned.push(entry(idsA[i], mapB.has(idsA[i]) ? 'movedTo' : 'onlyA'));
      i++;
    }
    // The anchor itself. Both walks skip only non-anchors and anchors are consumed in
    // lockstep, so idsA[i] and idsB[j] are necessarily the same id here.
    if (i < idsA.length && j < idsB.length) {
      aligned.push(entry(idsA[i], 'paired'));
      i++; j++;
    }
  }

  return aligned;
}

// Word-level diff of one chapter's content between the two versions.
// diffWordsWithSpace preserves whitespace/newlines exactly, which matters for
// prose (plain diffWords would collapse whitespace differences oddly).
//
// contentB (cloud) is treated as the diff's "old" baseline and contentA
// (this computer) as the "new" side: cloud is the last state both sides
// agreed on, and the computer's copy is whatever changed since then, so
// "added" reads as "written locally since the last sync" and "removed" reads
// as "was in the synced cloud copy, not present locally".
export function diffChapterContent(contentA, contentB) {
  return diffWordsWithSpace(contentB || '', contentA || '');
}

// Compares two chapters' annotation lists by stable id, classifying each as
// unchanged, present on only one side, or edited (same id, different
// note/anchorText) — used to badge annotations in the Review UI and to
// generate navigable "next diff" stops for annotation-only differences
// (annotations aren't part of the word-level content diff above, so without
// this they'd otherwise never get a hunk of their own).
export function diffAnnotations(annA, annB) {
  const listA = annA || [];
  const listB = annB || [];
  const mapB  = new Map(listB.map(a => [a.id, a]));
  const usedB = new Set();
  const rows  = [];
  for (const a of listA) {
    const b = mapB.get(a.id);
    if (b) {
      usedB.add(a.id);
      const same = (a.note || '') === (b.note || '') && (a.anchorText || '') === (b.anchorText || '');
      rows.push({ id: a.id, kind: same ? 'same' : 'changed', a, b });
    } else {
      rows.push({ id: a.id, kind: 'onlyA', a, b: null });
    }
  }
  for (const b of listB) {
    if (usedB.has(b.id)) continue;
    rows.push({ id: b.id, kind: 'onlyB', a: null, b });
  }
  return rows;
}

// Unchanged-word runs shorter than this, sitting between two changes, get
// folded into one hunk instead of fragmenting a single edit into several
// separate "next diff" stops.
const MERGE_GAP_WORDS = 10;

function wordCount(text) {
  return (text.match(/\S+/g) || []).length;
}

// Flattens aligned chapters into one ordered list of navigable "hunks" — only
// the differing regions. There's no value in reviewing the parts that match,
// so identical runs are never turned into hunks at all, just skipped over.
// Each hunk: { chapterId, chapterIndex, kind, partIndexStart?, partIndexEnd?, annotationId? }
// kind: 'changed' (word-level diff within a shared chapter) | 'onlyA' | 'onlyB'
//     | 'movedFrom' | 'movedTo' | 'annotation'
export function buildHunks(alignedChapters) {
  const hunks = [];

  alignedChapters.forEach((ch, chapterIndex) => {
    if (ch.kind === 'onlyA' || ch.kind === 'onlyB') {
      hunks.push({ chapterId: ch.chapterId, chapterIndex, kind: ch.kind });
      return;
    }

    // The vacated position. Shown as a deletion; its text is whole and unchanged there,
    // so there's nothing to word-diff — the edits (if any) belong to where it landed.
    if (ch.kind === 'movedFrom') {
      hunks.push({ chapterId: ch.chapterId, chapterIndex, kind: 'movedFrom' });
      return;
    }

    // The new position: an addition in its own right, and then whatever text actually
    // changed within it — a section can be moved AND edited, and both matter.
    if (ch.kind === 'movedTo') hunks.push({ chapterId: ch.chapterId, chapterIndex, kind: 'movedTo' });

    const parts = diffChapterContent(ch.contentA, ch.contentB);
    ch.parts = parts; // cached so the rendering pass doesn't need to re-diff

    let i = 0;
    while (i < parts.length) {
      if (!parts[i].added && !parts[i].removed) { i++; continue; }

      const start = i;
      let lastChangeEnd = i;
      let cursor = i;
      while (cursor < parts.length) {
        if (parts[cursor].added || parts[cursor].removed) {
          lastChangeEnd = cursor;
          cursor++;
          continue;
        }
        // parts[cursor] is unchanged — bridge over it only if it's short and
        // more changes immediately follow, so nearby edits merge into one hunk.
        const nextIsChange = parts[cursor + 1] && (parts[cursor + 1].added || parts[cursor + 1].removed);
        if (nextIsChange && wordCount(parts[cursor].value) < MERGE_GAP_WORDS) {
          cursor++;
          continue;
        }
        break;
      }

      hunks.push({
        chapterId: ch.chapterId,
        chapterIndex,
        kind: 'changed',
        partIndexStart: start,
        partIndexEnd: lastChangeEnd,
      });
      i = lastChangeEnd + 1;
    }

    // Annotations aren't part of the word-level content diff above (they're
    // rendered in their own box below each chapter), so without this they'd
    // never get a "next diff" stop of their own, however much they differ.
    const annotationRows = diffAnnotations(ch.annotationsA, ch.annotationsB);
    ch.annotationDiff = annotationRows; // cached for the rendering pass, same pattern as ch.parts
    annotationRows.forEach(row => {
      if (row.kind === 'same') return;
      hunks.push({ chapterId: ch.chapterId, chapterIndex, kind: 'annotation', annotationId: row.id });
    });
  });

  return hunks;
}
