// ── Sync client: the app's single entry point to the engine ─────────────────────
//
// Wires the pure engine (engine.js) to real dependencies — the IDB adapter, the /api
// cloud layer, Supabase token injection, the fork handler, and app UI hooks — and holds
// the one engine instance for the session. App.jsx / Editor.jsx / Home.jsx call
// getEngine() and never touch the sync modules directly.
//
// Guest / unpaid users get NO engine (getEngine() → null): the app runs local-only.
// A kill-switch (localStorage 'oodbo:sync-off' = '1') also forces local-only, so a
// misbehaving engine can be stopped in production without a redeploy.

import { createIdbAdapter, closeDB, wipeLocalData, newSyncRecord, commitClean, isStuckDirty } from './store.js';
import { createWebCloud } from './webCloud.js';
import { IS_TAURI } from '../platform.js';
import { wrapCloudWithEncryption } from '../contentCrypto.js';
import { createEngine } from './engine.js';
import { createForkHandler } from './fork.js';
import { canonicalHash, hashXml, parseOodbo } from './canonical.js';

const SYNC_OFF_KEY = 'oodbo:sync-off';
const OWNER_KEY    = 'oodbo:owner';   // last signed-in account; a change triggers a local wipe (isolation)

let _engine = null, _adapter = null, _cloud = null, _forkHandler = null, _provider = null, _owner = null;

function killed() {
  try { return localStorage.getItem(SYNC_OFF_KEY) === '1'; } catch { return false; }
}

// UA-derived label for fork filenames — "Chrome (Web)" etc. (DECISION 6). Trivial because
// the browser is all that disambiguates the two-browsers case; nickname is post-launch.
function webDeviceLabel() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  let b = 'Browser';
  if (ua.includes('Firefox/'))                               b = 'Firefox';
  else if (ua.includes('Edg/'))                              b = 'Edge';
  else if (ua.includes('Chrome/'))                           b = 'Chrome';
  else if (ua.includes('Safari/') && !ua.includes('Chrome')) b = 'Safari';
  return `${b} (Web)`;
}

// Build (or rebuild) the engine for a signed-in, paid, cloud-connected user.
// `getToken` is async → current Supabase access token (or the untrusted-device JWT).
// `hooks` are the app's UI bridges: onBoot(projectId,msg), onReauth(), onBadge(evt).
export async function initSync({ user, getToken, hooks = {} }) {
  if (killed())                        return null;
  if (!user?.provider)  return null;   // guest → local-only

  // Account isolation: if a DIFFERENT account used this browser last, wipe its local data
  // before touching anything, so cross-account bleed is impossible on a shared browser.
  try {
    const prev = localStorage.getItem(OWNER_KEY);
    // DESKTOP hosts multiple isolated accounts on one machine (Google + local-only). Each is already
    // owner-scoped in IDB, and a global wipe on account-switch would destroy the OTHER accounts'
    // projects — including local accounts that have NO cloud copy to re-pull. So desktop relies on
    // the owner filter alone and never global-wipes. Web keeps the shared-browser wipe.
    if (!IS_TAURI && prev && prev !== user.email) await wipeLocalData();
    localStorage.setItem(OWNER_KEY, user.email);
  } catch {}

  _provider = user.provider;
  _owner    = user.email;
  _adapter  = createIdbAdapter();
  // At-rest content encryption (contentCrypto.js / ENCRYPTION-DESIGN.md): wrap the cloud once at this
  // single seam. Encrypts xml into save/trash, decrypts out of load; engine/fork/canonical/migration see
  // plaintext. Legacy plaintext files pass through and convert to ciphertext on next save. `_owner` = key.
  // Desktop (Tauri) talks to Drive directly with its own locally-refreshed PKCE token
  // (createDesktopCloud sources it itself, so getToken is unused there); web injects getToken
  // into webCloud. Both satisfy the same 7-method cloud contract the engine consumes.
  const rawCloud = IS_TAURI
    ? (await import('../desktopCloud.js')).createDesktopCloud()
    : createWebCloud({ getToken });
  _cloud = wrapCloudWithEncryption(rawCloud, _owner);

  // The fork pair needs no bookkeeping here. It's recorded on the fork itself as `conflictOf`
  // and travels inside the file, so it survives a reload AND reaches the other device — see
  // getConflicts. This is now purely the UI notification.
  const onBadge = hooks.onBadge || (() => {});
  _forkHandler = createForkHandler({ adapter: _adapter, provider: _provider, owner: _owner, deviceLabel: webDeviceLabel(), onBadge });

  _engine = createEngine({
    adapter: _adapter, cloud: _cloud, provider: _provider, owner: _owner,
    handlers: {
      onConflict: _forkHandler,
      onBadge,
      onNetwork: setReachable,
      onGone:  async ({ projectId }) => onBadge({ type: 'cloud-missing', projectId }),
      onReauth: hooks.onReauth || (() => {}),
      onBoot:   hooks.onBoot   || (async () => {}),
    },
  });
  return _engine;
}

