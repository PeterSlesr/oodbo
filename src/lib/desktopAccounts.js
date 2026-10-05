// ── Desktop local-account registry (unplugged) ───────────────────────────────────────
//
// Desktop has NO guest mode: you open either a Google account (cloud sync + share) or a LOCAL
// account — a username, optionally protected by a PIN. Local accounts never touch a server; their
// writing lives on this machine only. This module is the durable registry of local accounts.
//
// Persistence: the source of truth is a JSON file in the app's AppData dir (survives relaunch AND
// app updates), mirrored to localStorage for an instant boot and as a backup. "Persist indefinitely"
// is the whole point — nothing here ever expires.
//
// Each account's PROJECTS are stored per-owner in IndexedDB (owner = the account id, e.g.
// "local:paul"), isolated from every other account, same owner-scoping the cloud tier uses.
//
// `secret` is null for an OPEN account (no PIN). When PIN protection is added (P2.5b), it holds the
// Model-B blob (PIN- and recovery-code-wrapped data key); this module just stores/returns it opaque.
//
// Tauri-only: imported lazily (via DesktopLogin / App boot) so the web bundle never pulls in fs.

import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, mkdir, writeFile, readTextFile } from '@tauri-apps/plugin-fs';

const FILE      = 'accounts.json';
const LS_MIRROR = 'fwd:desktop-accounts';

export const MAX_PIN_ATTEMPTS = 5;

export function sanitizeUsername(u) { return String(u || '').trim(); }
export function localIdFor(username) { return 'local:' + sanitizeUsername(username).toLowerCase(); }
export function googleIdFor(email)   { return 'google:' + String(email || '').toLowerCase(); }
export function toLocalUser(acct)    { return { provider: null, email: acct.id, name: acct.username, local: true }; }
// A registry row's display label (full, not masked — personal device; see accountCache rationale).
export function accountLabel(acct)   { return acct.type === 'google' ? `Google · ${acct.email || ''}` : (acct.username || ''); }

const empty = () => ({ version: 1, accounts: [], lastUsed: null });

// Cache the AppData-dir promise, but un-cache on failure so one transient error can't poison it
// for the app's lifetime (the desktopSave.js lesson).
let _dirPromise = null;
async function appDir() {
  if (!_dirPromise) {
    _dirPromise = (async () => {
      const dir = await appDataDir();
      if (!(await exists(dir))) await mkdir(dir, { recursive: true });
      return dir;
    })().catch(e => { _dirPromise = null; throw e; });
  }
  return _dirPromise;
}

function readMirror()  { try { return JSON.parse(localStorage.getItem(LS_MIRROR) || 'null'); } catch { return null; } }
function writeMirror(r) { try { localStorage.setItem(LS_MIRROR, JSON.stringify(r)); } catch {} }

async function readDisk() {
  try {
    const path = await join(await appDir(), FILE);
    if (!(await exists(path))) return null;
    return JSON.parse(await readTextFile(path));
  } catch { return null; }
}

async function persist(reg) {
  writeMirror(reg);                                    // instant + reliable
  try {
    const path = await join(await appDir(), FILE);
    await writeFile(path, new TextEncoder().encode(JSON.stringify(reg, null, 2)));
  } catch { /* localStorage mirror still holds it; disk is the durable backup */ }
}

// Disk is authoritative (most durable); fall back to the localStorage mirror, then empty.
export async function loadRegistry() {
  const disk = await readDisk();
  if (disk) { writeMirror(disk); return disk; }
  return readMirror() || empty();
}

export async function listLocalAccounts() { return (await loadRegistry()).accounts; }

export async function getLastUsedAccount() {
  const reg = await loadRegistry();
  return reg.lastUsed ? (reg.accounts.find(a => a.id === reg.lastUsed) || null) : null;
}

export async function setLastUsed(id) {
  const reg = await loadRegistry();
  reg.lastUsed = id;
  await persist(reg);
}

// Replace an account's secret blob (used when resetting a PIN via the recovery code).
export async function updateAccountSecret(id, secret) {
  const reg = await loadRegistry();
  const acct = reg.accounts.find(a => a.id === id);
  if (!acct) return;
  acct.secret = secret || null;
  acct.protected = !!secret;
  await persist(reg);
}

// Create an OPEN local account (secret=null) or a PIN-protected one (secret = Model-B blob, P2.5b).
export async function createLocalAccount({ username, secret = null }) {
  const name = sanitizeUsername(username);
  if (!name) throw new Error('empty_username');
  const reg = await loadRegistry();
  const id = localIdFor(name);
  if (reg.accounts.some(a => a.id === id)) throw new Error('username_taken');
  const acct = { id, type: 'local', username: name, protected: !!secret, secret: secret || null, failedAttempts: 0, createdAt: new Date().toISOString() };
  reg.accounts.push(acct);
  reg.lastUsed = id;
  await persist(reg);
  return acct;
}

// Remember a Google account in the "welcome back" list (upsert by email). `secret` (optional, Model-B
// blob with the provider tokens cached inside) is set when the user protects it with a PIN later.
export async function recordGoogleAccount({ email, secret = null }) {
  if (!email) return null;
  const reg = await loadRegistry();
  const id  = googleIdFor(email);
  let acct  = reg.accounts.find(a => a.id === id);
  if (!acct) {
    acct = { id, type: 'google', email, protected: !!secret, secret: secret || null, failedAttempts: 0, createdAt: new Date().toISOString() };
    reg.accounts.push(acct);
  } else if (secret !== null) {
    acct.secret = secret; acct.protected = !!secret;
  }
  reg.lastUsed = id;
  await persist(reg);
  return acct;
}

export async function getAccount(id) {
  return (await loadRegistry()).accounts.find(a => a.id === id) || null;
}

export async function removeAccount(id) {
  const reg = await loadRegistry();
  reg.accounts = reg.accounts.filter(a => a.id !== id);
  if (reg.lastUsed === id) reg.lastUsed = reg.accounts[reg.accounts.length - 1]?.id ?? null;
  await persist(reg);
}

// PIN attempt-limiting: 5 wrong tries locks the row (UI then steers to recovery / re-sign-in).
export async function registerFailedUnlock(id) {
  const reg = await loadRegistry();
  const acct = reg.accounts.find(a => a.id === id);
  if (!acct) return { count: 0, locked: false };
  acct.failedAttempts = (acct.failedAttempts || 0) + 1;
  await persist(reg);
  return { count: acct.failedAttempts, locked: acct.failedAttempts >= MAX_PIN_ATTEMPTS };
}

export async function clearFailedUnlock(id) {
  const reg = await loadRegistry();
  const acct = reg.accounts.find(a => a.id === id);
  if (acct && acct.failedAttempts) { acct.failedAttempts = 0; await persist(reg); }
}
