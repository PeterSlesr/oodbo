import { supabase } from './supabase.js';

// Returns the user object on success.
// Returns { _unauthorized: true } if the server explicitly rejects the token (401).
// Returns null on network/server error (caller may use cached data for offline support).
export async function getMe(token) {
  try {
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.status === 401) return { _unauthorized: true };
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function acceptShareTos(token) {
  try {
    const res = await fetch('/api/share', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch { return false; }
}

export async function signOut() {
  try {
    await supabase.auth.signOut();
  } catch (err) {
    console.warn('Sign-out error:', err);
  }
  try { sessionStorage.removeItem('fwd:session'); } catch {}
}
