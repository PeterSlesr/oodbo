import { createClient } from '@supabase/supabase-js';

// Trust-aware session persistence.
// By DEFAULT the supabase session persists in localStorage (survives a browser restart) — unchanged for
// trusted OAuth, magic-link, and the Word add-in. But when the user picks "No, sign me out when I close
// the browser", handleTrust sets `fwd:session-only`, and from then on the session is stored ONLY in
// sessionStorage, which the browser wipes on close. supabase-js still auto-refreshes it (into
// sessionStorage), so it works while the tab is open but CANNOT survive a close and is never re-persisted
// to localStorage against the user's choice. removeItem clears both stores so sign-out is thorough.
const sessionOnly = () => { try { return sessionStorage.getItem('fwd:session-only') === '1'; } catch { return false; } };

const trustAwareStorage = {
  getItem:    (k)    => { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch { return null; } },
  setItem:    (k, v) => { try { if (sessionOnly()) { sessionStorage.setItem(k, v); localStorage.removeItem(k); } else { localStorage.setItem(k, v); } } catch {} },
  removeItem: (k)    => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
};

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co',
  import.meta.env.VITE_SUPABASE_ANON_KEY || 'placeholder-anon-key',
  { auth: { storage: trustAwareStorage, persistSession: false, autoRefreshToken: false } },
);
