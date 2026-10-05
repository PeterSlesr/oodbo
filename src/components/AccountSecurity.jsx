import React, { useEffect, useState } from 'react';
import { setAccountPin, revealRecovery, changePin, isAccountProtected } from '../lib/desktopPin.js';

// ── In-app PIN & recovery management (Tauri only) ──────────────────────────────────────
// Opened from Home ("recovery") or the editor sidebar ("PIN") while signed in.
//   • No PIN yet  → set one (encrypts this account's writing; Google also seals its Drive tokens).
//   • Has a PIN   → show the recovery code (behind the PIN), or reset the PIN (behind the PIN).
//
// Props: user, onClose.

const PIN_RE = /^\d{4,8}$/;

export default function AccountSecurity({ user, onClose }) {
  const scheme = (() => { try { return localStorage.getItem('fwd:crt-scheme') || 'green'; } catch { return 'green'; } })();
  const [prot, setProt] = useState(null);     // null=loading, true/false
  const [view, setView] = useState('menu');    // menu | set | reveal | reset
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPin, setShowPin] = useState(false);

  const [pin,  setPin]  = useState('');
  const [pin2, setPin2] = useState('');
  const [cur,  setCur]  = useState('');        // current PIN (reveal / reset)
  const [code, setCode] = useState('');        // recovery code to display
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState('');        // success note

  useEffect(() => {
    isAccountProtected(user).then(p => { setProt(p); setView(p ? 'menu' : 'set'); }).catch(() => { setProt(false); setView('set'); });
  }, [user]);

  async function doSet() {
    if (!PIN_RE.test(pin)) { setError('PIN must be 4–8 digits.'); return; }
    if (pin !== pin2)      { setError('PINs don’t match.'); return; }
    setBusy(true); setError('');
    try { setCode(await setAccountPin(user, pin)); }
    catch { setError('Could not set the PIN.'); }
    finally { setBusy(false); }
  }

  async function doReveal() {
    if (!cur) { setError('Enter your PIN.'); return; }
    setBusy(true); setError('');
    const r = await revealRecovery(user, cur);
    setBusy(false);
    if (r.ok) setCode(r.code);
    else setError(r.reason === 'wrong-pin' ? 'Wrong PIN.' : 'Recovery code unavailable.');
  }

  async function doReset() {
    if (!cur) { setError('Enter your current PIN.'); return; }
    if (!PIN_RE.test(pin)) { setError('New PIN must be 4–8 digits.'); return; }
    if (pin !== pin2)      { setError('New PINs don’t match.'); return; }
    setBusy(true); setError('');
    const r = await changePin(user, cur, pin);
    setBusy(false);
    if (r.ok) { setDone('PIN updated. Your recovery code is unchanged.'); setView('done'); }
    else setError(r.reason === 'wrong-pin' ? 'Current PIN is wrong.' : 'Could not change the PIN.');
  }

  const pinField = (val, set, ph, onEnterKey) => (
    <div style={s.pinRow}>
      <input style={{ ...s.input, flex: 1 }} type={showPin ? 'text' : 'password'} inputMode="numeric" placeholder={ph}
             value={val} onChange={e => set(e.target.value.replace(/\D/g, '').slice(0, 8))}
             onKeyDown={e => { if (e.key === 'Enter' && !busy && onEnterKey) onEnterKey(); }} />
      <button type="button" style={s.eye} onClick={() => setShowPin(v => !v)}>{showPin ? 'hide' : 'show'}</button>
    </div>
  );

  return (
    <div style={s.overlay} data-scheme={scheme} onClick={onClose}>
      <div style={s.panel} onClick={e => e.stopPropagation()}>
        <p style={s.title}>PIN &amp; RECOVERY</p>

        {code ? (
          <>
            <p style={s.note}>{prot ? 'Your recovery code:' : 'PIN set. Save your recovery code — it resets a forgotten PIN and won’t be shown again without your PIN.'}</p>
            <div style={s.codeBox}>{code}</div>
            <button style={{ ...s.btn, ...s.newBtn }} onClick={() => { navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'COPIED ✓' : 'COPY CODE'}</button>
            <button style={{ ...s.btn, ...s.primary, marginTop: 12 }} onClick={onClose}>DONE</button>
          </>
        ) : view === 'done' ? (
          <><p style={s.note}>{done}</p><button style={{ ...s.btn, ...s.primary }} onClick={onClose}>DONE</button></>
        ) : prot === null ? (
          <p style={s.note}>loading…</p>
        ) : view === 'set' ? (
          <>
            <p style={s.note}>Protect this account with a PIN. It encrypts this account’s writing on this computer{user?.provider ? ' and lets it open offline' : ''}. You’ll get a one-time recovery code.</p>
            {pinField(pin, setPin, 'PIN (4–8 digits)')}
            <div style={{ height: 8 }} />
            {pinField(pin2, setPin2, 'Confirm PIN', doSet)}
            <div style={s.row}>
              <button style={{ ...s.btn, ...s.primary, flex: 1 }} disabled={busy} onClick={doSet}>{busy ? 'ENCRYPTING…' : 'SET PIN'}</button>
              <button style={{ ...s.btn, ...s.ghost }} onClick={onClose}>CANCEL</button>
            </div>
          </>
        ) : view === 'reveal' ? (
          <>
            <p style={s.note}>Enter your PIN to view this account’s recovery code.</p>
            {pinField(cur, setCur, 'PIN', doReveal)}
            <div style={s.row}>
              <button style={{ ...s.btn, ...s.primary, flex: 1 }} disabled={busy} onClick={doReveal}>{busy ? 'CHECKING…' : 'SHOW RECOVERY CODE'}</button>
              <button style={{ ...s.btn, ...s.ghost }} onClick={() => { setView('menu'); setCur(''); setError(''); }}>BACK</button>
            </div>
          </>
        ) : view === 'reset' ? (
          <>
            <p style={s.note}>Enter your current PIN, then choose a new one. Your recovery code stays the same.</p>
            {pinField(cur, setCur, 'Current PIN')}
            <div style={{ height: 8 }} />
            {pinField(pin, setPin, 'New PIN (4–8 digits)')}
            <div style={{ height: 8 }} />
            {pinField(pin2, setPin2, 'Confirm new PIN', doReset)}
            <div style={s.row}>
              <button style={{ ...s.btn, ...s.primary, flex: 1 }} disabled={busy} onClick={doReset}>{busy ? 'UPDATING…' : 'RESET PIN'}</button>
              <button style={{ ...s.btn, ...s.ghost }} onClick={() => { setView('menu'); setCur(''); setPin(''); setPin2(''); setError(''); }}>BACK</button>
            </div>
          </>
        ) : (
          // menu (protected account)
          <>
            <p style={s.note}>This account is protected by a PIN.</p>
            <button style={{ ...s.btn, ...s.primary }} onClick={() => { setView('reveal'); setError(''); }}>SHOW RECOVERY CODE</button>
            <button style={{ ...s.btn, ...s.newBtn, marginTop: 10 }} onClick={() => { setView('reset'); setError(''); }}>RESET PIN</button>
            <button style={{ ...s.btn, ...s.ghost, margin: '12px auto 0' }} onClick={onClose}>CLOSE</button>
          </>
        )}
        {error && <p style={s.error}>{error}</p>}
      </div>
    </div>
  );
}

