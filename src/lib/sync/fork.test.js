// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createForkHandler, forkTitle, sanitizeTitle } from './fork.js';
import { createIdbAdapter, newSyncRecord, commitClean, closeDB, __test } from './store.js';
import { serializeOodbo, canonicalHash, hashXml } from './canonical.js';

beforeEach(async () => {
  closeDB();
  await new Promise((res) => {
    const del = indexedDB.deleteDatabase(__test.DB_NAME);
    del.onsuccess = del.onerror = del.onblocked = () => res();
  });
});

const proj = (id, content, title = 'My Story') => ({
  id, title, activeChapterId: 'c1',
  chapters: [{ id: 'c1', level: 1, title: 'c', content, annotations: [] }],
});

describe('name helpers', () => {
  it('sanitizes filesystem-illegal characters', () => {
    expect(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(sanitizeTitle('   ')).toBe('Untitled');
  });

  it('forkTitle embeds device + date and adds a suffix only on collision', () => {
    const t0 = 1_700_000_000_000; // fixed date
    const base = forkTitle('My Story', 'Chrome (Web)', t0, []);
    expect(base).toMatch(/^My Story \(conflicted — Chrome \(Web\), \d{4}-\d{2}-\d{2}\)$/);
    // same-day double conflict → numeric suffix, never a collision
    const second = forkTitle('My Story', 'Chrome (Web)', t0, [base]);
    expect(second).toBe(`${base} (2)`);
    const third = forkTitle('My Story', 'Chrome (Web)', t0, [base, `${base} (2)`]);
    expect(third).toBe(`${base} (3)`);
  });
});

describe('fork-first handler (§8)', () => {
  async function run(provider) {
    const adapter = createIdbAdapter();
    const onBadge = vi.fn();
    const handler = createForkHandler({ adapter, provider, owner: 'me@x.com', deviceLabel: 'Chrome (Web)', now: () => 1_700_000_000_000, onBadge });

    // original project: local diverged to "mine", record's ancestor was "base"
    await adapter.putProject(proj('p1', 'mine'), 'me@x.com', { pendingSync: true });
    await adapter.addDirty('p1');
    const record = commitClean(newSyncRecord('p1', provider), {
      baseCloudRev: 'oldRev', baseCasRev: provider === 'azure' ? 'oldE' : null, syncedHash: await canonicalHash(proj('p1', 'base')),
    });
    await adapter.putRecord(record);

    const cloudXml  = serializeOodbo(proj('p1', 'theirs'));
    const cloudMeta = provider === 'azure' ? { rev: 'newE', cTag: 'newC' } : { rev: 'newHead' };
    const out = await handler({ projectId: 'p1', localProject: proj('p1', 'mine'), cloudXml, cloudMeta, record });
    return { adapter, out, onBadge, provider, cloudXml };
  }

  it('preserves BOTH versions: local becomes a fork, cloud becomes canonical for the original', async () => {
    const { adapter, out } = await run('google');

    // original id now holds the CLOUD content, clean, at the cloud rev
    expect((await adapter.getProject('p1')).chapters[0].content).toBe('theirs');
    const rec = await adapter.getRecord('p1');
    expect(rec.syncState).toBe('clean');
    expect(rec.baseCloudRev).toBe('newHead');
    expect(rec.syncedHash).toBe(await canonicalHash(proj('p1', 'theirs')));

    // the fork holds the LOCAL divergent content, under a new id, conflicted title
    const fork = await adapter.getProject(out.forkId);
    expect(fork.chapters[0].content).toBe('mine');
    expect(fork.title).toMatch(/conflicted — Chrome \(Web\)/);
  });

  it('the fork is never stranded: it is in the dirtySet, the original is not (invariants 7 & 1)', async () => {
    const { adapter, out } = await run('google');
    const dirty = await adapter.getDirtySet();
    expect(dirty.has(out.forkId)).toBe(true);
    expect(dirty.has('p1')).toBe(false);
  });

  it('OneDrive: original record adopts cTag as baseCloudRev and eTag as baseCasRev', async () => {
    const { adapter } = await run('azure');
    const rec = await adapter.getRecord('p1');
    expect(rec.baseCloudRev).toBe('newC');   // detection = cTag
    expect(rec.baseCasRev).toBe('newE');     // CAS = eTag
  });

  it('emits a non-blocking forked badge', async () => {
    const { onBadge, out } = await run('google');
    expect(onBadge).toHaveBeenCalledWith(expect.objectContaining({ type: 'forked', projectId: 'p1', forkId: out.forkId }));
  });

  // The forking device is the only one that knows a conflict happened. The other device — the
  // one whose write won — just receives a new project, and would show no badge at all unless
  // the pairing travels with the file.
  it('records what it is a fork OF, in the file, so the other device can see the pair too', async () => {
    const { adapter, out } = await run('google');
    const fork = await adapter.getProject(out.forkId);
    expect(fork.conflictOf).toBe('p1');
    // It reaches the cloud, rather than sitting in device-local metadata.
    expect(serializeOodbo(fork)).toContain('conflictOf="p1"');
    // ...and only the fork is marked; the original is a normal project.
    expect(await adapter.getProject('p1')).not.toHaveProperty('conflictOf');
  });
});