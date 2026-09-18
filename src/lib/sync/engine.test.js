import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createEngine } from './engine.js';
import { createForkHandler } from './fork.js';
import { createIdbAdapter, closeDB, __test } from './store.js';
import { serializeOodbo, canonicalHash } from './canonical.js';
import { CloudAuthError, CloudTransientError } from './cloud.js';

beforeEach(async () => {
  closeDB();
  await new Promise((res) => {
    const del = indexedDB.deleteDatabase(__test.DB_NAME);
    del.onsuccess = del.onerror = del.onblocked = () => res();
  });
});

const proj = (id, content) => ({
  id, title: 'T', activeChapterId: 'c1',
  chapters: [{ id: 'c1', level: 1, title: 'c', content, annotations: [] }],
});
const xmlOf = (id, content) => serializeOodbo(proj(id, content));

// A small stateful fake of Drive/OneDrive so pushes/pulls are coherent and revs behave
// like the real providers: content saves bump both eTag+cTag (OneDrive) / headRevisionId
// (Drive); a metaOnly put bumps eTag but NOT cTag (the drift the spike found).
function fakeBackend(provider, log) {
  let seq = 0;
  const store = new Map();
  const tombs = new Set();       // §9 ext: purge-tombstone manifest
  let tombRev = null;
  const bump = () => `r${++seq}`;
  const bumpTomb = () => { tombRev = `t${++seq}`; };
  const put = (id, xml, { metaOnly = false } = {}) => {
    const prev = store.get(id);
    if (provider === 'azure') {
      const eTag = bump();
      const cTag = metaOnly && prev ? prev.cTag : bump();
      store.set(id, { xml: metaOnly && prev ? prev.xml : xml, eTag, cTag, trashed: false });
      return { rev: eTag, cTag };
    }
    const rev = bump();
    store.set(id, { xml, rev, trashed: false });
    return { rev };
  };
  let beforeSave = null;   // test hook: fires once mid-save to simulate a concurrent write (TOCTOU)
  const metaOf = v => provider === 'azure'
    ? { exists: true, rev: v.eTag, cTag: v.cTag }
    : { exists: true, rev: v.rev };
  const cloud = {
    async list() { log.push('list'); return [...store.entries()].map(([projectId, v]) => ({ projectId, ...metaOf(v), trashed: v.trashed })); },
    async head(id) { log.push('head:' + id); const v = store.get(id); return v && !v.trashed ? metaOf(v) : { exists: false }; },
    async load(id) { log.push('load:' + id); const v = store.get(id); return v ? { xml: v.xml, rev: provider === 'azure' ? v.eTag : v.rev, cTag: v.cTag } : { notFound: true }; },
    async save(id, xml, opts = {}) {
      log.push('save:' + id);
      if (beforeSave) { const cb = beforeSave; beforeSave = null; cb(); }   // a foreign write lands between our decide and our save
      const v = store.get(id);
      if (provider === 'azure' && opts.ifMatch && v && opts.ifMatch !== v.eTag) return { precondition: true };
      return { ok: true, ...put(id, xml) };
    },
    async trash(id, xml) {
      log.push('trash:' + id);
      let v = store.get(id);
      if (!v && xml) { put(id, xml); v = store.get(id); }
      if (v) v.trashed = true;
      return { ok: true };
    },
    async restore(id) { log.push('restore:' + id); const v = store.get(id); if (v) v.trashed = false; return { ok: true }; },
    async remove(id) { log.push('remove:' + id); store.delete(id); tombs.add(id); bumpTomb(); return { ok: true }; },
    async removeMany(ids) { log.push('removeMany:' + ids.length); for (const id of ids) { store.delete(id); tombs.add(id); } bumpTomb(); return { ok: true }; },
    async readTombstones(knownRev) {
      log.push('tombstones');
      if (tombRev && knownRev === tombRev) return { rev: tombRev, unchanged: true };
      return { rev: tombRev, ids: [...tombs] };
    },
  };
  // purgeCloud simulates ANOTHER device permanently deleting: the cloud file is gone and the id
  // is tombstoned, exactly as the server DELETE handler leaves it.
  const purgeCloud = (id) => { store.delete(id); tombs.add(id); bumpTomb(); };
  return { cloud, store, put, tombs, purgeCloud, setBeforeSave: (fn) => { beforeSave = fn; } };
}

function setup(provider, { t = 1000 } = {}) {
  const log = [];
  const clock = { t };
  const adapter = createIdbAdapter();
  const { cloud, store, put, tombs, purgeCloud, setBeforeSave } = fakeBackend(provider, log);
  const onConflict = vi.fn(async () => {});
  const onGone     = vi.fn(async () => {});
  const onReauth   = vi.fn(() => {});
  const onBoot     = vi.fn(async () => {});
  const onBadge    = vi.fn(() => {});
  const onNetwork  = vi.fn(() => {});
  const sleep = (ms) => { log.push('sleep:' + ms); return Promise.resolve(); };
  const engine = createEngine({
    adapter, cloud, provider, owner: 'me@x.com',
    now: () => clock.t, sleep, jitter: () => 111, confirmDelayMs: 60_000,
    handlers: { onConflict, onGone, onReauth, onBoot, onBadge, onNetwork },
  });
  return { adapter, cloud, engine, log, store, put, tombs, purgeCloud, setBeforeSave, clock, onConflict, onGone, onReauth, onBoot, onBadge, onNetwork };
}

