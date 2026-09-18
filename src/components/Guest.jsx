import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import Editor from './Editor.jsx';

// Guest mode — zero-friction, fully ephemeral writing at /guest.
// Renders the real Editor with guest persistence (sessionStorage only, see
// guestStore). A guest is unauthenticated (user = null), so the Editor's
// existing !user gating already hides sync/share/export; the `guest` prop
// swaps persistence to sessionStorage and enables guest-specific chrome.
export default function Guest() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Authenticated users don't get guest mode — send them to their workspace.
      // Mirror App's own resolution: an untrusted-device JWT lives in
      // sessionStorage; OAuth / trusted-device sessions live in Supabase.
      const { data } = await supabase.auth.getSession();
      const hasSession = !!data?.session || !!sessionStorage.getItem('fwd:session');
      if (cancelled) return;
      if (hasSession) {
        // replace() so /guest isn't left in history for a signed-in user
        window.location.replace('/');
        return;
      }
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!ready) return null;

  return (
    <Editor
      guest
      user={null}
      jumpTarget={{ mode: 'focus' }}
      onSignIn={() => { window.location.href = '/?signup=1'; }}
      onSignOut={() => {}}
      onGoHome={null}
    />
  );
}
