import React, { useRef, useEffect } from 'react';

// Full-screen ambient "limbo" shown after a long idle on the homepage (see Home.jsx). The
// oodbo wordmark morphs into ∞ while the d/b/o fly out to head three cycling mantras, over a
// field of faint flickering specks. Purely decorative — Home owns the wake/return-and-sweep.
//
// Ported from public/logo-test9.html. Built imperatively into an <svg> so it stays a single
// self-contained rAF loop rather than re-rendering React each frame. Pauses when the tab is
// hidden so it isn't burning a rAF all night.
const NS = 'http://www.w3.org/2000/svg';

const MANTRAS = [
  ['one',  'eats',   'ptimal'],    // Done Beats Optimal
  ['raft', 'efore',  'bsessing'],  // Draft Before Obsessing
  ["on't", 'lock',   'utput'],     // Don't Block Output
  ['raft', 'reathe', 'rganize'],   // Draft Breathe Organize
];

export default function IdleScreen() {
  const svgRef = useRef(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const r = 24, S = 2 * r, N = 220;
    const MHOLD = 0.82, YSCALE = 1.5, SEP_MAX = 12, PITCH = 2 * r + SEP_MAX, OFF = r + SEP_MAX / 2;
    const wordPos = [[OFF + PITCH, 0], [OFF + 2 * PITCH, 0], [OFF + 3 * PITCH, 0]];
    const rowPos  = [[96, -72], [96, 0], [96, 72]];

    // ── build the DOM (presentation set as attributes — the app uses no CSS files) ──
    const el = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
    const STROKE = { fill: 'none', stroke: '#111', 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': 0.78 };
    const TEXT = { 'font-family': "'Helvetica Neue', Arial, sans-serif", 'font-size': 92, fill: '#111', 'fill-opacity': 0.76 };
    const speckLayer = el('g');
    const mark = el('path', STROKE);
    svg.append(speckLayer, mark);
    const letters = [el('path', STROKE), el('path', STROKE), el('path', STROKE)];
    const sfx = [el('text', TEXT), el('text', TEXT), el('text', TEXT)];
    letters.forEach((L, i) => svg.append(L, sfx[i]));

    // ── geometry ──
    function point(t, m) {
      const c = Math.cos(t);
      let cx, cy;
      if (c >= 0) { cx = r + r * Math.cos(2 * t); cy = r * Math.sin(2 * t); }
      else        { cx = -r - r * Math.cos(2 * t); cy = r * Math.sin(2 * t); }
      const den = 1 + Math.sin(t) * Math.sin(t);
      const bx = S * c / den, by = S * Math.sin(t) * c / den * YSCALE;
      const w = Math.sin(t) * Math.sin(t) * m;
      return [cx + w * (bx - cx), cy + w * (by - cy)];
    }
    function buildMorph(m) {
      let d = '';
      for (let i = 0; i <= N; i++) { const [x, y] = point(i / N * 2 * Math.PI, m); d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2) + ' '; }
      mark.setAttribute('d', d + 'Z');
    }
    function circle(cx, cy, rad) {
      let d = 'M ' + (cx + rad).toFixed(2) + ' ' + cy.toFixed(2) + ' ';
      for (let i = 1; i <= 56; i++) { const a = i / 56 * 2 * Math.PI; d += 'L ' + (cx + rad * Math.cos(a)).toFixed(2) + ' ' + (cy + rad * Math.sin(a)).toFixed(2) + ' '; }
      return d + 'Z ';
    }
    const buildSeparated = (sep) => { const off = r + sep / 2; mark.setAttribute('d', circle(off, 0, r) + circle(-off, 0, r)); };

    const stemUp = (x) => 'M ' + x + ' ' + r + ' L ' + x + ' ' + (-2 * r) + ' ';
    letters[0].setAttribute('d', circle(0, 0, r) + stemUp(r));
    letters[1].setAttribute('d', circle(0, 0, r) + stemUp(-r));
    letters[2].setAttribute('d', circle(0, 0, r));

    const lerp = (a, b, u) => a + (b - a) * u;
    function place(u, suffixOp) {
      letters.forEach((L, i) => {
        const x = lerp(wordPos[i][0], rowPos[i][0], u), y = lerp(wordPos[i][1], rowPos[i][1], u);
        L.setAttribute('transform', 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ')');
        const s = sfx[i];
        s.setAttribute('x', (x + r + 8).toFixed(1)); s.setAttribute('y', (y + r).toFixed(1)); s.style.opacity = suffixOp;
      });
    }
    const setMantra = (i) => sfx.forEach((s, k) => (s.textContent = MANTRAS[i][k]));

    // ── flickering specks ──
    const rnd = (a, b) => a + Math.random() * (b - a);
    const specks = [];
    for (let i = 0; i < 70; i++) {
      const c = el('circle', { cx: rnd(-64, 424).toFixed(1), cy: rnd(-114, 114).toFixed(1), r: rnd(0.7, 2.3).toFixed(2), fill: '#111' });
      speckLayer.appendChild(c);
      specks.push({ el: c, f1: rnd(0.0011, 0.006), f2: rnd(0.0015, 0.009), p1: rnd(0, 6.28), p2: rnd(0, 6.28), max: rnd(0.08, 0.34) });
    }
    function updateSpecks(t) {
      for (const s of specks) { let v = 0.5 + 0.5 * Math.sin(t * s.f1 + s.p1) * Math.sin(t * s.f2 + s.p2); v = v * v * v; s.el.setAttribute('opacity', (v * s.max).toFixed(3)); }
    }

    // ── timeline ──
    const easeIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const SPLIT = 0.35, MDUR = 2600, NM = MANTRAS.length, FADE = 350;
    const T = { WORD: 1400, IN: 1900, MANTRA: NM * MDUR, OUT: 1900 };
    const NEXT = { WORD: 'IN', IN: 'MANTRA', MANTRA: 'OUT', OUT: 'WORD' };
    let phase = 'WORD', start = null, curIdx = -1;

    function render(ph, p, e) {
      if (ph === 'WORD') { buildSeparated(SEP_MAX); place(0, 0); return; }
      if (ph === 'IN') {
        const g = easeIO(p);
        if (g < SPLIT) buildSeparated(SEP_MAX * (1 - g / SPLIT)); else buildMorph(MHOLD * (g - SPLIT) / (1 - SPLIT));
        if (curIdx !== 0) { setMantra(0); curIdx = 0; }
        place(g, 0); return;
      }
      if (ph === 'MANTRA') {
        buildMorph(MHOLD);
        const idx = Math.min(Math.floor(e / MDUR), NM - 1);
        if (idx !== curIdx) { setMantra(idx); curIdx = idx; }
        const local = e - idx * MDUR;
        const so = local < FADE ? local / FADE : local > MDUR - FADE ? (MDUR - local) / FADE : 1;
        place(1, clamp01(so)); return;
      }
      const g = easeIO(p), U = 1 - SPLIT;
      if (g < U) buildMorph(MHOLD * (1 - g / U)); else buildSeparated(SEP_MAX * (g - U) / SPLIT);
      place(1 - g, 0);
    }

    let raf = 0;
    function frame(ts) {
      if (start === null) start = ts;
      const e = ts - start, p = Math.min(e / T[phase], 1);
      render(phase, p, e);
      updateSpecks(ts);
      if (p >= 1) { phase = NEXT[phase]; start = ts; if (phase !== 'MANTRA') curIdx = -1; }
      raf = requestAnimationFrame(frame);
    }
    function run() { if (!raf) raf = requestAnimationFrame(frame); }
    function stop() { cancelAnimationFrame(raf); raf = 0; start = null; }
    const onVis = () => (document.hidden ? stop() : run());
    document.addEventListener('visibilitychange', onVis);
    run();

    return () => { document.removeEventListener('visibilitychange', onVis); stop(); svg.replaceChildren(); };
  }, []);

  return (
    <div style={s.overlay} aria-hidden="true">
      <svg ref={svgRef} width="600" height="300" viewBox="-70 -120 500 240" style={s.svg} />
    </div>
  );
}

const s = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 850, background: '#f5f2eb',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default',
  },
  svg: { maxWidth: '90vw', height: 'auto', overflow: 'visible' },
};
