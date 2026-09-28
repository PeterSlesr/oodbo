import React, { useState, useEffect, useRef, useMemo } from 'react';
import { EDITOR_THEMES } from './lib/themes.js';
import { btn } from './lib/ui.js';
import Editor from './components/Editor.jsx';
import Auth from './components/Auth.jsx';
import DesktopOAuthComplete from './components/DesktopOAuthComplete.jsx';
import Home from './components/Home.jsx';
import ShareView from './components/ShareView.jsx';
import { initSync, getEngine, clearLocalSession, runMigration } from './lib/sync/client.js';
import NotEntitled from './components/NotEntitled.jsx';
import { PAYMENTS_LIVE } from './lib/constants.js';
import { signIn as providerSignIn, getValidProviderAccessToken, signOut as providerSignOut } from './lib/providerSession.js';

// True inside the Tauri desktop shell (same detection the desktop build uses).
// The web entitlement gate below must never fire on desktop, which has a free tier.
const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;


function getDeviceLabel() {
  const ua = navigator.userAgent;
  let browser = 'Browser';
  let os = 'Unknown';
  if (ua.includes('Firefox/'))                               browser = 'Firefox';
  else if (ua.includes('Edg/'))                              browser = 'Edge';
  else if (ua.includes('Chrome/'))                           browser = 'Chrome';
  else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';
  if (ua.includes('Windows'))                                os = 'Windows';
  else if (ua.includes('iPhone') || ua.includes('iPad'))     os = 'iOS';
  else if (ua.includes('Android'))                           os = 'Android';
  else if (ua.includes('Mac OS'))                            os = 'Mac';
  else if (ua.includes('Linux'))                             os = 'Linux';
  return `${browser} · ${os}`;
}


// ── Component ─────────────────────────────────────────────────────────────────

