import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { closeDB, __test } from './sync/store.js';
import { createSidecarAdapter } from './sidecarAdapter.js';

// Mock the appdata I/O so we can assert what gets mirrored without a Tauri fs.
const fs = vi.hoisted(() => ({
  saveProjectXmlToAppData: vi.fn(async () => {}),
  writeAppDataSidecar:     vi.fn(async () => {}),
  deleteAppDataProject:    vi.fn(async () => {}),
}));
vi.mock('./desktopSave.js', () => fs);

const proj = (id, content) => ({ id, title: 'T', activeChapterId: 'c1', chapters: [{ id: 'c1', level: 1, title: 'c', content, annotations: [] }] });
const rec  = (id) => ({ projectId: id, provider: 'google', baseCloudRev: 'r1', syncedHash: 'h1', syncState: 'clean' });

beforeEach(async () => {
  closeDB();
  await new Promise((res) => { const d = indexedDB.deleteDatabase(__test.DB_NAME); d.onsuccess = d.onerror = d.onblocked = () => res(); });
  fs.saveProjectXmlToAppData.mockClear(); fs.writeAppDataSidecar.mockClear(); fs.deleteAppDataProject.mockClear();
});

describe('sidecar adapter — IDB cache + authoritative appdata mirror (§3.2)', () => {
  it('putProject writes IDB AND mirrors content + sidecar (with entry flags)', async () => {
    const a = createSidecarAdapter('me@x.com');
    await a.putProject(proj('p1', 'hi'), 'me@x.com', { trashed: false });
    expect((await a.getProject('p1')).chapters[0].content).toBe('hi');            // IDB cache has it
    expect(fs.saveProjectXmlToAppData).toHaveBeenCalledWith('me@x.com', 'p1', expect.stringContaining('hi'));
    expect(fs.writeAppDataSidecar).toHaveBeenCalledWith('me@x.com', 'p1', expect.objectContaining({ trashed: false }));
  });

  it('putRecord mirrors the record into the sidecar', async () => {
    const a = createSidecarAdapter('me@x.com');
    await a.putProject(proj('p1', 'hi'), 'me@x.com');
    fs.writeAppDataSidecar.mockClear();
    await a.putRecord(rec('p1'));
    expect(await a.getRecord('p1')).toMatchObject({ projectId: 'p1', syncState: 'clean' });
    expect(fs.writeAppDataSidecar).toHaveBeenCalledWith('me@x.com', 'p1',
      expect.objectContaining({ record: expect.objectContaining({ syncState: 'clean' }) }));
  });

  it('trashed flag rides into the sidecar', async () => {
    const a = createSidecarAdapter('me@x.com');
    await a.putProject(proj('p1', 'hi'), 'me@x.com', { trashed: true, deletedAt: '2026-01-01T00:00:00Z' });
    expect(fs.writeAppDataSidecar).toHaveBeenLastCalledWith('me@x.com', 'p1',
      expect.objectContaining({ trashed: true, deletedAt: '2026-01-01T00:00:00Z' }));
  });

  it('deleteProjectAndRecord removes IDB + the on-disk copies', async () => {
    const a = createSidecarAdapter('me@x.com');
    await a.commitProjectAndRecord(proj('p1', 'hi'), 'me@x.com', rec('p1'), {});
    await a.deleteProjectAndRecord('p1');
    expect(await a.getProjectEntry('p1')).toBeUndefined();
    expect(fs.deleteAppDataProject).toHaveBeenCalledWith('me@x.com', 'p1');
  });

  it('reads + dirtySet come straight from the IDB cache (spread interface intact)', async () => {
    const a = createSidecarAdapter('me@x.com');
    await a.addDirty('p1');
    expect([...(await a.getDirtySet())]).toEqual(['p1']);
    await a.removeDirty('p1');
    expect((await a.getDirtySet()).size).toBe(0);
  });
});