describe('engine — bootstrap create (row 0a)', () => {
  it('OneDrive commits clean immediately (true CAS)', async () => {
    const { adapter, engine, store } = setup('azure');
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { userInitiated: true });
    const rec = await adapter.getRecord('p1');
    expect(rec.syncState).toBe('clean');
    expect(rec.baseCloudRev).toBeTruthy();     // cTag
    expect(rec.baseCasRev).toBeTruthy();       // eTag
    expect(rec.syncedHash).toBe(await canonicalHash(proj('p1', 'hello')));
    expect(store.has('p1')).toBe(true);
    expect([...(await adapter.getDirtySet())]).toEqual([]);
  });

  it('Drive enters pending-verify (freezes pendingHash) and stays in the outbox', async () => {
    const { adapter, engine } = setup('google');
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { userInitiated: true });
    const rec = await adapter.getRecord('p1');
    expect(rec.syncState).toBe('pending-verify');
    expect(rec.pendingRev).toBeTruthy();
    expect(rec.pendingHash).toBe(await canonicalHash(proj('p1', 'hello')));
    expect((await adapter.getDirtySet()).has('p1')).toBe(true);
  });
});

describe('engine — Drive delayed confirmation (invariant 2)', () => {
  it('does NOT commit before ≥60s, then commits after', async () => {
    const { adapter, engine, clock } = setup('google', { t: 1000 });
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { userInitiated: true });          // pending, pendingSince=1000
    const pending = await adapter.getRecord('p1');

    await engine.runProject('p1', { userInitiated: true });          // t still 1000 → too soon
    expect((await adapter.getRecord('p1')).syncState).toBe('pending-verify');

    clock.t = 1000 + 60_000;                                         // ≥60s later
    await engine.runProject('p1', { userInitiated: true });
    const rec = await adapter.getRecord('p1');
    expect(rec.syncState).toBe('clean');
    expect(rec.baseCloudRev).toBe(pending.pendingRev);              // ancestor = the pushed rev
    expect(rec.syncedHash).toBe(pending.pendingHash);
    expect((await adapter.getDirtySet()).has('p1')).toBe(false);
  });

  // The "syncing…" badge is derived from this record. Confirmation happens in a background
  // sweep with no user action and no project change behind it, so if the engine settles the
  // record silently, nothing re-renders and the badge sits on screen until a reload.
  it('announces the confirmation, so the "syncing…" badge can clear itself', async () => {
    const { adapter, engine, clock, onBadge } = setup('google', { t: 1000 });
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { userInitiated: true });          // → pending-verify
    onBadge.mockClear();

    clock.t = 1000 + 60_000;
    await engine.runProject('p1', { userInitiated: true });          // → clean
    expect((await adapter.getRecord('p1')).syncState).toBe('clean');
    expect(onBadge).toHaveBeenCalledWith(expect.objectContaining({ type: 'confirmed', projectId: 'p1' }));
  });

  it('a foreign write landing on top → conflict, never a silent clean', async () => {
    const { adapter, engine, put, onConflict } = setup('google', { t: 1000 });
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { userInitiated: true });          // pending
    put('p1', xmlOf('p1', 'theirs'));                                // foreign upload lands
    await engine.runProject('p1', { userInitiated: true });          // head !== pendingRev
    expect(onConflict).toHaveBeenCalledOnce();
    expect((await adapter.getRecord('p1')).syncState).not.toBe('clean');
  });

  // T-12: kill mid-pending, relaunch → a FRESH engine over the persisted record must
  // re-verify and commit. Never stuck, never skipped (invariant 2).
  it('T-12: pending-verify survives a relaunch (fresh engine over the persisted record)', async () => {
    const log = [];
    const clock = { t: 1000 };
    const { cloud } = fakeBackend('google', log);
    const onConflict = vi.fn(async () => {});
    const mk = () => {
      const adapter = createIdbAdapter();
      const engine = createEngine({
        adapter, cloud, provider: 'google', owner: 'me@x.com',
        now: () => clock.t, sleep: () => Promise.resolve(), jitter: () => 0, confirmDelayMs: 60_000,
        handlers: { onConflict },
      });
      return { adapter, engine };
    };
    const s1 = mk();                                                        // session 1
    await s1.adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await s1.engine.runProject('p1', { cloudMeta: { exists: false }, userInitiated: true });
    expect((await s1.adapter.getRecord('p1')).syncState).toBe('pending-verify');

    closeDB();                                                              // "kill the tab"
    clock.t += 60_000;                                                      // relaunch ≥60s later
    const s2 = mk();                                                        // fresh engine + adapter, SAME IDB + cloud
    await s2.engine.sweepAll({ userInitiated: true });                      // launch sweep

    expect((await s2.adapter.getRecord('p1')).syncState).toBe('clean');     // re-verified + committed
    expect((await s2.adapter.getDirtySet()).has('p1')).toBe(false);         // out of the outbox
    expect(onConflict).not.toHaveBeenCalled();                             // no foreign write → not a conflict
  });

  // T-13b (the double-fork regression): two triggers fire at once on a collided
  // pending-verify project. Serialized sweeps must fork it EXACTLY once, not twice.
  it('T-13b: overlapping sweeps on a collided pending-verify project fork exactly once', async () => {
    const log = [];
    const clock = { t: 1000 };
    const { cloud, put } = fakeBackend('google', log);
    const adapter = createIdbAdapter();
    const forkHandler = createForkHandler({ adapter, provider: 'google', owner: 'me@x.com', deviceLabel: 'Chrome (Web)', now: () => clock.t });
    const engine = createEngine({
      adapter, cloud, provider: 'google', owner: 'me@x.com',
      now: () => clock.t, sleep: () => Promise.resolve(), jitter: () => 0, confirmDelayMs: 60_000,
      handlers: { onConflict: forkHandler },   // the REAL fork handler (adopts cloud, creates the sibling)
    });
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { cloudMeta: { exists: false }, userInitiated: true }); // pending-verify
    put('p1', xmlOf('p1', 'theirs'));                                                      // B's write moves the head

    await Promise.all([engine.sweepAll(), engine.sweepAll()]);                             // two near-simultaneous triggers

    const forks = (await adapter.getAllProjectEntries('me@x.com')).filter(e => e.data.title.includes('conflicted'));
    expect(forks).toHaveLength(1);                                                         // ← one fork, not two
    expect((await adapter.getProject('p1')).chapters[0].content).toBe('theirs');           // original adopted cloud
    expect((await adapter.getRecord('p1')).syncState).toBe('clean');
  });

  // Regression (live-diagnosed): binning a project WHILE it is mid-sync (Drive pending-verify) forked
  // it against its OWN unconfirmed push. The cloud rev had advanced because of our push and syncedHash
  // wasn't updated yet, so the trash table read T2 "edited elsewhere" and FORK_THEN_PULL — even though
  // local and cloud content were byte-identical. Result was a duplicate fork AND the project un-trashing
  // itself. The content-equality guard in FORK_THEN_PULL must honor the trash instead of forking.
  it('T-2 guard: binning mid-sync (pending-verify, cloud == local) honors the trash, does NOT fork', async () => {
    const log = [];
    const clock = { t: 1000 };
    const { cloud, store } = fakeBackend('google', log);
    const adapter = createIdbAdapter();
    const forkHandler = createForkHandler({ adapter, provider: 'google', owner: 'me@x.com', deviceLabel: 'Chrome (Web)', now: () => clock.t });
    const engine = createEngine({
      adapter, cloud, provider: 'google', owner: 'me@x.com',
      now: () => clock.t, sleep: () => Promise.resolve(), jitter: () => 0, confirmDelayMs: 60_000,
      handlers: { onConflict: forkHandler },
    });
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { cloudMeta: { exists: false }, userInitiated: true }); // → pending-verify; cloud now holds 'hello'
    expect((await adapter.getRecord('p1')).syncState).toBe('pending-verify');

    await engine.trashProject('p1');                                     // user bins it DURING the confirm window
    await engine.sweepAll({ userInitiated: true });

    const forks = (await adapter.getAllProjectEntries('me@x.com')).filter(e => e.data.conflictOf);
    expect(forks).toHaveLength(0);                                       // ← was forking against its own pending push
    expect(store.get('p1')?.trashed).toBe(true);                        // trash propagated to the cloud instead
  });

  // Same bug, second live case: local had moved PAST its own pending push (kept typing after the push,
  // before the 60s confirm) then binned. local !== cloud, so a plain equality check misses it — but the
  // cloud still holds exactly our pushed content (pendingHash), so it is ours, not a foreign edit.
  it('T-2 guard: binning mid-sync after typing past the pending push (local != cloud, cloud == pendingHash) does NOT fork', async () => {
    const log = [];
    const clock = { t: 1000 };
    const { cloud, store } = fakeBackend('google', log);
    const adapter = createIdbAdapter();
    const forkHandler = createForkHandler({ adapter, provider: 'google', owner: 'me@x.com', deviceLabel: 'Chrome (Web)', now: () => clock.t });
    const engine = createEngine({
      adapter, cloud, provider: 'google', owner: 'me@x.com',
      now: () => clock.t, sleep: () => Promise.resolve(), jitter: () => 0, confirmDelayMs: 60_000,
      handlers: { onConflict: forkHandler },
    });
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { cloudMeta: { exists: false }, userInitiated: true }); // → pending-verify; cloud holds 'hello'
    const rec = await adapter.getRecord('p1');
    expect(rec.syncState).toBe('pending-verify');
    expect(rec.pendingHash).toBe(await canonicalHash(proj('p1', 'hello')));

    await adapter.putProject(proj('p1', 'hello world'), 'me@x.com');     // kept typing past the push (local moves on)
    await engine.trashProject('p1');                                     // then bins it, still mid-confirm
    await engine.sweepAll({ userInitiated: true });

    const forks = (await adapter.getAllProjectEntries('me@x.com')).filter(e => e.data.conflictOf);
    expect(forks).toHaveLength(0);
    expect(store.get('p1')?.trashed).toBe(true);
  });
});

