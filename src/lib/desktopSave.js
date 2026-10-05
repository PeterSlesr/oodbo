// ── Desktop durability: mirror every project to real files in the AppData folder ────────────────
//
// IndexedDB alone isn't a strong "your writing is safe on this machine" guarantee. So on desktop every
// write is ALSO mirrored to files under %APPDATA%/io.oodbo.desktop/projects/<owner>/ :
//   • content         → <projectId>.oodbo          (the words)
//   • sync record + flags (trashed/deletedAt) → <projectId>.syncrecord.json   (the "sidecar")
// scoped per-owner so accounts never pool. For a PIN-protected account both files are encrypted with
// the account's data key (localVault); otherwise the .oodbo is plain, portable XML. No-op off desktop.
//
// AppData is AUTHORITATIVE (§3.2): desktopReconcile rebuilds IndexedDB from these files on launch, so an
// IDB wipe isn't data loss and fast-forward stays distinguishable from a real conflict (invariant 6).

import { save } from '@tauri-apps/plugin-dialog';
import { writeFile, mkdir, exists, readDir, readTextFile, remove } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { serializeOodbo } from './sync/canonical.js';
import { IS_TAURI } from './platform.js';
import { encryptText, decryptText } from './localVault.js';

// ── Mirror-on-write, throttled (≤ once per ~2s per project, trailing) — off the keystroke path. ───
const MIRROR_THROTTLE_MS = 2000;
const _mirrorPending = new Map();   // id -> { owner, project }  (freshest wins)
const _mirrorTimers  = new Map();   // id -> timeout handle

export function mirrorProjectToAppData(owner, project) {
  if (!IS_TAURI || !owner || !project?.id) return;
  _mirrorPending.set(project.id, { owner, project });
  if (_mirrorTimers.has(project.id)) return;                 // a flush is already scheduled (coalesce)
  _mirrorTimers.set(project.id, setTimeout(() => _flushMirror(project.id), MIRROR_THROTTLE_MS));
}

async function _flushMirror(id) {
  _mirrorTimers.delete(id);
  const item = _mirrorPending.get(id);
  if (!item) return;
  _mirrorPending.delete(id);
  try { await saveProjectXmlToAppData(item.owner, item.project.id, serializeOodbo(item.project)); } catch {}
}

export function removeProjectFromAppData(owner, projectId) {
  if (!IS_TAURI || !owner || !projectId) return;
  const t = _mirrorTimers.get(projectId);                    // cancel a pending mirror so a deleted file isn't re-created
  if (t) { clearTimeout(t); _mirrorTimers.delete(projectId); }
  _mirrorPending.delete(projectId);
  deleteAppDataProject(owner, projectId);
}

if (IS_TAURI && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    for (const id of [..._mirrorTimers.keys()]) { clearTimeout(_mirrorTimers.get(id)); _mirrorTimers.delete(id); _flushMirror(id); }
  });
}

// ── Directory setup (cache the promise; un-cache on failure so one transient error can't poison it). ─
let projectsDirPromise = null;
async function getProjectsDir() {
  if (!projectsDirPromise) {
    projectsDirPromise = (async () => {
      const dir = await join(await appDataDir(), 'projects');
      if (!(await exists(dir))) await mkdir(dir, { recursive: true });
      return dir;
    })().catch(err => { projectsDirPromise = null; throw err; });
  }
  return projectsDirPromise;
}

