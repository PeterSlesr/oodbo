// ── The sync engine: gather inputs → decide → execute (spec §5, §6, §10) ────────
//
// Platform-agnostic orchestrator. It owns the push state machine (§5.2), the dirtySet
// outbox, and backoff. It does NOT know about IndexedDB vs appdata (that's the injected
// adapter), nor about React. Fork-first (§8), bootstrap-compare-differ (0c), and terminal-
// delete (T5) are injected HANDLERS so this file stays free of Phase-4 fork mechanics while
// still routing to them precisely.
//
// Timing is injectable (now / sleep) so the jitter-first ordering and the ≥60 s Drive
// confirmation are provable under fake timers rather than hoped-for.

import { canonicalHash, hashXml, serializeOodbo, parseOodbo } from './canonical.js';
import { newSyncRecord, commitClean, stampDirty } from './store.js';
import { decide, Action } from './decisionTable.js';
import { trashDecide, TrashAction } from './trashTable.js';
import { genId, recoveredTitle } from './fork.js';
import { CloudAuthError, CloudTransientError, CloudQuotaError } from './cloud.js';

const CONFIRM_DELAY_MS = 60_000;   // §5.2 step 5: delayed confirmation floor
const JITTER_MAX_MS     = 5_000;   // §5.2 step 1