describe('engine — steady-state rows', () => {
  it('row 1: clean + cloud unchanged → NOOP (no network write)', async () => {
    const { adapter, engine, log } = setup('azure');
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { userInitiated: true });          // bootstrap → clean
    log.length = 0;
    await engine.runProject('p1', { userInitiated: true });
    expect(log.some(l => l.startsWith('save'))).toBe(false);
  });

  it('row 2: clean local, cloud moved → silent pull', async () => {
    const { adapter, engine, put } = setup('azure');
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { userInitiated: true });          // clean at "hello"
    put('p1', xmlOf('p1', 'remote'));                                // another device pushed
    await engine.runProject('p1', { userInitiated: true });
    expect((await adapter.getProject('p1')).chapters[0].content).toBe('remote');
    expect((await adapter.getRecord('p1')).syncedHash).toBe(await canonicalHash(proj('p1', 'remote')));
    expect([...(await adapter.getDirtySet())]).toEqual([]);
  });

  it('a pull signals the UI, so the winning device shows a pulled fork + its dot together', async () => {
    // A pull is how the device whose write won first receives the fork the other device made.
    // Landing it in IDB without a signal left the list and its conflict dots stale until a
    // manual sync — and refreshing off two triggers could show the row without the dot.
    const { adapter, engine, put, onBadge } = setup('azure');
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { userInitiated: true });
    put('p1', xmlOf('p1', 'remote'));
    onBadge.mockClear();
    await engine.runProject('p1', { userInitiated: true });          // → pull
    expect(onBadge).toHaveBeenCalledWith(expect.objectContaining({ type: 'pulled', projectId: 'p1' }));
  });

  it('row 3: dirty + cloud unchanged → push (OneDrive CAS)', async () => {
    const { adapter, engine, store } = setup('azure');
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { userInitiated: true });          // clean
    await adapter.putProject(proj('p1', 'hello world'), 'me@x.com'); // local edit
    await engine.runProject('p1', { userInitiated: true });
    const rec = await adapter.getRecord('p1');
    expect(rec.syncState).toBe('clean');
    expect(rec.syncedHash).toBe(await canonicalHash(proj('p1', 'hello world')));
    expect(store.get('p1').xml).toBe(xmlOf('p1', 'hello world'));
  });
});