export default function App() {
  // Handle special routes before any auth state logic
  // DEV-ONLY: /preview renders Home with seeded mock projects for UI tweaks without auth (localhost
  // can't sign in — OAuth/magic-link redirect to prod). Gated by import.meta.env.DEV → dropped in prod.
  if (import.meta.env.DEV && window.location.pathname === '/preview') {
    const PreviewHarness = React.lazy(() => import('./components/PreviewHarness.jsx'));
    return <React.Suspense fallback={null}><PreviewHarness /></React.Suspense>;
  }
  if (window.location.pathname === '/desktop/oauth-complete') {
    return <DesktopOAuthComplete />;
  }
  // Public read-only share viewer: /s/<driveFileId> — renders a public snapshot from the
  // author's Drive (no sign-in needed). Handled before any auth logic.
  if (window.location.pathname.startsWith('/s/')) {
    return <ShareView fileId={decodeURIComponent(window.location.pathname.slice(3))} />;
  }
  const [user,            setUser]            = useState(null);   // null=checking, false=guest, object=signed-in
  const [showAuth,        setShowAuth]        = useState(() => new URLSearchParams(window.location.search).get('signup') === '1');
  const [view,            setView]            = useState('editor'); // 'home' | 'editor'
  const [openProjectId,   setOpenProjectId]   = useState(null);    // specific ID, 'new', or null
  const [jumpTarget,      setJumpTarget]      = useState(null);    // { chapterId, cursorPosition, mode }
  const [searchTerm,      setSearchTerm]      = useState('');      // carried into the Editor's find bar on a search open
  const [newProjectType,  setNewProjectType]  = useState(null);    // type string when creating
  const [initialSyncing,  setInitialSyncing]  = useState(false);   // true while syncing (login or return-to-home)
  // One writing quote per syncing event, picked at random. Keyed on initialSyncing
  // so each time the sync screen appears it re-rolls a fresh quote.
  const syncQuote = useMemo(
    () => SYNC_QUOTES[Math.floor(Math.random() * SYNC_QUOTES.length)],
    [initialSyncing],
  );
  const [homeFlash,       setHomeFlash]       = useState('');       // brief message shown on home after being sent back
  const [syncReconnect,   setSyncReconnect]   = useState(false);    // §10: provider auth lost — show "reconnect"
  const [syncTick,        setSyncTick]        = useState(0);        // bumped when the engine changes a record; re-derives badges
  const syncLastAtRef      = useRef(0);     // timestamp of last manual sync — rate-limits the sync button

  useEffect(() => {
    // GIS access tokens are popup-based (they need a user gesture), so a new tab/reload can't
    // silently restore the session — we start as guest. The "sign in" button resumes in one
    // click, pre-selecting the last account (see handleProviderSignIn) so it skips the chooser.
    setUser(false);
  }, []);

  // Background sync (§6): while signed in with sync, drain the outbox on a timer and on
  // reconnect. Costs zero network when the outbox is empty (engine.sweepDirty short-circuits),
  // so this also closes the old gap where the Home page never auto-synced.
  useEffect(() => {
    if (!(user?.provider && user?.paid)) return;
    const id = setInterval(() => { getEngine()?.sweepDirty(); }, 60_000);
    function onOnline() { const eng = getEngine(); if (eng) { eng.reset(); eng.sweepDirty(); } }
    window.addEventListener('online', onOnline);
    return () => { clearInterval(id); window.removeEventListener('online', onOnline); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.provider, user?.paid]);


  // DEV-ONLY: pop the reconnect banner on demand — run `__forceReconnect()` in the console —
  // so the reconnect flow can be tested without waiting ~1h for the token to expire. Stripped
  // from production builds (import.meta.env.DEV is false there).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__forceReconnect = () => setSyncReconnect(true);
    return () => { try { delete window.__forceReconnect; } catch {} };
  }, []);

  // Shared post-auth path: used by both interactive sign-in and silent boot restore.
  async function enterSignedIn(u) {
    const me = { ...u, paid: true };              // free for everyone; paid kept truthy for old checks
    setUser(me);
    try { localStorage.setItem('fwd:user', JSON.stringify(me)); } catch {}
    setShowAuth(false);
    setSyncReconnect(false);   // (re)authed — clear any "storage disconnected" banner
    setView('home');
    setInitialSyncing(true);
    await initSync({
      user: me,
      getToken: getValidProviderAccessToken,
      hooks: {
        onBoot:   (projectId, msg) => { setView('home'); if (msg) { setHomeFlash(msg); setTimeout(() => setHomeFlash(''), 5000); } },
        onReauth: () => setSyncReconnect(true),
        onBadge:  () => setSyncTick(t => t + 1),
      },
    });
    await runMigration();
    await getEngine()?.sweepAll();
    setInitialSyncing(false);
  }

  async function handleProviderSignIn() {
    let u;
    try {
      // Pre-select the last account (from a prior session) so resuming is one click, no chooser.
      let hint;
      try { hint = JSON.parse(localStorage.getItem('fwd:user') || 'null')?.email; } catch {}
      u = await providerSignIn(hint);             // { provider: 'google', email }
    } catch (e) {
      console.warn('sign-in cancelled/failed:', e);
      return;
    }
    await enterSignedIn(u);
  }
  async function handleSignOut() {
    try { await providerSignOut(); } catch (err) { console.warn('sign-out error:', err); }
    localStorage.removeItem('fwd:user');
    await clearLocalSession();   // wipe this account's local data + drop the engine
    setUser(false);
    setView('editor');
    setOpenProjectId(null);
    setNewProjectType(null);
  }

  async function handleGoHome(msg) {
    const eng = getEngine();
    if (eng) {
      setInitialSyncing(true);
      await eng.sweepAll();
      setInitialSyncing(false);
    }
    setView('home');
    if (msg && typeof msg === 'string') {
      setHomeFlash(msg);
      setTimeout(() => setHomeFlash(''), 5000);
    }
  }

  function handleOpenProject(id, jump = null, term = '') {
    setOpenProjectId(id);
    setJumpTarget(jump);
    setSearchTerm(term);
    setNewProjectType(null);
    setView('editor');
  }

  async function handleSync() {
    const now = Date.now();
    if (now - syncLastAtRef.current < 30_000) return;
    syncLastAtRef.current = now;
    const eng = getEngine();
    if (eng) {
      eng.reset();
      const r = await eng.sweepAll({ userInitiated: true });
      // Stamp the UI's "synced X ago" note on a successful attempt, even when
      // nothing changed — the editor already does this in its sync wrapper, but
      // a sync from Home went through here and never touched the key, so the note
      // sat frozen after a no-op sync. (halted/transient = not a clean sync.)
      if (r?.ok) {
        try { localStorage.setItem(`fwd:lastSynced:${user?.email || ''}`, new Date().toISOString()); } catch {}
      }
    }
  }

  function handleNewProject(type) {
    setOpenProjectId('new');
    setNewProjectType(type);
    setView('editor');
  }

  // Still resolving session
  if (user === null) return null;

  // Pulling cloud projects on new device — show a simple loading screen
  if (initialSyncing) {
    return (
      <div style={sLoading.page}>
        <div style={sLoading.header}>
          <span style={sLoading.logo}>oodbo</span>
          <p style={sLoading.msg}>Syncing your projects…</p>
        </div>
        <blockquote style={sLoading.quote}>
          <p style={sLoading.quoteText}>“{syncQuote.text}”</p>
          <footer style={sLoading.quoteAttr}>{syncQuote.attr}</footer>
        </blockquote>
      </div>
    );
  }

  if (showAuth) {
    return <Auth onCancel={() => setShowAuth(false)} />;
  }

  // Web entitlement gate: web access is paid-only. A signed-in user without a
  // license (no account or paid=false) gets a "what happened / next steps" page.
  // Skipped on desktop (free tier) and when payments aren't live (avoids locking
  // out signed-in users pre-launch, when there's nothing to buy).
  if (user && !user.paid && !IS_TAURI && PAYMENTS_LIVE) {
    return <NotEntitled email={user.email} onSignOut={handleSignOut} />;
  }

  // Signed-in: show homepage or editor
  if (user) {
    if (view === 'home') {
      return (
        <>
          <Home
            user={user}
            onOpenProject={handleOpenProject}
            onNewProject={handleNewProject}
            onSignOut={handleSignOut}
            onSync={handleSync}
            syncTick={syncTick}
            syncReconnect={syncReconnect}
            onReconnect={handleProviderSignIn}
          />
          {homeFlash && (
            <div style={sFlash.banner}>{homeFlash}</div>
          )}
        </>
      );
    }
    return (
      <Editor
        key={user.email}
        user={user}
        onSignIn={handleProviderSignIn}
        onSignOut={handleSignOut}
        onGoHome={handleGoHome}
        openProjectId={openProjectId}
        newProjectType={newProjectType}
        jumpTarget={jumpTarget}
        searchTerm={searchTerm}
        syncReconnect={syncReconnect}
        onReconnect={handleProviderSignIn}
      />
    );
  }

  // Guest — open straight into the editor (ephemeral, no login wall).
  return (
    <Editor
      guest
      user={null}
      onSignIn={handleProviderSignIn}
      onSignOut={() => {}}
      onGoHome={null}
    />
  );
}