export function getEngine() {
  if (killed()) return null;
  return _engine;
}

// ── Cloud reachability (what the offline banner reads) ──────────────────────────
// Whether the last cloud operation actually got through — NOT navigator.onLine, which only
// says the machine has a network interface. Dropping Wi-Fi while a VPN or a virtual adapter
// (Hyper-V, WSL, VirtualBox) is up leaves navigator.onLine true, so the browser's own event
// never fires and nothing on screen changes. A request that failed is the only proof.
//
// Optimistic by default: assume reachable until something demonstrates otherwise, so a fresh
// tab doesn't accuse the network of being down before it has tried anything.
let _reachable = true;
const _reachListeners = new Set();

function setReachable(v) {
  if (_reachable === v) return;          // dedupe: the engine reports level, not edges
  _reachable = v;
  _reachListeners.forEach(fn => { try { fn(v); } catch {} });
}

export function isCloudReachable() { return _reachable; }

// Test-only: force the reachability signal so badge/offline tests are deterministic without
// standing up a live engine and a failed request. Not part of the runtime contract.
export function __setReachableForTest(v) { setReachable(v); }

export function subscribeReachable(fn) {
  _reachListeners.add(fn);
  return () => _reachListeners.delete(fn);
}

// ── Conflict pairs + badges (UI reads these; §8.2 / §10) ────────────────────────
// Unresolved forks: [{ projectId, forkId, forkTitle }]. `projectId` holds the version that
// came from the cloud; `forkId` holds the version this device had diverged to.
//
// DERIVED from the projects themselves — a fork carries `conflictOf` pointing at its
// original — rather than from this device's local metadata. Two reasons, both bugs that
// were real:
//   · Only the device that forked wrote that metadata, so the other device (whose write
//     won) received the fork as an unexplained new project and badged nothing.
//   · A pair is only meaningful while BOTH sides are live. Binning either one has to end
//     the conflict, and deriving means that happens by itself — there is no second copy of
//     the truth to forget to update.
// A fork whose original is gone is just a project; it stops being half of a pair.
export async function getConflicts() {
  if (!_adapter) return [];
  try {
    const entries = await _adapter.getAllProjectEntries(_owner);
    const live    = new Map(entries.filter(e => !e.trashed).map(e => [e.id, e.data]));
    const out = [];
    for (const [id, data] of live) {
      const of = data?.conflictOf;
      if (of && live.has(of)) out.push({ projectId: of, forkId: id, forkTitle: data.title });
    }
    return out;
  } catch { return []; }
}

