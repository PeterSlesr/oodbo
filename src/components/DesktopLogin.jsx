import React, { useEffect, useState } from 'react';
import {
  listLocalAccounts, createLocalAccount, updateAccountSecret, setLastUsed, getAccount,
  toLocalUser, accountLabel, registerFailedUnlock, clearFailedUnlock, MAX_PIN_ATTEMPTS,
} from '../lib/desktopAccounts.js';
import {
  createSecret, unlockWithPin, unlockWithRecovery, rewrapPin, setVaultKey, openSealed,
} from '../lib/localVault.js';
import { PROVIDER_TOKENS_KEY } from '../lib/desktopOAuth.js';

// ── Desktop login gate (Tauri only) ───────────────────────────────────────────────────
// No guest on desktop. One "welcome back" list of every account used on this machine (Google +
// local), each optionally PIN-protected. A PIN unlocks offline and (per Model B) encrypts that
// account's local data; a Google PIN also caches its Drive tokens so it opens offline w/o re-auth.
//
// Props: onGoogle(hint?) — start online Google PKCE sign-in;  onEnter(user) — enter a resolved account.

const PIN_RE = /^\d{4,8}$/;

export default function DesktopLogin({ onGoogle, onEnter }) {
  const scheme = (() => { try { return localStorage.getItem('fwd:crt-scheme') || 'green'; } catch { return 'green'; } })();
  const [accounts, setAccounts] = useState(null);     // null = loading
  const [mode,     setMode]     = useState('pick');    // pick | new | showRecovery | unlock | recovery
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState('');
  const [showPin,  setShowPin]  = useState(false);

  // new local account
  const [username, setUsername] = useState('');
  const [usePin,   setUsePin]   = useState(false);
  const [pin,      setPin]      = useState('');
  const [pin2,     setPin2]     = useState('');

  // recovery display (after local PIN create)
  const [recoveryCode, setRecoveryCode] = useState('');
  const [pendingUser,  setPendingUser]  = useState(null);
  const [copied,       setCopied]       = useState(false);

  // unlock / reset
  const [target,    setTarget]    = useState(null);
  const [locked,    setLocked]    = useState(false);
  const [unlockPin, setUnlockPin] = useState('');
  const [recInput,  setRecInput]  = useState('');
  const [newPin,    setNewPin]    = useState('');
  const [newPin2,   setNewPin2]   = useState('');

  const refresh = () => listLocalAccounts().then(setAccounts).catch(() => setAccounts([]));
  useEffect(() => { refresh(); }, []);

  function toPick() {
    setMode('pick'); setError(''); setBusy(false); setShowPin(false);
    setUsername(''); setUsePin(false); setPin(''); setPin2('');
    setRecoveryCode(''); setPendingUser(null); setCopied(false);
    setTarget(null); setLocked(false); setUnlockPin(''); setRecInput(''); setNewPin(''); setNewPin2('');
  }

  // Resolve the user object after a successful PIN/recovery unlock (restores Google tokens offline).
  async function enterUnlocked(acct, dek) {
    setVaultKey(dek);
    if (acct.type === 'google') {
      if (acct.secret?.creds) {
        const tokens = await openSealed(dek, acct.secret.creds);
        if (tokens) { try { localStorage.setItem(PROVIDER_TOKENS_KEY, JSON.stringify(tokens)); } catch {} }
      }
      try { await setLastUsed(acct.id); } catch {}
      onEnter({ provider: 'google', email: acct.email });
    } else {
      try { await setLastUsed(acct.id); } catch {}
      onEnter(toLocalUser(acct));
    }
  }

  function clickAccount(acct) {
    setError('');
    if (acct.protected) { setTarget(acct); setLocked((acct.failedAttempts || 0) >= MAX_PIN_ATTEMPTS); setUnlockPin(''); setMode('unlock'); return; }
    if (acct.type === 'google') { onGoogle(acct.email); return; }   // no-PIN Google → online resume (hint)
    (async () => { try { await setLastUsed(acct.id); } catch {} onEnter(toLocalUser(acct)); })();
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
        setVaultKey(dek);
        setRecoveryCode(recoveryCode); setPendingUser(toLocalUser(acct)); setMode('showRecovery'); setBusy(false);
      } else {
        const acct = await createLocalAccount({ username: name });
        onEnter(toLocalUser(acct));
      }
    } catch (e) {
      setError(e?.message === 'username_taken' ? 'That username already exists on this machine.' : 'Could not create the account.');
      setBusy(false);
    }
  }

  async function unlock() {
    if (!unlockPin) { setError('Enter your PIN.'); return; }
    setBusy(true); setError('');
    const fresh = await getAccount(target.id);               // re-read for the current secret/attempts
    const dek = await unlockWithPin(fresh.secret, unlockPin);
    if (!dek) {
      const { locked: nowLocked, count } = await registerFailedUnlock(target.id);
      setBusy(false); setUnlockPin('');
      if (nowLocked) { setLocked(true); setError('Too many attempts.'); }
      else setError(`Wrong PIN. ${MAX_PIN_ATTEMPTS - count} attempt${MAX_PIN_ATTEMPTS - count === 1 ? '' : 's'} left.`);
      return;
    }
    await clearFailedUnlock(target.id);
    await enterUnlocked(fresh, dek);
  }

  async function resetPin() {
    if (!PIN_RE.test(newPin)) { setError('New PIN must be 4–8 digits.'); return; }
    if (newPin !== newPin2)   { setError('New PINs don’t match.'); return; }
    setBusy(true); setError('');
    const fresh = await getAccount(target.id);
    const dek = await unlockWithRecovery(fresh.secret, recInput);
    if (!dek) { setError('That recovery code isn’t right.'); setBusy(false); return; }
    try {
      const secret2 = await rewrapPin(fresh.secret, dek, newPin);
      await updateAccountSecret(target.id, secret2);
      await clearFailedUnlock(target.id);
      await enterUnlocked({ ...fresh, secret: secret2 }, dek);
    } catch { setError('Could not reset the PIN.'); setBusy(false); }
  }

  const list = accounts || [];
  const pinInput = (val, set, ph, onEnterKey) => (
    <div style={s.pinRow}>
      <input style={{ ...s.input, flex: 1 }} type={showPin ? 'text' : 'password'} inputMode="numeric" placeholder={ph}
             value={val} autoFocus onChange={e => set(e.target.value.replace(/\D/g, '').slice(0, 8))}
             onKeyDown={e => { if (e.key === 'Enter' && !busy && onEnterKey) onEnterKey(); }} />
      <button type="button" style={s.eye} onClick={() => setShowPin(v => !v)}>{showPin ? 'hide' : 'show'}</button>
    </div>
  );

  return (
    <div style={s.page} data-scheme={scheme} className="crt-scanlines crt-vignette">
      <div style={s.panel}>
        <div style={s.bar} />
        <div style={s.head}>
          <span style={s.logo}>FORWARD&nbsp;ONLY</span>
          <p style={s.tag}>// open an account to begin</p>
        </div>

        {mode === 'pick' && (
          <>
            {accounts === null && <p style={s.note}>loading accounts…</p>}
            {list.map(acct => (
              <button key={acct.id} style={{ ...s.btn, ...s.acct }} onClick={() => clickAccount(acct)}
                      title={acct.protected ? 'PIN-protected' : 'Open this account'}>
                <span>▸ {accountLabel(acct)}</span>
                <span style={s.acctMeta}>{acct.protected ? '🔒 PIN' : (acct.type === 'google' ? 'google' : 'local')}</span>
              </button>
            ))}
            <div style={s.divider}><span style={s.divText}>ADD AN ACCOUNT</span></div>
            <button style={{ ...s.btn, ...s.google }} onClick={() => onGoogle()}>◉ CONTINUE WITH GOOGLE</button>
            <button style={{ ...s.btn, ...s.newBtn }} onClick={() => { toPick(); setMode('new'); }}>＋ NEW LOCAL ACCOUNT</button>
          </>
        )}

        {mode === 'new' && (
          <div style={s.form}>
            <label style={s.label}>USERNAME</label>
            <input autoFocus style={s.input} value={username} maxLength={40}
                   onChange={e => setUsername(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter' && !usePin && !busy) createAccount(); }} />
            <p style={s.note}>kept on this computer only · no cloud · no sign-up</p>
            <label style={s.check}>
              <input type="checkbox" checked={usePin} onChange={e => setUsePin(e.target.checked)} />
              <span>Protect with a PIN (encrypts this account’s writing)</span>
            </label>
            {usePin && (<>
              {pinInput(pin, setPin, 'PIN (4–8 digits)')}
              <div style={{ height: 8 }} />
              {pinInput(pin2, setPin2, 'Confirm PIN', createAccount)}
              <p style={s.note}>you’ll get a one-time recovery code to reset a forgotten PIN</p>
            </>)}
            <div style={s.row}>
              <button style={{ ...s.btn, ...s.newBtn, flex: 1 }} disabled={busy} onClick={createAccount}>{busy ? 'CREATING…' : 'CREATE & OPEN'}</button>
              <button style={{ ...s.btn, ...s.ghost }} disabled={busy} onClick={toPick}>BACK</button>
            </div>
          </div>
        )}

        {mode === 'showRecovery' && (
          <div style={s.form}>
            <p style={s.warnTitle}>SAVE YOUR RECOVERY CODE</p>
            <p style={s.note}>The only way to reset a forgotten PIN. It won’t be shown again. If you lose both the PIN and this code, the writing can’t be recovered.</p>
            <div style={s.codeBox}>{recoveryCode}</div>
            <button style={{ ...s.btn, ...s.newBtn }} onClick={() => { navigator.clipboard?.writeText(recoveryCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'COPIED ✓' : 'COPY CODE'}</button>
            <button style={{ ...s.btn, ...s.google, marginTop: 14 }} onClick={() => onEnter(pendingUser)}>I’VE SAVED IT — CONTINUE</button>
          </div>
        )}

        {mode === 'unlock' && target && (
          <div style={s.form}>
            <label style={s.label}>UNLOCK · {accountLabel(target)}</label>
            {locked
              ? <p style={s.note}>Too many wrong attempts. Reset with your recovery code{target.type === 'google' ? ', or sign in with Google again' : ''}.</p>
              : pinInput(unlockPin, setUnlockPin, 'PIN', unlock)}
            <div style={s.row}>
              {!locked && <button style={{ ...s.btn, ...s.newBtn, flex: 1 }} disabled={busy} onClick={unlock}>{busy ? 'UNLOCKING…' : 'UNLOCK'}</button>}
              {locked && target.type === 'google' && <button style={{ ...s.btn, ...s.google, flex: 1 }} onClick={() => onGoogle(target.email)}>SIGN IN WITH GOOGLE</button>}
              <button style={{ ...s.btn, ...s.ghost }} disabled={busy} onClick={toPick}>BACK</button>
            </div>
            <button style={s.link} onClick={() => { setMode('recovery'); setError(''); }}>Forgot PIN? Use recovery code</button>
          </div>
        )}

        {mode === 'recovery' && target && (
          <div style={s.form}>
            <label style={s.label}>RESET PIN · {accountLabel(target)}</label>
            <input autoFocus style={s.input} placeholder="Recovery code" value={recInput} onChange={e => setRecInput(e.target.value)} />
            <div style={{ height: 8 }} />
            {pinInput(newPin, setNewPin, 'New PIN (4–8 digits)')}
            <div style={{ height: 8 }} />
            {pinInput(newPin2, setNewPin2, 'Confirm new PIN', resetPin)}
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
  input: { width: '100%', padding: '11px 12px', background: 'var(--bg)', color: 'var(--tx)', border: '1px solid var(--bd)', fontFamily: 'var(--fm)', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
  pinRow: { display: 'flex', gap: 8, alignItems: 'stretch' },
  eye:   { background: 'transparent', border: '1px solid var(--bd)', color: 'var(--tx-faint)', fontFamily: 'var(--fm)', fontSize: 11, cursor: 'pointer', padding: '0 10px' },
  check: { display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 8px', fontSize: 12, color: 'var(--tx-dim)', cursor: 'pointer' },
  row:   { display: 'flex', gap: 8, alignItems: 'stretch' },
  link:  { display: 'block', width: '100%', marginTop: 12, background: 'transparent', border: 'none', color: 'var(--tx-faint)', fontFamily: 'var(--fm)', fontSize: 12, textDecoration: 'underline', cursor: 'pointer' },
  warnTitle: { fontSize: 13, letterSpacing: 2, color: 'var(--ph)', textShadow: 'var(--glow)', marginBottom: 8, textAlign: 'center' },
  codeBox: { margin: '14px 0', padding: '14px 10px', background: 'var(--bg)', border: '1px solid var(--ph-dim)', color: 'var(--ph)', fontFamily: 'var(--fm)', fontSize: 18, letterSpacing: 2, textAlign: 'center', wordBreak: 'break-all' },
  error: { marginTop: 12, fontSize: 12, color: '#ff6b6b', textAlign: 'center' },
};
