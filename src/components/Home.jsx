import React, { useState, useEffect, useRef, useMemo } from 'react';
import { searchAll } from '../lib/search/index.js';
import { CRT_THEME } from '../lib/themes.js';
import { btn, dialog } from '../lib/ui.js';
import BodyScrollLock from '../lib/BodyScrollLock.jsx';
import JSZip from 'jszip';
import { exportDocx } from '../lib/docx.js';
import { exportPdf }  from '../lib/pdf.js';
import { publishShare, unpublishShare } from '../lib/share.js';
import { getShareAccessToken } from '../lib/providerSession.js';
import { encodeEntry, decodeEntry, hasVaultKey } from '../lib/localVault.js';
import { openDB } from '../lib/sync/store.js';   // single IDB opener (v4) — see store.js
import { getEngine, getSyncBadges, resolveConflict, reassignFork } from '../lib/sync/client.js';
import ConflictDialog from './ConflictDialog.jsx';
import ConflictTree from './ConflictTree.jsx';
import OfflineBanner from './OfflineBanner.jsx';
import ReconnectBanner from './ReconnectBanner.jsx';
import IdleScreen from './IdleScreen.jsx';
import { useOnline } from '../lib/useOnline.js';
import { serializeOodbo, parseOodbo } from '../lib/sync/canonical.js';   // single serializer

const MS_STORE_URL  = 'https://marketplace.microsoft.com/en-us/product/office/WA200011123';

// Single serializer/parser (lib/sync/canonical.js). Note: the old local projectToXml here
// dropped <type> and cursorPosition; canonical preserves them, so exports are now complete.
const projectToXml = serializeOodbo;
const xmlToProject = parseOodbo;

// ── IDB helpers ────────────────────────────────────────────────────────────────
const openIDB = openDB;   // single opener aliased from lib/sync/store.js (v4)
const genId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);

async function readProjectsFromIDB(ownerEmail) {
  try {
    const db  = await openIDB();
    const all = await new Promise(res => {
      const req = db.transaction('projects', 'readonly').objectStore('projects').getAll();
      req.onsuccess = () => res(req.result ?? []);
      req.onerror   = () => res([]);
    });
    const mine = all.filter(e => (ownerEmail ? e.owner === ownerEmail : !e.owner) && !e.trashed);
    const decoded = await Promise.all(mine.map(e => decodeEntry(e)));   // decrypt PIN-vault entries (pass-through otherwise)
    return decoded.map(e => e.data).filter(Boolean);
  } catch { return []; }
}

// Full data for TRASHED projects — for the opt-in "search bin". Returns whole project objects
// (chapters/content) so search can match them; the active reader above excludes trashed.
async function readTrashedFromIDB(ownerEmail) {
  try {
    const db  = await openIDB();
    const all = await new Promise(res => {
      const req = db.transaction('projects', 'readonly').objectStore('projects').getAll();
      req.onsuccess = () => res(req.result ?? []);
      req.onerror   = () => res([]);
    });
    const mine = all.filter(e => (ownerEmail ? e.owner === ownerEmail : !e.owner) && e.trashed && (e.data || e.enc));
    const decoded = await Promise.all(mine.map(e => decodeEntry(e)));
    return decoded.map(e => e.data).filter(Boolean);
  } catch { return []; }
}

async function deleteFromIDB(id) {
  try {
    const db = await openIDB();
    const tx = db.transaction(['projects', 'wordAssets', 'handles'], 'readwrite');
    tx.objectStore('projects').delete(id);
    tx.objectStore('wordAssets').delete(id);
    tx.objectStore('handles').delete(id);
  } catch {}
}

// Mark an IDB entry as trashed (keeps the data so sync can push it as .trash)
async function markTrashedInIDB(id, project, ownerEmail) {
  try {
    const db = await openIDB();
    const existing = await new Promise(res => {
      const req = db.transaction('projects', 'readonly').objectStore('projects').get(id);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => res(null);
    });
    // existing keeps its (possibly encrypted) data as-is; the fallback carries plaintext `data`, so
    // run it through encodeEntry (encrypts under an active PIN vault, pass-through otherwise).
    const entry = existing
      ? { ...existing, trashed: true, deletedAt: new Date().toISOString() }
      : await encodeEntry({ id, owner: ownerEmail || '', pendingSync: false, lastSynced: null,
          trashed: true, deletedAt: new Date().toISOString(), data: project });
    await new Promise((res, rej) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(entry);
      tx.oncomplete = res; tx.onerror = rej;
    });
    // wordAssets and handles are no longer needed for trashed projects
    try {
      const tx2 = db.transaction(['wordAssets', 'handles'], 'readwrite');
      tx2.objectStore('wordAssets').delete(id);
      tx2.objectStore('handles').delete(id);
    } catch {}
  } catch {}
}

// Engineless (unpaid / local-only) restore: flip trashed→false directly in IDB, mirror of
// markTrashedInIDB. The sync engine has restoreProject(); users without an engine had no restore
// path (handleRestore bailed on !eng), so the bin's Restore silently no-opped for them.
async function restoreInIDB(id) {
  try {
    const db = await openIDB();
    const existing = await new Promise(res => {
      const req = db.transaction('projects', 'readonly').objectStore('projects').get(id);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => res(null);
    });
    if (!existing) return false;
    const entry = { ...existing, trashed: false, deletedAt: null };
    await new Promise((res, rej) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(entry);
      tx.oncomplete = res; tx.onerror = rej;
    });
    return true;
  } catch { return false; }
}

async function writeProjectToIDB(project, ownerEmail) {
  try {
    const db = await openIDB();
    const entry = await encodeEntry({ id: project.id, owner: ownerEmail || '', pendingSync: true, lastSynced: null,
                      trashed: false, deletedAt: null, data: project });
    await new Promise((res, rej) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(entry);
      tx.oncomplete = res;
      tx.onerror    = rej;
    });
  } catch {}
}

function mergeIntoLocalStorage(projects) {
  try {
    if (hasVaultKey()) return;   // PIN vault: never mirror plaintext projects to localStorage
    const existing = JSON.parse(localStorage.getItem('fwd:projects') || '[]');
    const merged   = [...existing];
    for (const p of projects) {
      const idx = merged.findIndex(e => e.id === p.id);
      if (idx >= 0) merged[idx] = p; else merged.push(p);
    }
    localStorage.setItem('fwd:projects', JSON.stringify(merged));
  } catch {}
}

// ── Project helpers ────────────────────────────────────────────────────────────
function wordCount(project) {
  return (project.chapters || []).reduce((sum, ch) => {
    return sum + (ch.content || '').trim().split(/\s+/).filter(Boolean).length;
  }, 0);
}

function lastUpdatedIso(project) {
  const dates = (project.chapters || [])
    .map(ch => ch.updatedAt || ch.createdAt)
    .filter(Boolean).sort().reverse();
  return dates[0] || project.updatedAt || project.createdAt || '';
}

// "1 word" / "2 words" — avoids the "1 words" that showed on single-word projects.
const plWords = (n) => `${Number(n).toLocaleString()} word${Number(n) === 1 ? '' : 's'}`;

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d   = new Date(iso);
    const now = new Date();
    // Always an absolute date (no "today"/"yesterday"/"N days ago"). Year shown only when
    // it differs from the current year.
    return d.toLocaleDateString('en', {
      month: 'short', day: 'numeric',
      ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    });
  } catch { return ''; }
}

// Absolute date + time (no seconds) — used in the bin so two same-titled, same-day deletions
// are distinguishable.
function formatDateTime(iso) {
  if (!iso) return '';
  try {
    return `${formatDate(iso)}, ${new Date(iso).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })}`;
  } catch { return formatDate(iso); }
}

// Compact "last synced" — time only when it's today, else short date + time. Never seconds.
function formatSync(iso) {
  try {
    const d = new Date(iso);
    const t = d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t : `${formatDate(iso)} ${t}`;
  } catch { return ''; }
}

