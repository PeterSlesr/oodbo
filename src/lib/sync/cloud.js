// ── Cloud network layer: the engine's only door to /api/storage ─────────────────
//
// Platform-agnostic by construction (spec §14): both web and desktop hit the same
// serverless endpoints, which reach Google Drive / OneDrive server-side. This module
// owns connectivity, timeouts, auth-token attachment, and HTTP error classification —
// so the decision table and engine deal in typed outcomes, never raw fetch.
//
// Connectivity model (§4): there is no isOnline boolean. The sync attempt IS the check —
// a failed request means offline for the endpoint that matters. Every call is bounded by
// a 10 s AbortController so a captive portal can never hang a sweep.
//
// Auth / headless refresh (§10): `getToken` is injected (async, returns the current
// Supabase access token or null). The server refreshes the *provider* token headlessly
// via its stored refresh token and returns 401 `needs_reauth:true` only when that refresh
// token is revoked. We map:
//   401 + needs_reauth   → CloudAuthError immediately (retry can't help; stop this provider)
//   401 (plain)          → one silent getToken() + retry (covers a mid-refresh Supabase JWT);
//                          still 401 → CloudAuthError (e.g. an untrusted-device JWT that
//                          cannot refresh headlessly — the one silent degrade)
//   403                  → CloudQuotaError (keep local intact, per-project notice)
//   5xx / 429 / network / timeout → CloudTransientError (stay dirty, back off, retry)
//   404 (load/trash)     → returned as { notFound:true } — caller routes to T5
//   412 (OneDrive save)  → returned as { precondition:true } — caller routes to row 4
// Only expected-control-flow statuses (404/412) are returned; everything abnormal throws
// a typed error the engine's error table (§10) switches on.

export class CloudAuthError      extends Error { constructor(m = 'reconnect')  { super(m); this.name = 'CloudAuthError'; } }
export class CloudTransientError extends Error { constructor(m = 'transient')  { super(m); this.name = 'CloudTransientError'; } }
export class CloudQuotaError     extends Error { constructor(m = 'quota')      { super(m); this.name = 'CloudQuotaError'; } }

const DEFAULT_TIMEOUT_MS = 10_000;

export function createCloud({ getToken, fetchImpl = globalThis.fetch, base = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof getToken !== 'function') throw new Error('createCloud requires a getToken() function');

  async function safeJson(res) { try { return await res.json(); } catch { return null; } }

  // One bounded network attempt with the token attached. Any thrown network error
  // (including an abort/timeout) becomes a CloudTransientError so the engine backs off.
  async function attempt(path, options, token) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetchImpl(base + path, {
        ...options,
        signal: ac.signal,
        headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
      });
    } catch (e) {
      throw new CloudTransientError(e?.name === 'AbortError' ? 'timeout' : `network:${e?.message || e}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // Attach auth, run the request, apply the §10 status→outcome mapping. Returns the raw
  // Response for 2xx/404/412 (callers interpret those); throws typed errors otherwise.
  async function request(path, options = {}) {
    const token = await getToken();
    if (!token) throw new CloudTransientError('no-session');  // supabase mid-init → retry later

    let res = await attempt(path, options, token);

    if (res.status === 401) {
      const body = await safeJson(res);
      if (body?.needs_reauth) throw new CloudAuthError();      // provider refresh revoked — no retry
      const token2 = await getToken();                         // silent Supabase refresh (trusted device)
      if (!token2) throw new CloudTransientError('no-session');
      res = await attempt(path, options, token2);
      if (res.status === 401) throw new CloudAuthError();      // unrecoverable headlessly
    }
    if (res.status === 403) throw new CloudQuotaError();
    if (res.status === 429 || res.status >= 500) throw new CloudTransientError(`http-${res.status}`);
    return res;
  }

  return {
    // List every .oodbo/.trash with its rev (Drive headRevisionId / OneDrive eTag) and,
    // for OneDrive, cTag. The batch-detection input (§7).
    async list() {
      const res = await request('/api/storage', { method: 'GET' });
      const { files } = await res.json();
      return files || [];
    },

    // Download content + revs. 404 → { notFound:true } (routes to T5, not an error).
    async load(projectId) {
      const res = await request(`/api/storage?projectId=${encodeURIComponent(projectId)}`, { method: 'GET' });
      if (res.status === 404) return { notFound: true };
      const { xml, rev, cTag } = await res.json();
      return { xml, rev, cTag };
    },

    // Create/update. Pass ifMatch (OneDrive eTag) for a conditional write; a 412 comes
    // back as { precondition:true } → the engine treats it as row 4. Drive ignores ifMatch
    // server-side (no conditional media write; the engine uses pending-verify instead).
    async save(projectId, xml, { ifMatch } = {}) {
      const res = await request('/api/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, xml, ...(ifMatch ? { ifMatch } : {}) }),
      });
      if (res.status === 412) return { precondition: true };
      const { rev, cTag } = await res.json();
      return { ok: true, rev, cTag };
    },

    // Rename .oodbo → .trash (xml lets the server create-as-trash when the file was never
    // uploaded — offline create then delete). restore does the reverse.
    async trash(projectId, xml) {
      const res = await request('/api/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, action: 'trash', ...(xml ? { xml } : {}) }),
      });
      if (res.status === 404) return { notFound: true };
      return { ok: true };
    },
    async restore(projectId) {
      const res = await request('/api/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, action: 'restore' }),
      });
      if (res.status === 404) return { notFound: true };
      return { ok: true };
    },

    // Cheap metadata-only lookup for ONE project (rev/cTag/trashed) via the folder
    // listing — no content download. Used by the Drive push's pre-check / immediate-verify
    // / delayed-confirm (§5.2) and the 5-min rev check (§6). Returns { exists:false } if gone.
    async head(projectId) {
      const res = await request('/api/storage', { method: 'GET' });
      const { files } = await res.json();
      const f = (files || []).find(x => x.projectId === projectId && !x.trashed);
      return f ? { exists: true, rev: f.rev, cTag: f.cTag, trashed: false } : { exists: false };
    },

    // Terminal delete (only ever from trash state, per §9). The server also records the id in
    // the tombstone manifest as part of this call, so the purge is durable across devices.
    async remove(projectId) {
      await request(`/api/storage?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      return { ok: true };
    },

    // Bulk permanent delete (§9 ext). One request removes every project's files AND writes all
    // their tombstones in a SINGLE manifest read-modify-write — emptying a bin must not fan out
    // to N concurrent DELETEs, which would race the manifest and lose most tombstones.
    async removeMany(projectIds) {
      await request('/api/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'purge', projectIds }),
      });
      return { ok: true };
    },

    // Read the purge-tombstone manifest, rev-gated (§9 ext). Pass the last-seen rev; the server
    // returns { rev, unchanged:true } when nothing changed (no content download) or { rev, ids }.
    // ids are the projectIds that were permanently deleted — honored so they can't resurrect.
    async readTombstones(knownRev) {
      const q = knownRev ? `?tombstones=1&knownRev=${encodeURIComponent(knownRev)}` : '?tombstones=1';
      const res = await request('/api/storage' + q, { method: 'GET' });
      return await res.json();   // { rev, unchanged } | { rev, ids }
    },
  };
}
