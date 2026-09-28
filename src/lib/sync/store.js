// ── Local durability layer for the sync engine (web / IndexedDB) ────────────────
//
// This is platform SEAM #1 (spec §14): the storage adapter that reads/writes content
// and the per-project sync record. Web keeps both in IndexedDB; desktop will inject an
// appdata-sidecar adapter with the SAME interface, so the engine, decision table, and
// fork/trash logic never learn which platform they run on.
//
// The engine depends on the interface returned by createIdbAdapter(), never on IDB
// directly. Keep every raw indexedDB call inside this file.
//
// DB: `oodbo-handles` (the app's existing DB), bumped to v4. New stores:
//   syncRecords (keyPath 'projectId')  — the §3.1 record, one per project
//   syncMeta    (keyPath 'key')        — scalars: the persisted dirtySet outbox
// Existing stores (handles, wordAssets, projects) are preserved untouched; this file is
// the single opener that Phase 5 wires the whole app onto.

const DB_NAME    = 'oodbo-handles';
const DB_VERSION = 4;

export const DIRTY_BADGE_MS = 24 * 60 * 60 * 1000; // §10 / DECISION 5: 24h stuck-dirty

// ── Sync record (spec §3.1, adapted to this codebase) ───────────────────────────
// provider uses the app's existing identifiers ('google' | 'azure'), not the spec's
// gdrive/onedrive labels — purely cosmetic.
//
// Two revs, because the OneDrive eTag drifts on metadata-only changes (spike 2026-07-14)
// while cTag is content-stable:
//   baseCloudRev — the CHANGE-DETECTION baseline. Drive: headRevisionId. OneDrive: cTag.
//                  The decision table compares "cloud rev now vs baseCloudRev" on THIS.
//   baseCasRev   — the If-Match CAS token. OneDrive: eTag. Drive: null (no conditional
//                  write; the engine closes that race via pending-verify instead).
export function newSyncRecord(projectId, provider) {
  return {
    projectId,
    provider,
    cloudFileId:  null,
    baseCloudRev: null,   // detection baseline (Drive headRevisionId | OneDrive cTag)
    baseCasRev:   null,   // OneDrive eTag for If-Match; null for Drive
    syncedHash:   null,   // canonical hash of the confirmed common ancestor
    syncState:    'dirty',// no ancestor yet ⇒ needs a push/bootstrap
    pendingRev:   null,   // Drive: rev of an unconfirmed upload (pending-verify)
    pendingHash:  null,   // Drive: canonical hash of the content we uploaded (the ancestor-
                          //   to-be). Frozen at upload so a confirm ≥60s later commits the
                          //   PUSHED content's hash, not whatever local looks like by then.
    pendingSince: null,   // timestamp entering pending-verify
    dirtySince:   null,   // display-only: oldest unsynced edit (§10). set-once, see stampDirty
  };
}

// Mark a record dirty. dirtySince is set ONCE on the clean→dirty transition and never
// advanced by later edits — otherwise a continuously-edited project would never cross the
// 24h badge threshold and the badge would lie (Paul's refinement). Pure; caller persists.
export function stampDirty(record, now = Date.now()) {
  return {
    ...record,
    syncState:  record.syncState === 'pending-verify' ? 'pending-verify' : 'dirty',
    dirtySince: record.dirtySince ?? now,
  };
}

// Commit a record to clean after a *confirmed* sync (spec §5.2). Clears the outbox-facing
// fields; syncedHash and the revs now describe the same moment (invariant 2). Pure.
export function commitClean(record, { baseCloudRev, baseCasRev = null, syncedHash, cloudFileId = record.cloudFileId }) {
  return {
    ...record,
    cloudFileId,
    baseCloudRev,
    baseCasRev,
    syncedHash,
    syncState:    'clean',
    pendingRev:   null,
    pendingHash:  null,
    pendingSince: null,
    dirtySince:   null,
  };
}

// Is this project overdue for a backup badge? Measured from the oldest unsynced edit,
// not failed-attempt count (a laptop closed all day has zero failures but is still stale).
export function isStuckDirty(record, now = Date.now()) {
  return record?.dirtySince != null && (now - record.dirtySince) >= DIRTY_BADGE_MS;
}

// ── IndexedDB plumbing ──────────────────────────────────────────────────────────
// One cached connection per process — reopening per operation leaks connections that
// block deleteDatabase and waste handles. onversionchange lets an external upgrade/delete
// proceed by dropping our handle rather than blocking it.
let _dbPromise = null;
export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Idempotent: create any store that isn't there yet, whether upgrading from v1-3
      // or creating the DB fresh (tests). Mirrors the app's existing stores + the two new.
      if (!db.objectStoreNames.contains('handles'))     db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('wordAssets'))  db.createObjectStore('wordAssets');
      if (!db.objectStoreNames.contains('projects'))    db.createObjectStore('projects',    { keyPath: 'id' });
      if (!db.objectStoreNames.contains('syncRecords')) db.createObjectStore('syncRecords', { keyPath: 'projectId' });
      if (!db.objectStoreNames.contains('syncMeta'))    db.createObjectStore('syncMeta',    { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); _dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}

// Close the cached connection (test teardown; also usable on sign-out).
export function closeDB() {
  const p = _dbPromise;
  _dbPromise = null;
  if (p) p.then(db => db.close()).catch(() => {});
}

