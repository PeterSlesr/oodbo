import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the provider-token source so createDesktopCloud() gets a stable google/azure identity.
// (Unplugged: desktopCloud now sources its token from desktopOAuth.getValidProviderToken.)
let CURRENT_PROVIDER = 'google';
vi.mock('./desktopOAuth.js', () => ({
  getValidProviderToken: async () => ({ provider: CURRENT_PROVIDER, accessToken: 'tok' }),
}));

// OneDrive file content is fetched in Rust via invoke('azure_graph_get') to bypass the WebView CSP
// (see desktopCloud.js azureContentGet). Tests point `azureGraphGet` at their in-memory store.
let azureGraphGet = async () => JSON.stringify({ ids: [] });
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd, args) => {
    if (cmd === 'azure_graph_get') return azureGraphGet(args.url, args.token);
    throw new Error('unmocked invoke: ' + cmd);
  },
}));

import { createDesktopCloud } from './desktopCloud.js';

// ── A tiny in-memory Google Drive appDataFolder, enough to exercise the tombstone manifest RMW ──
function driveMock() {
  const state = { manifest: null };   // { id, rev, ids } | null
  let writes = 0;
  const bump = () => 'rev' + Math.random().toString(36).slice(2, 8);
  const res = (status, bodyObj) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => bodyObj, text: async () => JSON.stringify(bodyObj),
  });

  global.fetch = vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET';
    // find by name
    if (url.includes('/drive/v3/files?') && url.includes('q=name')) {
      const isManifest = url.includes("name%3D'tombstones.json'");
      if (isManifest && state.manifest) return res(200, { files: [{ id: state.manifest.id, headRevisionId: state.manifest.rev, modifiedTime: '2020' }] });
      return res(200, { files: [] });                                    // manifest absent OR a project file (none in this mock)
    }
    // download content
    if (url.includes('/drive/v3/files/') && url.includes('alt=media')) {
      return res(200, { ids: state.manifest?.ids || [] });
    }
    // update existing (PATCH upload)
    if (url.includes('/upload/drive/v3/files/') && method === 'PATCH') {
      writes++; state.manifest.ids = JSON.parse(opts.body).ids; state.manifest.rev = bump();
      return res(200, { id: state.manifest.id, headRevisionId: state.manifest.rev });
    }
    // create new (multipart POST)
    if (url.includes('/upload/drive/v3/files?') && method === 'POST') {
      writes++;
      const ids = JSON.parse(opts.body.split('\r\n').filter(l => l.startsWith('{"ids"'))[0]).ids;
      state.manifest = { id: 'mid', rev: bump(), ids };
      return res(200, { id: 'mid' });
    }
    // project-file DELETE (nothing to delete in this mock)
    if (method === 'DELETE') return res(404, {});
    return res(200, {});
  });
  return { state, get writes() { return writes; } };
}

describe('desktopCloud tombstones (§9 ext) — google', () => {
  beforeEach(() => { CURRENT_PROVIDER = 'google'; });

  it('remove() appends the id to the shared manifest', async () => {
    driveMock();
    const cloud = createDesktopCloud();
    await cloud.remove('p1');
    const t = await cloud.readTombstones(null);
    expect(t.ids).toEqual(['p1']);
    expect(t.rev).toBeTruthy();
  });

  it('removeMany() writes ALL ids in a single manifest write (no per-id fan-out)', async () => {
    const m = driveMock();
    const cloud = createDesktopCloud();
    await cloud.removeMany(['a', 'b', 'c']);
    expect((await cloud.readTombstones(null)).ids.sort()).toEqual(['a', 'b', 'c']);
    expect(m.writes).toBe(1);                                            // one RMW for the whole batch
  });

  it('appends are idempotent and cumulative', async () => {
    driveMock();
    const cloud = createDesktopCloud();
    await cloud.remove('p1');
    await cloud.remove('p1');                                           // already present → no-op write
    await cloud.remove('p2');
    expect((await cloud.readTombstones(null)).ids.sort()).toEqual(['p1', 'p2']);
  });

  it('readTombstones is rev-gated: same rev → unchanged, no id download', async () => {
    driveMock();
    const cloud = createDesktopCloud();
    await cloud.remove('p1');
    const first = await cloud.readTombstones(null);
    const again = await cloud.readTombstones(first.rev);
    expect(again.unchanged).toBe(true);
    expect(again.ids).toBeUndefined();
  });
});

describe('desktopCloud tombstones (§9 ext) — azure (OneDrive)', () => {
  beforeEach(() => { CURRENT_PROVIDER = 'azure'; });

  it('remove() creates + appends via approot content, honored on readback', async () => {
    // Minimal OneDrive mock: approot:/tombstones.json meta + content, with an eTag.
    const store = { exists: false, ids: [], eTag: 'e0' };
    azureGraphGet = async () => JSON.stringify({ ids: store.ids });   // content read now goes through invoke (Rust)
    const res = (status, bodyObj) => ({ ok: status >= 200 && status < 300, status, json: async () => bodyObj, text: async () => JSON.stringify(bodyObj) });
    global.fetch = vi.fn(async (url, opts = {}) => {
      const method = opts.method || 'GET';
      if (url.includes('approot:/tombstones.json?$select')) return store.exists ? res(200, { id: 'm', eTag: store.eTag }) : res(404, {});
      if (url.includes('approot:/tombstones.json:/content') && method === 'GET') return res(200, { ids: store.ids });
      if (url.includes('approot:/tombstones.json:/content') && method === 'PUT') {
        store.exists = true; store.ids = JSON.parse(opts.body).ids; store.eTag = 'e' + store.ids.length;
        return res(200, { id: 'm', eTag: store.eTag });
      }
      if (method === 'DELETE') return res(404, {});
      return res(200, {});
    });
    const cloud = createDesktopCloud();
    await cloud.remove('x1');
    expect((await cloud.readTombstones(null)).ids).toEqual(['x1']);
  });
});
