// ── Desktop in-app PIN management: add a PIN to an existing account, or reveal its recovery code ──
//
// Setting a PIN on an account that already has plaintext data must RE-ENCRYPT what's on disk/IDB, not
// just future writes — so this reads every existing project, activates the vault key, and re-writes
// each (IDB entry encoded + AppData file/sidecar encrypted). A Google account also gets its Drive
// tokens sealed into the secret (for offline unlock) and the plaintext copy cleared.

import { getAccount, updateAccountSecret, googleIdFor } from './desktopAccounts.js';
import { createSecret, unlockWithPin, rewrapPin, setVaultKey, sealObject, openSealed, encodeEntry } from './localVault.js';
import { PROVIDER_TOKENS_KEY } from './desktopOAuth.js';
import { openDB } from './sync/store.js';
import { serializeOodbo } from './sync/canonical.js';
import { saveProjectXmlToAppData, writeAppDataSidecar } from './desktopSave.js';

export function accountIdFor(user) {
  return user?.provider ? googleIdFor(user.email) : user?.email;   // local ids are already "local:…"
}

const getAll = (db) => new Promise(res => {
  const r = db.transaction('projects', 'readonly').objectStore('projects').getAll();
  r.onsuccess = () => res(r.result ?? []); r.onerror = () => res([]);
});
const put = (db, entry) => new Promise((res, rej) => {
  const tx = db.transaction('projects', 'readwrite');
  tx.objectStore('projects').put(entry); tx.oncomplete = res; tx.onerror = rej;
});

// Re-encrypt every existing project for this owner now that a vault key is active.
async function reencryptOwner(owner) {
  const db = await openDB();
  const mine = (await getAll(db)).filter(e => (e.owner || '') === owner && e.data);   // plaintext entries only
  for (const e of mine) {
    try {
      await put(db, await encodeEntry(e));                                             // IDB: data → enc
      await saveProjectXmlToAppData(owner, e.id, serializeOodbo(e.data));              // AppData file: encrypted
      await writeAppDataSidecar(owner, e.id, { record: null, trashed: !!e.trashed, deletedAt: e.deletedAt ?? null });
    } catch {}
  }
  try { localStorage.removeItem('fwd:projects'); } catch {}                            // drop any plaintext mirror
}

// Add a PIN to the current account. Returns the one-time recovery code to show once.
export async function setAccountPin(user, pin) {
  const id = accountIdFor(user);
  const { secret, recoveryCode, dek } = await createSecret(pin);
  if (user.provider === 'google') {
    let tokens = null; try { tokens = JSON.parse(localStorage.getItem(PROVIDER_TOKENS_KEY) || 'null'); } catch {}
    if (tokens) secret.creds = await sealObject(dek, tokens);     // cache Drive tokens for offline unlock
  }
  await updateAccountSecret(id, secret);                          // marks the account protected
  setVaultKey(dek);
  await reencryptOwner(user.email);
  // NOTE: the plaintext PROVIDER_TOKENS_KEY stays for THIS live session (the engine still needs it);
  // it's sealed in secret.creds for next launch. Boot clears the plaintext copy for a locked protected
  // account (App), and sign-out clears it too — so it never lingers for a locked account.
  return recoveryCode;
}

// Reveal the stored recovery code for the current account, gated behind the PIN.
export async function revealRecovery(user, pin) {
  const acct = await getAccount(accountIdFor(user));
  if (!acct?.secret) return { ok: false, reason: 'no-pin' };
  const dek = await unlockWithPin(acct.secret, pin);
  if (!dek) return { ok: false, reason: 'wrong-pin' };
  const code = await openSealed(dek, acct.secret.recoveryShown);
  return code ? { ok: true, code } : { ok: false, reason: 'unavailable' };
}

// Change the PIN (requires the current PIN). The data key and recovery code are unchanged — only the
// PIN wrapping is re-made — so the existing encrypted data and recovery code stay valid.
export async function changePin(user, currentPin, newPin) {
  const id = accountIdFor(user);
  const acct = await getAccount(id);
  if (!acct?.secret) return { ok: false, reason: 'no-pin' };
  const dek = await unlockWithPin(acct.secret, currentPin);
  if (!dek) return { ok: false, reason: 'wrong-pin' };
  try {
    const secret2 = await rewrapPin(acct.secret, dek, newPin);
    await updateAccountSecret(id, secret2);
    setVaultKey(dek);
    return { ok: true };
  } catch { return { ok: false, reason: 'failed' }; }
}

export async function isAccountProtected(user) {
  const acct = await getAccount(accountIdFor(user));
  return !!acct?.protected;
}
