// ── localVault: Model-B PIN encryption for opt-in local-account protection (desktop) ──────────
//
// A local account can optionally be "hidden under a PIN". When it is, a random 256-bit AES-GCM Data
// Encryption Key (DEK) encrypts that account's project data. The DEK is wrapped TWICE:
//   · by a key derived (PBKDF2-SHA256) from the PIN, and
//   · by a key derived from a one-time RECOVERY CODE shown once at creation.
// Either unwraps the DEK, so a forgotten PIN is recoverable via the code (set a new PIN = re-wrap the
// PIN copy, recovery copy untouched). Lose BOTH the PIN and the code and the data is unrecoverable —
// inherent to zero-server encryption, the honest cost of real at-rest privacy.
//
// WebCrypto only (works in WebView2). The unlocked DEK is held in memory here after unlock and used
// by the IDB encode/decode helpers below; it is NEVER persisted. Open (no-PIN) accounts never set a
// DEK, so every helper is a transparent pass-through for them and for web — zero behaviour change.

const PBKDF2_ITER = 210_000;                 // OWASP 2023 guidance for PBKDF2-SHA256
const encTxt = new TextEncoder();
const decTxt = new TextDecoder();

// base64 that survives large (multi-MB) manuscripts without blowing the call stack.
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
const fromB64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// ── In-memory DEK (set on unlock, cleared on sign-out; never written to disk) ───────────────────
let _dek = null;
export function hasVaultKey()  { return !!_dek; }
export function setVaultKey(k) { _dek = k; }
export function clearVaultKey() { _dek = null; }

async function deriveKEK(secret, saltBytes, iterations = PBKDF2_ITER) {
  const base = await crypto.subtle.importKey('raw', encTxt.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'],
  );
}

async function wrapDek(dek, kek) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
  return { iv: toB64(iv), ct: toB64(wrapped) };
}
async function unwrapDek(blob, kek) {
  return crypto.subtle.unwrapKey(
    'raw', fromB64(blob.ct), kek, { name: 'AES-GCM', iv: fromB64(blob.iv) },
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],   // extractable so PIN reset can re-wrap
  );
}

// A one-time recovery code: Crockford-ish base32 (no ambiguous 0/O/1/I/L), grouped in 4s for reading.
export function generateRecoveryCode(len = 24) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) { out += A[r[i] % A.length]; if (i % 4 === 3 && i < len - 1) out += '-'; }
  return out;
}
const normCode = (code) => String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

// ── Secret lifecycle (the blob stored opaquely in the account registry) ─────────────────────────

// Make a fresh protected secret. Returns { secret, recoveryCode, dek }. Caller shows recoveryCode
// ONCE, stores `secret` on the account, and sets the returned dek as the active vault key.
export async function createSecret(pin) {
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const recoveryCode = generateRecoveryCode();
  const pinSalt = crypto.getRandomValues(new Uint8Array(16));
  const recSalt = crypto.getRandomValues(new Uint8Array(16));
  const secret = {
    v: 1, iter: PBKDF2_ITER,
    pinSalt: toB64(pinSalt), recSalt: toB64(recSalt),
    wrappedByPin:      await wrapDek(dek, await deriveKEK(pin, pinSalt)),
    wrappedByRecovery: await wrapDek(dek, await deriveKEK(normCode(recoveryCode), recSalt)),
  };
  return { secret, recoveryCode, dek };
}

// Returns the DEK (CryptoKey) on success, or null on a wrong PIN (GCM auth failure throws → null).
export async function unlockWithPin(secret, pin) {
  try { return await unwrapDek(secret.wrappedByPin, await deriveKEK(pin, fromB64(secret.pinSalt), secret.iter)); }
  catch { return null; }
}
export async function unlockWithRecovery(secret, code) {
  try { return await unwrapDek(secret.wrappedByRecovery, await deriveKEK(normCode(code), fromB64(secret.recSalt), secret.iter)); }
  catch { return null; }
}

// Re-wrap the DEK under a NEW pin (recovery copy stays valid). Returns the updated secret.
export async function rewrapPin(secret, dek, newPin) {
  const pinSalt = crypto.getRandomValues(new Uint8Array(16));
  return { ...secret, pinSalt: toB64(pinSalt), wrappedByPin: await wrapDek(dek, await deriveKEK(newPin, pinSalt, secret.iter)) };
}

// ── IDB entry encode/decode (transparent pass-through when no DEK is active) ─────────────────────
// A projects-store entry is { id, owner, pendingSync, lastSynced, data }. When a vault is active we
// move `data` into an encrypted `enc` blob so the writing never sits in IDB as plaintext; id/owner
// stay clear (needed for queries; they're not the content). Readers call decodeEntry to get `data` back.
async function encrypt(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _dek, encTxt.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(ct) };
}
async function decrypt(blob) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, _dek, fromB64(blob.ct));
  return JSON.parse(decTxt.decode(pt));
}

export async function encodeEntry(entry) {
  if (!_dek || !entry || entry.data == null) return entry;
  return { ...entry, data: null, enc: await encrypt(entry.data) };
}
export async function decodeEntry(entry) {
  if (!entry || !entry.enc) return entry;          // plaintext (open account / web) → unchanged
  if (!_dek) return entry;                          // locked: can't read — leave opaque (shouldn't happen when active)
  try { return { ...entry, data: await decrypt(entry.enc), enc: undefined }; }
  catch { return entry; }
}
