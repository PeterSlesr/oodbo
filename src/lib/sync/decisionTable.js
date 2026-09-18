// ── The decision table (spec §5.1): pure, per-project, per-sweep ─────────────────
//
// Given the cheaply-fetched inputs for one project, decide what the engine should do.
// NO I/O, NO platform awareness, NO timestamps — the whole point is that conflict
// detection is a deterministic function of (sync record, derived dirty, cloud rev now).
// The engine gathers the inputs and executes the returned action; this file only decides.
//
// Trash/delete reconciliation (§9) is a SEPARATE table (Phase 4) the engine consults
// first when a .trash file is involved. This table handles the active-file rows 0a–4.

export const Action = {
  NOOP:             'noop',              // row 1 — clean, cloud unchanged
  PULL:             'pull',              // row 2 — clean, cloud moved → fast-forward
  PUSH:             'push',              // row 3 — dirty, cloud unchanged → upload (§5.2)
  CONFLICT:         'conflict',          // row 4 — both diverged → fork-first (§8)
  BOOTSTRAP_CREATE: 'bootstrap-create',  // 0a — local content, no cloud file → upload
  BOOTSTRAP_PULL:   'bootstrap-pull',    // 0b — no local, cloud exists → download + init record
  BOOTSTRAP_COMPARE:'bootstrap-compare', // 0c — both exist, no record → hash-compare, adopt or fork
  PENDING_CONFIRM:  'pending-confirm',   // pending-verify, our upload still head → engine: ≥60s? commit : wait
  GONE:             'gone',              // record exists but cloud file absent (terminal delete) → §9 T5
};

// Inputs (all booleans unless noted):
//   hasRecord         — a sync record exists for this project
//   hasLocalContent   — local store holds content for it
//   cloudExists       — an active (.oodbo) cloud file exists (trash handled upstream, §9)
//   contentDirty      — canonicalHash(local) !== record.syncedHash (real edits; never UI state)
//   syncState         — 'clean' | 'dirty' | 'pending-verify' (from the record)
//   cloudRevChanged   — cloud detection rev now !== record.baseCloudRev
//                       (Drive headRevisionId / OneDrive cTag — never eTag, which drifts)
//   pendingRevIsHead  — pending-verify only: cloud head === record.pendingRev
//                       (i.e. our unconfirmed upload is still the latest)
//
// Note on "dirty": per spec §2, pending-verify counts as dirty. Here `contentDirty` is
// specifically the hash mismatch; the pending-verify STATE is handled by its own branch
// before the clean/dirty rows, so the two never collide.
export function decide(input) {
  const {
    hasRecord, hasLocalContent, cloudExists,
    contentDirty, syncState, cloudRevChanged, pendingRevIsHead,
  } = input;

  // ── Bootstrap: no record yet (rows 0a/0b/0c) ──────────────────────────────────
  if (!hasRecord) {
    if (hasLocalContent && !cloudExists) return Action.BOOTSTRAP_CREATE;  // 0a
    if (!hasLocalContent && cloudExists) return Action.BOOTSTRAP_PULL;    // 0b
    if (hasLocalContent && cloudExists)  return Action.BOOTSTRAP_COMPARE; // 0c
    return Action.NOOP; // nothing anywhere — nothing to do
  }

  // ── Record exists ─────────────────────────────────────────────────────────────
  // Cloud file gone entirely (not merely trashed — trash is routed by §9 upstream).
  // Never discard local on a 404; the engine's T5 keeps it as a re-upload candidate.
  if (!cloudExists) return Action.GONE;

  // Local content vanished while the cloud copy is still there — the IDB cache lost the entry
  // (a hard delete that left the record behind, or a pull that wrote the record before its
  // content and crashed between). You cannot push or fork content you do not hold: without this
  // guard the engine computes contentDirty = (null-hash !== syncedHash) = true and routes to
  // PUSH (serializeOodbo(null) → crash) or CONFLICT (fork of a null project). Recover from the
  // cloud instead — pull restores the entry and commits the record clean. Non-destructive and
  // self-healing; a genuine local delete removes the record too (T5 PURGE), so a lingering
  // record+cloud with no content is always a lost cache, never an intended deletion.
  if (!hasLocalContent) return Action.PULL;

  // Unconfirmed Drive upload in flight (§5.2 step 4/5).
  if (syncState === 'pending-verify') {
    // A foreign write landed on top of ours → genuine divergence.
    if (!pendingRevIsHead) return Action.CONFLICT;   // row 4
    // Our upload is still head → not a conflict; the engine decides commit-vs-wait by the
    // ≥60 s delayed-confirmation clock. pending-verify can never be skipped (counts dirty).
    return Action.PENDING_CONFIRM;
  }

  // ── Clean / dirty × cloud-unchanged / cloud-moved (rows 1–4) ───────────────────
  if (!contentDirty && !cloudRevChanged) return Action.NOOP;      // row 1
  if (!contentDirty &&  cloudRevChanged) return Action.PULL;      // row 2 (silent for closed; boot-to-home for open, §6)
  if ( contentDirty && !cloudRevChanged) return Action.PUSH;      // row 3
  return Action.CONFLICT;                                          // row 4: dirty AND cloud moved
}