// Relative "synced X ago" for the header sync line (designer mockup 4b). Recent stays
// relative; older than a day falls back to the compact absolute so it never lies by much.
function formatSyncAgo(iso) {
  try {
    const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (secs < 45) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
    return formatSync(iso);
  } catch { return ''; }
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function safeName(title) {
  return (title || 'oodbo').replace(/[^a-z0-9]/gi, '-');
}

// Compact LOCAL timestamp for export filenames: yyyymmddhhmmss.
function fileStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ── Constants ──────────────────────────────────────────────────────────────────
const PROJECT_TYPES = [
  { type: 'journal',    label: 'Journal',    desc: 'Dated entries, written forward' },
  { type: 'story',      label: 'Story',      desc: 'Long-form narrative' },
  { type: 'essay',      label: 'Essay',      desc: 'Structured argument or analysis' },
  { type: 'brainstorm', label: 'Brainstorm', desc: 'Rapid capture, no structure needed' },
  { type: 'log',        label: 'Log',        desc: 'Record-keeping and notes' },
];

const SORT_OPTIONS = [
  { value: 'updated',   label: 'Recently updated' },
  { value: 'type-name', label: 'Type then name' },
  { value: 'name',      label: 'Name A–Z' },
];

// ── Component ──────────────────────────────────────────────────────────────────
export default function Home({ user, onOpenProject, onNewProject, onSignOut, onSync, syncTick = 0, syncReconnect = false, onReconnect = null }) {
  const [projects,       setProjects]       = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [query,          setQuery]          = useState('');   // what's typed in the search box
  const [submittedQuery, setSubmittedQuery] = useState('');   // what's actually searched (on Enter / icon)
  const [includeBin,     setIncludeBin]     = useState(false); // opt-in: also search the recycle bin
  const [binSearchData,  setBinSearchData]  = useState([]);    // full trashed-project data for bin search
  const [sortMenuOpen,   setSortMenuOpen]   = useState(false); // sort text-button dropdown
  const [menuRow,        setMenuRow]        = useState(null);  // project id whose mobile ··· menu is open
  const sortRef = useRef(null);
  const rowMenuRef = useRef(null);
  const [sort,           setSort]           = useState(() => localStorage.getItem(`fwd:home-sort:${user?.email || ''}`) || 'updated');
  const [showTypePicker, setShowTypePicker] = useState(false);
  const [notice,         setNotice]         = useState(null);   // themed alert replacement: { title, body }
  const [syncing,          setSyncing]          = useState(false);
  const [deleteTarget,     setDeleteTarget]     = useState(null);
  const [syncBadges,       setSyncBadges]       = useState({});   // §8.2/§10 — derived from records at render
  const [conflictTarget,   setConflictTarget]   = useState(null);  // { projectId, forkId, original, conflicted }
  const [expandedConflictId, setExpandedConflictId] = useState(null);  // which row's conflict tree is open
  const online = useOnline();
  // Idle → limbo. 'active' | 'prompt' (still here?) | 'screensaver' (the animation). Homepage
  // only, so the timers live and die with this mount. A ref mirrors the stage for the raw event
  // listeners (which close over the first render otherwise).
  const [idleStage, setIdleStage] = useState('active');
  const idleStageRef  = useRef('active');
  const lastActiveRef = useRef(Date.now());
  const [deleteLinkAction, setDeleteLinkAction] = useState('keep'); // 'keep' | 'deactivate'
  const [showBin,          setShowBin]          = useState(false);
  const [binProjects,      setBinProjects]      = useState([]);
  const [binQuery,         setBinQuery]         = useState('');   // filters the bin by title (within the bin only)
  const [toast,            setToast]            = useState('');   // brief fading confirmation (e.g. "Copied")
  const toastTimer = useRef(null);
  const [binLoading,       setBinLoading]       = useState(false);
  const [permDeleteTarget, setPermDeleteTarget] = useState(null);
  const [confirmEmptyBin,  setConfirmEmptyBin]  = useState(false);
  const [emptyingBin,      setEmptyingBin]      = useState(false);   // true while the purge runs (shows "Deleting…")
  const [restoringId,      setRestoringId]      = useState(null);    // projectId being restored (shows "Restoring…")
  const [exportTarget,   setExportTarget]   = useState(null);
  const [shareTarget,    setShareTarget]    = useState(null);
  const [shareLinks,     setShareLinks]     = useState({});   // { [projectId]: driveFileId } — derived from project.shares; shareUrl(fileId) = /s/ link
  const [shareStatuses,  setShareStatuses]  = useState(() => {
    try { return JSON.parse(localStorage.getItem(`fwd:share-statuses:${user?.email || ''}`) || '{}'); } catch { return {}; }
  });
  const [shareLoading,   setShareLoading]   = useState(false);
  const [shareCopied,    setShareCopied]    = useState(false);
  const [showShares,     setShowShares]     = useState(false);  // "shared links" manager modal
  const [sharesList,     setSharesList]     = useState(null);   // null = loading; [] = loaded/empty
  const [sharesBusy,     setSharesBusy]     = useState(null);   // share id currently being actioned
  const [sharesCopied,   setSharesCopied]   = useState(null);   // share id just copied
  const [isMobile,       setIsMobile]       = useState(() => window.innerWidth < 768);

  // shareLinks (projectId → Drive fileId) derived from the synced project.shares; shareUrl(fileId)
  // yields the /s/ link. Single source of truth = project.shares (cross-device).
  useEffect(() => {
    const map = {};
    for (const p of projects) {
      const info = (p.shares || {})['__project__'];
      if (info?.fileId) map[p.id] = info.fileId;
    }
    setShareLinks(map);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = e => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  const importRef = useRef(null);

  // Inject spinner keyframes once
  useEffect(() => {
    if (document.getElementById('home-spin-style')) return;
    const el = document.createElement('style');
    el.id = 'home-spin-style';
    el.textContent = '@keyframes home-spin { to { transform: rotate(360deg); } } @keyframes home-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } } @keyframes home-toast { 0% { opacity: 0; transform: translateX(-50%) translateY(6px); } 12% { opacity: 1; transform: translateX(-50%) translateY(0); } 80% { opacity: 1; } 100% { opacity: 0; } }';
    document.head.appendChild(el);
  }, []);

  // Global CSS sets overflow:hidden on html/body/#root for the editor.
  // Home needs normal document scroll — override on mount, restore on unmount.
  useEffect(() => {
    const els = [document.documentElement, document.body, document.getElementById('root')];
    els.forEach(el => { if (el) el.style.overflow = 'auto'; });
    return () => els.forEach(el => { if (el) el.style.overflow = ''; });
  }, []);

  useEffect(() => {
    readProjectsFromIDB(user?.email).then(ps => {
      setProjects(ps);
      setLoading(false);
    });
  }, []);

  // Keep the project list in step with what the engine reports. A fork born in a background
  // sweep bumps syncTick, which lights the amber dot — but the badge derives from IDB while
  // this list is React state, so without re-reading here the new fork isn't in `projects` yet
  // and the tree (which looks the fork up in `projects`) opens to nothing: a ring, no panel.
  useEffect(() => {
    if (!syncTick) return;
    let cancelled = false;
    readProjectsFromIDB(user?.email).then(ps => { if (!cancelled) setProjects(ps); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncTick]);

  // Reset link action choice whenever the delete target changes
  useEffect(() => { setDeleteLinkAction('keep'); }, [deleteTarget]);

  // ── Idle → limbo (10 min → "still here?", +5 min → screensaver) ──
  // A full sweep runs at BOTH ends: on the way in (flush pending local work before the device
  // likely sleeps) and on the way out (pull anything that changed elsewhere) — the same
  // sweepAll as login, so you leave and return on freshly-synced state. A deliberate action
  // (click/tap/key/scroll) wakes it; passive mouse-move keeps you "active" while using the app
  // but does NOT wake — a stray cursor bump shouldn't fire a sweep. Suppressed while a conflict
  // is open (don't cover a decision in progress).
  useEffect(() => { idleStageRef.current = idleStage; }, [idleStage]);
  useEffect(() => {
    const PROMPT_MS = 10 * 60 * 1000, SAVER_MS = 15 * 60 * 1000;
    const RESET = ['pointermove', 'keydown', 'wheel', 'scroll', 'pointerdown', 'touchstart'];
    const WAKE  = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

    function onReset() { if (idleStageRef.current === 'active') lastActiveRef.current = Date.now(); }
    function onWake()  {
      if (idleStageRef.current === 'active') return;
      const wasSaver = idleStageRef.current === 'screensaver';
      lastActiveRef.current = Date.now();
      setIdleStage('active');
      if (wasSaver) runSweep();             // return-and-sweep, like login
    }
    async function runSweep() {
      const eng = getEngine();
      try {
        setSyncing(true);
        if (eng) { eng.reset(); await eng.sweepAll({ userInitiated: true }); }
        setProjects(await readProjectsFromIDB(user?.email));
        setSyncBadges(await getSyncBadges());
      } finally { setSyncing(false); }
    }

    RESET.forEach(e => window.addEventListener(e, onReset, { passive: true }));
    WAKE.forEach(e => window.addEventListener(e, onWake, { passive: true }));
    const id = setInterval(() => {
      if (idleStageRef.current === 'screensaver') return;
      if (conflictTarget) { lastActiveRef.current = Date.now(); return; }   // don't limbo over a conflict
      const idle = Date.now() - lastActiveRef.current;
      if (idle >= SAVER_MS)      { setIdleStage('screensaver'); runSweep(); }   // flush on the way in
      else if (idle >= PROMPT_MS) setIdleStage(s => (s === 'active' ? 'prompt' : s));
    }, 15000);

    return () => {
      RESET.forEach(e => window.removeEventListener(e, onReset));
      WAKE.forEach(e => window.removeEventListener(e, onWake));
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email, conflictTarget]);

  async function handleSync() {
    if (!onSync || syncing) return;
    setSyncing(true);
    try {
      await onSync();
      // Re-read IDB in case new projects arrived
      const fresh = await readProjectsFromIDB(user?.email);
      setProjects(fresh);
    } finally {
      setSyncing(false);
    }
  }

  function handleSort(val) {
    setSort(val);
    localStorage.setItem(`fwd:home-sort:${user?.email || ''}`, val);
  }

  // ── Share link helpers ─────────────────────────────────────────────────────

  // Returns all active [key, shareId] pairs belonging to a project (project + chapter shares)
  function activeSharesFor(projectId) {
    return Object.entries(shareLinks)
      .filter(([key]) => key === projectId || key.startsWith(`${projectId}:`))
      .filter(([, sid]) => (shareStatuses[sid] ?? 'active') === 'active');
  }

  // Unpublish every share (project + sections) a project has — deletes the public files from
  // the user's Drive so a deleted project leaves no live links behind.
  async function deactivateProjectShares(projectId) {
    const p = projects.find(x => x.id === projectId);
    const fileIds = Object.values(p?.shares || {}).map(sh => sh?.fileId).filter(Boolean);
    for (const fileId of fileIds) {
      try { await unpublishShare({ getShareToken: getShareAccessToken, fileId }); } catch {}
    }
    setShareLinks(prev => { const u = { ...prev }; delete u[projectId]; return u; });
  }

  // ── Delete project — moves to recycle bin ─────────────────────────────────
  async function doDeleteProject(p, linkAction) {
    // Trash via the engine: marks the IDB entry trashed (with deletedAt) and arms the outbox,
    // then kicks an immediate sweep so the cloud file is renamed to .trash (§9 T1) NOW rather
    // than on the next 60s tick — restore/purge already propagate immediately, so this makes
    // trash consistent. If the project was edited elsewhere since, edit-beats-delete kicks in.
    // Falls back to local-only trash if there's no engine (should not happen for a signed-in user).
    if (getEngine()) {
      await getEngine().trashProject(p.id);
      getEngine().sweepDirty().catch(() => {});
    } else {
      await markTrashedInIDB(p.id, p, user?.email);
    }
    try {
      if (!hasVaultKey()) {   // vault accounts keep no plaintext projects mirror to prune
        const existing = JSON.parse(localStorage.getItem('fwd:projects') || '[]');
        localStorage.setItem('fwd:projects', JSON.stringify(existing.filter(x => x.id !== p.id)));
      }
    } catch {}
    setProjects(prev => prev.filter(x => x.id !== p.id));
    setDeleteTarget(null);

    if (linkAction === 'deactivate') deactivateProjectShares(p.id);
  }

  // ── Recycle bin ────────────────────────────────────────────────────────────
  async function openBin() {
    setShowBin(true);
    setBinLoading(true);
    try {
      // Bin = the trashed subset of the synced project set. Under §4 full-parity the launch sweep
      // pulls every cloud .trash into IDB as a trashed entry (engine PULL_TRASH), so the bin is
      // identical on every device and works offline — no live cloud fetch needed.
      const db = await openIDB();
      const allEntries = await new Promise(res => {
        const req = db.transaction('projects', 'readonly').objectStore('projects').getAll();
        req.onsuccess = () => res(req.result ?? []);
        req.onerror   = () => res([]);
      });
      const localTrashed = allEntries.filter(e =>
        (user?.email ? e.owner === user.email : !e.owner) && e.trashed
      );
      // Most-recently-deleted first; entries with no deletedAt sink to the bottom.
      localTrashed.sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
      const decoded = await Promise.all(localTrashed.map(e => decodeEntry(e)));   // reveal PIN-vault titles/counts
      setBinProjects(decoded.map(e => ({
        projectId: e.id,
        title:     e.data?.title || 'Untitled',
        words:     e.data ? wordCount(e.data) : 0,   // distinguishes identical titles in the bin
        deletedAt: e.deletedAt,
        fromIDB:   true,
      })));
    } catch {}
    setBinLoading(false);
  }

  // Restore via the engine: it renames the cloud file back to .oodbo and un-trashes the local
  // entry. A bin item this device never had locally (trashed on another device) needs no
  // special case — the cloud file goes active and the sweep below pulls it in (row 0b).
  // If the cloud call fails (offline) we leave it in the bin rather than pretend it restored.
  // Badges are derived from the sync records each time the list changes, never stored — so
  // they can't drift from the truth. A fork found by a background sweep badges the list here
  // rather than ambushing the user with a modal (§8.2); the dialog waits until they open it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const b = await getSyncBadges();
      if (!cancelled) setSyncBadges(b);
    })();
    return () => { cancelled = true; };
    // syncTick: the engine settles records from background sweeps (a Drive upload stays
    // "syncing…" for ≥60s by design), and that changes no project — so without it the badge
    // would stay on screen until a reload.
    // online: "not backed up" depends on reachability, which flips on a connectivity change
    // with no record change behind it. Without this, going offline while sitting on the list
    // would leave a dirty project showing grey "syncing" instead of red — the sweep that would
    // eventually notice can't run while offline.
  }, [projects, syncTick, online]);

  // Open a single fork's two-way compare. Everything is already local (fork-first put both
  // versions on disk), so there's nothing to fetch — the original and the fork are just two
  // projects we already hold.
  function compareFork(projectId, forkId) {
    const conflicted = projects.find(p => p.id === forkId);      // the version that was split off
    const original   = projects.find(p => p.id === projectId);   // the one that kept the id and title
    if (conflicted && original) setConflictTarget({ projectId, forkId, original, conflicted });
  }

  // The conflict tree that opens under a row when its amber dot is clicked. Built from the
  // badge's fork LIST (not a single id), so a project forked twice shows both branches and the
  // count is the real one.
  function conflictTreeFor(id) {
    const b = syncBadges[id];
    if (!b) return null;
    // The dot can sit on either half. From the original we already hold the fork list; from a
    // fork, hop to its original and show the whole family so a sibling fork isn't hidden.
    const originalId = b.conflict ? id : b.ofProjectId;
    const original   = projects.find(p => p.id === originalId);
    const forkList   = (syncBadges[originalId]?.forks) || [];
    if (!original || !forkList.length) return null;
    const forks = forkList
      .map(f => {
        const project = projects.find(p => p.id === f.forkId);
        if (!project) return null;
        // The fork's title is "{original} (conflicted — Device, date)"; strip the shared stem
        // so the branch reads as just what distinguishes it.
        const branchLabel = (project.title || '').startsWith(original.title)
          ? '…' + (project.title.slice(original.title.length).trim() || project.title)
          : (project.title || 'Untitled');
        return { project, branchLabel, onCompare: () => compareFork(originalId, f.forkId) };
      })
      .filter(Boolean);
    if (!forks.length) return null;
    return <ConflictTree original={original} forks={forks} />;
  }

  // Status is a small flat dot with hover text, not a wordy pill. Only conflict is actionable —
  // clicking it toggles the tree open under the row. Red = unsynced work that isn't currently
  // reaching the cloud; grey = on its way up; clean shows nothing. All flat single colours.
  function badgeFor(id) {
    const b = syncBadges[id];
    if (!b) return null;
    if (b.conflict || b.conflictFork) {
      const open = expandedConflictId === id;
      return (
        <span
          style={{ ...s.statusDot, background: '#C88A15', cursor: 'pointer', outline: open ? '2px solid #e6d9a8' : 'none', outlineOffset: 2 }}
          title="Conflict requires resolution"
          role="button"
          tabIndex={0}
          aria-label="Conflict requires resolution"
          onClick={e => { e.stopPropagation(); setExpandedConflictId(open ? null : id); }}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); setExpandedConflictId(open ? null : id); } }}
        />
      );
    }
    if (b.notBackedUp) return <span style={{ ...s.statusDot, background: '#C0392B' }} title="Changes not yet backed up" aria-label="Changes not yet backed up" />;
    if (b.pending || b.syncing) return <span style={{ ...s.statusDot, background: '#A8A69C' }} title="Syncing" aria-label="Syncing" />;
    return null;
  }

  // Resolving from Home stays on Home: the list is where you can see the result. Mirrors
  // Editor.handleResolveConflict — the pairing ends before the loser is binned, so restoring
  // it later can't resurrect a decision already made.
  async function handleResolveConflict(choice) {
    const { projectId, forkId } = conflictTarget || {};
    const eng = getEngine();
    const loser = choice === 'conflicted' ? projectId : choice === 'original' ? forkId : null;
    // Keeping the fork bins the original. If that original has OTHER forks, hand them to the
    // surviving fork first so they aren't stranded pointing at a trashed project — the kept
    // version becomes the new trunk (see reassignFork).
    if (choice === 'conflicted') {
      const siblings = (syncBadges[projectId]?.forks || []).filter(f => f.forkId !== forkId);
      for (const sib of siblings) await reassignFork(sib.forkId, forkId);
    }
    await resolveConflict(forkId);
    if (loser && eng) { await eng.trashProject(loser); eng.sweepDirty().catch(() => {}); }   // propagate the loser's bin now, like the manual × bin
    setConflictTarget(null);
    const fresh = await getSyncBadges();
    // Keep the tree open only while the row it hangs under is still part of a conflict —
    // either as the trunk (more branches remain) or as a fork (opened from that dot).
    setExpandedConflictId(id => (id && (fresh[id]?.conflict || fresh[id]?.conflictFork) ? id : null));
    setProjects(await readProjectsFromIDB(user?.email));
    setSyncBadges(fresh);
  }

  function showToast(msg) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 1800);
  }

  // Intentional fork: duplicate a project as a new, independent one titled "<title> yyyy-mm-dd"
  // (the fork date convention). New project + chapter ids so nothing collides; no share links
  // carry over (they're keyed to the original's id). Local + synced like any new project — no paywall.
  async function handleCopyProject(p) {
    try {
      const ymd = new Date().toISOString().slice(0, 10);   // yyyy-mm-dd
      const now = new Date().toISOString();
      const copy = structuredClone(p);
      copy.id              = genId();
      copy.title           = `${p.title || 'Untitled'} ${ymd}`;
      copy.createdAt       = now;
      copy.updatedAt       = now;
      (copy.chapters || []).forEach(ch => { ch.id = genId(); });
      copy.activeChapterId = copy.chapters?.[0]?.id || null;
      await writeProjectToIDB(copy, user?.email);
      getEngine()?.markDirty(copy.id, copy);
      setProjects(await readProjectsFromIDB(user?.email));
      showToast('Copied');
    } catch { setNotice({ title: 'Copy failed', body: 'Could not copy the project.' }); }
  }

  async function handleRestore(f) {
    if (restoringId) return;                         // one restore at a time (mirrors the empty-bin flow)
    const eng = getEngine();
    setRestoringId(f.projectId);
    let restored = false;
    try {
      if (eng) {
        await eng.restoreProject(f.projectId);       // local untrash — authoritative + reliable
        restored = true;
        await eng.syncOne(f.projectId, { userInitiated: true });  // push now; the spinner covers this
      } else {
        // Engineless (unpaid / local-only): untrash directly in IDB — no cloud to push to.
        restored = await restoreInIDB(f.projectId);
      }
    } catch { /* cloud push deferred (transient) — background sweeps retry it */ }
    finally {
      // Drop it from the bin as long as the LOCAL restore succeeded, even if the cloud push threw.
      // (Was the "stays in the bin the first time, works the second" bug: a transient syncOne error
      // skipped the UI update while the project was already untrashed in IDB.)
      if (restored) {
        setBinProjects(prev => prev.filter(x => x.projectId !== f.projectId));
        setBinSearchData(prev => prev.filter(x => x.id !== f.projectId));  // leave the bin search results too
        try { setProjects(await readProjectsFromIDB(user?.email)); } catch {}
      }
      setRestoringId(null);
    }
  }

  // Restore button with the same spinner as the empty-bin flow, in the constructive (green) colour.
  // While any restore runs, the others dim + disable (one at a time), matching the delete UX.
  const restoreButton = (pid) => {
    const busy = restoringId === pid;
    return (
      <button
        style={{ ...s.exportBtn,
          ...(busy ? { color: '#567a4d', borderColor: '#567a4d', cursor: 'default' }
                   : (restoringId ? { opacity: 0.5, cursor: 'default' } : {})) }}
        onClick={() => handleRestore({ projectId: pid })}
        disabled={!!restoringId}
      >
        {busy
          ? <><span style={{ display: 'inline-block', animation: 'home-spin 0.7s linear infinite' }}>↻</span> Restoring…</>
          : 'restore'}
      </button>
    );
  };

  async function handlePermDelete(f) {
    if (emptyingBin) return;
    setEmptyingBin(true);
    try {
      // Deactivate any share links — mandatory on permanent delete
      await deactivateProjectShares(f.projectId);
      const eng = getEngine();
      if (eng) await eng.purgeProject(f.projectId);   // cloud file + local content + record + outbox
      else     await deleteFromIDB(f.projectId);
      setBinProjects(prev => prev.filter(x => x.projectId !== f.projectId));
      setBinSearchData(prev => prev.filter(x => x.id !== f.projectId));  // leave the bin search results too
      setPermDeleteTarget(null);
    } finally {
      setEmptyingBin(false);
    }
  }

  async function handleEmptyBin() {
    if (emptyingBin) return;
    setEmptyingBin(true);
    try {
      // With a search filter active, empty ONLY the matches; otherwise the whole bin.
      const targets = shownBin;
      await Promise.all(targets.map(f => deactivateProjectShares(f.projectId)));
      const eng = getEngine();
      if (eng) {
        // ONE batched purge — a single tombstone-manifest write for all of them. Fanning out to
        // per-project purges raced the manifest and lost most tombstones (the "not 49 ids" bug).
        await eng.purgeProjects(targets.map(f => f.projectId)).catch(() => {});
      } else {
        await Promise.all(targets.map(f => deleteFromIDB(f.projectId).catch(() => {})));
      }
      const ids = new Set(targets.map(f => f.projectId));
      setBinProjects(prev => prev.filter(f => !ids.has(f.projectId)));
      setBinQuery('');
      setConfirmEmptyBin(false);
    } finally {
      setEmptyingBin(false);
    }
  }

  // ── Share helpers ──────────────────────────────────────────────────────────
  function shareUrl(id) { return `${window.location.origin}/s/${id}`; }

  // External / static-page links. On web the native <a target="_blank"> handles
  // navigation, so this is a no-op. (On desktop this seam intercepts and opens
  // the page in the system browser — a plain <a> there would hit tauri.localhost/… and 404.)
  function openExternal(_e, _url) { /* web: native <a target="_blank"> handles it */ }

  // Build the JSON snapshot our /s/<id> viewer renders (whole project, or one section).
  function buildSnapshot(p, chapterId) {
    const sec = chapterId ? (p.chapters || []).find(c => c.id === chapterId) : null;
    const title = (sec ? sec.title : p.title) || 'Untitled';
    const sections = sec
      ? [{ title: sec.title || '', content: sec.content || '', level: sec.level || 1 }]
      : (p.chapters || []).map(c => ({ title: c.title || '', content: c.content || '', level: c.level || 1 }));
    return { v: 1, title, sections, author: user?.email || '', publishedAt: new Date().toISOString() };
  }

  // Persist a project whose .shares changed: write to IDB + mark dirty (syncs) + update state.
  async function persistProjectShare(updated) {
    try { await writeProjectToIDB(updated, user?.email); } catch {}
    getEngine()?.markDirty(updated.id, updated);
    getEngine()?.sweepDirty?.().catch(() => {});
    setProjects(prev => prev.map(x => x.id === updated.id ? updated : x));
  }

  async function handleShare(p) {
    setShareLoading(true);
    try {
      // Resolve the LIVE project from state (the passed `p`/shareTarget can be a stale snapshot).
      const cur  = projects.find(x => x.id === p.id) || p;
      const snap = buildSnapshot(cur, null);
      const blob = new Blob([JSON.stringify(snap)], { type: 'application/json' });
      const safe = ((cur.title || 'oodbo').replace(/[^\w .-]+/g, ' ').trim() || 'oodbo');
      const prev = (cur.shares || {})['__project__'];
      if (prev?.fileId) { try { await unpublishShare({ getShareToken: getShareAccessToken, fileId: prev.fileId }); } catch (e) { console.warn('unpublish old failed:', e); } }
      const { fileId } = await publishShare({ getShareToken: getShareAccessToken, name: `${safe}.oodbo.json`, blob, mimeType: 'application/json' });
      const url = `${window.location.origin}/s/${fileId}`;
      await persistProjectShare({ ...cur, shares: { ...(cur.shares || {}), '__project__': { fileId, url, publishedAt: snap.publishedAt } } });
      setShareLinks(prev2 => ({ ...prev2, [p.id]: fileId }));
    } catch (e) { console.warn('share failed:', e); }
    setShareLoading(false);
  }

  async function handleUnshare(p) {
    const cur  = projects.find(x => x.id === p.id) || p;   // live copy (has the fileId; avoids clobber)
    const info = (cur.shares || {})['__project__'];
    if (info?.fileId) {
      try { await unpublishShare({ getShareToken: getShareAccessToken, fileId: info.fileId }); }
      catch (e) { console.warn('unpublish failed:', e); }
    }
    const shares = { ...(cur.shares || {}) };
    delete shares['__project__'];
    await persistProjectShare({ ...cur, shares });
    setShareLinks(prev => { const u = { ...prev }; delete u[p.id]; return u; });
  }

  // ── "Shared links" manager — every share (project + section) in one place ───
  // The project page and the editor each manage one share at a time; this modal
  // lists them all so a user can copy / refresh-snapshot / remove from one view.
  function openSharesPanel() {
    setShowShares(true);
    // Derive the list straight from the synced project.shares — no server.
    const list = [];
    for (const p of projects) {
      for (const [slot, info] of Object.entries(p.shares || {})) {
        if (!info?.fileId) continue;
        const chapterId = slot === '__project__' ? null : slot;
        const title = chapterId
          ? ((p.chapters || []).find(c => c.id === chapterId)?.title || p.title || 'Untitled')
          : (p.title || 'Untitled');
        list.push({ id: info.fileId, project_id: p.id, chapter_id: chapterId, title, active: true, updated_at: info.publishedAt || null });
      }
    }
    setSharesList(list);
  }

  // Rebuild the JSON snapshot from LOCAL project data (for "update snapshot"). Returns null
  // when the project/section isn't on this device — Copy/Remove still work regardless.
  function rebuildSnapshot(projectId, chapterId) {
    const p = projects.find(x => x.id === projectId);
    if (!p) return null;
    if (chapterId && !(p.chapters || []).find(ch => ch.id === chapterId)) return null;
    return buildSnapshot(p, chapterId);
  }

  async function updateShareSnapshot(sh) {
    const snap = rebuildSnapshot(sh.project_id, sh.chapter_id);
    if (!snap) return;
    setSharesBusy(sh.id);
    try {
      const blob = new Blob([JSON.stringify(snap)], { type: 'application/json' });
      const safe = ((snap.title || 'oodbo').replace(/[^\w .-]+/g, ' ').trim() || 'oodbo');
      const { fileId } = await publishShare({ getShareToken: getShareAccessToken, name: `${safe}.oodbo.json`, blob, mimeType: 'application/json' });
      try { await unpublishShare({ getShareToken: getShareAccessToken, fileId: sh.id }); } catch {}   // drop the old file
      const url  = `${window.location.origin}/s/${fileId}`;
      const slot = sh.chapter_id || '__project__';
      const p    = projects.find(x => x.id === sh.project_id);
      if (p) await persistProjectShare({ ...p, shares: { ...(p.shares || {}), [slot]: { fileId, url, publishedAt: snap.publishedAt } } });
      setSharesList(list => (list || []).map(x => x.id === sh.id ? { ...x, id: fileId, updated_at: snap.publishedAt } : x));
      if (!sh.chapter_id) setShareLinks(prev => ({ ...prev, [sh.project_id]: fileId }));
    } catch (e) { console.warn('update snapshot failed:', e); }
    setSharesBusy(null);
  }

  async function removeShareLink(sh) {
    setSharesBusy(sh.id);
    try { await unpublishShare({ getShareToken: getShareAccessToken, fileId: sh.id }); } catch {}
    const slot = sh.chapter_id || '__project__';
    const p    = projects.find(x => x.id === sh.project_id);
    if (p) {
      const shares = { ...(p.shares || {}) };
      delete shares[slot];
      await persistProjectShare({ ...p, shares });
    }
    setSharesList(list => (list || []).filter(x => x.id !== sh.id));
    if (!sh.chapter_id) setShareLinks(prev => { const u = { ...prev }; delete u[sh.project_id]; return u; });
    setSharesBusy(null);
  }

  function copyShareLink(sh) {
    try { navigator.clipboard.writeText(shareUrl(sh.id)); } catch {}
    setSharesCopied(sh.id);
    setTimeout(() => setSharesCopied(c => (c === sh.id ? null : c)), 1500);
  }

  // ── Export single project ──────────────────────────────────────────────────
  function handleExportOodbo(p) {
    const blob = new Blob([projectToXml(p)], { type: 'application/xml' });
    triggerBlobDownload(blob, `${safeName(p.title)}.oodbo`);
  }

  async function handleExportDocx(p) {
    try {
      const blob = await exportDocx(p);
      triggerBlobDownload(blob, `${safeName(p.title)}.docx`);
    } catch { setNotice({ title: 'Export failed', body: 'Could not export the .docx.' }); }
  }

  function handleExportPdf(p) {
    try {
      const blob = exportPdf(p);
      triggerBlobDownload(blob, `${safeName(p.title)}.pdf`);
    } catch { setNotice({ title: 'Export failed', body: 'Could not export the .pdf.' }); }
  }

  function handleExportTxt(p) {
    const lines = [];
    if (p.title) {
      lines.push(p.title.toUpperCase());
      lines.push('='.repeat(p.title.length));
      lines.push('');
    }
    for (const ch of p.chapters || []) {
      if (ch.title) {
        lines.push(ch.title);
        lines.push('-'.repeat(ch.title.length));
      }
      if (ch.content) lines.push(ch.content);
      lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    triggerBlobDownload(blob, `${safeName(p.title)}.txt`);
  }

  function handleExportMd(p) {
    const lines = [];
    if (p.title) { lines.push(`# ${p.title}`); lines.push(''); }
    for (const ch of p.chapters || []) {
      if (ch.title) {
        const hashes = '#'.repeat((ch.level || 1) + 1);
        lines.push(`${hashes} ${ch.title}`);
        lines.push('');
      }
      if (ch.content) { lines.push(ch.content); lines.push(''); }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    triggerBlobDownload(blob, `${safeName(p.title)}.md`);
  }

  // ── Export all as zip ──────────────────────────────────────────────────────
  async function handleExportAll() {
    const zip  = new JSZip();
    const seen = {};
    for (const p of projects) {
      let base = safeName(p.title);
      if (seen[base]) { seen[base]++; base = `${base}-${seen[base]}`; } else { seen[base] = 1; }
      zip.file(`${base}.oodbo`, projectToXml(p));
    }
    // DEFLATE, not JSZip's default STORE — .oodbo is XML text and compresses ~3x.
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    triggerBlobDownload(blob, `oodbo-projects ${fileStamp()}.zip`);
  }

  // ── Import ─────────────────────────────────────────────────────────────────
  async function handleImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const importProjects = async (list) => {
      for (const p of list) await writeProjectToIDB(p, user?.email);
      mergeIntoLocalStorage(list);
      setProjects(prev => {
        const next = [...prev];
        for (const p of list) {
          const idx = next.findIndex(x => x.id === p.id);
          if (idx >= 0) next[idx] = p; else next.push(p);
        }
        return next;
      });
      onOpenProject(list[list.length - 1].id);
    };

    if (file.name.toLowerCase().endsWith('.zip')) {
      try {
        const zip   = await JSZip.loadAsync(await file.arrayBuffer());
        const names = Object.keys(zip.files).filter(n => {
          const low = n.toLowerCase();
          return (low.endsWith('.oodbo') || low.endsWith('.xml')) && !zip.files[n].dir;
        });
        if (names.length === 0) { setNotice({ title: 'Import failed', body: 'No .oodbo files found in the zip.' }); return; }
        const parsed = [];
        for (const name of names) {
          try { parsed.push(xmlToProject(await zip.files[name].async('string'))); } catch {}
        }
        if (parsed.length === 0) { setNotice({ title: 'Import failed', body: 'Could not read any .oodbo files from the zip.' }); return; }
        await importProjects(parsed);
      } catch { setNotice({ title: 'Import failed', body: 'Could not read the zip file.' }); }
      return;
    }

    try {
      const text = await file.text();
      const proj = xmlToProject(text);
      await importProjects([proj]);
    } catch { setNotice({ title: 'Import failed', body: "Could not read the file. Make sure it's a valid .oodbo file." }); }
  }

  // Bin filtered by its own search box (title substring; the bin only holds titles + meta, not
  // full content, so this is a title match).
  const shownBin = binQuery.trim()
    ? binProjects.filter(f => (f.title || '').toLowerCase().includes(binQuery.trim().toLowerCase()))
    : binProjects;

  // Per-project derived values, computed once per `projects` change — NOT per render. Typing in the
  // search box re-renders Home on every keystroke; without these memos each keystroke re-split every
  // project's full content (wordCount) and re-sorted every chapter's dates (lastUpdatedIso), which is
  // what made typing lag on large projects.
  const wordCounts  = useMemo(() => new Map(projects.map(p => [p.id, wordCount(p)])), [projects]);
  const lastUpdated = useMemo(() => new Map(projects.map(p => [p.id, lastUpdatedIso(p)])), [projects]);

  const sorted = useMemo(() => [...projects].sort((a, b) => {
    if (sort === 'type-name') {
      const ta = a.type || '', tb = b.type || '';
      return ta.localeCompare(tb) || (a.title || '').localeCompare(b.title || '');
    }
    if (sort === 'updated') return (lastUpdated.get(b.id) || '').localeCompare(lastUpdated.get(a.id) || '');
    return (a.title || '').localeCompare(b.title || '');
  }), [projects, sort, lastUpdated]);

  // The most-recently-edited chapter across all projects, for the "continue writing" card. Memoized
  // so typing (which re-renders the card) doesn't re-scan every chapter's date on each keystroke.
  const jumpBack = useMemo(() => {
    let bestProject = null, bestChapter = null, bestTime = 0;
    for (const p of projects) {
      for (const ch of p.chapters || []) {
        if (!ch.content) continue;
        const t = ch.updatedAt ? new Date(ch.updatedAt).getTime() : 0;
        if (t > bestTime) { bestTime = t; bestProject = p; bestChapter = ch; }
      }
    }
    return bestChapter ? { bestProject, bestChapter } : null;
  }, [projects]);

  // CRT theme — all colours come from CSS custom properties (src/crt.css), recoloured live by
  // the scheme picker (green/amber/dark/light) via data-scheme on the page container below.
  const th  = CRT_THEME;
  const dg  = dialog(th, { mobile: isMobile });
  const dgD = dialog(th, { mobile: isMobile, destructive: true });   // destructive dialogs (danger rule)

  // Colour scheme (shared with ShareView + the rest of the app) — persisted per browser.
  const [scheme, setScheme] = useState(() => {
    try { return localStorage.getItem('fwd:crt-scheme') || 'green'; } catch { return 'green'; }
  });
  const pickScheme = (v) => { setScheme(v); try { localStorage.setItem('fwd:crt-scheme', v); } catch {} };
  const [schemeMenuOpen, setSchemeMenuOpen] = useState(false);
  const schemeMenuRef = useRef(null);
  useEffect(() => {
    if (!schemeMenuOpen) return;
    const onDown = (e) => { if (schemeMenuRef.current && !schemeMenuRef.current.contains(e.target)) setSchemeMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [schemeMenuOpen]);
  const SCHEMES = [['green', '◉ GREEN'], ['amber', '◉ AMBER'], ['dark', '◉ DARK'], ['light', '◉ LIGHT'], ['parchment', '◉ PARCHMENT']];
  const curSchemeLabel = (SCHEMES.find((x) => x[0] === scheme) || SCHEMES[0])[1];

  // ── Homepage search ──────────────────────────────────────────────────────────
  // Search runs only when the user submits (Enter or the magnifying-glass icon) — NOT per
  // keystroke. When a query is submitted, show the projects that contain it (ranked) instead of
  // the sorted list. Opening a result carries the term into the Editor's in-project find bar.
  const searching     = submittedQuery.trim().length > 0;
  const searchResults = useMemo(() => (searching ? searchAll(projects, submittedQuery) : null), [searching, submittedQuery, projects]);
  const projectById   = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  const resultById    = useMemo(() => (searchResults ? new Map(searchResults.map(r => [r.projectId, r])) : null), [searchResults]);
  const displayList   = searchResults ? searchResults.map(r => projectById.get(r.projectId)).filter(Boolean) : sorted;

  // Binned matches — shown (not opened) below the active results when "search bin" is on. The user
  // restores from the bin to access them; clicking a binned row opens the bin panel.
  const binResults = useMemo(
    () => (searching && includeBin ? searchAll(binSearchData, submittedQuery) : null),
    [searching, includeBin, binSearchData, submittedQuery],
  );

  function runSearch()   { setSubmittedQuery(query.trim()); }
  function clearSearch() { setQuery(''); setSubmittedQuery(''); }

  // Close the sort menu on any outside click.
  useEffect(() => {
    if (!sortMenuOpen) return;
    const onDown = (e) => { if (sortRef.current && !sortRef.current.contains(e.target)) setSortMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [sortMenuOpen]);

  // Close the mobile row ··· menu on any outside click.
  useEffect(() => {
    if (!menuRow) return;
    const onDown = (e) => { if (rowMenuRef.current && !rowMenuRef.current.contains(e.target)) setMenuRow(null); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuRow]);

  // Row actions — shared by desktop (hover-revealed text) and the mobile ··· menu.
  const shareState = (id) => {
    const sid = shareLinks[id];
    return sid && (shareStatuses[sid] ?? 'active') === 'active';
  };
  function rowActionLinks(p, th) {
    return (
      <>
        <button style={s.rowLink} onClick={() => handleCopyProject(p)}>copy</button>
        <button style={s.rowLink} onClick={() => setExportTarget(p)}>export</button>
        {/* Sharing needs the user's cloud (Drive) — only cloud accounts, never local-only desktop ones. */}
        {user?.provider && (
          <button style={{ ...s.rowLink, ...(shareState(p.id) ? { color: '#4a7c4a' } : {}) }} onClick={() => setShareTarget(p)}>{shareState(p.id) ? 'share ✓' : 'share'}</button>
        )}
        <button style={{ ...s.rowLink, color: th.danger }} onClick={() => setDeleteTarget(p)}>delete</button>
      </>
    );
  }

  // Load full trashed-project data when bin search is enabled (cached; refreshed on syncTick).
  useEffect(() => {
    if (!includeBin) { setBinSearchData([]); return; }
    let cancelled = false;
    readTrashedFromIDB(user?.email).then(d => { if (!cancelled) setBinSearchData(d); });
    return () => { cancelled = true; };
  }, [includeBin, syncTick, user?.email]);

  // Open a project. While searching, carry the submitted term into the Editor's in-project find
  // bar; it lands on the first hit and cycles from there. A normal click passes term='', which
  // just opens the project. No jumpTarget — the find bar owns post-open navigation.
  function openFromList(p) {
    onOpenProject(p.id, null, searching ? submittedQuery : '');
  }

  // Full-window takeover, so it comes before the page rather than layering over it.
  if (conflictTarget) {
    return (
      <ConflictDialog
        original={conflictTarget.original}
        conflicted={conflictTarget.conflicted}
        onResolve={handleResolveConflict}
        onLater={() => setConflictTarget(null)}
      />
    );
  }

  return (
    <div style={s.page} data-scheme={scheme} className="crt-scanlines crt-vignette">

      {/* Idle limbo: the "still here?" checkpoint, then the full-screen animation. A deliberate
          action anywhere wakes it (handled by the idle effect's window listeners). */}
      {idleStage === 'prompt' && (
        <div style={s.idlePromptWrap}>
          <div style={s.idlePromptCard}>
            <p style={s.idlePromptText}>Still here?</p>
            <button style={s.idlePromptBtn} onClick={() => { lastActiveRef.current = Date.now(); setIdleStage('active'); }}>
              I’m here
            </button>
          </div>
        </div>
      )}
      {idleStage === 'screensaver' && <IdleScreen />}

      {/* First child of the flex column, so it pushes the page down instead of covering it.
          Only for users who actually sync — with no cloud connected there's nothing to be
          offline FROM, and promising it'll sync later would be a lie. */}
      {syncReconnect && user?.provider
        ? <ReconnectBanner provider={user.provider} onReconnect={onReconnect} />
        : !online && user?.provider && <OfflineBanner />}

      {/* Header */}
      <header style={s.header}>
        <span style={s.logo}>FORWARD&nbsp;ONLY</span>
        <span style={s.flex1} />
        <span style={{ position: 'relative' }} ref={schemeMenuRef}>
          <button className="crt-tog" aria-haspopup="listbox" aria-expanded={schemeMenuOpen}
                  onClick={() => setSchemeMenuOpen((o) => !o)}>{curSchemeLabel}&nbsp;▾</button>
          {schemeMenuOpen && (
            <div className="crt-menu" role="listbox">
              {SCHEMES.map(([val, label]) => (
                <button key={val} role="option" aria-selected={scheme === val}
                        className={`crt-menu-item${scheme === val ? ' on' : ''}`}
                        onClick={() => { pickScheme(val); setSchemeMenuOpen(false); }}>{label}</button>
              ))}
            </div>
          )}
        </span>
        <span style={s.userEmail}>{user?.name || user?.email?.split('@')[0]}</span>
        <button style={s.ghostBtn} onClick={onSignOut}>sign out</button>
      </header>

      {/* Content — scrollable middle area */}
      <div style={s.scrollArea}>
      <div style={s.content}>

        {/* Line 1 — title + sync state. Hidden on the pure empty state: no projects,
            nothing to name 'Projects' or to sync — the empty state carries the page. */}
        {projects.length > 0 && (
        <div style={s.headerLine}>
          <h1 style={s.heading}>Projects</h1>
          <span style={s.flex1} />
          {onSync && user?.provider && (() => {
            const lastSynced = (() => { try { return localStorage.getItem(`fwd:lastSynced:${user?.email || ''}`); } catch { return null; } })();
            return (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                {lastSynced && !syncing && <span style={s.syncNote}>synced {formatSyncAgo(lastSynced)}</span>}
                <button style={s.syncNowBtn} onClick={handleSync} disabled={syncing}>
                  {syncing ? 'syncing…' : 'sync now'}
                </button>
              </div>
            );
          })()}
        </div>
        )}

        {/* Line 2 — one toolbar (only once there are projects to search / sort / export) */}
        {projects.length > 0 && (
        <div style={s.toolbar}>
          <div style={s.searchWrap}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
                else if (e.key === 'Escape') { clearSearch(); }
              }}
              placeholder="Search projects…"
              style={s.searchInput}
              aria-label="Search projects"
            />
            {/* In-field magnifier — the tappable way to run the search on mobile, where
                there's no Enter key in reach. Submits; not a text target. */}
            <button style={s.searchGo} onClick={runSearch} title="Search" aria-label="Search">
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="6.4" cy="6.4" r="4.6" stroke="var(--tx-dim)" strokeWidth="1.3" />
                <line x1="9.9" y1="9.9" x2="13.4" y2="13.4" stroke="var(--tx-dim)" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
            {(query.trim() || searching) && (
              <label style={s.binToggle} title="Also search projects in the recycle bin">
                <input type="checkbox" checked={includeBin} onChange={e => setIncludeBin(e.target.checked)} style={{ margin: 0 }} />
                search bin
              </label>
            )}
            {searching && (
              <button style={s.searchClear} onClick={clearSearch} title="Clear search">✕</button>
            )}
          </div>
          {/* Sort — text button + menu (replaces the native select) */}
          <div style={{ position: 'relative' }} ref={sortRef}>
            <button style={s.sortBtn} onClick={() => setSortMenuOpen(o => !o)}>
              {SORT_OPTIONS.find(o => o.value === sort)?.label || 'Sort'} ⌄
            </button>
            {sortMenuOpen && (
              <div style={s.sortMenu}>
                {SORT_OPTIONS.map(o => (
                  <button
                    key={o.value}
                    style={{ ...s.sortMenuItem, ...(o.value === sort ? { color: 'var(--tx)', fontStyle: 'normal' } : {}) }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bd)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    onClick={() => { handleSort(o.value); setSortMenuOpen(false); }}
                  >{o.label}</button>
                ))}
              </div>
            )}
          </div>
          <button style={s.exportAllBtn} onClick={handleExportAll} title="Download every project as a .zip">
            Export all
          </button>
          <button style={s.newBtn} onClick={() => setShowTypePicker(true)}>
            New project
          </button>
        </div>
        )}

        {/* ── Jump back in ── (hidden while searching) */}
        {!loading && !searching && jumpBack && (() => {
          const { bestProject, bestChapter } = jumpBack;   // memoized above — not recomputed per keystroke

          // Build preview: cursor anchored with 3 words before it on its line,
          // remaining before-budget fills upward, after-budget fills downward.
          const content   = bestChapter.content || '';
          const pos       = bestChapter.cursorPosition ?? content.length;
          const beforeLen = isMobile ? 150 : 300;
          const afterLen  = isMobile ? 40  : 80;

          // Walk backwards from cursor to find where the 3rd preceding word starts
          const rawBefore = content.slice(Math.max(0, pos - beforeLen), pos);
          function splitAt3Words(text) {
            let i = text.length;
            while (i > 0 && /\s/.test(text[i - 1])) i--;          // skip trailing space
            for (let w = 0; w < 3 && i > 0; w++) {
              while (i > 0 && !/\s/.test(text[i - 1])) i--;        // skip word chars
              if (w < 2) while (i > 0 && /\s/.test(text[i - 1])) i--; // skip inter-word space
            }
            return { far: text.slice(0, i), near: text.slice(i) };
          }
          const { far, near } = splitAt3Words(rawBefore);
          // Cap far text to ~3 lines so cursor stays in the visible card area
          const farMax  = isMobile ? 80 : 180;
          const farTrim = far.length > farMax ? far.slice(far.length - farMax) : far;
          const farText = (far.length > farMax || pos > beforeLen ? '…' : '') + farTrim;
          const rawAfter = content.slice(pos, pos + afterLen);
          const after    = rawAfter + (pos + afterLen < content.length ? '…' : '');

          const openJump = (mode) => onOpenProject(bestProject.id, {
            chapterId:      bestChapter.id,
            cursorPosition: bestChapter.cursorPosition ?? content.length,
            mode,
          });

          return (
            <div style={s.jumpCard}>
              <div style={s.jumpMeta}>
                <span style={s.jumpLabel}>continue writing</span>
                <span style={s.jumpTitle}>{bestProject.title || 'Untitled'}</span>
                {bestChapter.title && <span style={s.jumpSection}>{bestChapter.title}</span>}
              </div>
              <p style={s.jumpPreview}>
                <span style={s.jumpBefore}>{farText}</span>
                <span style={s.jumpNear}>{near}</span>
                <span style={s.jumpCursor} aria-hidden="true">▎</span>
                {after && <span style={s.jumpAfter}>{after}</span>}
              </p>
              <div style={s.jumpActions}>
                <button style={s.jumpForwardBtn} onClick={() => openJump('focus')}>Forward Mode</button>
                <button style={s.jumpEditBtn}    onClick={() => openJump('edit')}>Edit</button>
              </div>
            </div>
          );
        })()}

        {loading ? (
          <p style={s.hint}>Loading…</p>
        ) : searching && displayList.length === 0 ? (
          <div style={s.emptyWrap}>
            <p style={s.hint}>No projects match “{submittedQuery.trim()}”.</p>
          </div>
        ) : sorted.length === 0 ? (
          <div style={s.emptyState}>
            <h2 style={s.emptyHeading}>Start your first project</h2>
            <p style={s.emptyBody}>
              Every new project is started in Forward mode, where you can write, but you can't
              edit or delete. The draft gets written before the critic gets a vote. Pick where
              to begin; you can rename it any time.
            </p>
            <div style={s.emptyTypes}>
              {PROJECT_TYPES.map(({ type, label, desc }) => (
                <button key={type} style={s.typeBtn} onClick={() => onNewProject(type)}>
                  <span style={s.typeBtnLabel}>{label}</span>
                  <span style={s.typeBtnDesc}>{desc}</span>
                </button>
              ))}
            </div>
            <p style={s.emptySecondary}>
              or <button style={s.emptyLink} onClick={() => importRef.current?.click()}>import a project</button>
              {' · '}
              <a href={MS_STORE_URL} onClick={(e) => openExternal(e, MS_STORE_URL)} target="_blank" rel="noopener noreferrer" style={s.emptyLink}>get the Word add-in</a>
            </p>
          </div>
        ) : (
          <div style={s.list}>
            {displayList.map(p => {
              const wc         = wordCounts.get(p.id) ?? 0;   // memoized — not recomputed per keystroke
              const sc         = (p.chapters || []).length;
              const typeLabel  = p.type || 'prose';
              const entryLabel = (p.type === 'journal' || p.type === 'log')
                ? (sc === 1 ? 'entry' : 'entries')
                : (sc === 1 ? 'section' : 'sections');
              return (
                <div key={p.id}>
                <div
                  style={isMobile ? s.rowMobile : s.row}
                  onClick={() => openFromList(p)}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = 'var(--bg3)';
                    const a = e.currentTarget.querySelector('[data-actions]');
                    if (a) { a.style.opacity = '1'; a.style.pointerEvents = 'auto'; }
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'transparent';
                    const a = e.currentTarget.querySelector('[data-actions]');
                    if (a) { a.style.opacity = '0'; a.style.pointerEvents = 'none'; }
                  }}
                >
                  {isMobile ? (
                    /* ── Mobile: two-line card ── */
                    <>
                      <div style={s.rowMobileTop}>
                        <span style={s.rowTitle}>{p.title || 'Untitled'}</span>
                        <span style={s.rowDate}>{formatDate(lastUpdatedIso(p))}</span>
                      </div>
                      <div style={s.rowMobileBottom}>
                        <span style={s.rowMetaLine}>
                          {badgeFor(p.id)}
                          <span style={s.rowMeta}>
                            {typeLabel}
                            {wc > 0 && ` · ${plWords(wc)}`}
                            {sc > 0 && ` · ${sc} ${entryLabel}`}
                          </span>
                        </span>
                        <div style={{ position: 'relative' }} ref={menuRow === p.id ? rowMenuRef : null} onClick={e => e.stopPropagation()}>
                          <button style={s.rowMenuBtn} onClick={() => setMenuRow(menuRow === p.id ? null : p.id)} aria-label="Project actions">···</button>
                          {menuRow === p.id && (
                            <div style={s.rowMenu}>
                              <button style={s.rowMenuItem} onClick={() => { handleCopyProject(p); setMenuRow(null); }}>Copy</button>
                              <button style={s.rowMenuItem} onClick={() => { setExportTarget(p); setMenuRow(null); }}>Export</button>
                              {user?.provider && (
                                <button style={s.rowMenuItem} onClick={() => { setShareTarget(p); setMenuRow(null); }}>{shareState(p.id) ? 'Share ✓' : 'Share'}</button>
                              )}
                              <button style={{ ...s.rowMenuItem, color: th.danger }} onClick={() => { setDeleteTarget(p); setMenuRow(null); }}>Delete</button>
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    /* ── Desktop: single horizontal row ── */
                    <>
                      <div style={s.rowMain}>
                        <span style={s.rowTitle}>{p.title || 'Untitled'}</span>
                        <span style={s.rowMetaLine}>
                          {badgeFor(p.id)}
                          <span style={s.rowMeta}>
                            {typeLabel}
                            {wc > 0 && ` · ${plWords(wc)}`}
                            {sc > 0 && ` · ${sc} ${entryLabel}`}
                          </span>
                        </span>
                      </div>
                      <div data-actions style={{ ...s.rowActions, opacity: 0, pointerEvents: 'none', transition: 'opacity 0.12s' }} onClick={e => e.stopPropagation()}>
                        {rowActionLinks(p, th)}
                      </div>
                      <span style={s.rowDate}>{formatDate(lastUpdatedIso(p))}</span>
                    </>
                  )}
                </div>
                {expandedConflictId === p.id && conflictTreeFor(p.id)}
                </div>
              );
            })}
          </div>
        )}

        {/* Binned matches — shown, not opened (Paul: "just show the project, they can restore").
            Clicking a row opens the recycle bin where the project can be restored. */}
        {searching && includeBin && binResults && binResults.length > 0 && (
          <div style={s.binResultsWrap}>
            <p style={s.binResultsLabel}>In bin</p>
            {binResults.map(r => (
              <div key={r.projectId} style={s.binResultRow}>
                <span style={s.binResultTitle}>{r.projectTitle || 'Untitled'}</span>
                <span style={s.rowActions}>
                  {restoreButton(r.projectId)}
                  <button style={{ ...s.exportBtn, color: th.danger, borderColor: th.danger }}
                    onClick={() => setPermDeleteTarget({ projectId: r.projectId, title: r.projectTitle })}>delete</button>
                </span>
              </div>
            ))}
          </div>
        )}

      </div>
      </div>

      {/* Footer */}
      {toast && <div style={s.toast}>{toast}</div>}

      <footer style={s.footer}>
        <a href="/privacy" onClick={(e) => openExternal(e, '/privacy')} target="_blank" rel="noopener noreferrer" style={s.footerLink}>privacy</a>
        <span style={s.footerDot}>·</span>
        <a href="/terms"   onClick={(e) => openExternal(e, '/terms')} target="_blank" rel="noopener noreferrer" style={s.footerLink}>terms</a>
        <span style={s.footerDot}>·</span>
        <a href={MS_STORE_URL} onClick={(e) => openExternal(e, MS_STORE_URL)} target="_blank" rel="noopener noreferrer" style={s.footerLink}>MS Word</a>
        {user && projects.length > 0 && <>
          <span style={s.footerDot}>·</span>
          <button style={s.footerBtn} onClick={openBin}>recycle bin</button>
        </>}
        {user && <>
          <span style={s.footerDot}>·</span>
          <button style={s.footerBtn} onClick={openSharesPanel}>shared links</button>
        </>}
      </footer>
      {/* Shared-links manager — copy / update snapshot / remove, all in one place */}
      {showShares && (
        <div style={dg.overlay} onClick={() => setShowShares(false)}>
          <BodyScrollLock />
          <div style={dg.box} onClick={e => e.stopPropagation()}>
            <p style={dg.title}>Shared links</p>
            <div style={dg.rule} />
            {/* scrollbarGutter reserves the scrollbar's width; paddingRight is the
                actual gap so the scrollbar never crosses the Copy button. */}
            <div style={{ overflowY: 'auto', overflowX: 'hidden', flex: 1, scrollbarGutter: 'stable', paddingRight: 12 }}>
              {sharesList === null && (
                <p style={{ ...dg.body, fontSize: 12, color: th.chromeMuted, fontStyle: 'italic', margin: 0 }}>loading…</p>
              )}
              {sharesList !== null && sharesList.length === 0 && (
                <p style={{ ...dg.body, fontSize: 12, color: th.chromeMuted, fontStyle: 'italic', margin: 0 }}>
                  You haven't shared anything yet. Share a whole project from its ··· menu, or a section from inside the editor.
                </p>
              )}
              {(sharesList || []).map(sh => {
                const scope  = sh.chapter_id ? 'Section' : 'Whole project';
                const proj   = projects.find(x => x.id === sh.project_id);
                const canUpd = !!rebuildSnapshot(sh.project_id, sh.chapter_id);
                const status = sh.active ? 'active' : (sh.inactive_reason || 'inactive');
                const busy   = sharesBusy === sh.id;
                return (
                  <div key={sh.id} style={{ padding: '12px 0', borderBottom: `1px solid ${th.chromeBorder}` }}>
                    <p style={{ fontFamily: 'var(--fm)', fontSize: 13, color: th.chromeText, margin: '0 0 2px' }}>
                      {sh.title || 'Untitled'}
                    </p>
                    <p style={{ fontFamily: 'var(--fm)', fontSize: 10, color: th.chromeMuted, fontStyle: 'italic', margin: '0 0 8px' }}>
                      {scope}{proj ? ` · in ${proj.title || 'Untitled'}` : ''}{status === 'active' && sh.updated_at ? ` · snapshot ${formatSyncAgo(sh.updated_at)}` : ''}
                    </p>

                    {status === 'active' && (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                          <input readOnly value={shareUrl(sh.id)}
                            style={{ flex: 1, minWidth: 0, fontFamily: 'var(--fm)', fontSize: 10, border: `1px solid ${th.chromeBorder}`, background: 'var(--bg2)', color: 'var(--tx)', padding: '4px 6px', outline: 'none' }}
                            onFocus={e => e.target.select()} />
                          <button
                            style={{ fontFamily: 'var(--fm)', fontSize: 10, padding: '4px 8px', background: sharesCopied === sh.id ? '#4a7c4a' : 'var(--tx)', color: 'var(--bg)', border: 'none', cursor: 'pointer', flexShrink: 0, transition: 'background 0.2s' }}
                            onClick={() => copyShareLink(sh)}
                          >{sharesCopied === sh.id ? '✓ Copied' : 'Copy'}</button>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            style={{ fontFamily: 'var(--fm)', fontSize: 10, fontStyle: 'italic', background: 'transparent', border: 'none', color: canUpd ? 'var(--tx-dim)' : 'var(--tx-faint)', cursor: canUpd ? 'pointer' : 'default', padding: 0 }}
                            onClick={() => canUpd && updateShareSnapshot(sh)} disabled={!canUpd || busy}
                          >{busy ? 'updating…' : 'Update snapshot'}</button>
                          <span style={{ color: 'var(--tx-faint)', fontSize: 10 }}>·</span>
                          <button
                            style={{ fontFamily: 'var(--fm)', fontSize: 10, fontStyle: 'italic', background: 'transparent', border: 'none', color: '#a03030', cursor: 'pointer', padding: 0 }}
                            onClick={() => removeShareLink(sh)} disabled={busy}
                          >Remove link</button>
                        </div>
                        {!canUpd && (
                          <p style={{ fontFamily: 'var(--fm)', fontSize: 9, color: 'var(--tx-faint)', fontStyle: 'italic', margin: '4px 0 0' }}>
                            snapshot can't be refreshed here — the original isn't on this device
                          </p>
                        )}
                      </>
                    )}

                    {status === 'reported' && (
                      <p style={{ fontFamily: 'var(--fm)', fontSize: 10, fontStyle: 'italic', color: 'var(--tx-dim)', margin: 0 }}>
                        under review — link hidden pending moderation
                      </p>
                    )}
                    {status === 'blocked' && (
                      <p style={{ fontFamily: 'var(--fm)', fontSize: 10, fontStyle: 'italic', color: '#a03030', margin: 0 }}>
                        permanently removed — sharing policy violation
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={dg.actions}>
              <button style={btn(th, 'ghost', { mobile: isMobile })} onClick={() => setShowShares(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden import input */}
      <input
        ref={importRef}
        type="file"
        accept=".oodbo,.xml,.zip"
        style={{ display: 'none' }}
        onChange={handleImport}
      />

      {/* Type picker */}
      {showTypePicker && (
        <div style={s.overlay} onClick={() => setShowTypePicker(false)}>
          <BodyScrollLock />
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <p style={s.modalTitle}>What are you starting?</p>
            {PROJECT_TYPES.map(({ type, label, desc }) => (
              <button
                key={type}
                style={s.typeBtn}
                onClick={() => { setShowTypePicker(false); onNewProject(type); }}
              >
                <span style={s.typeBtnLabel}>{label}</span>
                <span style={s.typeBtnDesc}>{desc}</span>
              </button>
            ))}
            <div style={s.modalDivider} />
            <button style={s.importBtn} onClick={() => { setShowTypePicker(false); importRef.current?.click(); }}>
              Import existing (.oodbo or .zip)
            </button>
            <button style={s.cancelBtn} onClick={() => setShowTypePicker(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Export modal */}
      {exportTarget && (
        <div style={dg.overlay} onClick={() => setExportTarget(null)}>
          <BodyScrollLock />
          <div style={dg.box} onClick={e => e.stopPropagation()}>
            <p style={dg.title}>Export "{exportTarget.title || 'Untitled'}"</p>
            <div style={dg.rule} />
            <button style={s.typeBtn} onClick={() => { handleExportOodbo(exportTarget); setExportTarget(null); }}>
              <span style={s.typeBtnLabel}>.oodbo</span>
              <span style={s.typeBtnDesc}>Native format — backup or re-import</span>
            </button>
            <button style={s.typeBtn} onClick={() => { handleExportDocx(exportTarget); setExportTarget(null); }}>
              <span style={s.typeBtnLabel}>.docx</span>
              <span style={s.typeBtnDesc}>Microsoft Word document</span>
            </button>
            <button style={s.typeBtn} onClick={() => { handleExportPdf(exportTarget); setExportTarget(null); }}>
              <span style={s.typeBtnLabel}>.pdf</span>
              <span style={s.typeBtnDesc}>Portable document format</span>
            </button>
            <button style={s.typeBtn} onClick={() => { handleExportTxt(exportTarget); setExportTarget(null); }}>
              <span style={s.typeBtnLabel}>.txt</span>
              <span style={s.typeBtnDesc}>Plain text</span>
            </button>
            <button style={s.typeBtn} onClick={() => { handleExportMd(exportTarget); setExportTarget(null); }}>
              <span style={s.typeBtnLabel}>.md</span>
              <span style={s.typeBtnDesc}>Markdown — Obsidian, Substack, Ghost</span>
            </button>
            <div style={dg.actions}>
              <button style={btn(th, 'ghost', { mobile: isMobile })} onClick={() => setExportTarget(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Share modal */}
      {shareTarget && (
        <div style={dg.overlay} onClick={() => setShareTarget(null)}>
          <BodyScrollLock />
          <div style={{ ...dg.box, ...(isMobile ? {} : { width: 420 }) }} onClick={e => e.stopPropagation()}>
            <>
                <p style={dg.title}>Share "{shareTarget.title || 'Untitled'}"</p>
                <div style={dg.rule} />
                {(() => {
                  const shareId = shareLinks[shareTarget.id];
                  const status  = shareId ? (shareStatuses[shareId] ?? 'active') : null;
                  return (
                    <>
                      {!shareId && (
                        <button
                          style={{ fontFamily: 'var(--fm)', fontSize: 11, padding: '5px 12px', background: 'var(--ph)', color: 'var(--bg)', border: 'none', cursor: 'pointer', marginTop: 4, marginBottom: 16 }}
                          onClick={() => handleShare(shareTarget)} disabled={shareLoading}
                        >{shareLoading ? 'creating…' : 'Create link'}</button>
                      )}
                      {status === 'reported' && (
                        <div style={{ margin: '6px 0 16px' }}>
                          <p style={{ fontFamily: 'var(--fm)', fontSize: 11, fontStyle: 'italic', color: 'var(--tx-dim)', margin: '0 0 2px' }}>under review — link hidden pending moderation</p>
                          <p style={{ fontFamily: 'var(--fm)', fontSize: 11, color: 'var(--tx-faint)', margin: 0, fontStyle: 'italic' }}>no actions available while under review</p>
                        </div>
                      )}
                      {status === 'blocked' && (
                        <div style={{ margin: '6px 0 16px' }}>
                          <p style={{ fontFamily: 'var(--fm)', fontSize: 11, fontStyle: 'italic', color: '#a03030', margin: '0 0 2px' }}>permanently removed — sharing policy violation</p>
                          <p style={{ fontFamily: 'var(--fm)', fontSize: 11, color: 'var(--tx-faint)', margin: 0, fontStyle: 'italic' }}>this project can no longer be shared</p>
                        </div>
                      )}
                      {status === 'active' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <input readOnly value={shareUrl(shareId)}
                              style={{ flex: 1, fontFamily: 'var(--fm)', fontSize: 10, border: '1px solid var(--bd)', background: 'var(--bg2)', color: 'var(--tx)', padding: '4px 6px', outline: 'none' }}
                              onFocus={e => e.target.select()} />
                            <button
                              style={{ fontFamily: 'var(--fm)', fontSize: 10, padding: '4px 8px', background: shareCopied ? '#4a7c4a' : 'var(--tx)', color: 'var(--bg)', border: 'none', cursor: 'pointer', flexShrink: 0, transition: 'background 0.2s' }}
                              onClick={() => { navigator.clipboard.writeText(shareUrl(shareId)); setShareCopied(true); setTimeout(() => setShareCopied(false), 1500); }}
                            >{shareCopied ? '✓ Copied' : 'Copy'}</button>
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button style={{ fontFamily: 'var(--fm)', fontSize: 10, fontStyle: 'italic', background: 'transparent', border: 'none', color: 'var(--tx-dim)', cursor: 'pointer', padding: 0 }} onClick={() => handleShare(shareTarget)} disabled={shareLoading}>
                              {shareLoading ? 'updating…' : 'Update snapshot'}
                            </button>
                            <span style={{ color: 'var(--tx-faint)', fontSize: 10, margin: '0 2px' }}>·</span>
                            <button style={{ fontFamily: 'var(--fm)', fontSize: 10, fontStyle: 'italic', background: 'transparent', border: 'none', color: '#a03030', cursor: 'pointer', padding: 0 }} onClick={() => handleUnshare(shareTarget)}>
                              Remove link
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
                <div style={dg.actions}>
                  <button style={btn(th, 'ghost', { mobile: isMobile })} onClick={() => setShareTarget(null)}>Close</button>
                </div>
              </>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div style={dg.overlay} onClick={() => setDeleteTarget(null)}>
          <BodyScrollLock />
          <div style={dg.box} onClick={e => e.stopPropagation()}>
            <p style={dg.title}>Move "{deleteTarget.title || 'Untitled'}" to the bin?</p>
            <div style={dg.rule} />
            <p style={{ ...dg.body, color: th.chromeMuted, fontStyle: 'italic', margin: '0 0 16px' }}>
              You can restore it from the recycle bin at any time.
            </p>
            {activeSharesFor(deleteTarget.id).length > 0 && (
              <div style={{ borderTop: `1px solid ${th.chromeBorder}`, padding: '12px 0 4px', marginBottom: 12 }}>
                <p style={{ fontFamily: 'var(--fm)', fontSize: 12, color: th.chromeText, margin: '0 0 10px' }}>
                  This project has an active share link.
                </p>
                {[['keep', 'Keep link active'], ['deactivate', 'Deactivate link']].map(([val, label]) => (
                  <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--fm)', fontSize: 12, color: th.chromeText, cursor: 'pointer', marginBottom: 6 }}>
                    <input type="radio" name="deleteLinkAction" value={val} checked={deleteLinkAction === val} onChange={() => setDeleteLinkAction(val)} />
                    {label}
                  </label>
                ))}
              </div>
            )}
            <div style={dg.actions}>
              <button style={btn(th, 'ghost', { mobile: isMobile })} onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button style={btn(th, 'secondary', { mobile: isMobile })}
                onClick={() => {
                  const blob = new Blob([projectToXml(deleteTarget)], { type: 'application/xml' });
                  triggerBlobDownload(blob, `${safeName(deleteTarget.title)}.oodbo`);
                  setDeleteTarget(null);
                }}
              >Export .oodbo first</button>
              <button style={btn(th, 'primary', { mobile: isMobile })} onClick={() => doDeleteProject(deleteTarget, deleteLinkAction)}>Move to bin</button>
            </div>
          </div>
        </div>
      )}

      {/* Themed notice — replaces window.alert for export/import errors. */}
      {notice && (
        <div style={dg.overlay} onClick={() => setNotice(null)}>
          <BodyScrollLock />
          <div style={{ ...dg.box, ...(isMobile ? {} : { width: 380 }) }} onClick={e => e.stopPropagation()}>
            <p style={dg.title}>{notice.title}</p>
            <div style={dg.rule} />
            {notice.body && <p style={{ ...dg.body, color: th.chromeMuted }}>{notice.body}</p>}
            <div style={dg.actions}>
              <button style={btn(th, 'primary', { mobile: isMobile })} onClick={() => setNotice(null)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Recycle bin modal ────────────────────────────────────────────────── */}
      {showBin && (
        <div style={s.overlay} onClick={() => { setShowBin(false); setPermDeleteTarget(null); setConfirmEmptyBin(false); setBinQuery(''); }}>
          <BodyScrollLock />
          <div style={{ ...s.modal, width: 'min(680px, 92vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <p style={dg.title}>Recycle bin</p>
            <p style={{ ...dg.label, margin: '6px 0 0' }}>
              {binProjects.length} project{binProjects.length !== 1 ? 's' : ''} · kept until permanently deleted
            </p>
            <div style={dg.rule} />
            {!binLoading && binProjects.length > 0 && (
              <input
                value={binQuery}
                onChange={e => setBinQuery(e.target.value)}
                placeholder="Search the bin…"
                aria-label="Search the recycle bin"
                style={{ fontFamily: 'var(--fm)', fontSize: 13, background: 'transparent', border: 'none',
                         borderBottom: `1px solid ${th.chromeBorder}`, color: th.chromeText, padding: '5px 0',
                         outline: 'none', width: '100%', marginBottom: 10 }}
              />
            )}
            {binLoading && (
              <p style={{ ...dg.body, color: th.chromeMuted, fontStyle: 'italic' }}>Loading…</p>
            )}
            {!binLoading && binProjects.length === 0 && (
              <p style={{ ...dg.body, color: th.chromeMuted, fontStyle: 'italic' }}>The bin is empty.</p>
            )}
            {!binLoading && binProjects.length > 0 && shownBin.length === 0 && (
              <p style={{ ...dg.body, color: th.chromeMuted, fontStyle: 'italic' }}>No projects in the bin match “{binQuery.trim()}”.</p>
            )}
            {/* scrollbarGutter reserves the scrollbar's width; paddingRight is the actual gap
                between the row's 'delete' button and the bar — kept comfortable so an active
                (hovered/dragged) scrollbar never touches the button. */}
            {!binLoading && shownBin.length > 0 && (
              <div style={{ overflowY: 'auto', overflowX: 'hidden', flex: 1, marginBottom: 12, scrollbarGutter: 'stable', paddingRight: 12 }}>
                {/* Word count + deleted time distinguish identical titles; delete is labelled, not an × */}
                {shownBin.map(f => (isMobile ? (
                  <div key={f.projectId} style={{ ...s.rowMobile, cursor: 'default' }}>
                    <div style={s.rowMobileTop}>
                      <span style={s.rowTitle}>{f.title}</span>
                      <span style={s.rowDate}>{formatDateTime(f.deletedAt)}</span>
                    </div>
                    <div style={s.rowMobileBottom}>
                      <span style={s.rowMeta}>{plWords(f.words)}</span>
                      <div style={s.rowActions}>
                        {restoreButton(f.projectId)}
                        <button style={{ ...s.exportBtn, color: th.danger, borderColor: th.danger }} onClick={() => setPermDeleteTarget(f)}>delete</button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={f.projectId} style={{ ...s.row, cursor: 'default' }}>
                    <div style={s.rowMain}>
                      <span style={s.rowTitle}>{f.title}</span>
                      <span style={s.rowMetaLine}><span style={s.rowMeta}>{plWords(f.words)} · deleted {formatDateTime(f.deletedAt)}</span></span>
                    </div>
                    <div style={s.rowActions}>
                      {restoreButton(f.projectId)}
                      <button style={{ ...s.exportBtn, color: th.danger, borderColor: th.danger }} onClick={() => setPermDeleteTarget(f)}>delete</button>
                    </div>
                  </div>
                )))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: `1px solid ${th.chromeBorder}`, paddingTop: 14 }}>
              {shownBin.length > 0 ? (
                <button
                  style={btn(th, 'destructive', { mobile: isMobile, outlined: true })}
                  onMouseEnter={e => { e.currentTarget.style.background = th.danger; e.currentTarget.style.color = th.dangerText; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = th.danger; }}
                  onClick={() => setConfirmEmptyBin(true)}
                >{binQuery.trim() ? 'Empty matches' : 'Empty bin'}</button>
              ) : <span />}
              <button style={btn(th, 'ghost', { mobile: isMobile })} onClick={() => { setShowBin(false); setBinQuery(''); }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Permanent delete confirmation ────────────────────────────────────── */}
      {permDeleteTarget && (
        <div style={dg.overlay} onClick={() => !emptyingBin && setPermDeleteTarget(null)}>
          <BodyScrollLock />
          <div style={dgD.box} onClick={e => e.stopPropagation()}>
            <p style={dgD.title}>Permanently delete "{permDeleteTarget.title}"?</p>
            <div style={dgD.rule} />
            <p style={{ ...dgD.body, color: th.chromeMuted, fontStyle: 'italic' }}>
              This cannot be undone.
            </p>
            {activeSharesFor(permDeleteTarget.projectId).length > 0 && (
              <p style={{ ...dgD.body, color: th.chromeMuted, fontStyle: 'italic', margin: '8px 0 0' }}>
                The share link for this project will also be deactivated.
              </p>
            )}
            <div style={dgD.actions}>
              <button style={{ ...btn(th, 'ghost', { mobile: isMobile }), ...(emptyingBin ? { opacity: 0.4, cursor: 'default' } : {}) }} onClick={() => !emptyingBin && setPermDeleteTarget(null)} disabled={emptyingBin}>Cancel</button>
              <button style={btn(th, 'destructive', { mobile: isMobile })} onClick={() => handlePermDelete(permDeleteTarget)} disabled={emptyingBin}>
                {emptyingBin
                  ? <><span style={{ display: 'inline-block', animation: 'home-spin 0.7s linear infinite' }}>↻</span> Deleting…</>
                  : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Empty bin confirmation ───────────────────────────────────────────── */}
      {confirmEmptyBin && (() => {
        const filtering = !!binQuery.trim();
        const binShareCount = shownBin.filter(f => activeSharesFor(f.projectId).length > 0).length;
        return (
        <div style={dg.overlay} onClick={() => !emptyingBin && setConfirmEmptyBin(false)}>
          <BodyScrollLock />
          <div style={dgD.box} onClick={e => e.stopPropagation()}>
            <p style={dgD.title}>{filtering ? 'Delete the matching projects?' : 'Empty the recycle bin?'}</p>
            <div style={dgD.rule} />
            <p style={{ ...dgD.body, color: th.chromeMuted, fontStyle: 'italic' }}>
              {shownBin.length} project{shownBin.length !== 1 ? 's' : ''}{filtering ? ` matching “${binQuery.trim()}”` : ''} will be permanently deleted. This cannot be undone.
            </p>
            {binShareCount > 0 && (
              <p style={{ ...dgD.body, color: th.chromeMuted, fontStyle: 'italic', margin: '8px 0 0' }}>
                {binShareCount} share link{binShareCount !== 1 ? 's' : ''} will also be deactivated.
              </p>
            )}
            <div style={dgD.actions}>
              <button style={{ ...btn(th, 'ghost', { mobile: isMobile }), ...(emptyingBin ? { opacity: 0.4, cursor: 'default' } : {}) }} onClick={() => !emptyingBin && setConfirmEmptyBin(false)} disabled={emptyingBin}>Cancel</button>
              <button style={btn(th, 'destructive', { mobile: isMobile })} onClick={handleEmptyBin} disabled={emptyingBin}>
                {emptyingBin
                  ? <><span style={{ display: 'inline-block', animation: 'home-spin 0.7s linear infinite' }}>↻</span> Deleting…</>
                  : `Delete ${shownBin.length} project${shownBin.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const s = {
  jumpCard: {
    border: '1px solid var(--bd)',
    borderLeft: '3px solid var(--ph)',
    padding: '14px 16px 12px',
    marginBottom: 20,
    background: 'var(--bg2)',
  },
  jumpMeta: {
    display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap',
  },
  jumpLabel: {
    fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--tx-faint)',
  },
  jumpTitle: {
    fontSize: 13, color: 'var(--tx)', fontWeight: 'normal',
  },
  jumpSection: {
    fontSize: 11, color: 'var(--tx-dim)', fontStyle: 'italic',
  },
  jumpPreview: {
    fontSize: 11, lineHeight: 1.65, marginBottom: 12,
    maxHeight: 90, overflow: 'hidden', whiteSpace: 'pre-wrap',
  },
  jumpBefore: { color: 'var(--tx-faint)', fontStyle: 'italic' },
  jumpNear:   { color: 'var(--tx-faint)', fontStyle: 'italic' },
  jumpCursor: { color: 'var(--tx)', fontWeight: 'bold', margin: '0 1px', animation: 'home-blink 1.1s step-start infinite' },
  jumpAfter:  { color: 'var(--tx-faint)', fontStyle: 'italic' },
  jumpActions: { display: 'flex', gap: 8 },
  jumpForwardBtn: {
    fontFamily: 'var(--fm)', fontSize: 11,
    padding: '5px 14px', background: 'var(--ph)', color: 'var(--bg)',
    border: '1px solid var(--ph)', cursor: 'pointer',
  },
  jumpEditBtn: {
    fontFamily: 'var(--fm)', fontSize: 11,
    padding: '5px 14px', background: 'transparent', color: 'var(--tx-dim)',
    border: '1px solid var(--bd)', cursor: 'pointer',
  },
  page: {
    position: 'relative',
    height: '100vh',
    background: 'var(--bg)',
    color: 'var(--tx)',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'var(--fm)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 24px',
    height: 44,
    borderBottom: '1px solid var(--bd)',
    background: 'var(--bg2)',
    flexShrink: 0,
    gap: 12,
  },
  logo: {
    fontFamily: 'var(--fd)',
    fontSize: 20,
    letterSpacing: '0.14em',
    color: 'var(--ph)',
    textShadow: 'var(--glow)',
  },
  flex1: { flex: 1 },
  userEmail: {
    fontSize: 11,
    color: 'var(--tx-faint)',
    fontStyle: 'italic',
  },
  ghostBtn: {
    fontFamily: 'var(--fm)',
    fontSize: 11,
    fontStyle: 'italic',
    background: 'transparent',
    border: 'none',
    color: 'var(--tx-faint)',
    cursor: 'pointer',
    padding: 0,
  },
  scrollArea: {
    flex: 1,
    overflowY: 'auto',
  },
  content: {
    maxWidth: 680,
    width: '100%',
    margin: '0 auto',
    padding: '32px 24px 48px',
    boxSizing: 'border-box',
  },
  headerLine: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    marginBottom: 14,
  },
  syncNote: {
    fontFamily: 'var(--fm)', fontSize: 11, fontStyle: 'italic', color: 'var(--tx-faint)',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    marginBottom: 20,
    flexWrap: 'wrap',
  },
  heading: {
    fontFamily: 'var(--fd)',
    fontSize: 28,
    fontWeight: 'normal',
    color: 'var(--ph)',
    textShadow: 'var(--glow)',
    letterSpacing: '0.06em',
    margin: 0,
  },
  sortBtn: {
    fontFamily: 'var(--fm)', fontSize: 12, background: 'transparent', border: 'none',
    color: 'var(--tx-dim)', padding: '4px 0', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
  },
  sortMenu: {
    position: 'absolute', top: '100%', right: 0, marginTop: 4, minWidth: 170,
    background: 'var(--bg2)', border: '1px solid var(--bd)', boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
    zIndex: 30, padding: '4px 0',
  },
  sortMenuItem: {
    display: 'block', width: '100%', textAlign: 'left', fontFamily: 'var(--fm)', fontSize: 12,
    fontStyle: 'italic', background: 'transparent', border: 'none', color: 'var(--tx-dim)',
    padding: '7px 14px', cursor: 'pointer',
  },
  searchWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 180,
    borderBottom: '1px solid var(--bd)',   // a single hairline baseline — the field's only chrome
  },
  searchInput: {
    fontFamily: 'var(--fm)',
    fontSize: 13,
    background: 'transparent',
    border: 'none',
    borderRadius: 0,
    color: 'var(--tx)',
    padding: '5px 0',
    outline: 'none',
    flex: 1,
    minWidth: 0,
  },
  searchGo: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  searchClear: {
    fontFamily: 'var(--fm)',
    fontSize: 13,
    background: 'transparent',
    border: 'none',
    color: 'var(--tx-dim)',
    cursor: 'pointer',
    padding: '0 6px',
  },
  binToggle: {
    fontFamily: 'var(--fm)',
    fontSize: 11,
    fontStyle: 'italic',
    color: 'var(--tx-dim)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    marginLeft: 8,
    userSelect: 'none',
  },
  binResultsWrap: {
    marginTop: 18,
    paddingTop: 12,
    borderTop: '1px solid var(--bd)',
  },
  binResultsLabel: {
    fontFamily: 'var(--fm)',
    fontSize: 11,
    fontStyle: 'italic',
    color: 'var(--tx-faint)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: '0 0 6px 0',
  },
  binResultRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '9px 2px',
    borderBottom: '1px solid var(--bd)',
  },
  binResultTitle: {
    fontFamily: 'var(--fm)',
    fontSize: 14,
    color: 'var(--tx-dim)',
  },
  binResultHint: {
    fontFamily: 'var(--fm)',
    fontSize: 11,
    fontStyle: 'italic',
    color: 'var(--tx-faint)',
    whiteSpace: 'nowrap',
  },
  exportAllBtn: {
    fontFamily: 'var(--fm)',
    fontSize: 12,
    background: 'transparent',
    border: 'none',
    color: 'var(--tx-dim)',
    padding: '4px 0',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  newBtn: {
    fontFamily: 'var(--fm)',
    fontSize: 12,
    padding: '8px 16px',
    background: 'var(--ph)',
    color: 'var(--bg)',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
  },
  syncNowBtn: {
    fontFamily: 'var(--fm)', fontSize: 11, background: 'transparent', border: 'none',
    color: 'var(--tx-dim)', cursor: 'pointer', padding: 0,
    textDecoration: 'underline', textUnderlineOffset: '3px',
  },
  list: {
    borderTop: '1px solid var(--bd)',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    padding: '14px 8px',
    borderBottom: '1px solid var(--bd)',
    cursor: 'pointer',
    gap: 12,
    transition: 'background 0.1s',
    margin: '0 -8px',
    borderRadius: 2,
  },
  rowMobile: {
    display: 'flex',
    flexDirection: 'column',
    padding: '12px 8px',
    borderBottom: '1px solid var(--bd)',
    cursor: 'pointer',
    gap: 6,
    transition: 'background 0.1s',
    margin: '0 -8px',
    borderRadius: 2,
  },
  rowMobileTop: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    minWidth: 0,
  },
  rowMobileBottom: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  rowTitle: {
    fontSize: 15,
    color: 'var(--tx)',
    flex: 1,
    minWidth: 0,
    // Wrap long titles, but cap at 2 lines then ellipsis (never hide text on one line, never grow
    // unbounded). overflowWrap breaks a very long unbroken token so it can't blow out the row.
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    overflowWrap: 'anywhere',
  },
  rowMeta: {
    fontSize: 11,
    color: 'var(--tx-dim)',
    fontStyle: 'italic',
  },
  // The status dot sits on the meta line, to the left of the meta text — the text is nudged
  // right by the dot's width to accommodate it. No dot ⇒ the text sits where it always did.
  rowMetaLine: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    minWidth: 0,
  },
  // Status is a small dot, not a pill — quiet by design: a fork or a stale backup is
  // information, not an alarm. Colour carries the meaning, hover text spells it out.
  statusDot: {
    width: 8, height: 8, borderRadius: '50%', flexShrink: 0, display: 'inline-block',
    border: 'none', padding: 0,
  },
  // Idle "still here?" checkpoint — quiet card centered over the list.
  idlePromptWrap: {
    position: 'fixed', inset: 0, zIndex: 840, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.72)',
  },
  idlePromptCard: {
    background: 'var(--bg2)', border: '1px solid var(--bd)', borderRadius: 0, padding: '22px 26px',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, boxShadow: '0 6px 24px rgba(0,0,0,0.08)',
  },
  idlePromptText: { fontFamily: 'var(--fm)', fontSize: 17, color: 'var(--tx)', fontStyle: 'italic' },
  idlePromptBtn: {
    fontFamily: 'var(--fm)', fontSize: 13, background: 'var(--ph)', color: 'var(--bg)', border: '1px solid var(--ph)',
    borderRadius: 0, padding: '7px 18px', cursor: 'pointer',
  },
  badgeWarn: {
    fontSize: 10, fontStyle: 'italic', color: '#a03030', background: 'var(--bg2)',
    border: '1px solid var(--bd)', borderRadius: 2, padding: '1px 5px', whiteSpace: 'nowrap', flexShrink: 0,
  },
  badgeMuted: {
    fontSize: 10, fontStyle: 'italic', color: 'var(--tx-dim)', background: 'var(--bd)',
    border: '1px solid var(--bd)', borderRadius: 2, padding: '1px 5px', whiteSpace: 'nowrap', flexShrink: 0,
  },
  rowActions: {
    display: 'flex',
    gap: 12,
    flexShrink: 0,
    alignItems: 'center',
  },
  rowLink: {
    fontFamily: 'var(--fm)', fontSize: 11, fontStyle: 'italic',
    background: 'transparent', border: 'none', color: 'var(--tx-dim)', cursor: 'pointer',
    padding: 0, whiteSpace: 'nowrap', textDecoration: 'underline', textUnderlineOffset: '2px',
  },
  rowMenuBtn: {
    fontFamily: 'var(--fm)', fontSize: 18, lineHeight: 1, letterSpacing: '0.05em',
    background: 'transparent', border: 'none', color: 'var(--tx-dim)', cursor: 'pointer', padding: '0 6px',
  },
  rowMenu: {
    position: 'absolute', top: '100%', right: 0, marginTop: 4, minWidth: 130,
    background: 'var(--bg2)', border: '1px solid var(--bd)', boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
    zIndex: 30, padding: '4px 0',
  },
  rowMenuItem: {
    display: 'block', width: '100%', textAlign: 'left', fontFamily: 'var(--fm)', fontSize: 13,
    background: 'transparent', border: 'none', color: 'var(--tx)', padding: '9px 14px', cursor: 'pointer',
    minHeight: 44, boxSizing: 'border-box',
  },
  exportBtn: {
    fontFamily: 'var(--fm)',
    fontSize: 10,
    fontStyle: 'italic',
    background: 'transparent',
    border: '1px solid var(--bd)',
    color: 'var(--tx-faint)',
    cursor: 'pointer',
    padding: '2px 6px',
    minWidth: 64,
    textAlign: 'center',
    boxSizing: 'border-box',
  },
  deleteRowBtn: {
    fontFamily: 'var(--fm)',
    fontSize: 12,
    background: 'transparent',
    border: '1px solid var(--bd)',
    color: 'var(--tx-faint)',
    cursor: 'pointer',
    padding: '2px 0',
    lineHeight: 1,
    minWidth: 22,
    textAlign: 'center',
    boxSizing: 'border-box',
  },
  rowDate: {
    fontSize: 11,
    color: 'var(--tx-faint)',
    fontStyle: 'italic',
    flexShrink: 0,
    textAlign: 'right',
    whiteSpace: 'nowrap',
  },
  hint: {
    fontSize: 13,
    color: 'var(--tx-faint)',
    fontStyle: 'italic',
    paddingTop: 20,
    margin: 0,
  },
  emptyWrap: {
    paddingTop: 48,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 16,
  },
  emptyState: {
    maxWidth: 460, margin: '28px auto 20px', padding: '0 4px',
  },
  emptyHeading: {
    fontFamily: 'var(--fm)', fontSize: 22, fontWeight: 'normal',
    color: 'var(--tx)', letterSpacing: '-0.02em', margin: '0 0 12px',
  },
  emptyBody: {
    fontFamily: 'var(--fm)', fontSize: 15, lineHeight: 1.7, color: 'var(--tx-dim)', margin: '0 0 24px',
  },
  emptyTypes: {
    display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18,
  },
  emptySecondary: {
    fontFamily: 'var(--fm)', fontSize: 13, fontStyle: 'italic', color: 'var(--tx-dim)', margin: 0,
  },
  emptyLink: {
    fontFamily: 'var(--fm)', fontSize: 13, fontStyle: 'italic', background: 'transparent',
    border: 'none', color: 'var(--tx-dim)', textDecoration: 'underline', textUnderlineOffset: '2px',
    cursor: 'pointer', padding: 0,
  },
  toast: {
    position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)',
    background: 'var(--tx)', color: 'var(--bg)', fontFamily: 'var(--fm)', fontSize: 13,
    padding: '9px 18px', zIndex: 1000, pointerEvents: 'none',
    animation: 'home-toast 1.8s ease forwards',
  },
  footer: {
    padding: '12px 24px',
    borderTop: '1px solid var(--bd)',
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    flexShrink: 0,
  },
  footerLink: {
    fontFamily: 'var(--fm)',
    fontSize: 10,
    color: 'var(--tx-faint)',
    fontStyle: 'italic',
    textDecoration: 'none',
  },
  footerDot: { color: 'var(--tx-faint)', fontSize: 10 },
  footerBtn: {
    fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--tx-faint)',
    fontStyle: 'italic', background: 'transparent', border: 'none',
    cursor: 'pointer', padding: 0,
  },
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  modal: {
    background: 'var(--bg)',
    borderTop: '3px solid var(--ph)',
    padding: '24px 24px 18px',
    width: 320,
    maxWidth: 'calc(100vw - 32px)',
    fontFamily: 'var(--fm)',
    boxSizing: 'border-box',
  },
  modalTitle: {
    fontSize: 15,
    color: 'var(--tx)',
    margin: '0 0 16px',
  },
  typeBtn: {
    fontFamily: 'var(--fm)',
    fontSize: 12,
    width: '100%',
    padding: '10px 12px',
    background: 'var(--ph)',
    color: 'var(--bg)',
    border: '1px solid var(--ph)',
    cursor: 'pointer',
    marginBottom: 8,
    textAlign: 'left',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  typeBtnLabel: { fontWeight: 'normal', fontSize: 13 },
  typeBtnDesc:  { fontSize: 10, color: 'var(--tx-faint)', fontStyle: 'italic' },
  modalDivider: {
    borderTop: '1px solid var(--bd)',
    margin: '12px 0',
  },
  importBtn: {
    fontFamily: 'var(--fm)',
    fontSize: 12,
    width: '100%',
    padding: '9px 12px',
    background: 'transparent',
    color: 'var(--tx-dim)',
    border: '1px solid var(--bd)',
    cursor: 'pointer',
    marginBottom: 8,
    textAlign: 'left',
    fontStyle: 'italic',
  },
  cancelBtn: {
    fontFamily: 'var(--fm)',
    fontSize: 11,
    background: 'transparent',
    border: 'none',
    color: 'var(--tx-dim)',
    cursor: 'pointer',
    fontStyle: 'italic',
    padding: 0,
    marginTop: 4,
  },
};
