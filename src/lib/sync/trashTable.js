// ── Trash & delete reconciliation (spec §9) — pure decision ─────────────────────
//
// Trashing = renaming a file to .trash; it reconciles as a file operation with its own
// conflict shape. Governing principle: AN EDIT BEATS A DELETE. Silently honoring a delete
// can destroy words; silently honoring an edit merely resurrects a file, re-trashed in one
// click. This function decides; the engine executes.
//
// It is consulted (ahead of the §5.1 table) whenever trash state is involved on either
// side — local entry.trashed, or a cloud .trash file present.

export const TrashAction = {
  TRASH_CLOUD:     'trash-cloud',     // T1 / local-only trash → propagate trash to cloud (rename or create-as-.trash)
  RESTORE_PULL:    'restore-pull',    // T2 (trash was clean) → restore local active, pull the edit
  FORK_THEN_PULL:  'fork-then-pull',  // T2 (edited-then-trashed) → fork the trashed content, pull cloud as canonical
  TRASH_LOCAL:     'trash-local',     // T3 → cloud trashed a clean local → trash locally
  PUSH_UNTRASH:    'push-untrash',    // T4 → cloud trashed a DIRTY local → edit wins, push & un-trash cloud
  PURGE_LOCAL:     'purge-local',     // T5 → cloud copy was permanently deleted elsewhere → honor it, drop local
  FORK_THEN_DROP:  'fork-then-drop',  // §9 ext → tombstoned id with provable unsynced edits → fork words to a new id, drop the dead id
  PULL_TRASH:      'pull-trash',      // §4 → a cloud-only .trash file we don't have locally → mirror it into IDB
  NOOP:            'noop',            // both agree trashed, or no trash divergence (main table owns it)
};

// Inputs:
//   localTrashed       — the local entry is in the trash
//   localDirty         — canonicalHash(local) !== syncedHash (real edits; never UI state, §3.4)
//   localEqualsSynced  — canonicalHash(local) === syncedHash (trash was clean at trash time)
//   cloudActive        — an .oodbo (active) file exists in the cloud
//   cloudTrash         — a .trash file exists in the cloud
//   cloudRevChanged    — the active cloud file's detection rev !== record.baseCloudRev
//                        (only meaningful when cloudActive)
export function trashDecide(input) {
  const { localTrashed, localDirty, localEqualsSynced, localEverSynced, cloudActive, cloudTrash, cloudTombstone = false, cloudRevChanged, localExists = true, localInOutbox = false } = input;

  // ── Purge tombstone (§9 ext) ────────────────────────────────────────────────────
  // The id is in the permanent-delete manifest: it was purged on purpose on another device.
  // Honor it over any local copy — that is the whole point (stop the resurrection). The ONE
  // exception is invariant 1: genuine unsynced edits must not be lost. We only fork when we can
  // PROVE such edits exist — a record that was ever synced AND local now differs from it. A
  // record-less local (can't prove edits) or a clean local is simply dropped; a tombstoned id is
  // a random UUID, so it is unambiguously the same dead project and never a legitimate new one.
  // Checked before everything else so it wins over active/trash cloud presence (a purge is terminal).
  if (cloudTombstone) {
    if (!localExists) return TrashAction.NOOP;                        // nothing to remove; never mirror a tombstone into the bin
    return (localEverSynced && localDirty) ? TrashAction.FORK_THEN_DROP
                                           : TrashAction.PURGE_LOCAL;
  }

  if (localTrashed) {
    if (cloudTrash) return TrashAction.NOOP;                 // both sides trashed — agreed
    if (cloudActive) {
      if (!cloudRevChanged) return TrashAction.TRASH_CLOUD;  // T1: nobody touched it → propagate the trash
      // T2: it was edited elsewhere since we based on it — edit beats delete.
      return localEqualsSynced ? TrashAction.RESTORE_PULL    //   trash was clean → restore + pull
                               : TrashAction.FORK_THEN_PULL; //   we edited THEN trashed → fork the trashed edit first
    }
    // Cloud has NOTHING. Two very different reasons, told apart by whether we were ever synced:
    //   • never uploaded (no baseCloudRev) → back it up as .trash (no-loss for offline scratch).
    //   • was on the cloud and now isn't → it was PERMANENTLY DELETED on another device.
    //     Honor that here instead of re-creating it — re-creating is what resurrects a bin item
    //     everywhere and fights an explicit purge (T5).
    return localEverSynced ? TrashAction.PURGE_LOCAL : TrashAction.TRASH_CLOUD;
  }

  // local is active (or absent entirely)
  if (cloudTrash && !cloudActive) {
    if (!localExists) return TrashAction.PULL_TRASH;          // §4: cloud-only .trash → mirror into IDB (full-parity bin)
    // PUSH_UNTRASH when THIS device wants it active — a real edit (localDirty) OR an explicit restore
    // (in our outbox but content-clean). T3 (honor the delete) is only for a project we're passively
    // seeing trashed elsewhere: clean AND not in our outbox.
    return (localDirty || localInOutbox) ? TrashAction.PUSH_UNTRASH   // T4 / restore intent → resurrect
                                         : TrashAction.TRASH_LOCAL;   // T3: clean & passive → honor delete
  }

  return TrashAction.NOOP;                                    // active/active — the §5.1 table handles it
}
