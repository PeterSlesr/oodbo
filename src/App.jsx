import React, { useState, useEffect, useRef, useMemo } from 'react';
import { supabase } from './lib/supabase.js';
import { getMe, signOut } from './lib/api.js';
import { EDITOR_THEMES } from './lib/themes.js';
import { btn } from './lib/ui.js';
import Editor from './components/Editor.jsx';
import Auth from './components/Auth.jsx';
import AuthCallback from './components/AuthCallback.jsx';
import DesktopOAuthComplete from './components/DesktopOAuthComplete.jsx';
import Home from './components/Home.jsx';
import SharedViewer from './components/SharedViewer.jsx';
import Admin from './components/Admin.jsx';
import { initSync, getEngine, teardownSync, runMigration } from './lib/sync/client.js';
import NotEntitled from './components/NotEntitled.jsx';
import { PAYMENTS_LIVE } from './lib/constants.js';

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

// Token for the sync engine: the current Supabase access token if present (trusted device,
// auto-refreshed), else the untrusted-device JWT held in sessionStorage.
async function syncGetToken() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) return session.access_token;
  } catch {}
  return sessionStorage.getItem('fwd:session');
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
  if (window.location.pathname === '/auth/callback') {
    return <AuthCallback />;
  }
  if (window.location.pathname === '/desktop/oauth-complete') {
    return <DesktopOAuthComplete />;
  }
  if (window.location.pathname.startsWith('/s/')) {
    const shareId = window.location.pathname.slice(3);
    return <SharedViewer id={shareId} />;
  }
  if (window.location.pathname === '/admin') {
    return <Admin />;
  }
  const [user,            setUser]            = useState(null);   // null=checking, false=guest, object=signed-in
  const [showAuth,        setShowAuth]        = useState(() => new URLSearchParams(window.location.search).get('signup') === '1');
  const [showTrustPrompt, setShowTrustPrompt] = useState(false);
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
  const initialDoneRef     = useRef(false); // prevents auth events on tab focus re-triggering the login sync
  const pendingSessionRef  = useRef(null);  // holds session while trust prompt is shown
  const accessTokenRef     = useRef(null);  // current access token (updated on refresh)
  const trustShownRef      = useRef(false); // prevents showing trust prompt twice on load

  useEffect(() => {
    // Untrusted-device ("sign me out on close") session lives in sessionStorage only — both the fwd:session
    // boot token and, via the storage adapter (lib/supabase.js), supabase's own session. The browser wipes
    // sessionStorage on close, so neither can survive a browser restart; supabase refreshes its copy in
    // sessionStorage while the tab is open but NEVER re-persists it to localStorage. On a same-tab reload
    // the trust choice was already made, so drive state from the fwd:session token and skip the prompt; the
    // live token for cloud calls comes from supabase.auth.getSession() (syncGetToken), so a stale snapshot
    // here is only the boot signal. A real sign-out is handled explicitly by handleSignOut.
    const storedToken = sessionStorage.getItem('fwd:session');
    if (storedToken) {
      fetchUser(storedToken);
      return;
    }

    function maybeShowTrustPrompt(session) {
      if (trustShownRef.current) return;
      trustShownRef.current = true;
      pendingSessionRef.current = session;
      setShowTrustPrompt(true);
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        // This getSession() can resolve AFTER the user picked "No" (which signs supabase out locally),
        // by which point session is null. In session-only mode the fwd:session token is the source of
        // truth — don't bounce to the landing page; only a genuinely session-less visitor should.
        if (sessionStorage.getItem('fwd:session')) return;
        setUser(false); return;
      }
      if (localStorage.getItem('fwd:trust')) {
        fetchUser(session.access_token);
      } else {
        maybeShowTrustPrompt(session);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        // Session-only ("No, sign me out when I close the browser") mode: the app is driven by the
        // fwd:session token and supabase is DELIBERATELY signed out, so ignore its SIGNED_OUT events
        // (which can fire repeatedly/late via auto-refresh/visibility) — they must NOT bounce the user
        // to the landing page. A real sign-out (handleSignOut) clears fwd:session and setUser(false)
        // itself, so this correctly no-ops then too. Replaces the racy one-shot suppressSignOutRef guard.
        if (sessionStorage.getItem('fwd:session')) return;
        setUser(false);
        return;
      }
      if (event === 'TOKEN_REFRESHED') {
        if (session) accessTokenRef.current = session.access_token;
        return;
      }
      if (!session) return;
      if (localStorage.getItem('fwd:trust')) {
        // TOKEN_REFRESHED already handled; INITIAL_SESSION / SIGNED_IN for returning users
        if (!initialDoneRef.current) fetchUser(session.access_token);
      } else {
        maybeShowTrustPrompt(session);
      }
    });

    return () => subscription.unsubscribe();
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


  async function handleTrust(trusted) {
    const session = pendingSessionRef.current;
    setShowTrustPrompt(false);

    if (trusted) {
      localStorage.setItem('fwd:trust', 'yes');
      sessionStorage.removeItem('fwd:session-only');   // trusted → session persists in localStorage (default)
      try {
        const res = await fetch('/api/auth/sessions', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body:    JSON.stringify({ device_label: getDeviceLabel() }),
        });
        if (res.ok) {
          const { id } = await res.json();
          localStorage.setItem('fwd:session-id', id);
        }
      } catch {}
      fetchUser(session.access_token);
    } else {
      // "Sign me out when I close the browser." Mark the session session-only so the supabase storage
      // adapter (lib/supabase.js) keeps it in sessionStorage — supabase still auto-refreshes it while the
      // tab is open, but the browser wipes sessionStorage on close and the adapter never re-persists it to
      // localStorage. So a "No" session CANNOT survive a close, no matter how long it stayed open.
      // Migrate the session OAuth already wrote to localStorage into sessionStorage now. NO signOut — even
      // scope:'local' terminates the session server-side, so /api/auth/me (getUser) and every cloud call
      // then 401 this token, which bounced the user to the landing page.
      sessionStorage.setItem('fwd:session-only', '1');
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
            sessionStorage.setItem(k, localStorage.getItem(k));
            localStorage.removeItem(k);
          }
        }
      } catch {}
      sessionStorage.setItem('fwd:session', session.access_token);
      fetchUser(session.access_token);
    }
  }

  async function fetchUser(accessToken) {
    accessTokenRef.current = accessToken;
    const me = await getMe(accessToken);

    // Token explicitly rejected by the server — clear everything and sign out.
    // Don't fall back to cache: the session was revoked, not a network blip.
    if (me?._unauthorized) {
      try { await signOut(); } catch {}
      localStorage.removeItem('fwd:user');
      localStorage.removeItem('fwd:session-id');
      sessionStorage.removeItem('fwd:session');
      accessTokenRef.current = null;
      initialDoneRef.current = false;
      trustShownRef.current  = false;
      setUser(false);
      return;
    }

    if (me) {
      const isFirst = !initialDoneRef.current;
      initialDoneRef.current = true;

      setUser(me);
      try { localStorage.setItem('fwd:user', JSON.stringify(me)); } catch {}
      setShowAuth(false);

      if (isFirst) {
        // Decide the post-login view BEFORE the awaits below. setUser(me) above triggers a render,
        // and view defaults to 'editor' (the signed-out local editor) — so without this the app
        // flashes a project for a frame before switching to home. Paid users go straight to the
        // sync loading screen instead.
        setView('home');
        if (me.provider && me.paid) setInitialSyncing(true);

        // Create a session record if trusted device and none exists yet
        if (localStorage.getItem('fwd:trust') && !localStorage.getItem('fwd:session-id')) {
          try {
            const res = await fetch('/api/auth/sessions', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
              body:    JSON.stringify({ device_label: getDeviceLabel() }),
            });
            if (res.ok) {
              const { id } = await res.json();
              localStorage.setItem('fwd:session-id', id);
            }
          } catch {}
        }
        if (me.provider && me.paid) {
          initSync({
            user: me,
            getToken: syncGetToken,
            hooks: {
              onBoot:   (projectId, msg) => { setView('home'); if (msg) { setHomeFlash(msg); setTimeout(() => setHomeFlash(''), 5000); } },
              onReauth: () => setSyncReconnect(true),
              // Badges are still derived from the records at render time (5e) — never stored, so
              // they can't drift. But deriving at render time only works if a render happens:
              // the engine changes records from background sweeps, so it has to say when.
              onBadge:  () => setSyncTick(t => t + 1),
            },
          });
          await runMigration();          // §12 — one-time, guarded
          await getEngine()?.sweepAll();  // launch sweep
          setInitialSyncing(false);
        }
      }
    } else {
      const cached = localStorage.getItem('fwd:user');
      if (cached) {
        try { setUser(JSON.parse(cached)); return; } catch {}
      }
      setUser(false);
    }
  }

  async function handleSignOut() {
    // Revoke our session record — try accessTokenRef first, fall back to Supabase session
    const sessionId = localStorage.getItem('fwd:session-id');
    if (sessionId) {
      let token = accessTokenRef.current;
      if (!token) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          token = session?.access_token;
        } catch {}
      }
      if (token) {
        fetch(`/api/auth/sessions?id=${sessionId}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    }
    try { await signOut(); } catch (err) { console.warn('handleSignOut error:', err); }
    localStorage.removeItem('fwd:user');
    localStorage.removeItem('fwd:session-id');
    // fwd:trust is intentionally kept — device preference persists across sign-ins
    sessionStorage.removeItem('fwd:session');
    accessTokenRef.current    = null;
    trustShownRef.current     = false;
    initialDoneRef.current    = false;
    teardownSync();   // drop the engine + close the IDB connection
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

  // Trust prompt — shown after first sign-in on a new device
  if (showTrustPrompt) {
    return (
      <div style={sTrust.wrap}>
        <div style={sTrust.box}>
          <h1 style={sTrust.brand}>oodbo</h1>
          <div style={sTrust.divider} />
          <p style={sTrust.title}>You're signed in.</p>
          <p style={sTrust.body}>Trust this device?</p>
          <button style={{ ...btn(EDITOR_THEMES.parchment, 'primary'), width: '100%', marginBottom: 10 }} onClick={() => handleTrust(true)}>
            Yes, keep me signed in
          </button>
          <button style={{ ...btn(EDITOR_THEMES.parchment, 'secondary'), width: '100%' }} onClick={() => handleTrust(false)}>
            No, sign me out when I close the browser
          </button>
        </div>
      </div>
    );
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
        onSignIn={() => setShowAuth(true)}
        onSignOut={handleSignOut}
        onGoHome={handleGoHome}
        openProjectId={openProjectId}
        newProjectType={newProjectType}
        jumpTarget={jumpTarget}
        searchTerm={searchTerm}
        syncReconnect={syncReconnect}
      />
    );
  }

  // Guest — open straight into the editor (ephemeral, no login wall).
  return (
    <Editor
      guest
      user={null}
      onSignIn={() => setShowAuth(true)}
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
