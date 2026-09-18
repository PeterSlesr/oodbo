// Crash-recovery buffer for an in-progress Forward-mode session.
//
// Everywhere else, durability is already solved: the editor writes the active project to
// IDB on a typing debounce, so a crash costs at most that debounce window. Forward mode
// was the one hole — its text lived only in React state until you published, so a crash
// mid-session lost the whole draft. This persists that text (debounced, by the Editor) to
// IDB so Forward mode costs no more than an editor edit would.
//
// LOCAL ONLY — never synced. It's a transient draft, not a committed edit; syncing partial
// drafts would only invite conflicts, and crash recovery only ever protects the surface you
// were typing on.
//
// Keyed per PROJECT + CHAPTER (`forwardDraft:<projectId>:<chapterId>`) in the existing
// `syncMeta` store — no schema-version bump, and crucially no cross-draft clobber: a crashed
// draft in project A is a different key from a new session in project B, so starting to write
// in B can never overwrite A's unrecovered draft. A session can only ever overwrite the draft
// for the very chapter it is writing into — the same logical draft.
//
// Lifecycle: written while a session is active; CLEARED on a clean exit (publish or cancel).
// A draft still present at startup therefore means the last session did not exit cleanly —
// that presence is the recovery signal, no flags needed.
import { openDB } from './sync/store.js';

const PREFIX = 'forwardDraft:';
const keyFor = (projectId, chapterId) => `${PREFIX}${projectId}:${chapterId}`;

function reqToPromise(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

// draft: { projectId, chapterId, text }. updatedAt is stamped here.
export async function saveForwardDraft(draft) {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('syncMeta', 'readwrite');
      tx.objectStore('syncMeta').put({ key: keyFor(draft.projectId, draft.chapterId), value: { ...draft, updatedAt: Date.now() } });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch { /* best-effort buffer — a failed write just narrows the recovery window */ }
}

export async function clearForwardDraft(projectId, chapterId) {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('syncMeta', 'readwrite');
      tx.objectStore('syncMeta').delete(keyFor(projectId, chapterId));
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch { /* ignore */ }
}

// The most-recent pending draft for a project (null if none). Enumerates syncMeta and filters
// by the project prefix — so drafts for other projects are never touched or considered.
export async function loadForwardDraft(projectId) {
  try {
    const db  = await openDB();
    const all = await reqToPromise(db.transaction('syncMeta', 'readonly').objectStore('syncMeta').getAll());
    const mine = all.filter(r =>
      typeof r.key === 'string' && r.key.startsWith(`${PREFIX}${projectId}:`) && r.value?.text?.trim());
    if (!mine.length) return null;
    mine.sort((a, b) => (b.value.updatedAt || 0) - (a.value.updatedAt || 0));
    return mine[0].value;
  } catch { return null; }
}
