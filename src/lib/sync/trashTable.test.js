import { describe, it, expect } from 'vitest';
import { trashDecide, TrashAction } from './trashTable.js';

const base = {
  localTrashed: false, localDirty: false, localEqualsSynced: true, localExists: true, localInOutbox: false,
  cloudActive: false, cloudTrash: false, cloudRevChanged: false,
};
const d = (o) => trashDecide({ ...base, ...o });

describe('trash table §9 — edit beats delete', () => {
  it('T1: local trashed, cloud active, rev unchanged → propagate trash to cloud', () => {
    expect(d({ localTrashed: true, cloudActive: true, cloudRevChanged: false })).toBe(TrashAction.TRASH_CLOUD);
  });

  it('T2 (clean trash): local trashed, cloud edited since → restore + pull', () => {
    expect(d({ localTrashed: true, cloudActive: true, cloudRevChanged: true, localEqualsSynced: true }))
      .toBe(TrashAction.RESTORE_PULL);
  });

  it('T2 (edited-then-trashed): local trashed AND diverged, cloud edited since → fork the trashed edit first', () => {
    expect(d({ localTrashed: true, cloudActive: true, cloudRevChanged: true, localEqualsSynced: false }))
      .toBe(TrashAction.FORK_THEN_PULL);
  });

  it('T3: local active & clean, cloud trashed → trash locally', () => {
    expect(d({ localTrashed: false, localDirty: false, cloudTrash: true, cloudActive: false }))
      .toBe(TrashAction.TRASH_LOCAL);
  });

  it('T4: local active & DIRTY, cloud trashed → edit wins, push & un-trash', () => {
    expect(d({ localTrashed: false, localDirty: true, cloudTrash: true, cloudActive: false }))
      .toBe(TrashAction.PUSH_UNTRASH);
  });

  it('§4: no local entry at all, cloud-only .trash → pull it into IDB (full-parity bin)', () => {
    expect(d({ localTrashed: false, localExists: false, cloudTrash: true, cloudActive: false }))
      .toBe(TrashAction.PULL_TRASH);
  });

  it('§4 restore intent: local active & CLEAN but in the outbox, cloud trashed → un-trash (not T3)', () => {
    expect(d({ localTrashed: false, localDirty: false, localInOutbox: true, cloudTrash: true, cloudActive: false }))
      .toBe(TrashAction.PUSH_UNTRASH);
  });

  it('local-only trash (never uploaded) → create-as-.trash', () => {
    expect(d({ localTrashed: true, cloudActive: false, cloudTrash: false })).toBe(TrashAction.TRASH_CLOUD);
  });

  it('T5: was-synced trash, cloud now gone → purge locally (a permanent delete elsewhere is honored)', () => {
    expect(d({ localTrashed: true, cloudActive: false, cloudTrash: false, localEverSynced: true }))
      .toBe(TrashAction.PURGE_LOCAL);
  });

  it('both trashed → NOOP', () => {
    expect(d({ localTrashed: true, cloudTrash: true })).toBe(TrashAction.NOOP);
  });

  it('active/active (no trash anywhere) → NOOP (main §5.1 table owns it)', () => {
    expect(d({ localTrashed: false, cloudActive: true, cloudTrash: false })).toBe(TrashAction.NOOP);
  });
});

describe('trash table §9 ext — purge tombstones (no resurrection)', () => {
  it('active + clean local, id tombstoned → PURGE_LOCAL (honor the purge, do not re-upload)', () => {
    expect(d({ localTrashed: false, localDirty: false, cloudTombstone: true, cloudActive: false, localEverSynced: true }))
      .toBe(TrashAction.PURGE_LOCAL);
  });

  it('no-record local (would bootstrap-create), id tombstoned → PURGE_LOCAL, never a re-upload', () => {
    // no record: localEverSynced false, localDirty defaults true (hasLocalContent) — must still PURGE, not fork.
    expect(d({ localTrashed: false, localDirty: true, localEverSynced: false, cloudTombstone: true, cloudActive: false }))
      .toBe(TrashAction.PURGE_LOCAL);
  });

  it('provable unsynced edits (ever-synced + dirty), id tombstoned → FORK_THEN_DROP (keep words, drop dead id)', () => {
    expect(d({ localTrashed: false, localDirty: true, localEverSynced: true, cloudTombstone: true, cloudActive: false }))
      .toBe(TrashAction.FORK_THEN_DROP);
  });

  it('no local content, id tombstoned → NOOP (never mirror a tombstone into the bin)', () => {
    expect(d({ localExists: false, cloudTombstone: true, cloudActive: false, cloudTrash: false }))
      .toBe(TrashAction.NOOP);
  });

  it('tombstone wins even if a stale active cloud file lingers (a purge is terminal)', () => {
    expect(d({ localTrashed: false, localDirty: false, localEverSynced: true, cloudTombstone: true, cloudActive: true }))
      .toBe(TrashAction.PURGE_LOCAL);
  });

  it('locally-trashed + tombstoned → PURGE_LOCAL (same honor path)', () => {
    expect(d({ localTrashed: true, localDirty: false, localEverSynced: true, cloudTombstone: true }))
      .toBe(TrashAction.PURGE_LOCAL);
  });

  it('regression: no tombstone → existing trash outcomes unchanged', () => {
    expect(d({ localTrashed: false, localDirty: false, cloudTrash: true, cloudActive: false, cloudTombstone: false }))
      .toBe(TrashAction.TRASH_LOCAL);
    expect(d({ localTrashed: true, cloudActive: true, cloudRevChanged: false, cloudTombstone: false }))
      .toBe(TrashAction.TRASH_CLOUD);
  });
});
