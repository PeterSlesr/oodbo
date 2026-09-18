import { describe, it, expect } from 'vitest';
import { decide, Action } from './decisionTable.js';

// Defaults represent a boring "record exists, clean, cloud unchanged" project; each test
// overrides only the inputs that define its row, so the intent of each case is legible.
const base = {
  hasRecord: true, hasLocalContent: true, cloudExists: true,
  contentDirty: false, syncState: 'clean', cloudRevChanged: false, pendingRevIsHead: true,
};
const d = (o) => decide({ ...base, ...o });

describe('decision table §5.1 — bootstrap rows (no record)', () => {
  it('0a: local content, no cloud → BOOTSTRAP_CREATE', () => {
    expect(d({ hasRecord: false, hasLocalContent: true, cloudExists: false })).toBe(Action.BOOTSTRAP_CREATE);
  });
  it('0b: no local, cloud exists → BOOTSTRAP_PULL', () => {
    expect(d({ hasRecord: false, hasLocalContent: false, cloudExists: true })).toBe(Action.BOOTSTRAP_PULL);
  });
  it('0c: both exist, no record → BOOTSTRAP_COMPARE (never guesses)', () => {
    expect(d({ hasRecord: false, hasLocalContent: true, cloudExists: true })).toBe(Action.BOOTSTRAP_COMPARE);
  });
  it('nothing anywhere → NOOP', () => {
    expect(d({ hasRecord: false, hasLocalContent: false, cloudExists: false })).toBe(Action.NOOP);
  });
});

describe('decision table §5.1 — rows 1–4', () => {
  it('row 1: clean + cloud unchanged → NOOP', () => {
    expect(d({ contentDirty: false, cloudRevChanged: false })).toBe(Action.NOOP);
  });
  it('row 2: clean + cloud moved → PULL', () => {
    expect(d({ contentDirty: false, cloudRevChanged: true })).toBe(Action.PULL);
  });
  it('row 3: dirty + cloud unchanged → PUSH', () => {
    expect(d({ contentDirty: true, cloudRevChanged: false })).toBe(Action.PUSH);
  });
  it('row 4: dirty + cloud moved → CONFLICT (both diverged from ancestor)', () => {
    expect(d({ contentDirty: true, cloudRevChanged: true })).toBe(Action.CONFLICT);
  });
});

describe('decision table §5.1 — pending-verify (Drive, §5.2)', () => {
  it('our upload still head → PENDING_CONFIRM (engine applies the ≥60s clock)', () => {
    expect(d({ syncState: 'pending-verify', pendingRevIsHead: true })).toBe(Action.PENDING_CONFIRM);
  });
  it('a foreign write landed on top → CONFLICT (row 4)', () => {
    expect(d({ syncState: 'pending-verify', pendingRevIsHead: false })).toBe(Action.CONFLICT);
  });
  it('pending-verify is evaluated regardless of contentDirty/cloudRevChanged flags', () => {
    // Even if the raw rev looks "unchanged", pending-verify routes through its own branch.
    expect(d({ syncState: 'pending-verify', pendingRevIsHead: false, contentDirty: false, cloudRevChanged: false }))
      .toBe(Action.CONFLICT);
  });
});

describe('decision table §5.1 — local cache lost (record + cloud, no local content)', () => {
  // Regression: with no local content the engine computes contentDirty = (null !== syncedHash) =
  // true; without the guard this routed to PUSH → serializeOodbo(null) crash (killed the sweep, so
  // Home never rendered on desktop). Must recover from the cloud, never push/fork a null project.
  it('cloud present, no local content → PULL (recover), regardless of derived-dirty / cloud-moved', () => {
    expect(d({ hasLocalContent: false, contentDirty: true,  cloudRevChanged: false })).toBe(Action.PULL);
    expect(d({ hasLocalContent: false, contentDirty: true,  cloudRevChanged: true  })).toBe(Action.PULL);
    expect(d({ hasLocalContent: false, contentDirty: false, cloudRevChanged: false })).toBe(Action.PULL);
  });
  it('a pending-verify record with no local content still recovers (PULL), never confirms a null', () => {
    expect(d({ hasLocalContent: false, syncState: 'pending-verify', pendingRevIsHead: true })).toBe(Action.PULL);
  });
  it('no cloud file wins over the lost-cache guard → GONE (nothing to recover from)', () => {
    expect(d({ hasLocalContent: false, cloudExists: false })).toBe(Action.GONE);
  });
});

describe('decision table §5.1 — cloud file gone', () => {
  it('record exists but no cloud file → GONE (never discard; engine routes to T5)', () => {
    expect(d({ cloudExists: false, contentDirty: true })).toBe(Action.GONE);
    expect(d({ cloudExists: false, contentDirty: false })).toBe(Action.GONE);
  });
});

describe('decision table — invariant 4: conflict only when both sides diverged', () => {
  it('CONFLICT requires contentDirty AND cloudRevChanged (or a pending foreign write)', () => {
    // Exhaustive over the clean/dirty × moved/unmoved grid: CONFLICT appears exactly once.
    const grid = [];
    for (const contentDirty of [false, true])
      for (const cloudRevChanged of [false, true])
        grid.push(d({ contentDirty, cloudRevChanged }));
    expect(grid.filter(a => a === Action.CONFLICT)).toHaveLength(1);
  });
});
