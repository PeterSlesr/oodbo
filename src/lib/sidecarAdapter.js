// ── Desktop storage adapter: IDB cache + authoritative appdata sidecars (§14 seam #1) ───────
//
// Same interface as createIdbAdapter (store.js), so the engine/decision-table/fork/trash never
// learn the platform. IDB stays the working store (fast reads, the dirtySet outbox), but every
// content/record write is ALSO mirrored to appdata, which is AUTHORITATIVE (§3.2):
//   • project content → `{projectId}.oodbo`
//   • sync record + entry flags (trashed/deletedAt) → `{projectId}.syncrecord.json`
// So an IDB wipe loses nothing — the startup reconciliation rebuilds IDB from disk, and
// fast-forward stays distinguishable from conflict (invariant 6). Appdata writes are best-effort
// (desktopSave swallows fs errors); a crash between the .oodbo and the sidecar leaves content newer
// than record = looks dirty = safe (§11).
//
// Used only on the IS_TAURI engine path (wired in client.js). For a PIN-protected account the
// mirrored files are encrypted by desktopSave (localVault); the engine never learns that either.

import { createIdbAdapter } from './sync/store.js';
import { serializeOodbo } from './sync/canonical.js';
import { saveProjectXmlToAppData, writeAppDataSidecar, deleteAppDataProject } from './desktopSave.js';

export function createSidecarAdapter(owner, codec) {
  const idb = createIdbAdapter(codec);   // codec encrypts the IDB cache for a PIN account (identity otherwise)

  async function mirrorSidecar(projectId) {
    const [entry, record] = await Promise.all([idb.getProjectEntry(projectId), idb.getRecord(projectId)]);
    if (!entry && !record) return;
    await writeAppDataSidecar(owner, projectId, {
      record:    record || null,
      trashed:   !!entry?.trashed,
      deletedAt: entry?.deletedAt ?? null,
    });
  }
  async function mirrorContent(project) {
    if (project?.id) await saveProjectXmlToAppData(owner, project.id, serializeOodbo(project));
  }

  return {
    ...idb,   // reads + dirtySet + meta come straight from the IDB cache

    async putProject(project, o, opts) {
      await idb.putProject(project, o, opts);
      await mirrorContent(project);
      await mirrorSidecar(project.id);
    },
    async putRecord(record) {
      await idb.putRecord(record);
      await mirrorSidecar(record.projectId);
    },
    async deleteRecord(projectId) {
      await idb.deleteRecord(projectId);
      await mirrorSidecar(projectId);
    },
    async commitProjectAndRecord(project, o, record, opts) {
      await idb.commitProjectAndRecord(project, o, record, opts);
      await mirrorContent(project);
      await mirrorSidecar(project.id);
    },
    async deleteProjectAndRecord(projectId) {
      await idb.deleteProjectAndRecord(projectId);
      await deleteAppDataProject(owner, projectId);
    },
  };
}
