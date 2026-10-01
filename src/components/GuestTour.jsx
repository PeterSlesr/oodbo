import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';

// Lightweight, dependency-free product tour for guest mode (desktop only).
// Anchors to real elements via [data-tour="..."] attributes, draws a highlight
// ring around each target and floats a tooltip card beside it. No page dimming.
//
// Controlled: the step index lives in the parent (so it can survive a "try it"
// excursion into Forward mode). `hidden` blanks the UI without losing the step
// — used while Forward mode is open so the card doesn't stack over it.
// onClose(completed: boolean) fires when the user finishes or skips.

const CARD_W = 264;

// Width of an element's rendered text, so a ring can hug the text of a
// full-width field (e.g. the section title input) instead of the whole box.
let _measureCanvas;
function measureTextWidth(el) {
  try {
    const text = (el.value ?? el.textContent ?? '').trim();
    if (!text) return null;
    const cs = getComputedStyle(el);
    _measureCanvas = _measureCanvas || document.createElement('canvas');
    const ctx = _measureCanvas.getContext('2d');
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return ctx.measureText(text).width;
  } catch { return null; }
}

export default function GuestTour({ steps, index, onIndex, onClose, hidden = false, panelOpen = false, menuOpen = false }) {
  const [box, setBox]       = useState(null); // primary target rect (viewport coords)
  const [extras, setExtras] = useState([]);   // additional standalone ring rects
  const cardRef             = useRef(null);
  const step                = steps[index];

  const measure = useCallback(() => {
    if (!step) return;
    const el = document.querySelector(step.selector);
    if (!el) { setBox(null); return; }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    let top = r.top, left = r.left, right = r.right, bottom = r.bottom;
    // If a companion element is present (e.g. an open dropdown), union it in so
    // the ring covers both and the card is pushed clear of it.
    if (step.expandSelector) {
      const ex = document.querySelector(step.expandSelector);
      if (ex) {
        const e = ex.getBoundingClientRect();
        top = Math.min(top, e.top); left = Math.min(left, e.left);
        right = Math.max(right, e.right); bottom = Math.max(bottom, e.bottom);
      }
    }
    const fitW = step.ringFitText ? measureTextWidth(el) : null;
    setBox({ top, left, width: right - left, height: bottom - top, fitW });
    // Extra standalone rings (e.g. the section-row "+" as well as "+ New section").
    setExtras((step.extraRings || [])
      .map(sel => document.querySelector(sel))
      .filter(Boolean)
      .map(elx => { const b = elx.getBoundingClientRect(); return { top: b.top, left: b.left, width: b.width, height: b.height }; }));
  }, [step]);

  // Re-measure on step change and whenever we become visible again.
  useLayoutEffect(() => { if (!hidden) measure(); }, [measure, hidden, menuOpen, panelOpen]);

  useEffect(() => {
    if (hidden) return;
    const onWin = () => measure();
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);
    return () => {
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
    };
  }, [measure, hidden]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (hidden || !step) return null;

  const isLast  = index === steps.length - 1;
  const isFirst = index === 0;
  const next = () => (isLast ? onClose(true) : onIndex(index + 1));
  const back = () => onIndex(Math.max(0, index - 1));

  // Position the card. A step may pin it to a viewport corner (used when the
  // target's action opens a panel the card would otherwise cover); otherwise it
  // sits beside the target, flipping/clamping to stay on-screen.
  const vw = window.innerWidth, vh = window.innerHeight;
  const ch = cardRef.current?.offsetHeight || 160;
  let cardPos = { top: 80, left: 80 };
  if (step.corner) {
    const m = 20;
    cardPos = {
      left: step.corner.includes('right') ? vw - CARD_W - m : m,
      top:  step.corner.includes('bottom') ? vh - ch - m    : m,
    };
  } else if (box) {
    const gap = 14;
    const side = step.side || 'bottom';
    let top, left;
    if (side === 'right') {
      left = box.left + box.width + gap;
      top  = box.top;
      if (left + CARD_W > vw - 12) left = box.left - CARD_W - gap; // flip left
    } else if (side === 'left') {
      left = box.left - CARD_W - gap;
      top  = box.top;
      if (left < 12) left = box.left + box.width + gap;            // flip right
    } else if (side === 'top') {
      left = box.left;
      top  = box.top - ch - gap;
    } else { // bottom
      left = box.left;
      top  = box.top + box.height + gap;
      if (top + ch > vh - 12) top = box.top - ch - gap;            // flip up
    }
    left = Math.max(12, Math.min(left, vw - CARD_W - 12));
    top  = Math.max(12, Math.min(top,  vh - ch - 12));
    // When the target's action opens a right-docked panel (width = step.dodgeLeft),
    // scootch the card just left of it — no further than needed.
    if (panelOpen && typeof step.dodgeLeft === 'number') {
      left = Math.min(left, vw - step.dodgeLeft - 16 - CARD_W);
      left = Math.max(12, left);
    }
    cardPos = { top, left };
  }

  // Keep a ring on-screen: nudge its left edge in and trim width to fit.
  const clampX = (left, width) => {
    if (left < 4) { width += left - 4; left = 4; }
    if (left + width > vw - 4) width = vw - 4 - left;
    return { left, width };
  };

  // Highlight ring geometry — per-step padding + optional min width so tight
  // targets (e.g. a short project title) read as their full editable area.
  const rings = [];
  if (box) {
    const padX = step.ringPadX ?? 5;
    const padY = step.ringPadY ?? 5;
    // Prefer hugging the rendered text (fitW) for full-width fields; otherwise
    // grow rightward from the target's left edge, honoring an optional min width.
    const rw0 = (step.ringFitText && box.fitW)
      ? box.fitW + padX * 2
      : Math.max(box.width + padX * 2, step.ringMinWidth || 0);
    const { left, width } = clampX(box.left - padX, rw0);
    // ringInsetBottom trims the target's own bottom padding so the ring hugs the text.
    rings.push({ top: box.top - padY, left, width, height: box.height + padY * 2 - (step.ringInsetBottom || 0) });
  }
  for (const ex of extras) {
    const { left, width } = clampX(ex.left - 5, ex.width + 10);
    rings.push({ top: ex.top - 5, left, width, height: ex.height + 10 });
  }

  return (
    <>
      {rings.map((rg, k) => (
        <div key={k} style={{
          position: 'fixed',
          top: rg.top, left: rg.left,
          width: rg.width, height: rg.height,
          border: '1px solid var(--ph)', borderRadius: 2,
          boxShadow: '0 0 0 3px rgba(0,0,0,0.35), 0 0 14px var(--ph-dim)',
          pointerEvents: 'none', zIndex: 900,
          transition: 'top .18s ease, left .18s ease, width .18s ease, height .18s ease',
        }} />
      ))}
      <div ref={cardRef} style={{ ...st.card, ...cardPos }}>
        <div style={st.counter}>{index + 1} of {steps.length}</div>
        <div style={st.title}>{step.title}</div>
        <div style={st.body}>{step.body}</div>
        <div style={st.footer}>
          <button style={st.skip} onClick={() => onClose(false)}>Skip tour</button>
          <div style={{ display: 'flex', gap: 6 }}>
            {!isFirst && <button style={st.back} onClick={back}>Back</button>}
            <button style={st.next} onClick={next}>{isLast ? 'Done' : 'Next'}</button>
          </div>
        </div>
      </div>
    </>
  );
}