const sTrust = {
  wrap: {
    minHeight: '100vh', display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: '#f5f2eb', padding: 20,
  },
  box:     { width: '100%', maxWidth: 360 },
  brand:   { fontFamily: 'Georgia, serif', fontSize: 28, fontWeight: 'normal', letterSpacing: '-0.02em', color: '#111', marginBottom: 4 },
  divider: { borderTop: '1px solid #ddd6c9', margin: '20px 0' },
  title:   { fontFamily: 'Georgia, serif', fontSize: 18, fontWeight: 'normal', color: '#111', marginBottom: 6 },
  body:    { fontFamily: 'Georgia, serif', fontSize: 14, color: '#444', marginBottom: 24, fontStyle: 'italic' },
  primary: {
    fontFamily: 'Georgia, serif', fontSize: 13, width: '100%', padding: '9px 12px',
    background: '#111', color: '#fff', border: '1px solid #111', cursor: 'pointer', marginBottom: 10, display: 'block',
  },
  ghost: {
    fontFamily: 'Georgia, serif', fontSize: 12, background: 'transparent',
    border: 'none', color: '#888', cursor: 'pointer', fontStyle: 'italic', padding: 0,
  },
};

const sFlash = {
  banner: {
    position:   'fixed',
    bottom:     24,
    left:       '50%',
    transform:  'translateX(-50%)',
    background: '#111',
    color:      '#f5f2eb',
    fontFamily: 'Georgia, serif',
    fontStyle:  'italic',
    fontSize:   12,
    padding:    '8px 18px',
    borderRadius: 0,
    pointerEvents: 'none',
    zIndex:     999,
    whiteSpace: 'nowrap',
  },
};