export function createEngine(deps) {
  const {
    adapter, cloud, provider, owner,
    now = () => Date.now(),
    sleep = (ms) => new Promise(r => setTimeout(r, ms)),
    jitter = () => Math.floor(Math.random() * JITTER_MAX_MS),
    confirmDelayMs = CONFIRM_DELAY_MS,
    handlers = {},
  } = deps;

  // Phase-4 seams (default to inert so Phase-3 sweeps run without them).
  const onConflict = handlers.onConflict || (async () => {});          // §8 fork-first
  const onGone     = handlers.onGone     || (async () => {});          // §9 T5
  const onReauth   = handlers.onReauth   || (() => {});                // §10 reconnect UI
  const onBadge    = handlers.onBadge    || (() => {});                // non-blocking notices
  const onBoot     = handlers.onBoot     || (async () => {});          // §6: boot the OPEN project to home
  // Can the cloud actually be reached? Fires only on CHANGE, with true/false. This is the
  // only honest answer available: navigator.onLine reports whether the machine has a network
  // interface, not whether anything is on the other end of it — a dropped Wi-Fi link with a
  // VPN or virtual adapter still up reads as "online", as does a captive portal.
  const onNetwork  = handlers.onNetwork  || (() => {});

  const isAzure = provider === 'azure';
  const nowIso  = () => new Date(now()).toISOString();

  // The provider's CHANGE-DETECTION rev from a metadata record: Drive headRevisionId,
  // OneDrive cTag (never eTag — it drifts on metadata; spike 2026-07-14).
  const detectRev = (meta) => (isAzure ? meta.cTag : meta.rev);

  let backoffStep = -1;              // -1 = healthy
  let providerHalted = false;        // set on unrecoverable auth failure until reset()

  // Every route into and out of network trouble goes through here, so what the UI believes
  // can't drift from the backoff state that actually drives retries. It reports the level
  // every time rather than just edges: reset() clears the backoff optimistically, before
  // anything has actually succeeded, and an edge-only signal would let that silent clear
  // desync the UI and strand the banner on screen. The listener dedupes.
  function setBackoffStep(step) {
    backoffStep = step;
    onNetwork(backoffStep < 0);
  }
  let openProjectId = null;          // §6: a remote change to THIS project boots the reader to home
  let _sweepChain = Promise.resolve(); // serializes sweeps (see sweep() below)

  // Purge-tombstone cache (§9 ext). rev-gated: the manifest body is downloaded only when its
  // rev changed (i.e. just after some device purged), so at steady state this costs nothing.
  let _tombRev = null;
  let _tombIds = new Set();

  // Offline permanent-delete queue (§9 ext). A purge that couldn't reach the cloud (offline)
  // still drops local immediately; the id waits here so the cloud file is removed AND the
  // tombstone written on reconnect — exactly once. Persisted in syncMeta (survives reload).
  async function getPendingPurges() { return (await adapter.getMeta('pendingPurges')) || []; }
  async function addPendingPurge(id) {
    const p = await getPendingPurges();
    if (!p.includes(id)) await adapter.setMeta('pendingPurges', [...p, id]);
  }
  async function removePendingPurge(id) {
    const p = await getPendingPurges();
    if (p.includes(id)) await adapter.setMeta('pendingPurges', p.filter(x => x !== id));
  }
  // Retry queued purges. Returns the STILL-pending set so the sweep can skip those ids (a cloud
  // file we haven't managed to remove yet must not be pulled back in as a bootstrap). Auth errors
  // propagate to halt the provider; transient errors just leave the id queued for next time.
  async function processPendingPurges() {
    for (const id of await getPendingPurges()) {
      try { await cloud.remove(id); await removePendingPurge(id); }
      catch (e) { if (e instanceof CloudAuthError) throw e; /* transient: keep queued */ }
    }
    return new Set(await getPendingPurges());
  }

  // Refresh the tombstone set, rev-gated. Best-effort: a transient failure keeps the cached set
  // (no worse than today); an auth failure propagates to halt the provider like any cloud call.
  async function refreshTombstones() {
    let t;
    try { t = await cloud.readTombstones(_tombRev); }
    catch (e) { if (e instanceof CloudAuthError) throw e; return; }   // transient → keep cache
    if (t && !t.unchanged) { _tombRev = t.rev; _tombIds = new Set(t.ids || []); }
  }

  // T5 (§9): the cloud file is terminally gone (404 — not merely trashed). Never discard
  // local content on a 404: drop the record so the project re-enters at row 0a and gets
  // re-uploaded, keep it in the outbox, and notify. Resurrecting a file the user purged is
  // an accepted annoyance (§16.3); losing their words is not (invariant 1).
  async function handleGone(projectId, record) {
    await adapter.deleteRecord(projectId);
    await adapter.addDirty(projectId);
    onBadge({ type: 'cloud-missing', projectId });
    await onGone({ projectId, record, provider, owner });   // optional notify hook (Phase 5 UI)
    return { action: 'gone' };
  }

  // ── executing one action ──────────────────────────────────────────────────────

  async function pull(projectId, record) {
    const cur = await cloud.load(projectId);
    if (cur.notFound) return handleGone(projectId, record);
    const pulled = parseOodbo(cur.xml);
    const h = await hashXml(cur.xml);
    const rec = commitClean(record ?? newSyncRecord(projectId, provider), {
      baseCloudRev: isAzure ? cur.cTag : cur.rev,
      baseCasRev:   isAzure ? cur.rev  : null,
      syncedHash:   h,
    });
    await adapter.commitProjectAndRecord(pulled, owner, rec, { pendingSync: false, lastSynced: nowIso() });
    await adapter.removeDirty(projectId);
    if (projectId === openProjectId) await onBoot(projectId, 'Switched to a newer version');  // §6
    // Tell the UI the local set changed. A pull is how the WINNING device first receives a
    // fork the other device made — silently landing it in IDB left the list and its conflict
    // dots stale until a manual sync, and worse, refreshing off two different triggers let the
    // fork row appear without its dot. One signal, so row and dot arrive together.
    onBadge({ type: 'pulled', projectId });
    return { action: 'pull' };
  }

  async function conflict(projectId, localProject, record) {
    const cur = await cloud.load(projectId);            // download the other side
    if (cur.notFound) return handleGone(projectId, record);

    // If local already hashes equal to cloud, this isn't a divergence — adopt, don't fork.
    // (Guards against a spurious fork when both devices coincidentally converged.)
    const cloudHash = await hashXml(cur.xml);
    const localHash = localProject ? await canonicalHash(localProject) : null;
    if (localHash && localHash === cloudHash) {
      const rec = commitClean(record ?? newSyncRecord(projectId, provider), {
        baseCloudRev: isAzure ? cur.cTag : cur.rev, baseCasRev: isAzure ? cur.rev : null, syncedHash: cloudHash,
      });
      await adapter.putRecord(rec);
      await adapter.removeDirty(projectId);
      return { action: 'adopt' };
    }

    await onConflict({ projectId, localProject, cloudXml: cur.xml, cloudMeta: cur, record, provider, owner });
    if (projectId === openProjectId) await onBoot(projectId, 'This project now has two versions');  // §6
    return { action: 'conflict' };
  }

  // OneDrive commit after a 2xx save: eTag is the CAS token, cTag the detection baseline.
  async function commitAzure(projectId, record, saveRes, syncedHash) {
    const rec = commitClean(record, { baseCloudRev: saveRes.cTag, baseCasRev: saveRes.rev, syncedHash });
    await adapter.putRecord(rec);
    await adapter.removeDirty(projectId);
    return { action: 'push', committed: true };
  }

  // OneDrive push (row 3 / bootstrap-create). True CAS via If-Match; a 412 is disambiguated
  // by cTag — same cTag = benign metadata drift (refresh eTag, retry once); moved = row 4.
  async function pushOneDrive(projectId, project, record, localHash) {
    const xml = serializeOodbo(project);
    const res = await cloud.save(projectId, xml, record.baseCasRev ? { ifMatch: record.baseCasRev } : {});
    if (!res.precondition) return commitAzure(projectId, record, res, localHash);

    const cur = await cloud.load(projectId);
    if (cur.notFound) return handleGone(projectId, record);
    if (cur.cTag === record.baseCloudRev) {
      const res2 = await cloud.save(projectId, xml, { ifMatch: cur.rev });   // metadata-only drift
      if (res2.precondition) return conflict(projectId, project, record);
      return commitAzure(projectId, record, res2, localHash);
    }
    return conflict(projectId, project, record);                             // content moved → row 4
  }

  // Drive push (row 3 / bootstrap-create) — §5.2. Jitter FIRST (timer/connectivity only),
  // tight pre-check→upload, then pending-verify. Commit-to-clean is deferred to a later
  // sweep's confirmPending, ≥60 s out.
  async function pushDrive(projectId, project, record, localHash, { userInitiated, isBootstrap }) {
    if (!userInitiated) await sleep(jitter());

    if (!isBootstrap) {
      const pre = await cloud.head(projectId);
      if (!pre.exists) return handleGone(projectId, record);
      if (pre.rev !== record.baseCloudRev) return conflict(projectId, project, record); // moved before upload
    }

    const res = await cloud.save(projectId, serializeOodbo(project));    // Drive ignores ifMatch
    const rec = { ...record, pendingRev: res.rev, pendingHash: localHash, syncState: 'pending-verify', pendingSince: now() };
    await adapter.putRecord(rec);          // persist BEFORE verify so a crash resumes as pending
    await adapter.addDirty(projectId);     // pending-verify keeps the outbox armed

    const post = await cloud.head(projectId);                            // immediate fast-fail verify
    if (!post.exists || post.rev !== res.rev) return conflict(projectId, project, rec);
    return { action: 'pending' };          // real commit happens ≥60s later in confirmPending
  }

  // Drive delayed confirmation (PENDING_CONFIRM). Never commits before ≥60 s after
  // pendingSince (invariant 2). Commits the PUSHED content's hash (pendingHash), not
  // whatever local looks like now — later local edits simply re-dirty it afterward.
  async function confirmPending(projectId, record) {
    if (now() - record.pendingSince < confirmDelayMs) return { action: 'pending-wait' };
    const h = await cloud.head(projectId);
    if (!h.exists) return handleGone(projectId, record);
    if (h.rev !== record.pendingRev) {
      const local = await adapter.getProject(projectId);
      return conflict(projectId, local, record);                         // foreign write landed → row 4
    }
    const rec = commitClean(record, { baseCloudRev: record.pendingRev, baseCasRev: null, syncedHash: record.pendingHash });
    await adapter.putRecord(rec);
    const cur = await adapter.getProject(projectId);
    const curHash = cur ? await canonicalHash(cur) : null;
    if (curHash === rec.syncedHash) await adapter.removeDirty(projectId); // else new edits keep it dirty
    // The "syncing…" badge is derived from this record, and this is the moment it stops being
    // true. It happens in a background sweep with no user action behind it, so without a signal
    // nothing would ever re-render and the badge would sit there until a reload.
    onBadge({ type: 'confirmed', projectId });
    return { action: 'confirmed' };
  }

  async function push(projectId, project, record, localHash, opts) {
    return isAzure
      ? pushOneDrive(projectId, project, record, localHash)
      : pushDrive(projectId, project, record, localHash, opts);
  }

  async function bootstrapCreate(projectId, project, localHash, opts) {
    const record = newSyncRecord(projectId, provider);
    return isAzure
      ? pushOneDrive(projectId, project, record, localHash)
      : pushDrive(projectId, project, record, localHash, { ...opts, isBootstrap: true });
  }

  // Bootstrap 0c: both sides exist, no record. Hash-equal → adopt silently; differ → fork.
  async function bootstrapCompare(projectId, project, localHash) {
    const cur = await cloud.load(projectId);
    if (cur.notFound) return bootstrapCreate(projectId, project, localHash, { userInitiated: true });
    const cloudHash = await hashXml(cur.xml);
    if (cloudHash === localHash) {
      const rec = commitClean(newSyncRecord(projectId, provider), {
        baseCloudRev: isAzure ? cur.cTag : cur.rev,
        baseCasRev:   isAzure ? cur.rev  : null,
        syncedHash:   localHash,
      });
      await adapter.putRecord(rec);
      await adapter.removeDirty(projectId);
      return { action: 'adopt' };
    }
    await onConflict({ projectId, localProject: project, cloudXml: cur.xml, cloudMeta: cur, record: null, provider, owner });
    return { action: 'conflict' };
  }

  // ── trash & delete execution (§9) ─────────────────────────────────────────────
  // "An edit beats a delete." Never propagate a delete over a divergent edit (T2/T4/T5).
  async function execTrash(action, { projectId, project, record, meta, trashMeta, localHash, userInitiated }) {
    switch (action) {
      case TrashAction.TRASH_CLOUD: {                     // T1 / local-only trash
        await cloud.trash(projectId, project ? serializeOodbo(project) : undefined);
        await adapter.removeDirty(projectId);
        return { action };
      }
      case TrashAction.RESTORE_PULL: {                    // T2 (trash was clean): edit wins → restore + pull
        const cur = await cloud.load(projectId);
        if (cur.notFound) return { action: 'noop' };
        const rec = commitClean(record ?? newSyncRecord(projectId, provider), {
          baseCloudRev: isAzure ? cur.cTag : cur.rev, baseCasRev: isAzure ? cur.rev : null, syncedHash: await hashXml(cur.xml),
        });
        await adapter.commitProjectAndRecord(parseOodbo(cur.xml), owner, rec, { pendingSync: false, lastSynced: nowIso(), trashed: false });
        await adapter.removeDirty(projectId);
        onBadge({ type: 'restored', projectId });
        return { action };
      }
      case TrashAction.FORK_THEN_PULL: {                  // T2 (edited-then-trashed): fork the trashed edit first
        const cur = await cloud.load(projectId);
        if (cur.notFound) return { action: 'noop' };
        // Guard (mirrors conflict()): the decision table picks this from a cloud REV change flagged as
        // "edited elsewhere", but during pending-verify that rev advanced because of OUR OWN unconfirmed
        // push (and syncedHash isn't updated yet, so localEqualsSynced reads false). A fork here is only
        // right for a GENUINE third version from another device. The cloud copy is "ours" — not foreign —
        // when it is byte-identical to our current local content, OR to the content we just pushed but
        // haven't confirmed (pendingHash — this is the "kept typing after the push" case, where local has
        // moved on but the cloud is still exactly our push), OR to our last synced ancestor (syncedHash —
        // the rev moved but the content didn't). In all three, honor the user's trash like T1 TRASH_CLOUD
        // instead of forking a duplicate and un-trashing the project. Only a truly foreign edit falls
        // through to the fork (see T-13b, where the cloud holds a third device's write).
        const cloudHash    = await hashXml(cur.xml);
        const localHashNow = project ? await canonicalHash(project) : null;
        const cloudIsOurs  = cloudHash === localHashNow
          || (record?.pendingHash && cloudHash === record.pendingHash)
          || (record?.syncedHash  && cloudHash === record.syncedHash);
        if (cloudIsOurs) {
          await cloud.trash(projectId, serializeOodbo(project));
          await adapter.removeDirty(projectId);
          return { action: 'trash-cloud' };
        }
        await onConflict({ projectId, localProject: project, cloudXml: cur.xml, cloudMeta: cur, record });
        return { action };
      }
      case TrashAction.TRASH_LOCAL: {                     // T3: clean local, cloud trashed → honor delete locally
        if (project) await adapter.putProject(project, owner, { trashed: true, pendingSync: false });
        await adapter.removeDirty(projectId);
        onBadge({ type: 'trashed-remote', projectId });
        return { action };
      }
      case TrashAction.PUSH_UNTRASH: {                    // T4: dirty local, cloud trashed → edit wins, resurrect
        await cloud.restore(projectId);
        const h = await cloud.head(projectId);
        const rec = { ...(record ?? newSyncRecord(projectId, provider)), baseCloudRev: detectRev(h), baseCasRev: isAzure ? h.rev : null };
        await adapter.putRecord(rec);
        return push(projectId, project, rec, localHash, { userInitiated });
      }
      case TrashAction.PURGE_LOCAL: {
        // The cloud copy was permanently deleted on another device (via a .trash that's now gone,
        // or a purge tombstone). Honor it: drop our local copy instead of re-uploading it (which
        // would resurrect it everywhere). Reached only for a CLEAN or record-less local — a
        // provably-edited one forks first (FORK_THEN_DROP) so no words are lost.
        await adapter.deleteProjectAndRecord(projectId);
        await adapter.removeDirty(projectId);
        return { action: 'purge-local' };
      }
      case TrashAction.FORK_THEN_DROP: {
        // §9 ext: this id is tombstoned (purged elsewhere) but we hold genuine unsynced edits.
        // Invariant 1 forbids losing words, so preserve them as a NEW project ("(recovered)")
        // — a fresh id at row 0a that uploads on its own — then drop the dead id so the purge
        // still wins. A tombstoned id is never resurrected; only the words survive, relabelled.
        if (project) {
          const forked = { ...structuredClone(project), id: genId(), title: recoveredTitle(project.title) };
          delete forked.conflictOf;
          await adapter.putProject(forked, owner, { pendingSync: true });
          await adapter.addDirty(forked.id);                 // never stranded — row 0a next sweep (invariant 7)
          onBadge({ type: 'recovered', projectId, forkId: forked.id, forkTitle: forked.title });
        }
        await adapter.deleteProjectAndRecord(projectId);
        await adapter.removeDirty(projectId);
        return { action: 'fork-then-drop' };
      }
      case TrashAction.PULL_TRASH: {
        // §4 full-parity: a project trashed on another device that this device never had locally.
        // Mirror the cloud .trash into IDB as a real trashed entry + record, so the bin is identical
        // on every device and works offline. Trashed analog of bootstrap-pull (row 0b); cloud.load
        // falls back to the .trash file when no active .oodbo exists.
        const cur = await cloud.load(projectId);
        if (cur.notFound) { await adapter.removeDirty(projectId); return { action: 'noop' }; }
        const rec = commitClean(newSyncRecord(projectId, provider), {
          baseCloudRev: isAzure ? cur.cTag : cur.rev, baseCasRev: isAzure ? cur.rev : null, syncedHash: await hashXml(cur.xml),
        });
        await adapter.commitProjectAndRecord(parseOodbo(cur.xml), owner, rec,
          { pendingSync: false, lastSynced: nowIso(), trashed: true, deletedAt: trashMeta?.modifiedTime || nowIso() });
        await adapter.removeDirty(projectId);
        onBadge({ type: 'trashed-remote', projectId });
        return { action };
      }
      case TrashAction.NOOP:
        // Both sides already trashed (or no divergence) — fully reconciled, nothing to push.
        // Must leave the outbox, or a trashed fork re-lists the cloud every 60s forever.
        await adapter.removeDirty(projectId);
        return { action: 'noop' };
      default: return { action: 'noop' };
    }
  }

  // ── one project, one sweep ────────────────────────────────────────────────────
  async function runProject(projectId, { cloudMeta, trashMeta = null, tombstoned = false, userInitiated = false } = {}) {
    const meta    = cloudMeta || (await cloud.head(projectId));   // ACTIVE (.oodbo) metadata
    const entry   = await adapter.getProjectEntry(projectId);
    const project = entry?.data ?? null;
    const localTrashed = !!entry?.trashed;
    const record  = await adapter.getRecord(projectId);
    const hasLocalContent = project != null;
    const localHash = hasLocalContent ? await canonicalHash(project) : null;

    // Trash/purge reconciliation (§9) precedes the active/active table when trash OR a purge
    // tombstone is involved. The tombstone must divert an ACTIVE local too (that is the
    // resurrection this fixes), so it enters here even without local/cloud trash state.
    if (localTrashed || trashMeta || tombstoned) {
      const inOutbox = (await adapter.getDirtySet()).has(projectId);
      const tAction = trashDecide({
        localTrashed,
        localExists:       hasLocalContent,                                  // §4: no local entry ⇒ cloud-only .trash → pull it in
        localInOutbox:     inOutbox,                                         // restore intent: in outbox but clean → un-trash, not T3
        localDirty:        record ? (localHash !== record.syncedHash) : hasLocalContent,
        localEqualsSynced: record ? (localHash === record.syncedHash) : false,
        localEverSynced:   record ? (record.baseCloudRev != null) : false,   // was it ever on the cloud?
        cloudActive:       !!meta.exists,
        cloudTrash:        !!trashMeta,
        cloudTombstone:    tombstoned,                                       // §9 ext: permanently deleted elsewhere
        cloudRevChanged:   record ? (detectRev(meta) !== record.baseCloudRev) : false,
      });
      return execTrash(tAction, { projectId, project, record, meta, trashMeta, localHash, userInitiated });
    }

    const action = decide({
      hasRecord:       !!record,
      hasLocalContent,
      cloudExists:     !!meta.exists,
      contentDirty:    record ? (localHash !== record.syncedHash) : false,
      syncState:       record?.syncState,
      cloudRevChanged: record ? (detectRev(meta) !== record.baseCloudRev) : false,
      pendingRevIsHead: record?.syncState === 'pending-verify' ? (meta.rev === record.pendingRev) : false,
    });

    switch (action) {
      // Nothing to sync ⇒ this project must not be sitting in the outbox. Without this, a
      // clean item stranded in the dirtySet (e.g. a resolved+trashed fork) keeps the 60s flush
      // armed forever, re-listing the cloud every minute. removeDirty is idempotent, so this is
      // a safe self-heal for any such ghost. (Same reasoning in the trash NOOP below.) Also reset a
      // stale 'dirty' record to clean here: since markDirty no longer re-hashes on every keystroke,
      // an edit-back-to-synced arrives here still flagged dirty — this is where it resolves clean.
      case Action.NOOP:
        if (record && record.syncState === 'dirty') await adapter.putRecord({ ...record, syncState: 'clean', dirtySince: null });
        await adapter.removeDirty(projectId);
        return { action };
      case Action.PULL:              return pull(projectId, record);
      case Action.PUSH:              return push(projectId, project, record, localHash, { userInitiated });
      case Action.CONFLICT:          return conflict(projectId, project, record);
      case Action.PENDING_CONFIRM:   return confirmPending(projectId, record);
      case Action.BOOTSTRAP_CREATE:  return bootstrapCreate(projectId, project, localHash, { userInitiated });
      case Action.BOOTSTRAP_PULL:    return pull(projectId, null);
      case Action.BOOTSTRAP_COMPARE: return bootstrapCompare(projectId, project, localHash);
      case Action.GONE:              return handleGone(projectId, record);
      default:                       return { action: 'noop' };
    }
  }

  // ── sweep: list once (§7), then run the relevant projects ─────────────────────
  async function _sweep(scope = 'all', { userInitiated = false } = {}) {
    if (providerHalted) return { halted: true };
    let files, stillPending;
    try {
      files = await cloud.list();
      await refreshTombstones();               // §9 ext: rev-gated; usually a no-op
      stillPending = await processPendingPurges(); // §9 ext: retry offline purges
    } catch (e) { return onSweepError(e); }

    // Group by id, tracking active (.oodbo) and .trash presence separately so §9 can route.
    const byId = new Map();
    for (const f of files) {
      const e = byId.get(f.projectId) || { active: null, trash: null };
      const m = { exists: true, rev: f.rev, cTag: f.cTag, modifiedTime: f.modifiedTime };
      if (f.trashed) e.trash = m; else e.active = m;
      byId.set(f.projectId, e);
    }
    const localIds = (await adapter.getAllProjectEntries(owner)).map(e => e.id);
    const dirty    = await adapter.getDirtySet();

    const ids = new Set(scope === 'all' ? [...localIds, ...byId.keys()] : scope);
    for (const id of dirty) ids.add(id);          // the outbox is always in scope
    for (const id of stillPending) ids.delete(id); // a purge we haven't removed yet — don't pull it back

    for (const id of ids) {
      try {
        const e = byId.get(id) || {};
        await runProject(id, { cloudMeta: e.active || { exists: false }, trashMeta: e.trash || null, tombstoned: _tombIds.has(id), userInitiated });
      } catch (e) {
        const halt = onSweepError(e);
        if (halt?.halted) return halt;            // auth failure aborts the whole provider
        // transient/quota: this project stays dirty (record uncommitted) → retried next sweep
      }
    }
    setBackoffStep(-1);                            // success resets backoff (and says we're back)
    return { ok: true };
  }

  // Sweeps are SERIALIZED. Multiple triggers (background timer, 5-min check, manual sync,
  // project open/close) can fire near-simultaneously; without this, two sweeps could both
  // read a project mid-conflict and BOTH fork it (the observed "double fork — X (conflicted)
  // and … (2)"). Chaining makes each sweep wait for the previous to finish, so by the time a
  // second one runs the first has already forked+adopted (record clean) → no duplicate.
  function sweep(scope = 'all', opts = {}) {
    const run = _sweepChain.then(() => _sweep(scope, opts), () => _sweep(scope, opts));
    _sweepChain = run.then(() => {}, () => {});     // keep the chain alive regardless of outcome
    return run;
  }

  // Trigger-shaped entry points the app wires in Phase 5.
  const sweepAll   = (opts) => sweep('all', opts);
  const syncOne    = (projectId, opts) => sweep([projectId], opts);
  // Zero network at steady state (goal 4 / invariant 3): an empty outbox short-circuits
  // BEFORE any cloud call, so the background timer is free when nothing is pending.
  const sweepDirty = async (opts) => {
    const ids = [...(await adapter.getDirtySet())];
    if (ids.length === 0) return { ok: true, empty: true };
    return sweep(ids, opts);
  };

  // Called by the app on a local save / new project: derive dirtiness from the hash and
  // arm the outbox. Replaces the old boolean dirtyRef. Reverting content to the ancestor
  // cleans it back off the outbox.
  // Arm the outbox for a project the user just edited. Deliberately does NO content hashing — that
  // was O(doc size) on EVERY keystroke-debounce (the jank on large docs, both platforms) and its
  // only job was to notice an edit-back-to-synced (dirty→clean). The sweep already re-hashes before
  // it pushes, so a reverted project resolves to NOOP + removeDirty there (≤ one sweep later). So:
  // stamp dirty once on the clean→dirty transition, then subsequent keystrokes do ~nothing but keep
  // the (idempotent) outbox armed. `project` is intentionally unused now.
  async function markDirty(projectId, project) {   // eslint-disable-line no-unused-vars
    const record = await adapter.getRecord(projectId);
    // Only persist the stamp on the clean→dirty transition. NOT `!== 'dirty'`: a Drive push sits in
    // 'pending-verify' for ~60s, and stamping there re-wrote the sidecar on EVERY keystroke. Editing
    // during pending-verify just re-arms the outbox; the sweep re-evaluates (confirm then re-push).
    if (record && record.syncState === 'clean') await adapter.putRecord(stampDirty(record, now()));
    await adapter.addDirty(projectId);
  }

  // Delete = trash (soft, resurrectable — §9). The next sweep propagates the rename to cloud.
  async function trashProject(projectId) {
    const entry = await adapter.getProjectEntry(projectId);
    if (!entry) return;
    await adapter.putProject(entry.data, owner, { trashed: true, deletedAt: entry.deletedAt || new Date(now()).toISOString() });
    await adapter.addDirty(projectId);
  }
  // Restore from the bin — LOCAL-FIRST so it works offline. Flip trashed off + arm the outbox; the
  // next sweep propagates the un-trash to the cloud (PUSH_UNTRASH). Outbox membership is what stops
  // that next sweep re-trashing it via T3 (clean local vs cloud-trashed → honor delete): trashDecide
  // routes an in-outbox local-active project to PUSH_UNTRASH instead. Symmetric with offline trash.
  // (Under §4 a bin item is always a real local entry, so no cloud-only special case is needed.)
  async function restoreProject(projectId) {
    const entry = await adapter.getProjectEntry(projectId);
    if (entry) await adapter.putProject(entry.data, owner, { trashed: false, deletedAt: null });
    await adapter.addDirty(projectId);
    return { ok: true };
  }

  // Terminal delete (§9: only ever from trash state). Removes the cloud file (the server writes
  // the purge tombstone as part of that call), then the local content + record + outbox entry.
  // If the cloud call fails (offline) we still drop locally — the user asked for it — but queue
  // the id so the removal AND its tombstone are guaranteed on reconnect (processPendingPurges),
  // rather than leaving an orphaned file that a later sweep would pull back in.
  async function purgeProject(projectId) {
    let removed = false;
    try { await cloud.remove(projectId); removed = true; } catch { /* offline / transient */ }
    await adapter.deleteProjectAndRecord(projectId);
    await adapter.removeDirty(projectId);
    if (!removed) await addPendingPurge(projectId);
  }

  // Bulk terminal delete (empty-bin). One cloud round-trip removes every file and writes all the
  // tombstones in a single manifest write — NEVER fan out to N concurrent purgeProject calls, which
  // race the manifest read-modify-write and lose most tombstones. Local drop + offline queue mirror
  // purgeProject, per id.
  async function purgeProjects(projectIds) {
    const ids = [...new Set((projectIds || []).filter(Boolean))];
    if (!ids.length) return;
    let removed = false;
    try { await cloud.removeMany(ids); removed = true; } catch { /* offline / transient */ }
    for (const id of ids) {
      await adapter.deleteProjectAndRecord(id);
      await adapter.removeDirty(id);
      if (!removed) await addPendingPurge(id);
    }
  }

  function onSweepError(e) {
    if (e instanceof CloudAuthError) { providerHalted = true; onReauth(); return { halted: true }; }
    if (e instanceof CloudTransientError || e instanceof CloudQuotaError) {
      setBackoffStep(0);   // flip reachability to "not reachable"; retry cadence is App's fixed 60s timer
      return { transient: true };
    }
    throw e;                                        // unknown — surface it
  }

  return {
    runProject, sweep, sweepAll, sweepDirty, syncOne,
    markDirty, trashProject, restoreProject, purgeProject, purgeProjects,
    setOpenProject(id) { openProjectId = id; },              // null when leaving the editor
    get openProjectId() { return openProjectId; },
    get halted() { return providerHalted; },
    reset() { setBackoffStep(-1); providerHalted = false; }, // connectivity event / manual sync
  };
}