describe('engine — OneDrive eTag drift does NOT fork (Paul’s refinement)', () => {
  it('412 from a metadata-only eTag drift → refresh eTag + retry, commit clean', async () => {
    const { adapter, engine, put, onConflict } = setup('azure');
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { userInitiated: true });          // clean (eTag e, cTag c)
    await adapter.putProject(proj('p1', 'hello world'), 'me@x.com'); // local dirty
    put('p1', xmlOf('p1', 'hello'), { metaOnly: true });             // foreign metadata touch: eTag++ cTag same
    await engine.runProject('p1', { userInitiated: true });
    expect(onConflict).not.toHaveBeenCalled();                       // drift is NOT a conflict
    expect((await adapter.getRecord('p1')).syncState).toBe('clean');
  });

  // T-14: the CAS LOSER. A commits between our decide and our If-Match save, so our PUT
  // 412s on a content change. That 412 must become row 4 (fork), never an error or a
  // blind retry, and must not clobber the winner.
  it('T-14: OneDrive CAS loser — a 412 from a real race (TOCTOU) → fork, not error/retry', async () => {
    const s = setup('azure', { t: 1000 });
    await s.adapter.putProject(proj('p1', 'base'), 'me@x.com');
    await s.engine.runProject('p1', { cloudMeta: { exists: false }, userInitiated: true }); // clean: eTag e1, cTag c1
    await s.adapter.putProject(proj('p1', 'B edit'), 'me@x.com');                            // B goes dirty
    s.setBeforeSave(() => s.put('p1', xmlOf('p1', 'A edit')));                               // A commits mid-save → e2, c2
    await s.engine.syncOne('p1', { userInitiated: true });
    expect(s.onConflict).toHaveBeenCalledTimes(1);            // 412 → row 4 (not thrown, not blind-retried)
    expect(s.store.get('p1').xml).toBe(xmlOf('p1', 'A edit')); // loser did NOT overwrite the winner's content
  });
});

describe('engine — conflict (row 4)', () => {
  it('dirty + cloud content moved → fork-first handler with both versions', async () => {
    const { adapter, engine, put, onConflict } = setup('azure');
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { userInitiated: true });          // clean
    await adapter.putProject(proj('p1', 'mine'), 'me@x.com');        // local dirty
    put('p1', xmlOf('p1', 'theirs'));                                // foreign content change
    await engine.runProject('p1', { userInitiated: true });
    expect(onConflict).toHaveBeenCalledOnce();
    const arg = onConflict.mock.calls[0][0];
    expect(arg.localProject.chapters[0].content).toBe('mine');
    expect(arg.cloudXml).toBe(xmlOf('p1', 'theirs'));
  });
});

describe('engine — §5.2 jitter ordering', () => {
  it('timer row-3 push jitters BEFORE its pre-check→upload; user push does not', async () => {
    const { adapter, engine, clock, cloud, log } = setup('google', { t: 1000 });
    await adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await engine.runProject('p1', { cloudMeta: { exists: false }, userInitiated: true }); // pending
    clock.t += 60_000;
    await engine.runProject('p1', { cloudMeta: await cloud.head('p1'), userInitiated: true }); // confirm → clean
    await adapter.putProject(proj('p1', 'hello2'), 'me@x.com');      // dirty again (row 3)

    // Mirror the sweep: cloudMeta comes from the batch list, so the ONLY head calls now
    // belong to the push (pre-check + verify).
    const meta = await cloud.head('p1');
    log.length = 0;
    await engine.runProject('p1', { cloudMeta: meta, userInitiated: false });   // TIMER push
    const iSleep = log.indexOf('sleep:111');
    const iHead  = log.findIndex(l => l.startsWith('head'));         // the pre-check
    const iSave  = log.findIndex(l => l.startsWith('save'));
    expect(iSleep).toBe(0);                                          // jitter FIRST, before anything
    expect(iSleep).toBeLessThan(iHead);                             // …before the pre-check
    expect(iHead).toBeLessThan(iSave);                             // …which precedes the upload

    // user-initiated bootstrap (same `if (!userInitiated)` gate) never jitters
    const b = setup('google');
    await b.adapter.putProject(proj('p2', 'hi'), 'me@x.com');
    await b.engine.runProject('p2', { cloudMeta: { exists: false }, userInitiated: true });
    expect(b.log.some(l => l.startsWith('sleep'))).toBe(false);
  });
});

