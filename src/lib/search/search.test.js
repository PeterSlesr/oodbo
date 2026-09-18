import { describe, it, expect } from 'vitest';
import { fold, foldWithMap, findRanges } from './fold.js';
import { makeSnippet } from './snippet.js';
import { matchProject } from './match.js';
import { searchProject, searchAll } from './index.js';

// ── Minimal project factory (canonical shape) ───────────────────────────────────
const proj = (over = {}) => ({
  id: 'p1', title: 'My Novel', updatedAt: '2026-01-01T00:00:00Z',
  chapters: [{ id: 'c1', title: 'Opening', content: 'The quick brown fox.', annotations: [] }],
  ...over,
});

describe('fold', () => {
  it('lowercases and strips accents', () => {
    expect(fold('CafÉ')).toBe('cafe');
    expect(fold('NAÏVE résumé')).toBe('naive resume');
  });
  it('is locale-independent (no Turkish I trap)', () => {
    expect(fold('I')).toBe('i');
    expect(fold('İ')).toBe('i');   // dotted capital I folds to plain i
  });
});

describe('foldWithMap', () => {
  it('ascii identity map', () => {
    const { folded, at } = foldWithMap('Hello');
    expect(folded).toBe('hello');
    expect(at(0)).toBe(0); expect(at(5)).toBe(5);
  });
  it('maps folded offsets back to original across length changes', () => {
    // "ﬁ" (U+FB01 ligature) decomposes to "fi" — 1 original char → 2 folded chars.
    const { folded, at } = foldWithMap('aﬁb');
    expect(folded).toBe('afib');
    expect(at(0)).toBe(0);  // a
    expect(at(1)).toBe(1);  // f  (from ﬁ at index 1)
    expect(at(2)).toBe(1);  // i  (same original char)
    expect(at(3)).toBe(2);  // b
    expect(at(4)).toBe(3);  // sentinel = length
  });
});

describe('findRanges', () => {
  it('finds all non-overlapping ascii matches', () => {
    expect(findRanges('ab AB aB', fold('ab'))).toEqual([
      { start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 },
    ]);
  });
  it('accent-insensitive with exact original offsets', () => {
    expect(findRanges('Café au lait', fold('cafe'))).toEqual([{ start: 0, end: 4 }]);
    expect(findRanges('naïve café', fold('cafe'))).toEqual([{ start: 6, end: 10 }]);
  });
  it('empty / whitespace needle → no matches', () => {
    expect(findRanges('anything', fold(''))).toEqual([]);
    expect(findRanges('anything', fold('   '))).toEqual([]);
  });
  it('no match → empty', () => {
    expect(findRanges('hello world', fold('xyz'))).toEqual([]);
  });
});

describe('makeSnippet', () => {
  it('centres the match and reports relative highlight offsets', () => {
    const text = 'a'.repeat(100) + 'MATCH' + 'b'.repeat(100);
    const s = makeSnippet(text, 100, 105, 10);
    expect(s.text.slice(s.matchStart, s.matchEnd)).toBe('MATCH');
    expect(s.text.startsWith('…')).toBe(true);
    expect(s.text.endsWith('…')).toBe(true);
  });
  it('no ellipsis when the whole string fits', () => {
    const s = makeSnippet('short match', 6, 11, 40);
    expect(s.text).toBe('short match');
    expect(s.text.slice(s.matchStart, s.matchEnd)).toBe('match');
  });
  it('replaces newlines 1:1 so offsets stay aligned', () => {
    const s = makeSnippet('line1\nhit\nline3', 6, 9, 40);
    expect(s.text.slice(s.matchStart, s.matchEnd)).toBe('hit');
    expect(s.text).not.toContain('\n');
  });
});

describe('matchProject — field detection & order', () => {
  it('matches project title, chapter title, content, annotations', () => {
    const p = proj({
      title: 'Dragon Tale',
      chapters: [{
        id: 'c1', title: 'The Dragon', content: 'A dragon flew.',
        annotations: [{ id: 'a1', start: 2, end: 8, anchorText: 'dragon roars', note: 'dragon lore', anchorType: 'content' }],
      }],
    });
    const hits = matchProject(p, fold('dragon'));
    const fields = hits.map(h => h.field);
    expect(fields).toEqual(['projectTitle', 'chapterTitle', 'content', 'annotationNote', 'annotationAnchor']);
  });

  it('content hit carries cursorPosition = offset into chapter content', () => {
    const p = proj({ chapters: [{ id: 'c1', title: '', content: 'zero one two fox', annotations: [] }] });
    const [hit] = matchProject(p, fold('fox'));
    expect(hit.field).toBe('content');
    expect(hit.chapterId).toBe('c1');
    expect(hit.cursorPosition).toBe(13);
    expect(hit.offset).toBe(13);
  });

  it('labels an inline ## heading as a heading (higher rank than body)', () => {
    const p = proj({ chapters: [{ id: 'c1', title: '', content: 'intro\n## Betaswork\nbody beta', annotations: [] }] });
    const hits = matchProject(p, fold('beta'));
    expect(hits.map(h => h.field)).toEqual(['heading', 'content']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('empty needle → no hits', () => {
    expect(matchProject(proj(), '')).toEqual([]);
  });
});

describe('searchProject / searchAll', () => {
  it('searchProject returns ordered cyclable hits', () => {
    const p = proj({ chapters: [{ id: 'c1', title: '', content: 'fox fox fox', annotations: [] }] });
    const hits = searchProject(p, 'fox');
    expect(hits.map(h => h.cursorPosition)).toEqual([0, 4, 8]);
  });

  it('searchAll returns only matching projects, ranked by best-field then count', () => {
    const a = proj({ id: 'a', title: 'zebra', updatedAt: '2026-01-01', chapters: [{ id: 'ca', title: '', content: 'nothing here', annotations: [] }] });
    const b = proj({ id: 'b', title: 'plain', updatedAt: '2026-02-01', chapters: [{ id: 'cb', title: '', content: 'zebra zebra crossing', annotations: [] }] });
    const c = proj({ id: 'c', title: 'plain', updatedAt: '2026-03-01', chapters: [{ id: 'cc', title: '', content: 'no match', annotations: [] }] });
    const res = searchAll([a, b, c], 'zebra');
    expect(res.map(r => r.projectId)).toEqual(['a', 'b']);   // a: title hit (score 100) beats b: content
    expect(res[0].hitCount).toBe(1);
    expect(res[1].hitCount).toBe(2);
  });

  it('searchAll empty query → []', () => {
    expect(searchAll([proj()], '')).toEqual([]);
  });

  it('a huge content string matches quickly and at the right offset', () => {
    const big = 'x'.repeat(2_000_000) + 'needle' + 'y'.repeat(2_000_000);
    const p = proj({ chapters: [{ id: 'c1', title: '', content: big, annotations: [] }] });
    const t0 = Date.now();
    const [hit] = searchProject(p, 'needle');
    expect(hit.cursorPosition).toBe(2_000_000);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