// Clear ALL per-account sync state (content, records, and the dirtySet/meta). Called on
// sign-out and when the signed-in account changes, so one account's local data can never
// leak into another's session on a shared browser. The cloud is the source of truth, so
// nothing is lost — the next sign-in re-pulls. Leaves the legacy 'handles'/'wordAssets'
// stores alone (not account content).
export async function wipeLocalData() {
  const db = await openDB();
  await new Promise((res, rej) => {
    const tx = db.transaction(['projects', 'syncRecords', 'syncMeta'], 'readwrite');
    tx.objectStore('projects').clear();
    tx.objectStore('syncRecords').clear();
    tx.objectStore('syncMeta').clear();
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
    tx.onabort    = () => rej(tx.error);
  });
}

const reqToPromise = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone       = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

// Existing 'projects' entry shape, preserved so this is a drop-in for the app's current
// content store. pendingSync/lastSynced are legacy display-only fields (§12.3) — the new
// engine derives dirtiness from the hash, not from these.
function projectEntry(project, owner, { trashed = false, pendingSync = false, lastSynced = null, deletedAt = null } = {}) {
  return { id: project.id, owner: owner || '', data: project, trashed, pendingSync, lastSynced, deletedAt };
}

// ── The adapter (SEAM #1 web implementation) ────────────────────────────────────
export function createIdbAdapter() {
  const withDB = async fn => fn(await openDB());

  return {
    // ---- content (projects store) ----
    async getProjectEntry(projectId) {
      return withDB(db => reqToPromise(db.transaction('projects', 'readonly').objectStore('projects').get(projectId)));
    },
    async getProject(projectId) {
      const e = await this.getProjectEntry(projectId);
      return e?.data ?? null;
    },
    async getAllProjectEntries(owner) {
      const all = await withDB(db => reqToPromise(db.transaction('projects', 'readonly').objectStore('projects').getAll()));
      return owner == null ? all : all.filter(e => (e.owner || '') === owner);
    },
    async putProject(project, owner, opts) {
      return withDB(async db => {
        const tx = db.transaction('projects', 'readwrite');
        tx.objectStore('projects').put(projectEntry(project, owner, opts));
        return txDone(tx);
      });
    },

    // ---- sync records (syncRecords store) ----
    async getRecord(projectId) {
      const rec = await withDB(db => reqToPromise(db.transaction('syncRecords', 'readonly').objectStore('syncRecords').get(projectId)));
      return rec ?? null;
    },
    async getAllRecords() {
      return withDB(db => reqToPromise(db.transaction('syncRecords', 'readonly').objectStore('syncRecords').getAll()));
    },
    async putRecord(record) {
      return withDB(async db => {
        const tx = db.transaction('syncRecords', 'readwrite');
        tx.objectStore('syncRecords').put(record);
        return txDone(tx);
      });
    },
    async deleteRecord(projectId) {
      return withDB(async db => {
        const tx = db.transaction('syncRecords', 'readwrite');
        tx.objectStore('syncRecords').delete(projectId);
        return txDone(tx);
      });
    },

    // ---- ATOMIC content + record (spec §11) ----
    // A pull or a commit-to-clean must land content and its sync record together, or a
    // crash between them could make fast-forward look like a conflict. One transaction
    // spanning both stores guarantees all-or-nothing.
    async commitProjectAndRecord(project, owner, record, opts) {
      return withDB(async db => {
        const tx = db.transaction(['projects', 'syncRecords'], 'readwrite');
        tx.objectStore('projects').put(projectEntry(project, owner, opts));
        tx.objectStore('syncRecords').put(record);
        return txDone(tx);
      });
    },
    async deleteProjectAndRecord(projectId) {
      return withDB(async db => {
        const tx = db.transaction(['projects', 'syncRecords'], 'readwrite');
        tx.objectStore('projects').delete(projectId);
        tx.objectStore('syncRecords').delete(projectId);
        return txDone(tx);
      });
    },

    // ---- dirtySet outbox (syncMeta store) ----
    async getDirtySet() {
      const row = await withDB(db => reqToPromise(db.transaction('syncMeta', 'readonly').objectStore('syncMeta').get('dirtySet')));
      return new Set(row?.ids ?? []);
    },
    async setDirtySet(set) {
      return withDB(async db => {
        const tx = db.transaction('syncMeta', 'readwrite');
        tx.objectStore('syncMeta').put({ key: 'dirtySet', ids: [...set] });
        return txDone(tx);
      });
    },
    async addDirty(projectId) {
      const set = await this.getDirtySet();
      if (!set.has(projectId)) { set.add(projectId); await this.setDirtySet(set); }
      return set;
    },
    async removeDirty(projectId) {
      const set = await this.getDirtySet();
      if (set.has(projectId)) { set.delete(projectId); await this.setDirtySet(set); }
      return set;
    },

    // ---- scalar metadata (syncMeta store): migration flag, conflict pairs, etc. ----
    async getMeta(key) {
      const row = await withDB(db => reqToPromise(db.transaction('syncMeta', 'readonly').objectStore('syncMeta').get(key)));
      return row?.value;
    },
    async setMeta(key, value) {
      return withDB(async db => {
        const tx = db.transaction('syncMeta', 'readwrite');
        tx.objectStore('syncMeta').put({ key, value });
        return txDone(tx);
      });
    },
  };
}

// Test-only surface.
export const __test = { openDB, DB_NAME, DB_VERSION };
export { closeDB as __closeDB };
