import React, { useState, useEffect, useRef } from 'react';

const WINDOW_SIZE = 5; // visible words

function tokenize(text) {
  const result = [];
  for (const part of text.split(/([\n]+|[ \t]+)/)) {
    if (!part) continue;
    result.push({ text: part, isWord: !!part.trim() && !part.includes('\n') });
  }
  return result;
}

function countWords(text) {
  return (text || '').trim() ? (text || '').trim().split(/\s+/).filter(Boolean).length : 0;
}

// The app's colour schemes (shared with the header picker via localStorage 'fwd:crt-scheme').
const SCHEMES = [['green', '◉ GREEN'], ['amber', '◉ AMBER'], ['dark', '◉ DARK'], ['light', '◉ LIGHT'], ['parchment', '◉ PARCHMENT']];

function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

export default function FocusMode({ chapter, onPublish, onCancel, journalMode, autoPublish = false, prefix = '', introOpen = false, onIntroDismiss, initialText = '', onDraftChange }) {
  // initialText seeds a RESUMED session (crash recovery) — forward-only means the user can
  // only append to it, exactly as if they'd never left.
  const [text, setText]               = useState(() => initialText || '');
  // Subscribed mobile flag — a render-time window.innerWidth read went stale after a
  // rotation (Editor.jsx and Home.jsx already track it this way).
  const [isMobile, setIsMobile]       = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = e => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  // Report live text up so the Editor can persist a crash-recovery draft (it owns the
  // debounce). Empty text is a no-op there; a resumed session re-saves itself, harmlessly.
  useEffect(() => { onDraftChange?.(text); }, [text]);
  // Colour scheme — shared app-wide. Applied as data-scheme on the overlay so the writer can
  // switch it mid-session and the whole surface (via CSS vars) recolours instantly.
  const [scheme, setScheme]           = useState(() => {
    try { return localStorage.getItem('fwd:crt-scheme') || 'green'; } catch { return 'green'; }
  });
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef(null);
  const [showPublish, setShowPublish] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);  // themed replacement for window.confirm on Esc/Cancel
  const [boxSize, setBoxSize]         = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('fwd:box-size') || 'null');
      if (saved?.w && saved?.h) return saved;
    } catch {}
    return null;
  });
  const displayRef  = useRef(null);
  const textareaRef = useRef(null);
  const sizerRef    = useRef(null);

  function focusInput() {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    // Forward-only: the caret always belongs at the end (and this places it correctly
    // when a resumed session mounts pre-filled with recovered text).
    const n = ta.value.length;
    try { ta.setSelectionRange(n, n); } catch {}
  }

  // Render the sliding window of visible/hidden text.
  // `prefix` is the existing chapter text before the cursor; `t` is what the
  // user has typed this session. The sliding window runs over prefix+t combined
  // so the last 5 bright words flow naturally from context into new writing.
  function renderText(t) {
    const combined = prefix + t;
    const tokens   = tokenize(combined);
    const wordIdx  = tokens.reduce((a, tk, i) => { if (tk.isWord) a.push(i); return a; }, []);
    const total    = wordIdx.length;
    const splitAt  = total <= WINDOW_SIZE ? 0 : wordIdx[wordIdx.length - WINDOW_SIZE];
    const hidden   = tokens.slice(0, splitAt).map(tk => tk.text).join('');
    const visible  = tokens.slice(splitAt).map(tk => tk.text).join('');

    if (displayRef.current) {
      displayRef.current.innerHTML =
        `<span class="fh">${esc(hidden)}</span>` +
        `<span class="fv">${esc(visible)}</span>` +
        `<span class="fc"></span>`;
      displayRef.current.parentElement.scrollTop =
        displayRef.current.parentElement.scrollHeight;
    }
  }

  useEffect(() => { renderText(text); }, [text, prefix]);

  // Close the scheme menu on outside click.
  useEffect(() => {
    if (!themeMenuOpen) return;
    const onDown = (e) => { if (themeMenuRef.current && !themeMenuRef.current.contains(e.target)) setThemeMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [themeMenuOpen]);

  // Focus the textarea on open — double rAF ensures the overlay has painted.
  // The intro overlay is non-interactive (pointerEvents:none), so the textarea
  // keeps focus while it is up: the first keystroke both writes and dismisses it.
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        focusInput();
        // Re-apply the scroll-to-caret now that the paper has its real height. renderText scrolls
        // on mount too, but when RESUMING a draft the paper often isn't laid out yet, so the caret
        // (end of the recovered text) sat below the fold until the first keystroke re-rendered.
        const disp = displayRef.current;
        if (disp?.parentElement) disp.parentElement.scrollTop = disp.parentElement.scrollHeight;
      });
    });
  }, []);

  // Dismiss the one-time intro on the first real interaction (typing or clicking).
  const dismissIntro = () => { if (introOpen) onIntroDismiss?.(); };

  // Clamp writing box to viewport whenever the browser window is resized.
  // Does NOT persist the clamped size — when the window grows back, the next
  // open restores the user's chosen dimensions from localStorage.
  useEffect(() => {
    if (isMobile) return;
    function clamp() {
      const el = sizerRef.current;
      if (!el) return;
      const maxW = window.innerWidth  - 40;
      const maxH = window.innerHeight - 120;
      if (el.offsetWidth  > maxW) el.style.width  = maxW + 'px';
      if (el.offsetHeight > maxH) el.style.height = maxH + 'px';
    }
    clamp(); // clamp saved size to current viewport on open
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [isMobile]);

  // Custom resize handle with 2x width/height growth.
  // Flex centering halves growth per side, so 2x growth means the right/bottom
  // edges move exactly 1x — the corner tracks the cursor 1:1.
  function handleResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();
    const el     = sizerRef.current;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = el.offsetWidth;
    const startH = el.offsetHeight;

    function onMove(ev) {
      const newW = Math.max(220, Math.min(window.innerWidth  - 40,  startW + (ev.clientX - startX) * 2));
      const newH = Math.max(160, Math.min(window.innerHeight - 120, startH + (ev.clientY - startY) * 2));
      el.style.width  = newW + 'px';
      el.style.height = newH + 'px';
    }

    function onUp() {
      const size = { w: el.offsetWidth, h: el.offsetHeight };
      setBoxSize(size);
      try { localStorage.setItem('fwd:box-size', JSON.stringify(size)); } catch {}
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup',   onUp);
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup',   onUp);
  }

  // Desktop: block forbidden keys, handle shortcuts.
  // Plain function (not useCallback) so handlePublishClick and handleCancel
  // always close over the current `text` value — useCallback with stale deps
  // caused ctrl+enter to see text='' and call onCancel instead.
  function onKey(e) {
    if (showPublish) return;
    dismissIntro();  // any keystroke clears the one-time intro; the char still writes

    const blocked = ['Backspace','Delete','ArrowLeft','ArrowRight',
                     'ArrowUp','ArrowDown','Home','End','PageUp','PageDown'];
    if (blocked.includes(e.key))                  { e.preventDefault(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); return; }
    if (e.key === 'Escape')                       { e.preventDefault(); handleCancel(); return; }
    if (e.ctrlKey && e.key === 'Enter')           { e.preventDefault(); handlePublishClick(); return; }
    // Enter, Tab, Space, regular chars: let the textarea handle them naturally —
    // onChange picks them up and enforces forward-only.
  }

  // Mobile + desktop fallback: onChange enforces forward-only.
  // Accept only if the new value extends the current text (no deletions, no edits).
  function handleChange(e) {
    const newVal = e.target.value;
    if (newVal.length >= text.length && newVal.startsWith(text)) {
      setText(newVal);
    }
    // If rejected, React's controlled value reverts the textarea on next render.
  }

  function handlePublishClick() {
    if (!text.trim()) { onCancel(); return; }
    if (autoPublish) { publish(false); return; }
    setShowPublish(true);
  }

  function handleCancel() {
    if (!text.trim()) { onCancel(); return; }
    setDiscardConfirm(true);   // themed modal below, not a native confirm()
  }

  function publish(startNew) {
    onPublish(text, startNew);
  }

  const wc = countWords(text);
  const curSchemeLabel = (SCHEMES.find(([k]) => k === scheme) || SCHEMES[0])[1];

  return (
    <div
      data-scheme={scheme}
      className="crt-scanlines crt-vignette"
      style={s.overlay}
      onClick={e => {
        if (!['BUTTON','INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) {
          focusInput();
        }
        dismissIntro();  // clicking anywhere also clears the intro
      }}
    >

      {/* Toolbar */}
      <div style={s.toolbar}>
        <span style={s.brand}>FORWARD&nbsp;ONLY</span>
        {!isMobile && <span style={s.spacer} />}
        <div ref={themeMenuRef} style={{ position: 'relative' }}>
          <button className="crt-tog" onClick={() => setThemeMenuOpen(o => !o)}>{curSchemeLabel}&nbsp;▾</button>
          {themeMenuOpen && (
            <div className="crt-menu" role="listbox">
              {SCHEMES.map(([k, label]) => (
                <button key={k} role="option" aria-selected={scheme === k}
                  className={`crt-menu-item${scheme === k ? ' on' : ''}`}
                  onClick={() => { setScheme(k); try { localStorage.setItem('fwd:crt-scheme', k); } catch {} setThemeMenuOpen(false); focusInput(); }}
                >{label}</button>
              ))}
            </div>
          )}
        </div>
        {!isMobile && <span style={s.wcBadge}>{wc} words</span>}
        <button className="crt-tog" onClick={handleCancel}>{journalMode ? 'BURN' : 'CANCEL'}</button>
        <button style={s.publishBtn} onClick={handlePublishClick}>EDIT&nbsp;MODE</button>
      </div>

      {/* Paper */}
      <div style={s.paperWrap}>
        <style>{`
          .fh { color: var(--tx-faint); }
          .fv { color: var(--tx); text-shadow: var(--glow); }
          .fc {
            display: inline-block;
            width: 0.55em;
            height: 1em;
            background: var(--ph);
            vertical-align: text-bottom;
            box-shadow: 0 0 6px var(--ph-dim);
            animation: fwd-blink 1s step-start infinite;
          }
          @keyframes fwd-blink   { 0%,100%{opacity:1} 50%{opacity:0} }
          @keyframes fwd-fadein  { from{opacity:0} to{opacity:1} }
          .fwd-paper::-webkit-scrollbar { display: none; }
          .fwd-paper { scrollbar-width: none; }
          .fwd-modal button:focus { outline: 1px solid var(--ph); outline-offset: 2px; }
        `}</style>
        <div
          ref={sizerRef}
          style={{
            ...s.sizerBox,
            ...(boxSize && !isMobile ? { width: boxSize.w, height: boxSize.h } : {}),
          }}
        >
          <div style={s.paper}>
            <div className="fwd-paper" style={s.paperScroll}>
              {/* Visual display — renders the sliding word window */}
              <div ref={displayRef} style={s.display} />
            </div>
            {/* Hidden textarea — sits on paper outside the scroll container so the
                browser cannot use it to snap scrollTop back toward offset 0. */}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleChange}
              onKeyDown={onKey}
              style={{ ...s.hiddenInput, pointerEvents: (showPublish || discardConfirm) ? 'none' : 'auto' }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>
          {!isMobile && (
            <div
              style={{
                ...s.resizeHandle,
                backgroundImage: `repeating-linear-gradient(-45deg, var(--ph) 0, var(--ph) 1px, transparent 0, transparent 4px)`,
              }}
              onPointerDown={handleResizeStart}
            />
          )}
        </div>
      </div>

      {/* One-time "Forward only" intro — plain text in the theme's ink, no card,
          no button. pointerEvents:none so the textarea keeps focus underneath;
          the first keystroke (onKey) or any click (overlay onClick) clears it. */}
      {introOpen && (
        <div style={s.introLayer}>
          <div style={s.introInner}>
            <p style={s.introTitle}>FORWARD ONLY</p>
            <p style={s.introBody}>
              You can’t edit or delete what you write here, you can only keep going.
              Let it be rough; fix it later. That’s the whole idea.
            </p>
            <p style={{ ...s.introBody, opacity: 0.6, marginTop: 18 }}>
              Click “Edit Mode” or press Ctrl / ⌘ + Enter when you’re done.
            </p>
          </div>
        </div>
      )}

      {/* Status bar */}
      <div style={s.statusbar}>
        <span style={{ color: 'var(--tx-faint)' }}>CTRL+ENTER · EDIT &nbsp;·&nbsp; ESC · CANCEL</span>
      </div>

      {/* Publish modal */}
      {showPublish && (
        <div style={s.modalOverlay}>
          <div style={s.modal} className="fwd-modal">
            <p style={s.modalTitle}>Edit {wc} word{wc === 1 ? '' : 's'}</p>
            <p style={s.modalSub}>Where should this go? · tab to move · enter to confirm</p>
            <button autoFocus style={s.modalBtn} onClick={() => publish(false)}>
              Add to "{chapter.title}"
            </button>
            <button style={{ ...s.modalBtn, ...s.modalBtnSecondary }} onClick={() => publish(true)}>
              {journalMode ? 'Start a new entry' : 'Start a new section'}
            </button>
            <button style={s.modalGhost} onClick={() => { setShowPublish(false); focusInput(); }}>
              Keep writing
            </button>
          </div>
        </div>
      )}

      {/* Discard confirm — themed to match the publish modal, not a native window.confirm(). */}
      {discardConfirm && (
        <div style={s.modalOverlay}>
          <div style={s.modal} className="fwd-modal">
            <p style={s.modalTitle}>{journalMode ? `Burn ${wc} word${wc === 1 ? '' : 's'}?` : `Discard ${wc} word${wc === 1 ? '' : 's'}?`}</p>
            <p style={s.modalSub}>This can’t be undone.</p>
            <button autoFocus style={s.modalBtn} onClick={() => { setDiscardConfirm(false); focusInput(); }}>
              Keep writing
            </button>
            <button style={s.modalGhost} onClick={() => { setDiscardConfirm(false); onCancel(); }}>
              {journalMode ? 'Burn it' : 'Discard'}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

const s = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 800,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg)',
    color: 'var(--tx)',
    fontFamily: 'var(--fm)',
    animation: 'fwd-fadein 280ms ease forwards',
    // Keep the toolbar out from under the notch and the status bar above the home
    // indicator. env() is 0 on non-notched devices, so desktop is untouched.
    paddingTop: 'env(safe-area-inset-top)',
    paddingBottom: 'env(safe-area-inset-bottom)',
    paddingLeft: 'env(safe-area-inset-left)',
    paddingRight: 'env(safe-area-inset-right)',
  },
  toolbar: {
    background: 'var(--bg2)',
    borderBottom: '1px solid var(--bd)',
    padding: '0 16px',
    height: 44,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0,
  },
  brand: {
    fontFamily: 'var(--fd)', fontSize: 18, letterSpacing: '0.15em',
    color: 'var(--ph)', textShadow: 'var(--glow)', whiteSpace: 'nowrap',
  },
  spacer: { flex: 1 },
  introLayer: {
    position: 'absolute',
    top: 44, left: 0, right: 0, bottom: 0,   // below the toolbar
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none',                    // never intercept the writing surface
    padding: '24px',
    animation: 'fwd-fadein 400ms ease forwards',
    zIndex: 62,
  },
  introInner: {
    maxWidth: 460, textAlign: 'center',
  },
  introTitle: {
    fontFamily: 'var(--fd)', fontSize: 30, letterSpacing: '0.14em',
    color: 'var(--ph)', textShadow: 'var(--glow)', margin: '0 0 16px',
  },
  introBody: {
    fontFamily: 'var(--fm)', fontSize: 15, lineHeight: 1.7, margin: 0, color: 'var(--tx-dim)',
  },
  wcBadge: {
    fontFamily: 'var(--fm)',
    fontSize: 11,
    color: 'var(--tx-dim)',
    letterSpacing: '0.05em',
  },
  publishBtn: {
    fontFamily: 'var(--fm)',
    fontSize: 11,
    letterSpacing: '0.06em',
    padding: '4px 12px',
    minWidth: 92,
    textAlign: 'center',
    background: 'var(--ph)',
    color: 'var(--bg)',
    border: '1px solid var(--ph)',
    cursor: 'pointer',
  },
  paperWrap: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  sizerBox: {
    position: 'relative',
    width: 'min(640px, calc(100vw - 24px))',
    height: 440,
    minWidth: 220,
    minHeight: 160,
    flexShrink: 0,
    boxSizing: 'border-box',
  },
  resizeHandle: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 16,
    height: 16,
    cursor: 'nwse-resize',
    zIndex: 10,
    opacity: 0.5,
    clipPath: 'polygon(100% 0, 100% 100%, 0 100%)',
  },
  paper: {
    width: '100%',
    height: '100%',
    border: '1px solid var(--bd)',
    background: 'var(--bg2)',
    position: 'relative',
    overflow: 'hidden',
    boxSizing: 'border-box',
  },
  paperScroll: {
    position: 'absolute',
    inset: 0,
    overflowY: 'auto',
    padding: '22px 26px'
  },
  display: {
    fontFamily: 'var(--fm)',
    fontSize: 16,
    lineHeight: 1.95,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    outline: 'none',
    minHeight: 60,
    position: 'relative',
    zIndex: 0
  },
  hiddenInput: {
    position: 'absolute',
    inset: 0,
    opacity: 0,
    resize: 'none',
    border: 'none',
    outline: 'none',
    overflow: 'hidden',   // no internal scroll — prevents browser from touching container scrollTop
    zIndex: 1,
    cursor: 'text',
    fontSize: 16, // prevents iOS auto-zoom on focus (must be >= 16px)
    background: 'transparent',
    color: 'transparent',
    caretColor: 'transparent',
  },
  statusbar: {
    background: 'var(--bg2)',
    borderTop: '1px solid var(--bd)',
    padding: '4px 14px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontFamily: 'var(--fm)',
    fontSize: 10,
    letterSpacing: '0.06em',
    flexShrink: 0
  },
  modalOverlay: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 70,
  },
  modal: {
    background: 'var(--bg2)',
    border: '1px solid var(--bd)',
    borderTop: '2px solid var(--ph)',
    padding: '22px 24px 18px',
    width: 340,
    fontFamily: 'var(--fm)'
  },
  modalTitle: {
    fontFamily: 'var(--fd)', fontSize: 22, letterSpacing: '0.04em',
    color: 'var(--ph)', textShadow: 'var(--glow)', margin: '0 0 4px'
  },
  modalSub: {
    fontSize: 11,
    color: 'var(--tx-dim)',
    fontStyle: 'italic',
    marginBottom: 16
  },
  modalBtn: {
    fontFamily: 'var(--fm)',
    fontSize: 12,
    width: '100%',
    padding: '9px 12px',
    background: 'var(--ph)',
    color: 'var(--bg)',
    border: '1px solid var(--ph)',
    cursor: 'pointer',
    marginBottom: 8,
    textAlign: 'left'
  },
  modalBtnSecondary: {
    background: 'transparent',
    color: 'var(--tx)',
    border: '1px solid var(--bd)',
    marginBottom: 12
  },
  modalGhost: {
    fontFamily: 'var(--fm)',
    fontSize: 11,
    background: 'transparent',
    border: 'none',
    color: 'var(--tx-dim)',
    cursor: 'pointer',
    fontStyle: 'italic',
    padding: 0
  }
};
