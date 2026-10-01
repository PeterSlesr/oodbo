import React, { useEffect, useState } from 'react';
import { listLocalAccounts, createLocalAccount, updateAccountSecret, setLastUsed, toLocalUser } from '../lib/desktopAccounts.js';
import { createSecret, unlockWithPin, unlockWithRecovery, rewrapPin, setVaultKey } from '../lib/localVault.js';

// ── Desktop login gate (Tauri only) ───────────────────────────────────────────────────
// No guest on desktop. Open a Google account (cloud sync + share) or a LOCAL account (a username,
// optionally PIN-protected). A PIN uses Model B (localVault): a one-time recovery code is shown at
// creation so a forgotten PIN can be reset without losing data. CRT-themed via the app scheme.
//
// Props: onGoogle(), onLocal(user)   — onLocal receives a toLocalUser(acct) object.

const PIN_RE = /^\d{4,8}$/;

export default function DesktopLogin({ onGoogle, onLocal }) {
  const scheme = (() => { try { return localStorage.getItem('fwd:crt-scheme') || 'green'; } catch { return 'green'; } })();
  const [accounts, setAccounts] = useState(null);     // null = loading
  const [mode,     setMode]     = useState('pick');    // pick | new | showRecovery | unlock | recovery
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState('');

  // new-account form
  const [username, setUsername] = useState('');
  const [usePin,   setUsePin]   = useState(false);
  const [pin,      setPin]      = useState('');
  const [pin2,     setPin2]     = useState('');

  // post-create recovery display
  const [recoveryCode, setRecoveryCode] = useState('');
  const [pendingAcct,  setPendingAcct]  = useState(null);
  const [copied,       setCopied]       = useState(false);

  // unlock / reset
  const [target,    setTarget]    = useState(null);    // the protected account being opened
  const [unlockPin, setUnlockPin] = useState('');
  const [recInput,  setRecInput]  = useState('');
  const [newPin,    setNewPin]    = useState('');
  const [newPin2,   setNewPin2]   = useState('');

  useEffect(() => { listLocalAccounts().then(setAccounts).catch(() => setAccounts([])); }, []);

  function reset(toMode = 'pick') {
    setMode(toMode); setError(''); setBusy(false);
    setUsername(''); setUsePin(false); setPin(''); setPin2('');
    setRecoveryCode(''); setPendingAcct(''); setCopied(false);
    setTarget(null); setUnlockPin(''); setRecInput(''); setNewPin(''); setNewPin2('');
  }

  function openAccount(acct) {
    if (acct.protected) { setTarget(acct); setUnlockPin(''); setError(''); setMode('unlock'); return; }
    (async () => { try { await setLastUsed(acct.id); } catch {} onLocal(toLocalUser(acct)); })();
  }

  async function createAccount() {
    const name = username.trim();
    if (!name) { setError('Pick a username.'); return; }
    if (usePin) {
      if (!PIN_RE.test(pin)) { setError('PIN must be 4–8 digits.'); return; }
      if (pin !== pin2)      { setError('PINs don’t match.'); return; }
    }
    setBusy(true); setError('');
    try {
      if (usePin) {
        const { secret, recoveryCode, dek } = await createSecret(pin);
        const acct = await createLocalAccount({ username: name, secret });
        setVaultKey(dek);                       // data written from here on is encrypted
        setRecoveryCode(recoveryCode); setPendingAcct(acct); setMode('showRecovery'); setBusy(false);
      } else {
        const acct = await createLocalAccount({ username: name });
        onLocal(toLocalUser(acct));
      }
    } catch (e) {
      setError(e?.message === 'username_taken' ? 'That username already exists on this machine.' : 'Could not create the account.');
      setBusy(false);
    }
  }

  async function unlock() {
    if (!unlockPin) { setError('Enter your PIN.'); return; }
    setBusy(true); setError('');
    const dek = await unlockWithPin(target.secret, unlockPin);
    if (!dek) { setError('Wrong PIN.'); setBusy(false); return; }
    setVaultKey(dek);
    try { await setLastUsed(target.id); } catch {}
    onLocal(toLocalUser(target));
  }

  async function resetPin() {
    if (!PIN_RE.test(newPin)) { setError('New PIN must be 4–8 digits.'); return; }
    if (newPin !== newPin2)   { setError('New PINs don’t match.'); return; }
    setBusy(true); setError('');
    const dek = await unlockWithRecovery(target.secret, recInput);
    if (!dek) { setError('That recovery code isn’t right.'); setBusy(false); return; }
    try {
      const secret2 = await rewrapPin(target.secret, dek, newPin);
      await updateAccountSecret(target.id, secret2);
      setVaultKey(dek);
      await setLastUsed(target.id);
      onLocal(toLocalUser(target));
    } catch { setError('Could not reset the PIN.'); setBusy(false); }
  }

  const list = accounts || [];

  return (
    <div style={s.page} data-scheme={scheme} className="crt-scanlines crt-vignette">
      <div style={s.panel}>
        <div style={s.bar} />
        <div style={s.head}>
          <span style={s.logo}>FORWARD&nbsp;ONLY</span>
          <p style={s.tag}>// open an account to begin</p>
        </div>

        {/* ── PICK ────────────────────────────────────────────────────────── */}
        {mode === 'pick' && (
          <>
            <button style={{ ...s.btn, ...s.google }} onClick={onGoogle}>◉ CONTINUE WITH GOOGLE</button>
            <p style={s.note}>syncs to your Google Drive · enables sharing</p>
            <div style={s.divider}><span style={s.divText}>OR — ON THIS MACHINE</span></div>
            {accounts === null && <p style={s.note}>loading accounts…</p>}
            {list.map(acct => (
              <button key={acct.id} style={{ ...s.btn, ...s.acct }} onClick={() => openAccount(acct)}
                      title={acct.protected ? 'PIN-protected' : 'Open this local account'}>
                <span>▸ {acct.username}</span>
                <span style={s.acctMeta}>{acct.protected ? '🔒 PIN' : 'local'}</span>
              </button>
            ))}
            <button style={{ ...s.btn, ...s.newBtn }} onClick={() => reset('new')}>＋ NEW LOCAL ACCOUNT</button>
          </>
        )}

        {/* ── NEW ─────────────────────────────────────────────────────────── */}
        {mode === 'new' && (
          <div style={s.form}>
            <label style={s.label}>USERNAME</label>
            <input autoFocus style={s.input} value={username} maxLength={40}
                   onChange={e => setUsername(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter' && !usePin && !busy) createAccount(); }} />
            <p style={s.note}>kept on this computer only · no cloud · no sign-up</p>

            <label style={s.check}>
              <input type="checkbox" checked={usePin} onChange={e => setUsePin(e.target.checked)} />
              <span>Protect with a PIN</span>
            </label>
            {usePin && (
              <>
                <input style={s.input} type="password" inputMode="numeric" placeholder="PIN (4–8 digits)"
                       value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} />
                <input style={{ ...s.input, marginTop: 8 }} type="password" inputMode="numeric" placeholder="Confirm PIN"
                       value={pin2} onChange={e => setPin2(e.target.value.replace(/\D/g, '').slice(0, 8))}
                       onKeyDown={e => { if (e.key === 'Enter' && !busy) createAccount(); }} />
                <p style={s.note}>you’ll get a one-time recovery code to reset a forgotten PIN</p>
              </>
            )}
            <div style={s.row}>
              <button style={{ ...s.btn, ...s.newBtn, flex: 1 }} disabled={busy} onClick={createAccount}>{busy ? 'CREATING…' : 'CREATE & OPEN'}</button>
              <button style={{ ...s.btn, ...s.ghost }} disabled={busy} onClick={() => reset('pick')}>BACK</button>
            </div>
          </div>
        )}

        {/* ── SHOW RECOVERY (once) ─────────────────────────────────────────── */}
        {mode === 'showRecovery' && (
          <div style={s.form}>
            <p style={s.warnTitle}>SAVE YOUR RECOVERY CODE</p>
            <p style={s.note}>This is the only way to reset a forgotten PIN. It won’t be shown again. Store it somewhere safe — if you lose both the PIN and this code, the writing can’t be recovered.</p>
            <div style={s.codeBox}>{recoveryCode}</div>
            <button style={{ ...s.btn, ...s.newBtn }} onClick={() => { navigator.clipboard?.writeText(recoveryCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? 'COPIED ✓' : 'COPY CODE'}
            </button>
            <button style={{ ...s.btn, ...s.google, marginTop: 14 }} onClick={() => onLocal(toLocalUser(pendingAcct))}>I’VE SAVED IT — CONTINUE</button>
          </div>
        )}

        {/* ── UNLOCK ──────────────────────────────────────────────────────── */}
        {mode === 'unlock' && target && (
          <div style={s.form}>
            <label style={s.label}>UNLOCK · {target.username}</label>
            <input autoFocus style={s.input} type="password" inputMode="numeric" placeholder="PIN"
                   value={unlockPin} onChange={e => setUnlockPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                   onKeyDown={e => { if (e.key === 'Enter' && !busy) unlock(); }} />
            <div style={s.row}>
              <button style={{ ...s.btn, ...s.newBtn, flex: 1 }} disabled={busy} onClick={unlock}>{busy ? 'UNLOCKING…' : 'UNLOCK'}</button>
              <button style={{ ...s.btn, ...s.ghost }} disabled={busy} onClick={() => reset('pick')}>BACK</button>
            </div>
            <button style={s.link} onClick={() => { setMode('recovery'); setError(''); }}>Forgot PIN?</button>
          </div>
        )}

        {/* ── RECOVERY (reset PIN) ─────────────────────────────────────────── */}
        {mode === 'recovery' && target && (
          <div style={s.form}>
            <label style={s.label}>RESET PIN · {target.username}</label>
            <input autoFocus style={s.input} placeholder="Recovery code" value={recInput}
                   onChange={e => setRecInput(e.target.value)} />
            <input style={{ ...s.input, marginTop: 8 }} type="password" inputMode="numeric" placeholder="New PIN (4–8 digits)"
                   value={newPin} onChange={e => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 8))} />
            <input style={{ ...s.input, marginTop: 8 }} type="password" inputMode="numeric" placeholder="Confirm new PIN"
                   value={newPin2} onChange={e => setNewPin2(e.target.value.replace(/\D/g, '').slice(0, 8))}
                   onKeyDown={e => { if (e.key === 'Enter' && !busy) resetPin(); }} />
            <div style={s.row}>
              <button style={{ ...s.btn, ...s.newBtn, flex: 1 }} disabled={busy} onClick={resetPin}>{busy ? 'RESETTING…' : 'RESET & OPEN'}</button>
              <button style={{ ...s.btn, ...s.ghost }} disabled={busy} onClick={() => { setMode('unlock'); setError(''); }}>BACK</button>
            </div>
          </div>
        )}

        {error && <p style={s.error}>{error}</p>}
      </div>
    </div>
  );
}

const s = {
  page:  { height: '100%', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', color: 'var(--tx)', fontFamily: 'var(--fm)', padding: 16, overflow: 'auto' },
  panel: { position: 'relative', width: '100%', maxWidth: 440, background: 'var(--bg2)', border: '1px solid var(--bd)', padding: '32px 28px 28px' },
  bar:   { position: 'absolute', top: 0, left: 0, right: 0, height: 6, background: 'var(--ph)' },
  head:  { textAlign: 'center', marginBottom: 24 },
  logo:  { fontFamily: 'var(--fd)', fontSize: 44, letterSpacing: 2, color: 'var(--ph)', textShadow: 'var(--glow)', lineHeight: 1 },
  tag:   { marginTop: 8, fontSize: 12, letterSpacing: 2, color: 'var(--tx-dim)' },
  btn:   { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '12px 14px', marginTop: 10, background: 'transparent', color: 'var(--tx)', border: '1px solid var(--bd)', fontFamily: 'var(--fm)', fontSize: 13, letterSpacing: 1, cursor: 'pointer', textTransform: 'uppercase' },
  google:{ borderColor: 'var(--ph-dim)', color: 'var(--ph)' },
  acct:  { justifyContent: 'space-between', textTransform: 'none', letterSpacing: 0.5 },
  acctMeta: { fontSize: 11, color: 'var(--tx-faint)', letterSpacing: 1 },
  newBtn:{ borderStyle: 'dashed', color: 'var(--tx-dim)' },
  ghost: { width: 'auto', color: 'var(--tx-faint)' },
  divider: { position: 'relative', textAlign: 'center', margin: '22px 0 4px', borderTop: '1px solid var(--bd)' },
  divText: { position: 'relative', top: -9, background: 'var(--bg2)', padding: '0 10px', fontSize: 10, letterSpacing: 2, color: 'var(--tx-faint)' },
  note:  { marginTop: 6, fontSize: 11, color: 'var(--tx-faint)', textAlign: 'center', letterSpacing: 0.5, lineHeight: 1.5 },
  form:  { marginTop: 4 },
  label: { display: 'block', fontSize: 11, letterSpacing: 2, color: 'var(--tx-dim)', marginBottom: 6 },
  input: { width: '100%', padding: '11px 12px', background: 'var(--bg)', color: 'var(--tx)', border: '1px solid var(--bd)', fontFamily: 'var(--fm)', fontSize: 14, outline: 'none' },
  check: { display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 8px', fontSize: 13, color: 'var(--tx-dim)', cursor: 'pointer' },
  row:   { display: 'flex', gap: 8, alignItems: 'stretch' },
  link:  { display: 'block', width: '100%', marginTop: 12, background: 'transparent', border: 'none', color: 'var(--tx-faint)', fontFamily: 'var(--fm)', fontSize: 12, textDecoration: 'underline', cursor: 'pointer' },
  warnTitle: { fontSize: 13, letterSpacing: 2, color: 'var(--ph)', textShadow: 'var(--glow)', marginBottom: 8, textAlign: 'center' },
  codeBox: { margin: '14px 0', padding: '14px 10px', background: 'var(--bg)', border: '1px solid var(--ph-dim)', color: 'var(--ph)', fontFamily: 'var(--fm)', fontSize: 18, letterSpacing: 2, textAlign: 'center', wordBreak: 'break-all' },
  error: { marginTop: 12, fontSize: 12, color: '#ff6b6b', textAlign: 'center' },
};
