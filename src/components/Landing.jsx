import React, { useEffect, useState } from 'react';
import { PAYMENTS_LIVE } from '../lib/constants.js';
import { EDITOR_THEMES } from '../lib/themes.js';
import { btn, dialog } from '../lib/ui.js';
import BodyScrollLock from '../lib/BodyScrollLock.jsx';

const _th = EDITOR_THEMES.parchment;               // landing page is parchment
const _dg = dialog(_th, {});

const LS_OODBO = 'https://oodbo.lemonsqueezy.com/checkout/buy/3229a629-9112-4867-a4c1-e9e510a544b1';
const MS_STORE_URL = 'https://marketplace.microsoft.com/en-us/product/office/WA200011123';

// Public marketing landing (logged-out visitors). Was TestHome.jsx — renamed for clarity;
// Home.jsx is the signed-in project dashboard, this is the front door.
export default function Landing({ onSignIn }) {
  const [showComingSoon, setShowComingSoon] = useState(false);
  const [showWordPrompt, setShowWordPrompt] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 640px)').matches);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = e => setIsMobile(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const handleBuy = () => {
    if (!PAYMENTS_LIVE) { setShowComingSoon(true); return; }
    window.open(LS_OODBO, '_blank', 'noopener,noreferrer');
  };
  const handleBuyWord = () => {
    if (!PAYMENTS_LIVE) { setShowComingSoon(true); return; }
    setShowWordPrompt(true);
  };
  const confirmWordOpen = (dest = MS_STORE_URL) => {
    setShowWordPrompt(false);
    window.open(dest, '_blank', 'noopener,noreferrer');
  };
  const goGuest    = () => { window.location.href = '/guest'; };
  const goDownload = () => { window.open('/download', '_blank', 'noopener,noreferrer'); };

  // Our own scroll container controls the page (root is overflow:hidden globally).
  useEffect(() => {
    const els = [document.documentElement, document.body, document.getElementById('root')];
    els.forEach(el => { if (el) el.style.overflow = 'hidden'; });
    return () => els.forEach(el => { if (el) el.style.overflow = ''; });
  }, []);

  return (
    <div style={s.page}>

      {/* ── Nav ── */}
      <nav style={s.nav}>
        <span style={s.navLogo}>oodbo.io</span>
        <div style={s.navRight}>
          <button style={s.navSignIn} onClick={onSignIn}>sign in</button>
          <button style={s.navBuy} onClick={handleBuy}>get oodbo</button>
        </div>
      </nav>

      <div style={s.scroll}>

        {/* ── Hero ── */}
        <header style={s.hero}>
          <p style={s.eyebrow}>a forward-only writing tool</p>
          <h1 style={s.headline}>Draft without looking back.</h1>
          <p style={s.lede}>
            Forward Mode removes the option to edit: no backspace, no delete, nothing
            in your way. Your first draft isn't precious. Getting it out of your head is.
          </p>
          <button style={s.ctaPrimary} onClick={goGuest}>start writing free</button>
          <p style={s.micro}>no account, nothing to install</p>
        </header>

        <div style={s.rule} />

        {/* ── How it works ── */}
        <section style={s.col}>
          <h2 style={s.h2}>How it works.</h2>
          <p style={s.body}>In Forward Mode, you write forward.</p>
          <p style={s.body}>
            You can write the next word or you can stop, but you cannot run in circles
            or second guess yourself. You cannot change what you have just written.
            There is no select, cut, or delete.
          </p>
          <p style={s.body}>
            Backspace does nothing so the typos stay and the wrong words stay and you
            are free to explore your ideas without being interrupted by 'making it
            better'. There is time for that later.
          </p>
          <p style={s.body}>
            In Edit Mode, you can fix your typos and reword awkward phrasing. Move
            things around. Leave yourself comments for future passes.
          </p>
          <p style={s.punch}>
            The goal is not beautiful first drafts. The goal is first drafts that exist at all.
          </p>
        </section>

        <div style={s.rule} />

        {/* ── Demo ── */}
        <section style={s.demoSec}>
          <iframe
            src="/forward-demo.html"
            title="oodbo Forward mode — a live demo that writes itself"
            style={{ ...s.demoFrame, height: isMobile ? 560 : 470 }}
          />
        </section>

        <div style={s.rule} />

        {/* ── Three places ── */}
        <section style={s.col}>
          <h2 style={s.h2}>Three places to write.</h2>
          <div style={{ ...s.places, gridTemplateColumns: isMobile ? '1fr' : `repeat(${PAYMENTS_LIVE ? 3 : 2}, 1fr)` }}>
            <div style={s.place}>
              <p style={s.placeT}>In your browser</p>
              <p style={s.placeD}>Nothing to install, no account required to give it a try. The real editor runs right away. Purchase oodbo and your writing automatically syncs to your Google Drive or OneDrive account.</p>
              <button style={s.placeBtn} onClick={goGuest}>try it free</button>
            </div>
            {PAYMENTS_LIVE && (
            <div style={s.place}>
              <p style={s.placeT}>On your desktop</p>
              <p style={s.placeD}>A native app for Windows, with macOS on the roadmap. Your work lives in real files on your computer, with the option to sync to your Google Drive or OneDrive account. Works offline.</p>
              <button style={s.placeBtn} onClick={goDownload}>get the desktop app</button>
            </div>
            )}
            <div style={s.place}>
              <p style={s.placeT}>Inside Microsoft Word</p>
              <p style={s.placeD}>Forward Mode in the document you're already writing, publishing back into it when you're done. Free to install with a limited trial, then included in your purchase.</p>
              <button style={s.placeBtn} onClick={handleBuyWord}>get it for Word</button>
            </div>
          </div>
          <p style={s.placesFoot}>
            One purchase covers all three. <a href="/features" style={s.inlineLink}>See the full feature list here</a>
          </p>
        </section>

        <div style={s.rule} />

        {/* ── Founder note ── */}
        <section style={s.noteSec}>
          <p style={s.note}>
            I built oodbo because editing was blocking me from writing the next line.
            This tool helps me to hold off the inner critic until I've got something
            complete enough to adjust. I built it in the hopes of writing more, and so
            far I have :)
          </p>
        </section>

      </div>{/* end scroll */}

      {/* ── Footer (pinned to the viewport bottom, outside the scroll area) ── */}
      <footer style={s.footer}>
        <a href="/privacy" target="_blank" rel="noopener noreferrer" style={s.footerLink}>privacy</a>
        <span style={s.footerDot}>·</span>
        <a href="/terms"   target="_blank" rel="noopener noreferrer" style={s.footerLink}>terms</a>
        <span style={s.footerDot}>·</span>
        <a href="/faq"     target="_blank" rel="noopener noreferrer" style={s.footerLink}>faq</a>
        <span style={s.footerDot}>·</span>
        <a href="/blog"    target="_blank" rel="noopener noreferrer" style={s.footerLink}>blog</a>
        <span style={s.footerDot}>·</span>
        <a href={MS_STORE_URL} target="_blank" rel="noopener noreferrer" style={s.footerLink}>MS Word</a>
        {PAYMENTS_LIVE && <>
          <span style={s.footerDot}>·</span>
          <a href="/download" target="_blank" rel="noopener noreferrer" style={s.footerLink}>desktop app</a>
        </>}
      </footer>

      {/* ── Coming soon modal ── */}
      {showComingSoon && (
        <div style={_dg.overlay} onClick={() => setShowComingSoon(false)}>
          <BodyScrollLock />
          <div style={_dg.box} onClick={e => e.stopPropagation()}>
            <p style={_dg.title}>Coming soon</p>
            <div style={_dg.rule} />
            <p style={_dg.body}>
              Purchasing isn't switched on just yet. In the meantime, you can use the
              editor free in your browser.
            </p>
            <div style={_dg.actions}>
              <button style={btn(_th, 'ghost')} onClick={() => setShowComingSoon(false)}>Maybe later</button>
              <button style={btn(_th, 'primary')} onClick={goGuest}>Try the editor</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Word requirement prompt ── */}
      {showWordPrompt && (
        <div style={_dg.overlay} onClick={() => setShowWordPrompt(false)}>
          <BodyScrollLock />
          <div style={_dg.box} onClick={e => e.stopPropagation()}>
            <p style={_dg.title}>Before you continue</p>
            <div style={_dg.rule} />
            <p style={_dg.body}>
              The oodbo add-in installs from the Microsoft AppSource store, inside Word.
              We'll open the store listing in a new tab.
            </p>
            <div style={_dg.actions}>
              <button style={btn(_th, 'ghost')} onClick={() => setShowWordPrompt(false)}>Cancel</button>
              <button style={btn(_th, 'primary')} onClick={() => confirmWordOpen()}>OK, take me to the MS Store</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

const s = {
  page: { height: '100%', display: 'flex', flexDirection: 'column', background: '#f5f2eb', color: '#1f1f1f', fontFamily: 'Georgia, serif', WebkitFontSmoothing: 'antialiased' },

  nav: { flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 clamp(20px,4vw,40px)', height: 54, borderBottom: '1px solid #ddd6c9' },
  navLogo: { fontSize: 16, fontStyle: 'italic', color: '#8a847a', letterSpacing: '-0.02em' },
  navRight: { display: 'flex', alignItems: 'center', gap: 18 },
  navSignIn: { fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: 13, color: '#8a847a', background: 'none', border: 'none', cursor: 'pointer', padding: 0 },
  navBuy: { fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: 13, color: '#555', background: 'transparent', border: '1px solid #ddd6c9', padding: '6px 14px', cursor: 'pointer' },

  scroll: { flex: 1, overflowY: 'auto', scrollbarGutter: 'stable' },

  hero: { textAlign: 'center', maxWidth: 600, margin: '0 auto', padding: 'clamp(56px,8vw,88px) clamp(20px,4vw,32px) clamp(44px,6vw,64px)' },
  eyebrow: { fontSize: 12, fontStyle: 'italic', color: '#a8a091', letterSpacing: '0.08em', margin: '0 0 20px' },
  headline: { fontSize: 'clamp(40px,7vw,68px)', fontWeight: 'normal', fontStyle: 'italic', letterSpacing: '-0.03em', lineHeight: 1.08, color: '#111', margin: '0 0 26px', textWrap: 'balance' },
  lede: { fontSize: 17, lineHeight: 1.8, color: '#4a453d', maxWidth: 500, margin: '0 auto 36px' },
  ctaPrimary: { display: 'inline-block', fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: 15, color: '#f5f2eb', background: '#111', padding: '12px 28px', border: 'none', cursor: 'pointer' },
  micro: { fontSize: 12, fontStyle: 'italic', color: '#a8a091', margin: '14px 0 0' },

  rule: { maxWidth: 640, margin: '0 auto', height: 1, background: '#ddd6c9' },

  col: { maxWidth: 640, margin: '0 auto', padding: 'clamp(44px,6vw,60px) clamp(20px,4vw,32px)' },
  h2: { fontSize: 22, fontWeight: 'normal', fontStyle: 'italic', letterSpacing: '-0.02em', color: '#111', margin: '0 0 22px' },
  body: { fontSize: 16, lineHeight: 1.85, color: '#3a352d', margin: '0 0 18px' },
  punch: { fontSize: 17, fontStyle: 'italic', color: '#111', margin: '26px 0 0', lineHeight: 1.6 },

  demoSec: { display: 'flex', justifyContent: 'center', padding: 'clamp(40px,6vw,60px) clamp(20px,4vw,32px)' },
  demoFrame: { width: 'min(590px, 100%)', border: 0, display: 'block', background: 'transparent' },

  places: { display: 'grid', gap: 24, alignItems: 'stretch', marginBottom: 26 },
  place: { display: 'flex', flexDirection: 'column' },
  placeT: { fontSize: 14, fontStyle: 'italic', color: '#111', margin: '0 0 6px' },
  placeD: { fontSize: 14, lineHeight: 1.7, color: '#6a6459', margin: '0 0 16px' },
  placeBtn: { marginTop: 'auto', display: 'block', textAlign: 'center', fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: 13, color: '#111', background: 'transparent', border: '1px solid #cfc7b6', padding: '10px 12px', cursor: 'pointer' },
  placesFoot: { fontSize: 16, lineHeight: 1.85, color: '#3a352d', margin: 0 },
  inlineLink: { fontStyle: 'italic', color: '#111', textDecoration: 'underline', textUnderlineOffset: '3px' },

  noteSec: { maxWidth: 540, margin: '0 auto', padding: 'clamp(44px,6vw,60px) clamp(20px,4vw,32px)' },
  note: { fontSize: 15, lineHeight: 1.85, color: '#8a847a', fontStyle: 'italic', margin: 0 },

  footer: { flexShrink: 0, borderTop: '1px solid #ddd6c9', padding: '16px clamp(20px,4vw,40px)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11 },
  footerLink: { color: '#a8a091', textDecoration: 'none', fontStyle: 'italic' },
  footerDot: { color: '#ccc' },
};
