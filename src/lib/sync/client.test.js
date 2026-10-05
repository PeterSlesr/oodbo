// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { migrateProjects, initSync, getEngine, teardownSync,
         getConflicts, getSyncBadges, resolveConflict, reassignFork,
         __setReachableForTest } from './client.js';
import { createIdbAdapter, closeDB, newSyncRecord, stampDirty, __test } from './store.js';
import { createForkHandler } from './fork.js';
import { serializeOodbo, canonicalHash } from './canonical.js';

// This suite runs in node (no jsdom): provide a minimal localStorage so the kill-switch
// and owner-guard paths in client.js have somewhere to read/write.
if (typeof localStorage === 'undefined') {
  const _ls = new Map();
  globalThis.localStorage = {
    getItem:    (k) => (_ls.has(k) ? _ls.get(k) : null),
    setItem:    (k, v) => { _ls.set(k, String(v)); },
    removeItem: (k) => { _ls.delete(k); },
    clear:      () => { _ls.clear(); },
  };
}

beforeEach(async () => {
  teardownSync();
  try { localStorage.removeItem('oodbo:sync-off'); } catch {}
  closeDB();
  await new Promise((res) => {
    const del = indexedDB.deleteDatabase(__test.DB_NAME);
    del.onsuccess = del.onerror = del.onblocked = () => res();
  });
});

const proj = (id, content, title = 'T') => ({
  id, title, activeChapterId: 'c1',
  chapters: [{ id: 'c1', level: 1, title: 'c', content, annotations: [] }],
});
const xmlOf = (id, content) => serializeOodbo(proj(id, content));

function fakeCloud(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async list() { return [...store.entries()].map(([projectId, v]) => ({ projectId, rev: v.rev, cTag: v.cTag, trashed: !!v.trashed })); },
    async load(id) { const v = store.get(id); return v ? { xml: v.xml, rev: v.rev, cTag: v.cTag } : { notFound: true }; },
  };
}

async function migrate(adapter, cloud) {
  const forkHandler = createForkHandler({ adapter, provider: 'azure', owner: 'me@x.com', deviceLabel: 'Chrome (Web)', now: () => 1_700_000_000_000 });
  return migrateProjects({ adapter, cloud, provider: 'azure', owner: 'me@x.com', forkHandler });
}

describe('migration §12', () => {
  it('equal local & cloud → clean record', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('p1', 'same'), 'me@x.com');
    await migrate(a, fakeCloud({ p1: { xml: xmlOf('p1', 'same'), rev: 'e1', cTag: 'c1' } }));
    const rec = await a.getRecord('p1');
    expect(rec.syncState).toBe('clean');
    expect(rec.baseCloudRev).toBe('c1');           // detection = cTag
    expect(rec.syncedHash).toBe(await canonicalHash(proj('p1', 'same')));
  });

  it('differ + clean (never edited offline) → trust cloud, pull', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('p2', 'stale local'), 'me@x.com', { pendingSync: false });
    await migrate(a, fakeCloud({ p2: { xml: xmlOf('p2', 'newer cloud'), rev: 'e', cTag: 'c' } }));
    expect((await a.getProject('p2')).chapters[0].content).toBe('newer cloud');   // pulled, no fork
    expect((await a.getRecord('p2')).syncState).toBe('clean');
  });

  it('differ + dirty (pendingSync) → fork-first, both versions kept', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('p3', 'my offline edit'), 'me@x.com', { pendingSync: true });
    await migrate(a, fakeCloud({ p3: { xml: xmlOf('p3', 'their cloud edit'), rev: 'e', cTag: 'c' } }));
    // original adopts cloud
    expect((await a.getProject('p3')).chapters[0].content).toBe('their cloud edit');
    // and a fork holds the local edit
    const forks = (await a.getAllProjectEntries('me@x.com')).filter(e => e.data.chapters[0].content === 'my offline edit');
    expect(forks).toHaveLength(1);
    expect(forks[0].data.title).toMatch(/conflicted/);
  });

  it('local not in cloud → left recordless and dirty (row 0a on first sweep)', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('p4', 'only local'), 'me@x.com');
    await migrate(a, fakeCloud({}));
    expect(await a.getRecord('p4')).toBeNull();
    expect((await a.getDirtySet()).has('p4')).toBe(true);
  });

  it('sets the migrated flag and is idempotent', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('p1', 'same'), 'me@x.com');
    const cloud = fakeCloud({ p1: { xml: xmlOf('p1', 'same'), rev: 'e', cTag: 'c' } });
    expect(await migrate(a, cloud)).toEqual({ migrated: true });
    expect(await migrate(a, cloud)).toEqual({ skipped: true });   // second run no-ops
  });

  it('offline (list throws) defers without setting the flag', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('p1', 'x'), 'me@x.com');
    const cloud = { async list() { throw new Error('offline'); }, async load() { return { notFound: true }; } };
    expect(await migrate(a, cloud)).toEqual({ deferred: true });
    expect(await a.getMeta('migrated:v1')).toBeUndefined();       // will retry next launch
  });
});

describe('client gating & kill-switch', () => {
  const validUser = { provider: 'azure', email: 'me@x.com' };
  const getToken = async () => 'tok';

  // Gating is provider-only now — there is no payment concept. A guest (no user) or a
  // signed-in user without a cloud provider runs local-only (no engine).
  it('guest / no-provider users get no engine', async () => {
    expect(await initSync({ user: null, getToken })).toBeNull();
    expect(await initSync({ user: { provider: null, email: 'x' }, getToken })).toBeNull();
  });

  it('a signed-in provider user gets an engine', async () => {
    expect(await initSync({ user: validUser, getToken })).not.toBeNull();
    expect(getEngine()).not.toBeNull();
  });

  it('the kill-switch forces local-only (no engine)', async () => {
    localStorage.setItem('oodbo:sync-off', '1');
    expect(await initSync({ user: validUser, getToken })).toBeNull();
    expect(getEngine()).toBeNull();
  });
});

