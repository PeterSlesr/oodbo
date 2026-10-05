import React, { useState, useEffect, useRef, useMemo } from 'react';
import { EDITOR_THEMES } from './lib/themes.js';
import { btn } from './lib/ui.js';
import Editor from './components/Editor.jsx';
import DesktopOAuthComplete from './components/DesktopOAuthComplete.jsx';
// Desktop-only login gate — lazy so its fs/account deps never enter the web bundle.
const DesktopLogin = React.lazy(() => import('./components/DesktopLogin.jsx'));
import Home from './components/Home.jsx';
import ShareView from './components/ShareView.jsx';
import { initSync, getEngine, clearLocalSession, teardownSync, runMigration } from './lib/sync/client.js';
import { signIn as providerSignIn, getValidProviderAccessToken, signOut as providerSignOut, restoreSession } from './lib/providerSession.js';
import { IS_TAURI } from './lib/platform.js';
import { clearVaultKey } from './lib/localVault.js';
import { readGuestDraftText } from './lib/guestStore.js';
import { WRITING_QUOTES } from './lib/quotes.js';


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
  const [view,            setView]            = useState('editor'); // 'home' | 'editor'
  const [openProjectId,   setOpenProjectId]   = useState(null);    // specific ID, 'new', or null
  const [jumpTarget,      setJumpTarget]      = useState(null);    // { chapterId, cursorPosition, mode }
  const [searchTerm,      setSearchTerm]      = useState('');      // carried into the Editor's find bar on a search open
  const [newProjectType,  setNewProjectType]  = useState(null);    // type string when creating
  const [initialSyncing,  setInitialSyncing]  = useState(false);   // true while syncing (login or return-to-home)
  // One writing quote per syncing event, picked at random. Keyed on initialSyncing
  // so each time the sync screen appears it re-rolls a fresh quote.
  const syncQuote = useMemo(
    () => WRITING_QUOTES[Math.floor(Math.random() * WRITING_QUOTES.length)],
    [initialSyncing],
  );
  const scheme = (() => { try { return localStorage.getItem('fwd:crt-scheme') || 'green'; } catch { return 'green'; } })();
  const [homeFlash,       setHomeFlash]       = useState('');       // brief message shown on home after being sent back
  const [syncReconnect,   setSyncReconnect]   = useState(false);    // §10: provider auth lost — show "reconnect"
  const [syncTick,        setSyncTick]        = useState(0);        // bumped when the engine changes a record; re-derives badges
  const syncLastAtRef      = useRef(0);     // timestamp of last manual sync — rate-limits the sync button

  useEffect(() => {
    // WEB: GIS access tokens are popup-based (they need a user gesture), so a new tab/reload can't
    // silently restore the session — we start as guest. The "sign in" button resumes in one click,
    // pre-selecting the last account (see handleProviderSignIn) so it skips the chooser.
    // DESKTOP (Tauri): we hold a real refresh token, so boot restore IS silent — resume the session
    // with no popup. Falls back to guest if there's no stored session (or it's dead / offline).
    let cancelled = false;
    (async () => {
      if (IS_TAURI) {
        let last = null;
        try { const { getLastUsedAccount } = await import('./lib/desktopAccounts.js'); last = await getLastUsedAccount(); } catch {}
        // A protected Google account that was quit (not signed out) may still have plaintext Drive tokens
        // in localStorage — clear them while it's locked at the gate (they're sealed in the account's
        // secret and restored on PIN unlock), so nothing plaintext lingers for a locked account.
        if (last?.protected && last.type === 'google') { try { localStorage.removeItem('fwd:desktop-provider-tokens'); } catch {} }
        // A PIN-protected last account must be unlocked at the gate — never silent-restore past the PIN.
        if (!last?.protected) {
          // Google (or first run): resume silently from the refresh token if there is one.
          if (!last || last.type === 'google') {
            try { const u = await restoreSession(); if (!cancelled && u?.email) { await enterSignedIn(u); return; } } catch {}
            // Offline / transient token: open the last Google account from its cached identity so it
            // works offline LIKE LOCAL (sync resumes on reconnect). Only when there was a real session.
            if (!cancelled && last?.type === 'google') {
              try {
                const cached = JSON.parse(localStorage.getItem('fwd:user') || 'null');
                if (cached?.provider) { await enterSignedIn(cached); return; }
              } catch {}
            }
          }
          // Open local account: auto-open from disk (no cloud).
          if (!cancelled && last && last.type === 'local') {
            try { const { toLocalUser } = await import('./lib/desktopAccounts.js'); await enterSignedIn(toLocalUser(last)); return; } catch {}
          }
        }
        // Else fall through → setUser(false) renders the desktop login gate (no guest on desktop).
      }
      if (!cancelled) setUser(false);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background sync (§6): while signed in with sync, drain the outbox on a timer and on
  // reconnect. Costs zero network when the outbox is empty (engine.sweepDirty short-circuits),
  // so this also closes the old gap where the Home page never auto-synced.
  useEffect(() => {
    if (!user?.provider) return;
    const id = setInterval(() => { getEngine()?.sweepDirty(); }, 60_000);
    function onOnline() { const eng = getEngine(); if (eng) { eng.reset(); eng.sweepDirty(); } }
    window.addEventListener('online', onOnline);
    return () => { clearInterval(id); window.removeEventListener('online', onOnline); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.provider]);


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
    const me = { ...u };                          // free for everyone — no entitlement concept
    setUser(me);
    try { localStorage.setItem('fwd:user', JSON.stringify(me)); } catch {}
    // Desktop: remember a Google account in the "welcome back" registry (fresh sign-in or boot restore).
    if (IS_TAURI && me.provider === 'google') {
      import('./lib/desktopAccounts.js').then(m => m.recordGoogleAccount({ email: me.email })).catch(() => {});
    }
    setSyncReconnect(false);   // (re)authed — clear any "storage disconnected" banner
    // A guest who signs in should KEEP the writing they did as a guest — otherwise switching to
    // the account's own storage would orphan the in-tab draft (this bit the "share while guest"
    // flow). If the guest draft has actual content, route into the editor's adopt path (below),
    // which imports it into this account; otherwise land on home as usual.
    const adoptGuest = !!readGuestDraftText();
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
    // Desktop LOCAL accounts have no engine, so client.js can't reconcile them — rebuild IDB from the
    // durable appdata .oodbo files here (Google/cloud accounts are reconciled inside initSync via the
    // sidecar adapter). An IDB wipe / fresh profile isn't data loss.
    if (IS_TAURI && !me.provider) {
      try { const { recoverAppDataToIdb } = await import('./lib/desktopReconcile.js'); await recoverAppDataToIdb(me.email); } catch {}
    }
    await runMigration();
    await getEngine()?.sweepAll();
    setInitialSyncing(false);
    if (adoptGuest) { setOpenProjectId('adopt-guest'); setNewProjectType(null); setView('editor'); }
  }

  async function handleProviderSignIn(hint) {
    let u;
    try {
      // Pre-select an account so resuming is one click, no chooser: an explicit email hint (from the
      // desktop picker row), else the last account from a prior session. Guard the type — the web
      // "sign in" button is wired onClick={onSignIn}, which would otherwise pass a click EVENT as the
      // hint; Google then calls .trim() on it and throws ("c.trim is not a function").
      let h = (typeof hint === 'string' && hint) ? hint : null;
      if (!h) { try { h = JSON.parse(localStorage.getItem('fwd:user') || 'null')?.email || null; } catch {} }
      u = await providerSignIn(h || undefined);   // { provider: 'google', email }
    } catch (e) {
      console.warn('sign-in cancelled/failed:', e);
      return;
    }
    await enterSignedIn(u);
  }
  async function handleSignOut() {
    try { await providerSignOut(); } catch (err) { console.warn('sign-out error:', err); }
    localStorage.removeItem('fwd:user');
    clearVaultKey();   // drop any PIN-unlocked data key so the next account starts locked
    if (IS_TAURI) {
      // Desktop machines hold multiple isolated accounts; NEVER global-wipe on sign-out — it would
      // destroy the other accounts' local data (incl. local-only accounts with no cloud copy to
      // re-pull). Just drop the session + engine; the owner filter keeps accounts separate.
      teardownSync();
    } else {
      await clearLocalSession();   // web: wipe this account's local data (cloud re-pulls on next sign-in)
    }
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
      <div style={sLoading.page} data-scheme={scheme} className="crt-scanlines crt-vignette">
        <div style={sLoading.header}>
          <span style={sLoading.logo}>FORWARD&nbsp;ONLY</span>
          <p style={sLoading.msg}>Syncing your projects…</p>
        </div>
        <blockquote style={sLoading.quote}>
          <p style={sLoading.quoteText}>“{syncQuote.text}”</p>
          <footer style={sLoading.quoteAttr}>{syncQuote.attr}</footer>
        </blockquote>
      </div>
    );
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

  // Desktop has NO guest mode — show the login gate (Google, or a local account).
  if (IS_TAURI) {
    return (
      <React.Suspense fallback={null}>
        <DesktopLogin onGoogle={handleProviderSignIn} onEnter={enterSignedIn} />
      </React.Suspense>
    );
  }

  // Web — guest: open straight into the editor (ephemeral, no login wall).
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

const sLoading = {
  page: {
    position: 'relative',
    minHeight: '100vh',
    background: 'var(--bg)',
    color: 'var(--tx)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--fm)',
    padding: '0 28px',
    boxSizing: 'border-box',
  },
  // Wordmark + "Syncing…" cluster — lifted above centre so the quote reads as central.
  header: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 10,
    marginBottom: 'clamp(36px, 8vh, 72px)',
  },
  logo: {
    fontFamily: 'var(--fd)',
    fontSize: 28,
    letterSpacing: '0.14em',
    color: 'var(--ph)',
    textShadow: 'var(--glow)',
  },
  msg: {
    fontSize: 12,
    color: 'var(--tx-dim)',
    letterSpacing: '0.05em',
    margin: 0,
  },
  quote: {
    margin: 0,
    maxWidth: 560,
    textAlign: 'center',
  },
  quoteText: {
    margin: 0,
    fontFamily: 'var(--fm)',
    fontSize: 'clamp(17px, 4.2vw, 22px)',
    lineHeight: 1.6,
    color: 'var(--tx)',
    textShadow: 'var(--glow)',
  },
  quoteAttr: {
    marginTop: 18,
    fontSize: 13,
    letterSpacing: '0.05em',
    color: 'var(--tx-faint)',
  },
};