describe('engine — §10 error handling', () => {
  it('CloudAuthError halts the provider and calls onReauth', async () => {
    const { engine, cloud, onReauth } = setup('azure');
    cloud.list = async () => { throw new CloudAuthError(); };
    const r = await engine.sweepAll();
    expect(r.halted).toBe(true);
    expect(onReauth).toHaveBeenCalledOnce();
    expect(engine.halted).toBe(true);
  });

  // The offline banner can't rely on navigator.onLine: it reports whether the machine has a
  // network interface, not whether the cloud answers. Drop Wi-Fi on a box with a VPN or a
  // virtual adapter up and it still says "online" and fires no event — the failure people
  // actually hit. A request that failed is the only proof, and the engine is what holds it.
  it('reports the cloud unreachable when requests fail, and reachable again when they work', async () => {
    const { engine, cloud, onNetwork } = setup('azure');
    const realList = cloud.list;

    cloud.list = async () => { throw new CloudTransientError(); };
    await engine.sweepAll();
    expect(onNetwork).toHaveBeenLastCalledWith(false);

    cloud.list = realList;                       // network comes back
    await engine.sweepAll();
    expect(onNetwork).toHaveBeenLastCalledWith(true);
  });

  it('says nothing about the network on a clean sweep from a healthy start', async () => {
    // Reporting the level (not just edges) is deliberate — reset() clears backoff silently —
    // so the listener dedupes. It must never flap the banner on ordinary successful sweeps.
    const { engine, onNetwork } = setup('azure');
    await engine.sweepAll();
    expect(onNetwork.mock.calls.every(([ok]) => ok === true)).toBe(true);   // never a false
  });

  it('CloudTransientError marks unreachable and does not halt (retry is App-driven)', async () => {
    const { engine, cloud, onNetwork } = setup('azure');
    cloud.list = async () => { throw new CloudTransientError(); };
    await engine.sweepAll();
    await engine.sweepAll();
    expect(onNetwork).toHaveBeenLastCalledWith(false);
    expect(engine.halted).toBe(false);
  });
});