const st = {
  card: {
    position: 'fixed', width: CARD_W, zIndex: 901,
    background: 'var(--bg2)', border: '1px solid var(--bd)', color: 'var(--tx)',
    boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
    padding: '14px 16px 12px', fontFamily: 'var(--fm)',
    transition: 'left .25s ease, top .25s ease',
  },
  counter: { fontSize: 10, color: 'var(--tx-faint)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 },
  title:   { fontFamily: 'var(--fd)', fontSize: 20, letterSpacing: '0.04em', color: 'var(--ph)', textShadow: 'var(--glow)', marginBottom: 6 },
  body:    { fontSize: 12.5, lineHeight: 1.6, color: 'var(--tx-dim)', marginBottom: 12 },
  footer:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  skip:    { fontFamily: 'var(--fm)', fontSize: 11, fontStyle: 'italic', background: 'transparent', border: 'none', color: 'var(--tx-faint)', cursor: 'pointer', padding: 0 },
  back:    { fontFamily: 'var(--fm)', fontSize: 12, background: 'transparent', border: '1px solid var(--bd)', color: 'var(--tx-dim)', cursor: 'pointer', padding: '5px 12px' },
  next:    { fontFamily: 'var(--fm)', fontSize: 12, background: 'var(--ph)', border: '1px solid var(--ph)', color: 'var(--bg)', cursor: 'pointer', padding: '5px 14px' },
};
