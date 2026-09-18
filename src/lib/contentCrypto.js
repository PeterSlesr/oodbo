// ── At-rest content encryption for cloud-stored .oodbo files ─────────────────────
//
// Purpose (see ENCRYPTION-DESIGN.md §1): keep project prose out of any bulk AI-training
// scrape Google/Microsoft might run over Drive/OneDrive contents. NOT zero-knowledge —
// the key is derived from the account email + an app constant that ships in this bundle,
// so this is deliberately "unhardened." It defeats a content-agnostic scraper, nothing more.
//
// The ONLY integration point is wrapCloudWithEncryption(), applied to the engine's `cloud`
// dependency in sync/client.js. It encrypts the `xml` going into save()/trash() and decrypts
// the `xml` coming out of load(); every other engine module (hashXml, parseOodbo, fork,
// migration) sees plaintext because decryption happens inside load() before they run.
//
// DO NOT call the serializer with this — exports, imports, the appdata mirror, and share
// snapshots must stay plaintext (design §3). Encryption belongs to the cloud adapter only.

import { CloudTransientError } from './sync/cloud.js';

// ── Constants (identical on web + desktop by being hardcoded here, NOT env-sourced) ──────
// If these came from import.meta.env, the desktop build (no web .env) would derive a
// DIFFERENT key and silently fail to read web-written files. Hardcoding guarantees parity.
// APP_SECRET is not a real secret (it's in the shipped bundle); its only job is to keep the
// key from being derivable from the email alone. Rotating it later ⇒ a v2 envelope + re-encrypt.
const APP_SECRET = '0jo6kmlxd6atm7rrkk3xqi4612sjx4wlxsw5jercud3e7dkv6y11irq2lirnsc8s'; // PERMANENT — changing it later = v2 envelope + re-encrypt (§12.2)
const SALT = new Uint8Array([
  // 16 fixed bytes. Fixed so every device derives the same key (per-user uniqueness comes
  // from the email in the KDF material). Replace with your own 16 random bytes.
  0x6f, 0x6f, 0x64, 0x62, 0x6f, 0x2d, 0x65, 0x6e, 0x63, 0x2d, 0x73, 0x61, 0x6c, 0x74, 0x2d, 0x31,
]);
const PBKDF2_ITERS = 200_000;

const PREFIX = 'oodbo-enc:v1:';   // full v1 envelope prefix
const MAGIC  = 'oodbo-enc:';      // any-version marker used for encrypted-vs-legacy detection

// ── Email normalization — deterministic and LOCALE-INDEPENDENT ───────────────────────────
// toLowerCase() (Unicode default mapping), NEVER toLocaleLowerCase(): the latter turns 'I'
// into dotless 'ı' on a Turkish-locale machine, deriving a different key on that device only —
// the #1 silent cross-device break. NFC first so a non-ASCII email in a different Unicode
// form still normalizes identically across OSes.
export function normalizeEmail(email) {
  return String(email == null ? '' : email).normalize('NFC').trim().toLowerCase();
}

// ── Byte-safe base64 (btoa over a BYTE-string, never over a UTF-8 string) ─────────────────
// btoa(utf8String) corrupts any non-ASCII (curly quotes, em-dashes, emoji, accented names).
// Operating on a Uint8Array via fromCharCode keeps every byte intact. Chunked to avoid the
// call-stack limit that a spread over a large array would hit.
function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Key derivation (PBKDF2 → AES-GCM CryptoKey) ──────────────────────────────────────────
// Same crypto.subtle the sync hash (canonical.js) already relies on, so it is known-good in
// every oodbo runtime: browser, WKWebView (desktop macOS), WebView2 (desktop Windows).
export async function deriveKey(email) {
  const material = new TextEncoder().encode(normalizeEmail(email) + ' ' + APP_SECRET);
  const baseKey = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,                    // non-extractable
    ['encrypt', 'decrypt'],
  );
}

// ── Envelope encrypt / decrypt ───────────────────────────────────────────────────────────
// Random 12-byte IV per call ⇒ identical plaintext yields different ciphertext (no equality
// leak). Harmless to the engine: it only re-saves when the *content* hash changes, so it
// never re-encrypts unchanged text (design §8).
export async function encryptEnvelope(key, plaintextXml) {
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintextXml);
  const ct   = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return `${PREFIX}${bytesToBase64(iv)}:${bytesToBase64(ct)}`;
}

// AES-GCM authentication makes a wrong key OR a corrupted byte THROW rather than return
// garbage. We convert any failure to CloudTransientError so the engine treats it as
// "cloud unreachable for this project": stay dirty, keep local intact, retry — NEVER a
// destructive notFound/empty/different-content path (design §7). This is the safety net.
export async function decryptEnvelope(key, blob) {
  try {
    if (!blob.startsWith(PREFIX)) throw new Error('unknown envelope version');
    const body = blob.slice(PREFIX.length);
    const sep  = body.indexOf(':');
    if (sep < 0) throw new Error('malformed envelope');
    const iv = base64ToBytes(body.slice(0, sep));
    const ct = base64ToBytes(body.slice(sep + 1));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    throw new CloudTransientError('decrypt-failed');
  }
}

export function isEncrypted(blob) {
  return typeof blob === 'string' && blob.startsWith(MAGIC);
}

// ── The decorator: the entire behavioural change ─────────────────────────────────────────
// Wraps whichever cloud adapter client.js selected (web createCloud or desktop
// createDesktopCloud — identical 7-method contract). Only save/load/trash carry content;
// list/restore/head/remove pass through untouched via the spread.
export function wrapCloudWithEncryption(cloud, ownerEmail) {
  if (!ownerEmail) return cloud;    // safety: no key material ⇒ plaintext passthrough

  // Derive once per session, lazily, and memoise the promise — PBKDF2 at 200k iters is not
  // per-file work. Keeps initSync synchronous (the promise resolves on first save/load).
  let keyPromise = null;
  const getKey = () => (keyPromise || (keyPromise = deriveKey(ownerEmail)));

  const enc = async (xml) => (xml == null ? xml : encryptEnvelope(await getKey(), xml));

  // Legacy plaintext (no magic prefix) passes straight through — this is what makes the
  // format migration transparent: reads accept both, writes always emit ciphertext.
  const dec = async (blob) => {
    if (blob == null || !isEncrypted(blob)) return blob;
    return decryptEnvelope(await getKey(), blob);
  };

  return {
    ...cloud,

    async save(projectId, xml, opts) {
      return cloud.save(projectId, await enc(xml), opts);
    },

    // undefined stays undefined (plain rename); only a real create-as-trash body is encrypted.
    // Encrypting `undefined` would send the literal "oodbo-enc:..." string as a file body.
    async trash(projectId, xml) {
      return cloud.trash(projectId, xml === undefined ? undefined : await enc(xml));
    },

    async load(projectId) {
      const r = await cloud.load(projectId);
      if (!r || r.notFound || r.xml == null) return r;   // preserve control-flow shapes
      return { ...r, xml: await dec(r.xml) };
    },
  };
}
