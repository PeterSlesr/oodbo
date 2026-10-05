// @vitest-environment jsdom
// (parseOodbo/hashXml use DOMParser; the default node env has no DOM — this test needs jsdom, which
//  is a devDependency. Matches how desktop-port ran these reconciliation tests.)
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { createIdbAdapter, closeDB, __test, newSyncRecord, commitClean } from './sync/store.js';
import { serializeOodbo, hashXml } from './sync/canonical.js';
import { reconcileDesktop, recoverAppDataToIdb } from './desktopReconcile.js';

// Fake "appdata disk": an in-memory map the reconciler reads through the mocked desktopSave I/O.
// The reconciler only READS from desktopSave (list/read xml/read sidecar); it WRITES via the
// adapter, which here is the plain IDB adapter — so IDB (adapter) and disk (this map) are cleanly
// separated and independently assertable.
const fs = vi.hoisted(() => {
  const disk = new Map();  // id → { xml, sidecar }
  return {
    disk,
    listAppDataProjectIds: vi.fn(async () => [...disk.keys()]),
    readAppDataProjectXml: vi.fn(async (_o, id) => disk.get(id)?.xml ?? null),
    readAppDataSidecar:    vi.fn(async (_o, id) => disk.get(id)?.sidecar ?? null),
  };
});
vi.mock('./desktopSave.js', () => fs);

const OWNER = 'me@x.com';
const proj = (id, content, title = 'T') => ({
  id, title, activeChapterId: 'c1',
  chapters: [{ id: 'c1', level: 1, title: 'c', content, createdAt: 't', updatedAt: 't', annotations: [] }],
});

// Put a project on the fake disk with a clean, synced sidecar record (ancestor = the disk content).
async function onDisk(id, content, { trashed = false, deletedAt = null, record = 'clean', title = 'T' } = {}) {
  const xml = serializeOodbo(proj(id, content, title));
  let rec = null;
  if (record === 'clean') {
    rec = commitClean(newSyncRecord(id, 'google'), { baseCloudRev: 'r1', syncedHash: await hashXml(xml) });
  } else if (record === 'stale') {
    // a synced ancestor for DIFFERENT (older) content — used to model an unpushed edit on disk
    rec = commitClean(newSyncRecord(id, 'google'), { baseCloudRev: 'r1', syncedHash: 'OLD_ANCESTOR_HASH' });
  } else if (record && typeof record === 'object') {
    rec = record;
  }
  fs.disk.set(id, { xml, sidecar: rec === null && record === null ? { record: null, trashed, deletedAt } : { record: rec, trashed, deletedAt } });
  return { xml, rec };
}

async function reconcile(adapter) {
  return reconcileDesktop({ adapter, owner: OWNER, provider: 'google' });
}

beforeEach(async () => {
  closeDB();
  fs.disk.clear();
  await new Promise((res) => { const d = indexedDB.deleteDatabase(__test.DB_NAME); d.onsuccess = d.onerror = d.onblocked = () => res(); });
});