const ownerDirCache = new Map();
const sanitizeOwnerBucket = (o) => String(o).toLowerCase().replace(/[\\/:*?"<>|]/g, '_');
async function getOwnerDir(ownerBucket) {
  const key = sanitizeOwnerBucket(ownerBucket);
  if (!ownerDirCache.has(key)) {
    ownerDirCache.set(key, (async () => {
      const dir = await join(await getProjectsDir(), key);
      if (!(await exists(dir))) await mkdir(dir, { recursive: true });
      return dir;
    })().catch(err => { ownerDirCache.delete(key); throw err; }));
  }
  return ownerDirCache.get(key);
}

// ── Content (.oodbo) ─────────────────────────────────────────────────────────────────────────────
export async function saveProjectXmlToAppData(ownerBucket, projectId, xml) {
  if (!projectId || !ownerBucket) return;
  try {
    const dir     = await getOwnerDir(ownerBucket);
    const content = await encryptText(xml);                  // plaintext XML when no vault; ciphertext for a PIN account
    await writeFile(await join(dir, `${projectId}.oodbo`), new TextEncoder().encode(content));
  } catch {}
}

export async function listAppDataProjectIds(ownerBucket) {
  if (!ownerBucket) return [];
  try {
    const dir = await getOwnerDir(ownerBucket);
    const entries = await readDir(dir);
    return entries.filter(e => e.isFile && e.name?.endsWith('.oodbo')).map(e => e.name.replace(/\.oodbo$/, ''));
  } catch { return []; }
}

export async function readAppDataProjectXml(ownerBucket, projectId) {
  if (!ownerBucket) return null;
  try {
    const dir = await getOwnerDir(ownerBucket);
    const raw = await readTextFile(await join(dir, `${projectId}.oodbo`));
    return await decryptText(raw);                           // decrypts a vault file; plaintext as-is; null if locked
  } catch { return null; }
}

// ── Sync-record sidecar (§3.2) — record + trashed/deletedAt next to the content. Encrypted for vault. ─
export async function writeAppDataSidecar(ownerBucket, projectId, obj) {
  if (!projectId || !ownerBucket) return;
  try {
    const dir     = await getOwnerDir(ownerBucket);
    const content = await encryptText(JSON.stringify(obj));
    await writeFile(await join(dir, `${projectId}.syncrecord.json`), new TextEncoder().encode(content));
  } catch {}
}

export async function readAppDataSidecar(ownerBucket, projectId) {
  if (!ownerBucket) return null;
  try {
    const dir = await getOwnerDir(ownerBucket);
    const raw = await readTextFile(await join(dir, `${projectId}.syncrecord.json`));
    const txt = await decryptText(raw);
    return txt == null ? null : JSON.parse(txt);
  } catch { return null; }
}

// Terminal delete of a project's on-disk copies (content + sidecar).
export async function deleteAppDataProject(ownerBucket, projectId) {
  if (!ownerBucket || !projectId) return;
  try {
    const dir = await getOwnerDir(ownerBucket);
    for (const name of [`${projectId}.oodbo`, `${projectId}.syncrecord.json`]) {
      const p = await join(dir, name);
      if (await exists(p)) await remove(p);
    }
  } catch {}
}

// ── Forward-mode crash-recovery drafts (mirrors lib/forwardDraft.js to disk). Not owner-scoped —
// recovery filters by the open user's own projects. Keyed per project+chapter. Encrypted for vault. ──
let fwdDraftsDirPromise = null;
async function getForwardDraftsDir() {
  if (!fwdDraftsDirPromise) {
    fwdDraftsDirPromise = (async () => {
      const dir = await join(await appDataDir(), 'forward-drafts');
      if (!(await exists(dir))) await mkdir(dir, { recursive: true });
      return dir;
    })().catch(err => { fwdDraftsDirPromise = null; throw err; });
  }
  return fwdDraftsDirPromise;
}
const fwdDraftFile = (projectId, chapterId) => `${projectId}.${chapterId}.fwddraft.json`;

export async function writeForwardDraftAppData(projectId, chapterId, obj) {
  if (!IS_TAURI || !projectId || !chapterId) return;
  try {
    const dir = await getForwardDraftsDir();
    await writeFile(await join(dir, fwdDraftFile(projectId, chapterId)), new TextEncoder().encode(await encryptText(JSON.stringify(obj))));
  } catch {}
}

export async function readForwardDraftAppData(projectId) {
  if (!IS_TAURI || !projectId) return null;
  try {
    const dir     = await getForwardDraftsDir();
    const entries = await readDir(dir);
    const mine    = [];
    for (const e of entries) {
      if (e.isFile && e.name?.startsWith(`${projectId}.`) && e.name.endsWith('.fwddraft.json')) {
        try { const txt = await decryptText(await readTextFile(await join(dir, e.name))); if (txt != null) mine.push(JSON.parse(txt)); } catch {}
      }
    }
    if (!mine.length) return null;
    mine.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return mine[0];
  } catch { return null; }
}

export async function removeForwardDraftAppData(projectId, chapterId) {
  if (!IS_TAURI || !projectId || !chapterId) return;
  try {
    const dir = await getForwardDraftsDir();
    const p   = await join(dir, fwdDraftFile(projectId, chapterId));
    if (await exists(p)) await remove(p);
  } catch {}
}

// ── Native export/save (the <a download> blob trick doesn't work in Tauri's webview) ──────────────
export async function saveBlobToDisk(blob, filename) {
  try {
    const ext  = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : undefined;
    const path = await save({ defaultPath: filename, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined });
    if (!path) return false;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return true;
  } catch { return false; }
}