// Writing quotes shown on the sync screen (same set as the Word add-in taskpane).
const SYNC_QUOTES = [
  { text: "The first draft is just you telling yourself the story.", attr: "— Terry Pratchett" },
  { text: "You can always edit a bad page. You can't edit a blank page.", attr: "— Jodi Picoult" },
  { text: "Start writing, no matter what. The water does not flow until the faucet is turned on.", attr: "— Louis L'Amour" },
  { text: "Don't get it right, get it written.", attr: "— James Thurber" },
  { text: "A word after a word after a word is power.", attr: "— Margaret Atwood" },
  { text: "The scariest moment is always just before you start.", attr: "— Stephen King" },
  { text: "I write to find out what I'm thinking.", attr: "— Joan Didion" },
  { text: "There is nothing to writing. All you do is sit down at a typewriter and bleed.", attr: "— Red Smith" },
  { text: "Writing is thinking on paper.", attr: "— William Zinsser" },
  { text: "The writer who waits for ideal conditions under which to work will die without putting a word on paper.", attr: "— E.B. White" },
  { text: "One day I will find the right words, and they will be simple.", attr: "— Kerouac" },
  { text: "Fill your paper with the breathings of your heart.", attr: "— Wordsworth" },
  { text: "Almost all good writing begins with terrible first efforts.", attr: "— Anne Lamott" },
  { text: "Quantity produces quality. If you only write a few things, you're doomed.", attr: "— Ray Bradbury" },
  { text: "The secret of getting ahead is getting started.", attr: "— Mark Twain (probably not, but he gets credit anyway)" },
  { text: "Do not hoard what seems good for a later place in the book. Give it now.", attr: "— Annie Dillard" },
  { text: "If you wait for inspiration to write, you're not a writer, you're a waiter.", attr: "— Dan Poynter" },
  { text: "Write. Rewrite. When not writing or rewriting, read.", attr: "— Larry L. King" },
  { text: "You have to write the book that wants to be written.", attr: "— Madeleine L'Engle" },
];

const sLoading = {
  page: {
    minHeight: '100vh',
    background: '#f5f2eb',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'Georgia, serif',
    padding: '0 28px',
    boxSizing: 'border-box',
  },
  // Logo + "Syncing…" cluster — lifted above centre so the quote reads as central.
  header: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 10,
    marginBottom: 'clamp(36px, 8vh, 72px)',
  },
  logo: {
    fontSize: 22,
    color: '#888',
    fontStyle: 'italic',
    letterSpacing: '-0.02em',
  },
  msg: {
    fontSize: 13,
    color: '#aaa',
    fontStyle: 'italic',
    margin: 0,
  },
  quote: {
    margin: 0,
    maxWidth: 540,
    textAlign: 'center',
  },
  quoteText: {
    margin: 0,
    fontSize: 'clamp(18px, 4.4vw, 23px)',
    lineHeight: 1.5,
    fontStyle: 'italic',
    color: '#6f675b',
  },
  quoteAttr: {
    marginTop: 16,
    fontSize: 14,
    color: '#a89f8e',
    fontStyle: 'normal',
  },
};