describe('engine — trash & delete (§9, edit beats delete)', () => {
  // reach a clean, synced project, then explore each trash interleaving through sweep().
  async function seedClean(s, content = 'hello') {
    await s.adapter.putProject(proj('p1', content), 'me@x.com');
    await s.engine.runProject('p1', { cloudMeta: { exists: false }, userInitiated: true });
    if (s.provider === 'google') {                       // Drive: confirm out of pending-verify
      s.clock.t += 60_000;
      await s.engine.runProject('p1', { cloudMeta: await s.cloud.head('p1'), userInitiated: true });
    }
  }

  it('T1: local trashed, cloud unchanged → propagate trash to cloud', async () => {
    const s = setup('azure'); await seedClean(s);
    await s.adapter.putProject(proj('p1', 'hello'), 'me@x.com', { trashed: true });   // trashed locally
    await s.adapter.addDirty('p1');
    await s.engine.sweepAll({ userInitiated: true });
    expect(s.store.get('p1').trashed).toBe(true);
    expect([...(await s.adapter.getDirtySet())]).toEqual([]);
  });

  it('T3: local active & clean, cloud trashed → trash locally (silent)', async () => {
    const s = setup('azure'); await seedClean(s);
    await s.cloud.trash('p1');                            // another device trashed it
    await s.engine.sweepAll({ userInitiated: true });
    expect((await s.adapter.getProjectEntry('p1')).trashed).toBe(true);
  });

  it('T4: local active & DIRTY, cloud trashed → edit wins, push & un-trash', async () => {
    const s = setup('azure'); await seedClean(s);
    await s.adapter.putProject(proj('p1', 'hello world'), 'me@x.com');   // local edit (dirty)
    await s.cloud.trash('p1');                                            // cloud trashed meanwhile
    await s.engine.sweepAll({ userInitiated: true });
    expect(s.store.get('p1').trashed).toBe(false);                       // resurrected
    expect(s.store.get('p1').xml).toBe(xmlOf('p1', 'hello world'));      // with our content
    expect((await s.adapter.getRecord('p1')).syncState).toBe('clean');
  });

  it('T5: a bin item purged on another device is dropped locally, NOT resurrected on the cloud', async () => {
    // Was synced (so its record has a baseCloudRev), trashed locally, and the cloud copy has
    // since been permanently deleted elsewhere. Honor the delete — don't re-upload it.
    const s = setup('azure'); await seedClean(s);
    await s.adapter.putProject((await s.adapter.getProjectEntry('p1')).data, 'me@x.com', { trashed: true });
    await s.adapter.addDirty('p1');
    s.store.delete('p1');                                          // another device permanently deleted it
    await s.engine.sweepAll();
    expect(await s.adapter.getProjectEntry('p1')).toBeUndefined(); // gone locally — purge honored
    expect(s.store.has('p1')).toBe(false);                        // and NOT re-created on the cloud
    expect((await s.adapter.getDirtySet()).has('p1')).toBe(false);
  });

  it('a NEVER-synced bin item is still backed up to the cloud (no-loss for offline scratch)', async () => {
    // No record ⇒ never uploaded ⇒ create-as-.trash so it isn't lost. This is the case that
    // must NOT be purged, distinguishing it from T5 above.
    const s = setup('azure');
    await s.adapter.putProject(proj('p9', 'scratch'), 'me@x.com', { trashed: true });
    await s.adapter.addDirty('p9');
    await s.engine.sweepAll();
    expect(s.store.get('p9')?.trashed).toBe(true);                // backed up as .trash on the cloud
    expect(await s.adapter.getProjectEntry('p9')).toBeDefined();  // kept locally
  });

  it('§4: a cloud-only .trash (trashed elsewhere, never local here) is pulled into IDB as a trashed entry', async () => {
    const s = setup('azure');
    await s.cloud.trash('p2', xmlOf('p2', 'from other device'));   // create + trash a cloud file; no local entry here
    await s.engine.sweepAll({ userInitiated: true });
    const entry = await s.adapter.getProjectEntry('p2');
    expect(entry).toBeDefined();
    expect(entry.trashed).toBe(true);                             // mirrored into IDB as trashed
    expect(entry.data.chapters[0].content).toBe('from other device');
    expect(await s.adapter.getRecord('p2')).toBeTruthy();         // and given a sync record
    expect((await s.adapter.getDirtySet()).has('p2')).toBe(false);// reconciled, not left in the outbox
  });

  it('§4 restore is local-first + outbox-routed: flips trashed off, next sweep un-trashes the cloud (not re-trashed by T3)', async () => {
    const s = setup('azure'); await seedClean(s);
    await s.engine.trashProject('p1');
    await s.engine.sweepAll({ userInitiated: true });             // T1 → cloud .trash
    expect(s.store.get('p1').trashed).toBe(true);
    await s.engine.restoreProject('p1');                          // local-first: flip + arm outbox, NO cloud call
    expect((await s.adapter.getProjectEntry('p1')).trashed).toBe(false);   // active locally at once (works offline)
    expect((await s.adapter.getDirtySet()).has('p1')).toBe(true); // restore intent armed
    await s.engine.sweepAll({ userInitiated: true });             // outbox intent → PUSH_UNTRASH, NOT T3 re-trash
    expect(s.store.get('p1').trashed).toBe(false);               // cloud un-trashed
    expect((await s.adapter.getProjectEntry('p1')).trashed).toBe(false);   // still active locally
  });

  it('a clean project trashed on BOTH sides is evicted from the outbox (no 60s ghost)', async () => {
    // The observed bug: a resolved conflict-fork, binned, sat clean-and-trashed in the dirtySet
    // forever, so the 60s flush re-listed the cloud every minute. Both-sides-trashed is a
    // trash NOOP, which must still drop it from the outbox.
    const s = setup('azure'); await seedClean(s);
    await s.adapter.putProject((await s.adapter.getProjectEntry('p1')).data, 'me@x.com', { trashed: true });
    s.store.get('p1').trashed = true;                          // cloud .trash exists too
    await s.adapter.addDirty('p1');                            // stranded in the outbox
    expect((await s.adapter.getDirtySet()).has('p1')).toBe(true);
    expect((await s.adapter.getRecord('p1')).syncState).toBe('clean');   // clean, yet in the outbox
    await s.engine.sweepAll();
    expect((await s.adapter.getDirtySet()).has('p1')).toBe(false);       // evicted — no more ghost
  });

  it('T2 (clean trash): local trashed, cloud edited since → restore + pull', async () => {
    const s = setup('azure'); await seedClean(s);
    await s.adapter.putProject(proj('p1', 'hello'), 'me@x.com', { trashed: true });   // trashed, still clean
    s.put('p1', xmlOf('p1', 'remote'));                                                // edited elsewhere
    await s.engine.sweepAll({ userInitiated: true });
    const entry = await s.adapter.getProjectEntry('p1');
    expect(entry.trashed).toBe(false);                                                 // restored
    expect(entry.data.chapters[0].content).toBe('remote');                             // with the edit
  });

  it('T2 (edited-then-trashed): local trashed AND diverged, cloud edited → fork the trashed edit (inv. 9)', async () => {
    const s = setup('azure'); await seedClean(s);
    await s.adapter.putProject(proj('p1', 'my trashed edit'), 'me@x.com', { trashed: true }); // edited THEN trashed
    s.put('p1', xmlOf('p1', 'remote edit'));                                                   // and edited elsewhere
    await s.engine.sweepAll({ userInitiated: true });
    expect(s.onConflict).toHaveBeenCalledOnce();                                              // routed to fork-first
    const arg = s.onConflict.mock.calls[0][0];
    expect(arg.localProject.chapters[0].content).toBe('my trashed edit');
    expect(arg.cloudXml).toBe(xmlOf('p1', 'remote edit'));
  });

  it('T5: cloud file terminally gone (404) → keep local, drop to row 0a, re-upload (never discard)', async () => {
    const s = setup('azure'); await seedClean(s);
    s.store.delete('p1');                                  // terminal delete elsewhere — file just gone
    await s.engine.sweepAll({ userInitiated: true });
    // record dropped → row 0a, project stays in the outbox, local content intact
    expect(await s.adapter.getRecord('p1')).toBeNull();
    expect((await s.adapter.getDirtySet()).has('p1')).toBe(true);
    expect((await s.adapter.getProject('p1')).chapters[0].content).toBe('hello');
    expect(s.onGone).toHaveBeenCalledOnce();

    // and the very next sweep re-creates it in the cloud (row 0a bootstrap-create)
    await s.engine.sweepAll({ userInitiated: true });
    expect(s.store.has('p1')).toBe(true);
  });
});