// Called once the user has decided. Both versions are already on disk either way, so this
// only ends the PAIRING: it clears `conflictOf` from the fork, which stops both sides badging
// and leaves an ordinary project.
//
// Clearing it changes the fork's content hash, which is the point — that's what marks it
// dirty, pushes it, and lets the other device's next sweep pull the resolution and drop its
// badge too. A decision made here shouldn't need making again over there.
//
// Takes the FORK's id, not the original's: an original can have more than one fork, so "the
// original" no longer names a single pair. The fork is always unambiguous.
export async function resolveConflict(forkId) {
  if (!_adapter || !_engine) return;
  try {
    const entry = await _adapter.getProjectEntry(forkId);
    if (!entry?.data?.conflictOf) return;
    const { conflictOf, ...cleared } = entry.data;
    await _adapter.putProject(cleared, _owner, { pendingSync: true });
    await _engine.markDirty(forkId, cleared);
    _engine.sweepDirty().catch(() => {});   // best-effort; the outbox retries regardless
  } catch {}
}

// Re-point a fork at a different original. Used when the user keeps a fork and bins the
// original it split from, while OTHER forks of that original still exist: without this those
// siblings would be left pointing at a trashed project — silently un-conflicted, their
// prompt to reconcile gone. Re-pointing them at the surviving fork keeps the group whole,
// with the kept version as the new trunk.
export async function reassignFork(forkId, newOriginalId) {
  if (!_adapter || !_engine) return;
  try {
    const entry = await _adapter.getProjectEntry(forkId);
    if (!entry?.data) return;
    const updated = { ...entry.data, conflictOf: newOriginalId };
    await _adapter.putProject(updated, _owner, { pendingSync: true });
    await _engine.markDirty(forkId, updated);
    _engine.sweepDirty().catch(() => {});
  } catch {}
}

// Per-project badge state for the project list, derived from the records at render time
// rather than stored — so it can never drift from the truth.
export async function getSyncBadges() {
  if (!_adapter) return {};
  try {
    const [records, conflicts, dirtyIds] = await Promise.all([_adapter.getAllRecords(), getConflicts(), _adapter.getDirtySet()]);
    const now = Date.now();
    const recordIds = new Set(records.map(r => r.projectId));
    // Can the cloud be reached at all right now? Both signals, same as the offline banner:
    // navigator.onLine (trust only its "no") plus the engine's proof-by-failed-request.
    const reachable = isCloudReachable() && (typeof navigator === 'undefined' || navigator.onLine !== false);
    const out = {};
    for (const r of records) {
      const dirty = r.syncState === 'dirty';
      // "Not backed up" fires the moment unsynced work can't reach the cloud — not after a
      // 24h wait. Offline with a dirty project is exactly that. The old ≥24h threshold is
      // kept only as a backstop for the rarer case where the cloud looks reachable but the
      // work still isn't landing (persistent errors). pending-verify is an upload in flight,
      // so it reads as syncing, never as un-backed-up.
      out[r.projectId] = {
        pending:     r.syncState === 'pending-verify',
        notBackedUp: dirty && (!reachable || isStuckDirty(r, now)),
        syncing:     dirty && reachable && !isStuckDirty(r, now),   // queued/going up
      };
    }
    // A project created offline and never pushed is in the dirtySet but has NO record yet, so the
    // records loop above skips it — leaving new offline work silently un-badged (looks backed up
    // when it isn't). Badge those too: notBackedUp when unreachable, else syncing (queued to push).
    for (const id of dirtyIds) {
      if (recordIds.has(id)) continue;
      out[id] = { ...(out[id] || {}), notBackedUp: !reachable, syncing: reachable };
    }
    // One original can have MORE than one fork — two devices each forking it before either
    // synced. Accumulate the forks into a list rather than overwriting; a single `forkId`
    // field is exactly the bug that made the badge say "2 versions" when there were three.
    for (const c of conflicts) {
      const o = out[c.projectId] || {};
      o.conflict = true;
      o.forks = [...(o.forks || []), { forkId: c.forkId, forkTitle: c.forkTitle }];
      out[c.projectId] = o;
      out[c.forkId] = { ...(out[c.forkId] || {}), conflictFork: true, ofProjectId: c.projectId };
    }
    return out;
  } catch { return {}; }
}

