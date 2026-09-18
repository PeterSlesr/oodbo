// ── Fork-first conflict handling (spec §8) ──────────────────────────────────────
//
// Row 4 (both sides diverged from the ancestor) is resolved by preserving BOTH versions
// on durable storage BEFORE any UI renders — a crash mid-resolution loses nothing. The
// dialog is pure presentation and comes later; "decide later" is always legitimate.
//
// Mechanism:
//   1. The local divergent version becomes a NEW sibling project (fresh id, conflicted
//      title). It has no sync record → next sweep sees it at row 0a → bootstrap-create →
//      pushed automatically. It joins the dirtySet immediately so a network blip cannot
//      strand it local-only (invariant 7).
//   2. The cloud version becomes the canonical local copy for the ORIGINAL id; its record
//      is set to the cloud rev/hash, clean.
//   3. The original id leaves the dirtySet — its divergence now lives in the fork.
//
// This file EXPORTS createForkHandler; the engine calls it through its injected
// `onConflict` seam, so the engine stays free of fork mechanics. Platform-agnostic:
// deviceLabel is supplied by the caller (UA-derived "Chrome (Web)" on web, machine name
// on desktop).

import { parseOodbo, hashXml } from './canonical.js';
import { newSyncRecord, commitClean } from './store.js';

export function genId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// "{Title} (recovered)" — for a project rescued from a purge race (§9 ext FORK_THEN_DROP): it
// had unsynced edits when its id was permanently deleted elsewhere, so the words live on under a
// new id while the dead id stays dead.
export function recoveredTitle(title) {
  return `${sanitizeTitle(title)} (recovered)`;
}

// Filesystem-illegal characters are replaced even though cloud files are id-named — titles
// flow into export filenames elsewhere (docx/png), so keep them clean defensively.
export function sanitizeTitle(s) {
  const cleaned = String(s ?? '').replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned || 'Untitled';
}

// "{Title} (conflicted — {device}, {YYYY-MM-DD})", with a numeric suffix on a same-day
// double-conflict collision so the two forks stay distinguishable to the user (§8.1 / DEC 1).
export function forkTitle(title, deviceLabel, nowMs, takenTitles = []) {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const base = `${sanitizeTitle(title)} (conflicted — ${deviceLabel}, ${date})`;
  const taken = new Set(takenTitles);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

export function createForkHandler({ adapter, provider, owner, deviceLabel = 'Web', now = () => Date.now(), onBadge = () => {} }) {
  const nowIso = () => new Date(now()).toISOString();

  // ctx (from the engine's conflict path): { projectId, localProject, cloudXml, cloudMeta, record }
  return async function onConflict(ctx) {
    const { projectId, localProject, cloudXml, cloudMeta, record } = ctx;
    const isAzure = provider === 'azure';

    // 1. Preserve the local divergent version as a new sibling (row 0a).
    const taken   = (await adapter.getAllProjectEntries(owner)).map(e => e.data?.title).filter(Boolean);
    const forkId  = genId();
    const forked  = {
      ...structuredClone(localProject),
      id: forkId,
      title: forkTitle(localProject?.title, deviceLabel, now(), taken),
      // Which project this is a second version OF. It lives in the FILE, not in this device's
      // local metadata, so it reaches the other device: the device that forked is the only one
      // that knows a conflict happened, and the other one — whose write won — would otherwise
      // just receive an unexplained new project and show no badge at all.
      conflictOf: projectId,
    };
    await adapter.putProject(forked, owner, { pendingSync: true });
    await adapter.addDirty(forkId);          // never stranded — retried at row 0a (invariant 7)

    // 2. Adopt the cloud version as canonical for the original id (durable before any dialog).
    const cloudProject = parseOodbo(cloudXml);
    const cloudHash    = await hashXml(cloudXml);
    const rec = commitClean(record ?? newSyncRecord(projectId, provider), {
      baseCloudRev: isAzure ? cloudMeta.cTag : cloudMeta.rev,
      baseCasRev:   isAzure ? cloudMeta.rev  : null,
      syncedHash:   cloudHash,
    });
    await adapter.commitProjectAndRecord(cloudProject, owner, rec, { pendingSync: false, lastSynced: nowIso() });

    // 3. Original's divergence now lives in the fork.
    await adapter.removeDirty(projectId);

    // Non-blocking notice; the resolution dialog (Keep A/B/both) is shown by the UI on open.
    onBadge({ type: 'forked', projectId, forkId, forkTitle: forked.title });
    return { forkId, forkTitle: forked.title };
  };
}