// ── Phase 5a app-facing additions ──────────────────────────────────────────────
describe('engine — markDirty (replaces dirtyRef)', () => {
  async function reachClean() {
    const s = setup('azure');
    await s.adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await s.engine.runProject('p1', { cloudMeta: { exists: false }, userInitiated: true }); // clean
    return s;
  }
  it('arms the outbox and stamps dirtySince once', async () => {
    const s = await reachClean();
    await s.adapter.putProject(proj('p1', 'hello world'), 'me@x.com');   // local edit (not yet noted)
    await s.engine.markDirty('p1');
    const rec = await s.adapter.getRecord('p1');
    expect(rec.syncState).toBe('dirty');
    expect(rec.dirtySince).toBe(s.clock.t);
    expect((await s.adapter.getDirtySet()).has('p1')).toBe(true);
    // a later markDirty does not advance dirtySince
    s.clock.t += 5000;
    await s.engine.markDirty('p1');
    expect((await s.adapter.getRecord('p1')).dirtySince).toBe(rec.dirtySince);
  });
  it('editing back to the synced content: markDirty stays dirty, the SWEEP cleans it (no per-keystroke hash)', async () => {
    const s = await reachClean();
    await s.adapter.putProject(proj('p1', 'hello world'), 'me@x.com');
    await s.engine.markDirty('p1');
    await s.adapter.putProject(proj('p1', 'hello'), 'me@x.com');          // reverted to ancestor
    await s.engine.markDirty('p1');
    // markDirty no longer re-hashes → still flagged dirty + armed in the outbox
    expect((await s.adapter.getRecord('p1')).syncState).toBe('dirty');
    expect((await s.adapter.getDirtySet()).has('p1')).toBe(true);
    // the sweep re-hashes, sees local == synced (cloud unchanged) → NOOP → clean + off the outbox
    await s.engine.sweepAll({ userInitiated: true });
    expect((await s.adapter.getRecord('p1')).syncState).toBe('clean');
    expect((await s.adapter.getDirtySet()).has('p1')).toBe(false);
  });
  it('a project with no record (new) just enters the outbox', async () => {
    const s = setup('azure');
    await s.adapter.putProject(proj('p9', 'new'), 'me@x.com');
    await s.engine.markDirty('p9');
    expect((await s.adapter.getDirtySet()).has('p9')).toBe(true);
  });
});

describe('engine — open-project boots to home on remote change (§6)', () => {
  it('PULL of the open project fires onBoot; a closed project does not', async () => {
    const s = setup('azure');
    await s.adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await s.engine.runProject('p1', { cloudMeta: { exists: false }, userInitiated: true }); // clean
    s.put('p1', xmlOf('p1', 'remote'));                                                      // remote edit

    s.engine.setOpenProject(null);
    await s.engine.runProject('p1', { userInitiated: true });     // closed → silent
    expect(s.onBoot).not.toHaveBeenCalled();
  });
  it('fires onBoot when the pulled project is the open one', async () => {
    const s = setup('azure');
    await s.adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await s.engine.runProject('p1', { cloudMeta: { exists: false }, userInitiated: true });
    s.put('p1', xmlOf('p1', 'remote'));
    s.engine.setOpenProject('p1');
    await s.engine.runProject('p1', { userInitiated: true });     // open → boot
    expect(s.onBoot).toHaveBeenCalledWith('p1', expect.any(String));
  });
});

describe('engine — equal-hash-adopt guard', () => {
  it('a "conflict" where local already equals cloud adopts instead of forking', async () => {
    const s = setup('azure');
    await s.adapter.putProject(proj('p1', 'same'), 'me@x.com');
    await s.engine.runProject('p1', { cloudMeta: { exists: false }, userInitiated: true }); // clean at "same"
    // force a stale record so decide() would call conflict(), but content matches cloud
    const rec = await s.adapter.getRecord('p1');
    await s.adapter.putRecord({ ...rec, baseCloudRev: 'STALE', syncState: 'dirty', syncedHash: 'STALEHASH' });
    await s.adapter.addDirty('p1');
    await s.engine.runProject('p1', { userInitiated: true });     // dirty + cloudRevChanged → conflict path
    expect(s.onConflict).not.toHaveBeenCalled();                  // …but adopted, not forked
    expect((await s.adapter.getRecord('p1')).syncState).toBe('clean');
  });
});

describe('engine — invariant 3: empty outbox ⇒ zero network', () => {
  it('sweepDirty makes no cloud call when the dirtySet is empty', async () => {
    const s = setup('azure');
    const before = s.log.length;
    const r = await s.engine.sweepDirty();
    expect(r).toEqual({ ok: true, empty: true });
    expect(s.log.length).toBe(before);        // not even a list() call
  });
});

describe('engine — trashProject / restoreProject', () => {
  it('trashProject marks local trashed and arms the outbox', async () => {
    const s = setup('azure');
    await s.adapter.putProject(proj('p1', 'hello'), 'me@x.com');
    await s.engine.trashProject('p1');
    expect((await s.adapter.getProjectEntry('p1')).trashed).toBe(true);
    expect((await s.adapter.getDirtySet()).has('p1')).toBe(true);
  });
  it('restoreProject clears the trashed flag and arms the outbox', async () => {
    const s = setup('azure');
    await s.adapter.putProject(proj('p1', 'hello'), 'me@x.com', { trashed: true });
    await s.engine.restoreProject('p1');
    expect((await s.adapter.getProjectEntry('p1')).trashed).toBe(false);
    expect((await s.adapter.getDirtySet()).has('p1')).toBe(true);
  });
});