describe('desktop reconciliation — appdata authoritative, IDB rebuildable (§11 / invariant 6)', () => {
  it('IDB wipe, clean project on disk → rebuilds entry + record CLEAN (fast-forward ready, not dirty)', async () => {
    const a = createIdbAdapter();
    const { rec } = await onDisk('p1', 'hello');           // disk has content + clean record; IDB empty

    const stats = await reconcile(a);

    expect(stats.recovered).toBe(1);
    expect((await a.getProject('p1')).chapters[0].content).toBe('hello');   // content back in IDB
    const back = await a.getRecord('p1');
    expect(back.syncState).toBe('clean');
    expect(back.syncedHash).toBe(rec.syncedHash);          // ancestor preserved → row 2 FF, not phantom fork
    expect((await a.getDirtySet()).has('p1')).toBe(false); // clean project is NOT queued to push
  });

  it('IDB wipe, disk content edited past its ancestor → recovered DIRTY (unpushed edit re-pushes, row 3)', async () => {
    const a = createIdbAdapter();
    await onDisk('p1', 'edited-after-sync', { record: 'stale' });  // record ancestor ≠ disk content

    const stats = await reconcile(a);

    expect(stats.recovered).toBe(1);
    expect((await a.getRecord('p1')).syncState).toBe('dirty');
    expect((await a.getDirtySet()).has('p1')).toBe(true);
  });

  it('IDB wipe, appdata-only project with no record → recordless + dirty (row 0a bootstrap-create)', async () => {
    const a = createIdbAdapter();
    await onDisk('p1', 'never-synced', { record: null });

    const stats = await reconcile(a);

    expect(stats.recovered).toBe(1);
    expect(await a.getProject('p1')).toBeTruthy();
    expect(await a.getRecord('p1')).toBeNull();
    expect((await a.getDirtySet()).has('p1')).toBe(true);
  });

  it('trashed project on disk survives an IDB wipe as a trashed entry', async () => {
    const a = createIdbAdapter();
    await onDisk('p1', 'gone', { trashed: true, deletedAt: '2026-01-01T00:00:00Z' });

    await reconcile(a);

    const entry = await a.getProjectEntry('p1');
    expect(entry.trashed).toBe(true);
    expect(entry.deletedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('record store wiped but content intact in IDB → restores the record from the sidecar', async () => {
    const a = createIdbAdapter();
    const { rec } = await onDisk('p1', 'hello');
    await a.putProject(proj('p1', 'hello'), OWNER, {});   // IDB has content but NO record

    const stats = await reconcile(a);

    expect(stats.recordRestored).toBe(1);
    expect((await a.getRecord('p1')).syncedHash).toBe(rec.syncedHash);
  });

  it('steady state (IDB == disk, record present) → no changes, all stats zero', async () => {
    const a = createIdbAdapter();
    const { rec } = await onDisk('p1', 'hello');
    await a.commitProjectAndRecord(proj('p1', 'hello'), OWNER, rec, {});   // IDB already agrees

    const stats = await reconcile(a);

    expect(stats).toMatchObject({ recovered: 0, recordRestored: 0, diskWins: 0, idbWins: 0, forked: 0, mirrored: 0 });
    expect((await a.getDirtySet()).size).toBe(0);
  });

  it('legacy IDB project with NO on-disk copy → backfilled (durability pass 2)', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('p1', 'only-in-idb'), OWNER, {});   // nothing on disk for p1

    const stats = await reconcile(a);

    expect(stats.mirrored).toBe(1);
    expect(await a.getProject('p1')).toBeTruthy();   // untouched in IDB
  });

  it('local-vs-local: IDB and disk both diverged from the ancestor → keep BOTH (trunk + conflictOf sibling)', async () => {
    const a = createIdbAdapter();
    // Disk record's ancestor matches NEITHER the disk content NOR the IDB content.
    await onDisk('p1', 'disk-version', { record: 'stale' });
    await a.commitProjectAndRecord(
      proj('p1', 'idb-version'),
      OWNER,
      commitClean(newSyncRecord('p1', 'google'), { baseCloudRev: 'r1', syncedHash: 'OLD_ANCESTOR_HASH' }),
      {},
    );

    const stats = await reconcile(a);

    expect(stats.forked).toBe(1);
    expect((await a.getProject('p1')).chapters[0].content).toBe('idb-version');   // trunk preserved
    const entries = await a.getAllProjectEntries(OWNER);
    const sibling = entries.find(e => e.data?.conflictOf === 'p1');
    expect(sibling).toBeTruthy();
    expect(sibling.data.chapters[0].content).toBe('disk-version');                // disk copy preserved
  });
});

describe('non-engine recovery — recoverAppDataToIdb (free/local tier: appdata → IDB)', () => {
  it('rebuilds IDB from disk for projects it lacks; records not required', async () => {
    const a = createIdbAdapter();
    await onDisk('p1', 'local words', { record: null });   // magic/unpaid: content on disk, no record

    const stats = await recoverAppDataToIdb(OWNER);

    expect(stats.recovered).toBe(1);
    expect((await a.getProject('p1')).chapters[0].content).toBe('local words');
  });

  it('skips projects IDB already has (no duplicate, idempotent)', async () => {
    const a = createIdbAdapter();
    await onDisk('p1', 'x', { record: null });
    await a.putProject(proj('p1', 'x'), OWNER, {});   // already present

    const stats = await recoverAppDataToIdb(OWNER);

    expect(stats.recovered).toBe(0);
  });

  it('recovers a trashed project as trashed (stays in the bin)', async () => {
    const a = createIdbAdapter();
    await onDisk('p1', 'gone', { record: null, trashed: true, deletedAt: '2026-01-01T00:00:00Z' });

    await recoverAppDataToIdb(OWNER);

    const entry = await a.getProjectEntry('p1');
    expect(entry.trashed).toBe(true);
    expect(entry.deletedAt).toBe('2026-01-01T00:00:00Z');
  });
});
