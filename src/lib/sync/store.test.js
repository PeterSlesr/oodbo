import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createIdbAdapter, newSyncRecord, stampDirty, commitClean, isStuckDirty,
  DIRTY_BADGE_MS, closeDB, __test,
} from './store.js';

// Fresh DB per test so ordering never leaks state. Close the cached connection first,
// otherwise deleteDatabase blocks on the open handle.
beforeEach(async () => {
  closeDB();
  await new Promise((res) => {
    const del = indexedDB.deleteDatabase(__test.DB_NAME);
    del.onsuccess = del.onerror = del.onblocked = () => res();
  });
});

const proj = (id = 'p1', content = 'hello') => ({
  id, title: 'T', activeChapterId: 'c1',
  chapters: [{ id: 'c1', level: 1, title: 'c', content, annotations: [] }],
});

describe('the single v4 opener creates every store the app needs', () => {
  it('has the legacy stores (handles/wordAssets/projects) + the new ones (syncRecords/syncMeta)', async () => {
    const db = await __test.openDB();
    const names = [...db.objectStoreNames].sort();
    expect(names).toEqual(['handles', 'projects', 'syncMeta', 'syncRecords', 'wordAssets']);
    expect(db.version).toBe(__test.DB_VERSION);
  });
});

describe('sync record helpers (pure)', () => {
  it('newSyncRecord starts dirty with no ancestor', () => {
    const r = newSyncRecord('p1', 'google');
    expect(r).toMatchObject({ projectId: 'p1', provider: 'google', syncState: 'dirty', syncedHash: null, dirtySince: null });
  });

  it('stampDirty sets dirtySince ONCE and never advances it', () => {
    const r0 = newSyncRecord('p1', 'google');
    const r1 = stampDirty(r0, 1000);
    expect(r1.dirtySince).toBe(1000);
    const r2 = stampDirty(r1, 9999);        // later edit
    expect(r2.dirtySince).toBe(1000);       // unchanged — the badge clock must not reset
    expect(r2.syncState).toBe('dirty');
  });

  it('stampDirty preserves pending-verify state', () => {
    const r = stampDirty({ ...newSyncRecord('p1', 'google'), syncState: 'pending-verify' }, 1);
    expect(r.syncState).toBe('pending-verify');
  });

  it('commitClean clears the outbox fields and records the ancestor', () => {
    const r = stampDirty(newSyncRecord('p1', 'google'), 1000);
    const c = commitClean(r, { baseCloudRev: 'rev9', syncedHash: 'h9', cloudFileId: 'f1' });
    expect(c).toMatchObject({ syncState: 'clean', baseCloudRev: 'rev9', syncedHash: 'h9', cloudFileId: 'f1', dirtySince: null, pendingRev: null, pendingSince: null });
  });

  it('isStuckDirty fires only past the 24h threshold, measured from dirtySince', () => {
    const now = 1_000_000_000_000;
    const fresh = stampDirty(newSyncRecord('p1', 'google'), now - 1000);
    const old   = stampDirty(newSyncRecord('p2', 'google'), now - DIRTY_BADGE_MS - 1);
    expect(isStuckDirty(fresh, now)).toBe(false);
    expect(isStuckDirty(old, now)).toBe(true);
    expect(isStuckDirty(commitClean(old, { baseCloudRev: 'r', syncedHash: 'h' }), now)).toBe(false); // clean = never stuck
  });
});

describe('adapter — records & content', () => {
  it('round-trips a sync record', async () => {
    const a = createIdbAdapter();
    const r = commitClean(newSyncRecord('p1', 'azure'), { baseCloudRev: 'cT', baseCasRev: 'eT', syncedHash: 'h' });
    await a.putRecord(r);
    expect(await a.getRecord('p1')).toMatchObject({ projectId: 'p1', baseCloudRev: 'cT', baseCasRev: 'eT' });
    expect((await a.getAllRecords())).toHaveLength(1);
    await a.deleteRecord('p1');
    expect(await a.getRecord('p1')).toBeNull();
  });

  it('stores content scoped by owner', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('p1'), 'me@x.com');
    await a.putProject(proj('p2'), 'other@x.com');
    expect(await a.getProject('p1')).toMatchObject({ id: 'p1' });
    expect(await a.getAllProjectEntries('me@x.com')).toHaveLength(1);
    expect(await a.getAllProjectEntries('other@x.com')).toHaveLength(1);
  });
});

describe('adapter — atomic content+record (spec §11)', () => {
  it('commitProjectAndRecord writes both stores in one transaction', async () => {
    const a = createIdbAdapter();
    const r = commitClean(newSyncRecord('p1', 'google'), { baseCloudRev: 'rev1', syncedHash: 'h1' });
    await a.commitProjectAndRecord(proj('p1', 'pulled content'), 'me@x.com', r, { pendingSync: false });
    expect((await a.getProject('p1')).chapters[0].content).toBe('pulled content');
    expect(await a.getRecord('p1')).toMatchObject({ syncState: 'clean', baseCloudRev: 'rev1' });
  });

  it('deleteProjectAndRecord removes both', async () => {
    const a = createIdbAdapter();
    await a.commitProjectAndRecord(proj('p1'), 'me@x.com', newSyncRecord('p1', 'google'), {});
    await a.deleteProjectAndRecord('p1');
    expect(await a.getProject('p1')).toBeNull();
    expect(await a.getRecord('p1')).toBeNull();
  });
});

describe('adapter — dirtySet outbox', () => {
  it('persists membership and is idempotent', async () => {
    const a = createIdbAdapter();
    expect([...(await a.getDirtySet())]).toEqual([]);
    await a.addDirty('p1');
    await a.addDirty('p1');            // idempotent
    await a.addDirty('p2');
    expect([...(await a.getDirtySet())].sort()).toEqual(['p1', 'p2']);
    await a.removeDirty('p1');
    expect([...(await a.getDirtySet())]).toEqual(['p2']);
  });

  it('survives a fresh adapter over the same DB (persisted, not in-memory)', async () => {
    await createIdbAdapter().addDirty('p9');
    const set = await createIdbAdapter().getDirtySet();   // new adapter instance, same DB
    expect(set.has('p9')).toBe(true);
  });
});