describe('engine — purge tombstones (§9 ext, no resurrection across devices)', () => {
  async function seedClean(s, id = 'p1', content = 'hello') {
    await s.adapter.putProject(proj(id, content), 'me@x.com');
    await s.engine.runProject(id, { cloudMeta: { exists: false }, userInitiated: true });
  }

  it('B holds the project ACTIVE + clean; A purges it → B drops it, never re-uploads (the bug)', async () => {
    const s = setup('azure'); await seedClean(s);
    s.purgeCloud('p1');                                  // another device permanently deleted it
    await s.engine.sweepAll();
    expect(await s.adapter.getProjectEntry('p1')).toBeUndefined();  // honored locally
    expect(s.store.has('p1')).toBe(false);                          // NOT resurrected on the cloud
    expect((await s.adapter.getDirtySet()).has('p1')).toBe(false);
  });

  it('B holds it with NO sync record (would bootstrap-create); tombstoned → dropped, not uploaded', async () => {
    const s = setup('azure');
    await s.adapter.putProject(proj('p1', 'hello'), 'me@x.com');    // local content, no record
    await s.adapter.addDirty('p1');
    s.purgeCloud('p1');                                             // tombstone exists for this id
    await s.engine.sweepAll();
    expect(await s.adapter.getProjectEntry('p1')).toBeUndefined();
    expect(s.store.has('p1')).toBe(false);                         // never re-created
  });

  it('B has genuine unsynced edits; tombstoned → words fork to a new "(recovered)" id, dead id stays dead', async () => {
    const s = setup('azure'); await seedClean(s);
    await s.adapter.putProject(proj('p1', 'my unsynced words'), 'me@x.com');  // local edit → dirty
    await s.adapter.addDirty('p1');
    s.purgeCloud('p1');
    await s.engine.sweepAll();

    expect(await s.adapter.getProjectEntry('p1')).toBeUndefined();  // dead id dropped locally
    expect(s.store.has('p1')).toBe(false);                         // dead id NOT resurrected on cloud
    const rec = s.onBadge.mock.calls.map(c => c[0]).find(b => b.type === 'recovered');
    expect(rec).toBeTruthy();
    const forked = await s.adapter.getProjectEntry(rec.forkId);
    expect(forked).toBeDefined();
    expect(forked.data.title).toMatch(/\(recovered\)/);
    expect(forked.data.chapters[0].content).toBe('my unsynced words');  // words preserved

    await s.engine.sweepAll();                                      // the fork uploads on its own (row 0a)
    expect(s.store.has(rec.forkId)).toBe(true);
  });

  it('offline purge queues, then completes on reconnect (file removed + tombstone written, exactly once)', async () => {
    const s = setup('azure'); await seedClean(s);
    const realRemove = s.cloud.remove;
    s.cloud.remove = () => Promise.reject(new CloudTransientError());   // offline
    await s.engine.purgeProject('p1');
    expect(await s.adapter.getProjectEntry('p1')).toBeUndefined();      // dropped locally immediately
    expect(s.store.has('p1')).toBe(true);                              // couldn't reach cloud yet
    expect(await s.adapter.getMeta('pendingPurges')).toEqual(['p1']);

    // A sweep during the offline window must NOT pull the lingering cloud file back in.
    await s.engine.sweepAll();
    expect(await s.adapter.getProjectEntry('p1')).toBeUndefined();
    expect(await s.adapter.getMeta('pendingPurges')).toEqual(['p1']);   // still queued

    s.cloud.remove = realRemove;                                        // reconnect
    await s.engine.sweepAll();
    expect(s.store.has('p1')).toBe(false);                             // cloud file removed
    expect(s.tombs.has('p1')).toBe(true);                             // tombstone written
    expect(await s.adapter.getMeta('pendingPurges')).toEqual([]);      // drained
  });
});

describe('engine — bulk purge (empty-bin) tombstones every id in one write', () => {
  async function seedClean(s, id) {
    await s.adapter.putProject(proj(id, 'x'), 'me@x.com');
    await s.engine.runProject(id, { cloudMeta: { exists: false }, userInitiated: true });
  }

  it('purgeProjects tombstones ALL ids (no manifest race) and drops them locally', async () => {
    const s = setup('azure');
    for (const id of ['a', 'b', 'c']) await seedClean(s, id);
    await s.engine.purgeProjects(['a', 'b', 'c']);
    expect(s.tombs.has('a') && s.tombs.has('b') && s.tombs.has('c')).toBe(true);   // the "not 49 ids" bug: all present
    for (const id of ['a', 'b', 'c']) {
      expect(await s.adapter.getProjectEntry(id)).toBeUndefined();
      expect(s.store.has(id)).toBe(false);
    }
  });

  it('offline bulk purge queues every id, then drains + tombstones all on reconnect', async () => {
    const s = setup('azure');
    for (const id of ['a', 'b']) await seedClean(s, id);
    const real = s.cloud.removeMany;
    s.cloud.removeMany = () => Promise.reject(new CloudTransientError());
    await s.engine.purgeProjects(['a', 'b']);
    expect(await s.adapter.getMeta('pendingPurges')).toEqual(['a', 'b']);
    expect(s.store.has('a') && s.store.has('b')).toBe(true);         // not removed yet (offline)
    s.cloud.removeMany = real;                                       // reconnect
    await s.engine.sweepAll();
    expect(s.tombs.has('a') && s.tombs.has('b')).toBe(true);
    expect(await s.adapter.getMeta('pendingPurges')).toEqual([]);
  });
});
