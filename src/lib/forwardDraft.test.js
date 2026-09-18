import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { saveForwardDraft, loadForwardDraft, clearForwardDraft } from './forwardDraft.js';
import { closeDB, __test } from './sync/store.js';

// Fresh DB per test (same pattern as store.test.js) so ordering never leaks state.
beforeEach(async () => {
  closeDB();
  await new Promise((res) => {
    const del = indexedDB.deleteDatabase(__test.DB_NAME);
    del.onsuccess = del.onerror = del.onblocked = () => res();
  });
});

describe('forwardDraft — crash-recovery buffer', () => {
  it('saves and loads a draft for its project', async () => {
    await saveForwardDraft({ projectId: 'A', chapterId: 'c1', cursor: 3, text: 'the quick brown' });
    const d = await loadForwardDraft('A');
    expect(d.text).toBe('the quick brown');
    expect(d.chapterId).toBe('c1');
    expect(d.cursor).toBe(3);
    expect(typeof d.updatedAt).toBe('number');
  });

  it('returns null when a project has no draft', async () => {
    expect(await loadForwardDraft('A')).toBeNull();
  });

  // The guarantee Paul insisted on: a new session in project B must never clobber A's draft.
  it('isolates drafts per project — no cross-project clobber', async () => {
    await saveForwardDraft({ projectId: 'A', chapterId: 'c1', cursor: 0, text: 'crashed in A' });
    await saveForwardDraft({ projectId: 'B', chapterId: 'c9', cursor: 0, text: 'writing in B' });
    expect((await loadForwardDraft('A')).text).toBe('crashed in A');
    expect((await loadForwardDraft('B')).text).toBe('writing in B');
  });

  it('clear removes only the target project+chapter, leaving others intact', async () => {
    await saveForwardDraft({ projectId: 'A', chapterId: 'c1', cursor: 0, text: 'A one' });
    await saveForwardDraft({ projectId: 'B', chapterId: 'c9', cursor: 0, text: 'B nine' });
    await clearForwardDraft('A', 'c1');
    expect(await loadForwardDraft('A')).toBeNull();
    expect((await loadForwardDraft('B')).text).toBe('B nine');
  });

  it('within a project, returns the most-recently-updated chapter draft', async () => {
    await saveForwardDraft({ projectId: 'A', chapterId: 'c1', cursor: 0, text: 'older' });
    await new Promise(r => setTimeout(r, 5));
    await saveForwardDraft({ projectId: 'A', chapterId: 'c2', cursor: 0, text: 'newer' });
    expect((await loadForwardDraft('A')).text).toBe('newer');
  });

  it('ignores an empty/whitespace draft (nothing to recover)', async () => {
    await saveForwardDraft({ projectId: 'A', chapterId: 'c1', cursor: 0, text: '   ' });
    expect(await loadForwardDraft('A')).toBeNull();
  });
});
