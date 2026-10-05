// ── Desktop startup reconciliation: appdata is authoritative, IDB is a cache (§11, seam #2) ──
//
// Runs ONCE at launch on desktop. Two entry points:
//   • reconcileDesktop  — ENGINE tier (cloud/Google): rebuild IDB entries AND sync records from the
//     authoritative appdata .oodbo + .syncrecord sidecars, so the next sweep resolves a cloud change
//     as a FAST-FORWARD (row 2), not a phantom conflict (INVARIANT 6). Never destroys a version.
//   • recoverAppDataToIdb — NON-ENGINE tier (local accounts): rebuild IDB from the durable .oodbo
//     files for anything IDB lacks. Writes entries ENCODED (localVault) so a PIN account's cache
//     stays encrypted, and reads the sidecar's trashed/deletedAt so the bin survives an IDB wipe.
//
// Reads appdata, so it lives here and is invoked only on the IS_TAURI path.

import { openDB, stampDirty } from './sync/store.js';
import { parseOodbo, hashXml, canonicalHash } from './sync/canonical.js';
import { forkTitle } from './sync/fork.js';
import { encodeEntry } from './localVault.js';
import { listAppDataProjectIds, readAppDataProjectXml, readAppDataSidecar } from './desktopSave.js';

function genId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// ── Non-engine tier recovery (local accounts): appdata .oodbo → IDB, for anything IDB doesn't have ──
const getEntry = (db, id) => new Promise(res => {
  const r = db.transaction('projects', 'readonly').objectStore('projects').get(id);
  r.onsuccess = () => res(r.result || null);
  r.onerror   = () => res(null);
});
const putEntry = (db, entry) => new Promise((res, rej) => {
  const tx = db.transaction('projects', 'readwrite');
  tx.objectStore('projects').put(entry);
  tx.oncomplete = res; tx.onerror = rej;
});

export async function recoverAppDataToIdb(owner) {
  // No IS_TAURI guard: callers gate on it (App only invokes this on desktop); keeping it ungated
  // lets the unit tests exercise it in node. A non-desktop call just finds no appdata files → no-op.
  const stats = { recovered: 0 };
  if (!owner) return stats;
  let ids = [];
  try { ids = await listAppDataProjectIds(owner); } catch { return stats; }
  let db;
  try { db = await openDB(); } catch { return stats; }
  for (const id of ids) {
    try {
      if (await getEntry(db, id)) continue;                 // IDB already has it
      const xml = await readAppDataProjectXml(owner, id);   // decrypts for a vault account
      if (xml == null) continue;                            // unreadable/locked/corrupt → skip
      let project; try { project = parseOodbo(xml); } catch { continue; }
      const sidecar = await readAppDataSidecar(owner, id);  // may be null (a never-synced local project)
      const entry = await encodeEntry({
        id, owner, pendingSync: true, lastSynced: null,
        trashed: !!sidecar?.trashed, deletedAt: sidecar?.deletedAt ?? null,
        data: project,
      });
      await putEntry(db, entry);
      stats.recovered++;
    } catch { /* one bad file can't abort the rest */ }
  }
  return stats;
}

// ── Engine tier (cloud): full reconcile via the sidecar adapter, preserving records + conflicts. ──
export async function reconcileDesktop({ adapter, owner, provider, deviceLabel = 'Desktop' }) {
  const stats = { recovered: 0, recordRestored: 0, diskWins: 0, idbWins: 0, forked: 0, mirrored: 0 };
  if (!adapter || !owner) return stats;

  let diskIds = [];
  try { diskIds = await listAppDataProjectIds(owner); } catch { return stats; }

  const idbEntries = await adapter.getAllProjectEntries(owner);
  const seen = new Set();

  // ── Pass 1: every project that has an authoritative on-disk copy ──
  for (const id of diskIds) {
    seen.add(id);
    const xml = await readAppDataProjectXml(owner, id);
    if (xml == null) continue;                       // unreadable → leave IDB as-is
    let diskHash;
    try { diskHash = await hashXml(xml); } catch { continue; }   // corrupt XML → skip, never clobber IDB

    const sidecar   = await readAppDataSidecar(owner, id);       // { record, trashed, deletedAt } | null
    const record    = sidecar?.record || null;
    const trashed   = !!sidecar?.trashed;
    const deletedAt = sidecar?.deletedAt ?? null;
    const entry     = await adapter.getProjectEntry(id);

    // ── IDB-wipe recovery (INVARIANT 6): rebuild the entry (+ record) from disk ──
    if (!entry) {
      const project = parseOodbo(xml);
      if (record) {
        const unpushed = diskHash !== record.syncedHash;         // edited after last sync, before wipe
        const rec = unpushed ? stampDirty(record) : record;
        await adapter.commitProjectAndRecord(project, owner, rec, { trashed, deletedAt, pendingSync: unpushed });
        if (unpushed) await adapter.addDirty(id);
      } else {
        await adapter.putProject(project, owner, { trashed, deletedAt, pendingSync: true });
        await adapter.addDirty(id);
      }
      stats.recovered++;
      continue;
    }

    // ── Entry present in both. Restore a lost record from the sidecar (record store wiped alone). ──
    let idbRec = await adapter.getRecord(id);
    if (!idbRec && record) { await adapter.putRecord(record); idbRec = record; stats.recordRestored++; }

    const idbHash = await canonicalHash(entry.data);
    if (idbHash === diskHash) continue;              // agree → nothing to do (the steady state)

    // ── Content disagreement (§11): the ancestor decides; never lose a version. ──
    const ancestor = (idbRec || record)?.syncedHash ?? null;
    if (ancestor && diskHash === ancestor && idbHash !== ancestor) {
      await adapter.putProject(entry.data, owner, { trashed: entry.trashed, deletedAt: entry.deletedAt, pendingSync: true });
      await adapter.addDirty(id);
      stats.idbWins++;
    } else if (ancestor && idbHash === ancestor && diskHash !== ancestor) {
      const project = parseOodbo(xml);
      const rec = idbRec ? stampDirty(idbRec) : null;
      if (rec) await adapter.commitProjectAndRecord(project, owner, rec, { trashed, deletedAt, pendingSync: true });
      else     await adapter.putProject(project, owner, { trashed, deletedAt, pendingSync: true });
      await adapter.addDirty(id);
      stats.diskWins++;
    } else {
      // Neither matches the ancestor → genuine local-vs-local divergence on one machine. Keep IDB as
      // trunk; preserve the disk copy as a sibling fork (conflictOf → trunk). Surfaces via getConflicts.
      const taken  = idbEntries.map(e => e.data?.title).filter(Boolean);
      const forkId = genId();
      const forked = { ...parseOodbo(xml), id: forkId, title: forkTitle(entry.data?.title, deviceLabel, Date.now(), taken), conflictOf: id };
      await adapter.putProject(forked, owner, { pendingSync: true });
      await adapter.addDirty(forkId);
      stats.forked++;
    }
  }

  // ── Pass 2: durability backfill — IDB entries with no on-disk copy get mirrored (§12.2). ──
  for (const entry of idbEntries) {
    if (seen.has(entry.id)) continue;
    await adapter.putProject(entry.data, entry.owner || owner, {
      trashed: entry.trashed, deletedAt: entry.deletedAt, pendingSync: entry.pendingSync,
    });
    const rec = await adapter.getRecord(entry.id);
    if (rec) await adapter.putRecord(rec);
    stats.mirrored++;
  }

  return stats;
}
