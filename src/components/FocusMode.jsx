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

const FOCUS_THEMES = [
  ['dark-white', 'Dark — White'],
  ['dark-green', 'Dark — Green'],
  ['dark-amber', 'Dark — Amber'],
  ['light',      'Light'],
];

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
  const [theme, setTheme]             = useState(() => localStorage.getItem('fwd:focus-theme') || 'dark-white');
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

  useEffect(() => { renderText(text); }, [text, theme, prefix]);

  // Close the theme menu on outside click.
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

  const themes = {
    'dark-white': { bg: '#000', hidden: '#3a3a3a', visible: '#fff',  cursor: '#fff',    content: '#000' },
    'dark-green': { bg: '#0a0a0a', hidden: '#1a3d1a', visible: '#33ff33', cursor: '#33ff33', content: '#0a0a0a' },
    'dark-amber': { bg: '#0a0800', hidden: '#3d2800', visible: '#ffb000', cursor: '#ffb000', content: '#0a0800' },
    'light':      { bg: '#f5f2eb', hidden: '#d8d8d8', visible: '#111',  cursor: '#111',    content: '#fff' },
  };
  const t = themes[theme] || themes['dark-white'];

  const wc       = countWords(text);

  return (
    <div
      style={{ ...s.overlay, background: t.bg }}
      onClick={e => {
        if (!['BUTTON','INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) {
          focusInput();
        }
        dismissIntro();  // clicking anywhere also clears the intro
      }}
    >

      {/* Toolbar */}
      <div style={s.toolbar}>
        {!isMobile && <span style={s.spacer} />}
        <div ref={themeMenuRef} style={{ position: 'relative' }}>
          <button
            style={{ ...s.themeSelect, whiteSpace: 'nowrap' }}
            onClick={() => setThemeMenuOpen(o => !o)}
          >{(FOCUS_THEMES.find(([k]) => k === theme) || [])[1] || 'Theme'} ▾</button>
          {themeMenuOpen && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 150, background: '#1f1f1f', border: '1px solid #444', boxShadow: '0 6px 20px rgba(0,0,0,0.4)', zIndex: 30, padding: '4px 0' }}>
              {FOCUS_THEMES.map(([k, label]) => (
                <button key={k}
                  style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: 'Georgia, serif', fontSize: 12, background: theme === k ? '#333' : 'transparent', color: '#ccc', border: 'none', padding: '7px 14px', cursor: 'pointer' }}
                  onClick={() => { setTheme(k); localStorage.setItem('fwd:focus-theme', k); setThemeMenuOpen(false); focusInput(); }}
                >{label}</button>
              ))}
            </div>
          )}
        </div>
        {!isMobile && <span style={s.wcBadge}>{wc} words</span>}
        <button style={s.cancelBtn} onClick={handleCancel}>{journalMode ? 'Burn' : 'Cancel'}</button>
        <button style={s.publishBtn} onClick={handlePublishClick}>
          Edit Mode
        </button>
      </div>

      {/* Paper */}
      <div style={s.paperWrap}>
        <style>{`
          .fh { color: ${t.hidden}; }
          .fv { color: ${t.visible}; }
          .fc {
            display: inline-block;
            width: ${theme === 'light' ? '2px' : '0.55em'};
            height: 1em;
            background: ${t.cursor};
            vertical-align: text-bottom;
            margin-left: ${theme === 'light' ? '1px' : '0'};
            animation: fwd-blink 1s step-start infinite;
          }
          @keyframes fwd-blink   { 0%,100%{opacity:1} 50%{opacity:0} }
          @keyframes fwd-fadein  { from{opacity:0} to{opacity:1} }
          .fwd-paper::-webkit-scrollbar { display: none; }
          .fwd-paper { scrollbar-width: none; }
          .fwd-modal button:focus { outline: 2px solid #888; outline-offset: 2px; }
        `}</style>
        <div
          ref={sizerRef}
          style={{
            ...s.sizerBox,
            ...(boxSize && !isMobile ? { width: boxSize.w, height: boxSize.h } : {}),
          }}
        >
          <div style={{ ...s.paper, borderColor: theme === 'light' ? 'transparent' : t.visible, background: t.content }}>
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
                backgroundImage: `repeating-linear-gradient(-45deg, ${t.visible} 0, ${t.visible} 1px, transparent 0, transparent 4px)`,
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
            <p style={{ ...s.introTitle, color: t.visible }}>Forward only</p>
            <p style={{ ...s.introBody, color: t.visible }}>
              You can’t edit or delete what you write here, you can only keep going.
              Let it be rough; fix it later. That’s the whole idea.
            </p>
            <p style={{ ...s.introBody, color: t.visible, opacity: 0.6, marginTop: 18 }}>
              Click “Edit Mode” or press Ctrl / ⌘ + Enter when you’re done.
            </p>
          </div>
        </div>
      )}

      {/* Status bar */}
      <div style={s.statusbar}>
        <span style={{ color: '#666' }}>ctrl+enter · edit &nbsp;·&nbsp; esc · cancel</span>
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
    animation: 'fwd-fadein 280ms ease forwards',
    // Keep the toolbar out from under the notch and the status bar above the home
    // indicator. env() is 0 on non-notched devices, so desktop is untouched.
    paddingTop: 'env(safe-area-inset-top)',
    paddingBottom: 'env(safe-area-inset-bottom)',
    paddingLeft: 'env(safe-area-inset-left)',
    paddingRight: 'env(safe-area-inset-right)',
  },
  toolbar: {
    background: '#1f1f1f',
    padding: '0 20px',
    height: 44,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0,
  },
  spacer: { flex: 1 },
  introLayer: {
    position: 'absolute',
    top: 44, left: 0, right: 0, bottom: 0,   // below the toolbar
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none',                    // never intercept the writing surface
    padding: '24px',
    animation: 'fwd-fadein 400ms ease forwards',
  },
  introInner: {
    maxWidth: 440, textAlign: 'center',
  },
  introTitle: {
    fontFamily: 'Georgia, serif', fontSize: 15, fontStyle: 'italic',
    letterSpacing: '0.02em', margin: '0 0 14px',
  },
  introBody: {
    fontFamily: 'Georgia, serif', fontSize: 17, lineHeight: 1.6, margin: 0,
  },
  wcBadge: {
    fontFamily: 'Georgia, serif',
    fontSize: 11,
    fontStyle: 'italic',
    color: '#aaa',
  },
  publishBtn: {
    fontFamily: 'Georgia, serif',
    fontSize: 12,
    padding: '5px 14px',
    minWidth: 92,
    textAlign: 'center',
    background: '#fff',
    color: '#1f1f1f',
    border: '1px solid #fff',
    cursor: 'pointer'
  },
  cancelBtn: {
    fontFamily: 'Georgia, serif',
    fontSize: 12,
    padding: '5px 14px',
    minWidth: 74,
    textAlign: 'center',
    background: 'transparent',
    color: '#ccc',
    border: '1px solid #444',
    cursor: 'pointer'
  },
  themeSelect: {
    fontFamily: 'Georgia, serif',
    fontSize: 10,
    background: '#1f1f1f',
    border: '1px solid #444',
    color: '#aaa',
    padding: '3px 6px',
    cursor: 'pointer',
    outline: 'none'
  },
  paperWrap: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  sizerBox: {
    position: 'relative',
    width: 'min(595px, calc(100vw - 24px))',
    height: 420,
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
    opacity: 0.4,
    clipPath: 'polygon(100% 0, 100% 100%, 0 100%)',
  },
  paper: {
    width: '100%',
    height: '100%',
    border: '1px solid',
    position: 'relative',
    overflow: 'hidden',
    boxSizing: 'border-box',
  },
  paperScroll: {
    position: 'absolute',
    inset: 0,
    overflowY: 'auto',
    padding: '20px 24px'
  },
  display: {
    fontFamily: "'Courier New', Courier, monospace",
    fontSize: 17,
    lineHeight: 1.85,
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
    background: '#1f1f1f',
    padding: '4px 14px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontFamily: 'Georgia, serif',
    fontSize: 10,
    fontStyle: 'italic',
    flexShrink: 0
  },
  modalOverlay: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  modal: {
    background: '#f5f2eb',
    borderTop: '3px solid #111',
    padding: '24px 24px 18px',
    width: 320,
    fontFamily: 'Georgia, serif'
  },
  modalTitle: {
    fontSize: 15,
    color: '#111',
    marginBottom: 4
  },
  modalSub: {
    fontSize: 11,
    color: '#888',
    fontStyle: 'italic',
    marginBottom: 16
  },
  modalBtn: {
    fontFamily: 'Georgia, serif',
    fontSize: 12,
    width: '100%',
    padding: '9px 12px',
    background: '#111',
    color: '#fff',
    border: '1px solid #111',
    cursor: 'pointer',
    marginBottom: 8,
    textAlign: 'left'
  },
  modalBtnSecondary: {
    background: 'transparent',
    color: '#111',
    marginBottom: 12
  },
  modalGhost: {
    fontFamily: 'Georgia, serif',
    fontSize: 11,
    background: 'transparent',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    fontStyle: 'italic',
    padding: 0
  }
};