export function teardownSync() {
  _engine = _adapter = _cloud = _forkHandler = _provider = null;
  _owner = null;
  setReachable(true);   // no engine ⇒ nothing is failing; don't leave a stale banner up
  closeDB();
}

// Sign-out: wipe THIS account's local data and forget the owner, then tear the engine down —
// so nothing afterward can re-read another account's leftovers. Cloud is the source of truth,
// so the wipe loses nothing (next sign-in re-pulls).
export async function clearLocalSession() {
  try { await wipeLocalData(); } catch {}
  try { localStorage.removeItem(OWNER_KEY); } catch {}
  teardownSync();
}

// ── Migration (§12) ─────────────────────────────────────────────────────────────
// One-time pass that brings pre-existing projects under sync records. Runs at launch,
// before the first sweep, guarded by a persisted flag. Never guesses: hashes decide, and
// the legacy `pendingSync` flag stands in for the old imDirty when local ≠ cloud.
//   equal            → init clean record
//   differ + clean   → trust cloud (pull) — a stale-but-unedited local copy, no fork
//   differ + dirty   → fork-first (local edits preserved as a sibling)
//   not in cloud     → leave recordless + dirty → row 0a bootstrap-create on first sweep
// (No pre-migration snapshot: current data is disposable; add one at real launch.)
export async function migrateProjects({ adapter, cloud, provider, owner, forkHandler }) {
  if (await adapter.getMeta('migrated:v1')) return { skipped: true };

  let files;
  try { files = await cloud.list(); }
  catch { return { deferred: true }; }   // offline → migrate on a later launch (flag unset)

  const cloudById = new Map(files.filter(f => !f.trashed).map(f => [f.projectId, f]));
  const nowIso = () => new Date().toISOString();
  const detectOf = (cur) => (provider === 'azure' ? cur.cTag : cur.rev);
  const casOf    = (cur) => (provider === 'azure' ? cur.rev  : null);

  for (const entry of await adapter.getAllProjectEntries(owner)) {
    const id = entry.id;
    if (entry.trashed) continue;                 // trash reconciles via §9 on first sweep
    if (await adapter.getRecord(id)) continue;   // already migrated

    if (!cloudById.has(id)) { await adapter.addDirty(id); continue; }   // row 0a

    const cur = await cloud.load(id);
    if (cur.notFound) { await adapter.addDirty(id); continue; }

    const localHash = await canonicalHash(entry.data);
    const cloudHash = await hashXml(cur.xml);

    if (localHash === cloudHash) {
      await adapter.putRecord(commitClean(newSyncRecord(id, provider), {
        baseCloudRev: detectOf(cur), baseCasRev: casOf(cur), syncedHash: cloudHash,
      }));
    } else if (entry.pendingSync) {
      await forkHandler({ projectId: id, localProject: entry.data, cloudXml: cur.xml, cloudMeta: cur, record: null });
    } else {
      await adapter.commitProjectAndRecord(parseOodbo(cur.xml), owner,
        commitClean(newSyncRecord(id, provider), { baseCloudRev: detectOf(cur), baseCasRev: casOf(cur), syncedHash: cloudHash }),
        { pendingSync: false, lastSynced: nowIso(), trashed: false });
    }
  }

  await adapter.setMeta('migrated:v1', true);
  return { migrated: true };
}

// Run migration against the current session's engine wiring.
export async function runMigration() {
  if (!_engine) return { skipped: true };
  // A decrypt failure inside migrateProjects (cloud.load → CloudTransientError) must DEFER migration,
  // not propagate: `migrated:v1` is only set after the loop, so it retries next launch. Mirrors the
  // cloud.list() catch inside migrateProjects.
  try {
    return await migrateProjects({ adapter: _adapter, cloud: _cloud, provider: _provider, owner: _owner, forkHandler: _forkHandler });
  } catch {
    return { deferred: true };
  }
}