describe('conflict pairs & badges — derived from conflictOf, N forks per original', () => {
  const validUser = { provider: 'azure', paid: true, email: 'me@x.com' };
  const getToken = async () => 'tok';
  const forkOf = (id, of, title) => ({ ...proj(id, 'v', title), conflictOf: of });

  it('one original with TWO forks reports both — the count is real, not overwritten to one', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('orig', 'base', 'Story'), 'me@x.com');
    await a.putProject(forkOf('f1', 'orig', 'Story (conflicted — A)'), 'me@x.com');
    await a.putProject(forkOf('f2', 'orig', 'Story (conflicted — B)'), 'me@x.com');
    initSync({ user: validUser, getToken });

    expect(await getConflicts()).toHaveLength(2);            // both pairs, not one
    const badges = await getSyncBadges();
    expect(badges.orig.forks.map(f => f.forkId).sort()).toEqual(['f1', 'f2']);   // ← the miscount fix
    expect(badges.f1.conflictFork).toBe(true);
    expect(badges.f2.conflictFork).toBe(true);
  });

  it('a fork whose original is trashed is no longer a conflict — just a project', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('orig', 'base', 'Story'), 'me@x.com');
    await a.putProject(forkOf('f1', 'orig', 'Story (fork)'), 'me@x.com');
    await a.putProject({ ...proj('orig', 'base', 'Story'), }, 'me@x.com', { trashed: true });
    initSync({ user: validUser, getToken });
    expect(await getConflicts()).toHaveLength(0);
  });

  it('keeping a fork over the original re-points siblings so none are stranded', async () => {
    // orig has f1 and f2. Keep f1, bin orig. f2 must become a fork of f1 — the new trunk —
    // not left pointing at a trashed project with its reconcile prompt silently gone.
    const a = createIdbAdapter();
    await a.putProject(proj('orig', 'base', 'Story'), 'me@x.com');
    await a.putProject(forkOf('f1', 'orig', 'Story (A)'), 'me@x.com');
    await a.putProject(forkOf('f2', 'orig', 'Story (B)'), 'me@x.com');
    initSync({ user: validUser, getToken });

    await reassignFork('f2', 'f1');     // sibling handed to the survivor
    await resolveConflict('f1');        // survivor becomes the trunk
    await getEngine().trashProject('orig');

    const conflicts = await getConflicts();
    expect(conflicts).toEqual([{ projectId: 'f1', forkId: 'f2', forkTitle: 'Story (B)' }]);
    expect((await a.getProject('f1'))).not.toHaveProperty('conflictOf');   // trunk is clean
  });
});

describe('sync badges — "not backed up" flags on failure, not on a 24h clock', () => {
  const validUser = { provider: 'azure', paid: true, email: 'me@x.com' };
  const getToken = async () => 'tok';
  // Force navigator.onLine for the duration of an async read, restoring after it resolves.
  const withOnline = async (v, fn) => {
    const d = Object.getOwnPropertyDescriptor(navigator, 'onLine');
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v });
    try { return await fn(); } finally { d ? Object.defineProperty(navigator, 'onLine', d) : delete navigator.onLine; }
  };

  it('dirty + online ⇒ syncing; dirty + offline (Wi-Fi off) ⇒ not-backed-up immediately', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('p', 'x'), 'me@x.com');
    await a.putRecord(newSyncRecord('p', 'azure'));   // syncState 'dirty', freshly, dirtySince null
    initSync({ user: validUser, getToken });
    __setReachableForTest(true);

    const online = await withOnline(true, () => getSyncBadges());
    expect(online.p.syncing).toBe(true);
    expect(online.p.notBackedUp).toBe(false);         // online + recent ⇒ on its way, no alarm

    __setReachableForTest(true);                       // isolate the navigator.onLine signal
    const offline = await withOnline(false, () => getSyncBadges());
    expect(offline.p.notBackedUp).toBe(true);          // offline ⇒ flagged NOW, no 24h wait
    expect(offline.p.syncing).toBe(false);
  });

  it('dirty + cloud unreachable (captive portal — navigator still "online") ⇒ not-backed-up', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('p', 'x'), 'me@x.com');
    await a.putRecord(newSyncRecord('p', 'azure'));
    initSync({ user: validUser, getToken });
    __setReachableForTest(false);                       // engine proved the cloud unreachable

    const badges = await withOnline(true, () => getSyncBadges());   // navigator lies "online"
    expect(badges.p.notBackedUp).toBe(true);
  });

  it('still flags after 24h even when the cloud looks reachable (the backstop)', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('q', 'x'), 'me@x.com');
    const old = { ...newSyncRecord('q', 'azure'), dirtySince: Date.now() - 25 * 60 * 60 * 1000 };
    await a.putRecord(stampDirty(old, old.dirtySince));   // dirty for 25h
    initSync({ user: validUser, getToken });
    __setReachableForTest(true);

    const badges = await withOnline(true, () => getSyncBadges());
    expect(badges.q.notBackedUp).toBe(true);
  });

  it('a clean project shows nothing', async () => {
    const a = createIdbAdapter();
    await a.putProject(proj('c', 'x'), 'me@x.com');
    await a.putRecord({ ...newSyncRecord('c', 'azure'), syncState: 'clean', dirtySince: null });
    initSync({ user: validUser, getToken });
    __setReachableForTest(true);
    const badges = await withOnline(true, () => getSyncBadges());
    expect(badges.c.notBackedUp).toBe(false);
    expect(badges.c.syncing).toBe(false);
    expect(badges.c.pending).toBe(false);
  });
});