const s = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  panel: { position: 'relative', width: '100%', maxWidth: 400, background: 'var(--bg2)', border: '1px solid var(--bd)', padding: '26px 24px', color: 'var(--tx)', fontFamily: 'var(--fm)' },
  title: { fontFamily: 'var(--fd)', fontSize: 22, letterSpacing: 2, color: 'var(--ph)', textShadow: 'var(--glow)', marginBottom: 14, textAlign: 'center' },
  note:  { fontSize: 12, color: 'var(--tx-faint)', lineHeight: 1.5, marginBottom: 12, textAlign: 'center' },
  btn:   { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', padding: '11px 14px', background: 'transparent', color: 'var(--tx)', border: '1px solid var(--bd)', fontFamily: 'var(--fm)', fontSize: 13, letterSpacing: 1, cursor: 'pointer', textTransform: 'uppercase' },
  primary: { borderColor: 'var(--ph-dim)', color: 'var(--ph)' },
  newBtn:  { borderStyle: 'dashed', color: 'var(--tx-dim)' },
  ghost:   { width: 'auto', color: 'var(--tx-faint)' },
  row:   { display: 'flex', gap: 8, alignItems: 'stretch', marginTop: 10 },
  input: { width: '100%', padding: '11px 12px', background: 'var(--bg)', color: 'var(--tx)', border: '1px solid var(--bd)', fontFamily: 'var(--fm)', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
  pinRow: { display: 'flex', gap: 8, alignItems: 'stretch' },
  eye:   { background: 'transparent', border: '1px solid var(--bd)', color: 'var(--tx-faint)', fontFamily: 'var(--fm)', fontSize: 11, cursor: 'pointer', padding: '0 10px' },
  codeBox: { margin: '6px 0 14px', padding: '14px 10px', background: 'var(--bg)', border: '1px solid var(--ph-dim)', color: 'var(--ph)', fontFamily: 'var(--fm)', fontSize: 17, letterSpacing: 2, textAlign: 'center', wordBreak: 'break-all' },
  error: { marginTop: 12, fontSize: 12, color: '#ff6b6b', textAlign: 'center' },
};
