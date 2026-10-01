// ── Desktop cloud layer: the engine's `cloud` dependency for the native-OAuth tier ──────────
//
// Same 7-method contract as cloud.js (list/load/save/trash/restore/head/remove) and the same typed
// outcomes (CloudAuthError/Transient/Quota, {notFound}, {precondition}) — but talks DIRECTLY to
// Google Drive appDataFolder / Microsoft Graph approot with the LOCALLY-HELD provider token, no
// /api/storage server hop. This is the desktop half of §14 seam #1; the engine, decision table,
// fork and trash logic never learn which cloud they got.
//
// Surfaces the revs the engine needs (mirrors api/storage.js's current logic, ported client-side):
//   Drive:    rev = headRevisionId (detection); no cTag; ignores If-Match (pending-verify covers it).
//   OneDrive: rev = eTag (If-Match CAS token); cTag = content tag (detection); If-Match → 412.
// Also mirrors: newest-dup collapse (Drive allows same-name files) and delete-EVERY-copy on remove.

import { invoke } from '@tauri-apps/api/core';
import { CloudAuthError, CloudTransientError, CloudQuotaError } from './sync/cloud.js';
import { getValidProviderToken } from './desktopOAuth.js';

const TIMEOUT_MS = 10_000;
const GDRIVE = 'https://www.googleapis.com/drive/v3';
const GUP    = 'https://www.googleapis.com/upload/drive/v3';
const GRAPH  = 'https://graph.microsoft.com/v1.0/me/drive';

const nameOf = (projectId, trashed) => `${projectId}.${trashed ? 'trash' : 'oodbo'}`;

// Non-2xx → typed error, except 404/412 which are control-flow the caller interprets (§10).
function classify(status) {
  if (status === 401) throw new CloudAuthError();
  if (status === 403) throw new CloudQuotaError();
  if (status === 404 || status === 412) return;
  throw new CloudTransientError(`http-${status}`);
}

// A valid provider token, or the right typed error (§4/§10).
async function token() {
  try { return await getValidProviderToken(); }   // { provider, accessToken, ... }
  catch (err) {
    if (err.message === 'needs_reauth' || err.message === 'no-provider-session') throw new CloudAuthError();
    throw new CloudTransientError(`token:${err.message}`);
  }
}

// Bounded fetch; a network failure/timeout is the connectivity signal (§4) → CloudTransientError.
async function pf(url, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  catch (e) { throw new CloudTransientError(e?.name === 'AbortError' ? 'timeout' : `network:${e?.message || e}`); }
  finally { clearTimeout(timer); }
}

// OneDrive file content, fetched in Rust to bypass the WebView CSP. Graph's /content 302-redirects
// to a Microsoft download host outside connect-src, so a webview fetch() is blocked ("Failed to
// fetch") — this is why OneDrive pull silently failed while Google (served from the allow-listed
// googleapis.com, no off-host redirect) worked. Returns the body text, or null for 404 (notFound);
// 401/403/5xx map through classify() to the same typed cloud errors; network → transient.
async function azureContentGet(url, accessToken) {
  try {
    return await invoke('azure_graph_get', { url, token: accessToken });
  } catch (e) {
    const m = String(e || '').match(/status:(\d+)/);
    if (m) { classify(Number(m[1])); return null; }   // classify throws 401/403/5xx; returns (→ null) for 404/412
    throw new CloudTransientError(`azure-content:${e}`);
  }
}

// Find a Google file (id + headRevisionId) by exact name — NEWEST wins (Drive allows dup names).
async function gFind(auth, name) {
  const r = await pf(`${GDRIVE}/files?spaces=appDataFolder&q=name%3D'${name}'&fields=files(id,headRevisionId,modifiedTime)`, { headers: auth });
  if (!r.ok) { classify(r.status); return null; }
  const { files } = await r.json();
  if (!files?.length) return null;
  return files.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''))[0];
}

const gMultipart = (name, xml) =>
  `--b\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n--b\r\nContent-Type: application/xml\r\n\r\n${xml}\r\n--b--`;

// Rename .oodbo↔.trash. `xml` lets trash create-as-.trash when the file was never uploaded
// (offline create then delete). Returns {notFound} when there's nothing to rename and no xml.
async function rename(provider, accessToken, projectId, action, xml) {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const fromName = nameOf(projectId, action !== 'trash');   // trash: from .oodbo; restore: from .trash
  const toName   = nameOf(projectId, action === 'trash');
  if (provider === 'google') {
    const hit = await gFind(auth, fromName);
    if (hit) {
      const r = await pf(`${GDRIVE}/files/${hit.id}`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: toName }) });
      if (!r.ok) classify(r.status);
      return { ok: true };
    }
    if (action === 'trash' && xml) {
      const r = await pf(`${GUP}/files?uploadType=multipart`, { method: 'POST', headers: { ...auth, 'Content-Type': 'multipart/related; boundary=b' }, body: gMultipart(toName, xml) });
      if (!r.ok) classify(r.status);
      return { ok: true };
    }
    return { notFound: true };
  }
  const meta = await pf(`${GRAPH}/special/approot:/${fromName}?$select=id`, { headers: auth });
  if (meta.ok) {
    const { id } = await meta.json();
    const r = await pf(`${GRAPH}/items/${id}`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: toName }) });
    if (!r.ok) classify(r.status);
    return { ok: true };
  }
  if (meta.status === 404 && action === 'trash' && xml) {
    const r = await pf(`${GRAPH}/special/approot:/${toName}:/content`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/xml' }, body: xml });
    if (!r.ok) classify(r.status);
    return { ok: true };
  }
  if (meta.status === 404) return { notFound: true };
  classify(meta.status);
}

// ── Purge tombstones (§9 ext) — the desktop half of api/storage/_tombstones.js ─────────────────
// A single `tombstones.json` in the SAME cloud folder as the .oodbo files holds the ids of
// permanently-deleted projects, so a device that only sees a project's absence can tell "purged on
// purpose" from "missing" and honor the delete instead of resurrecting it. Ported 1:1 from the
// server helper (which web reaches via /api/storage) so that web and desktop share ONE manifest per
// cloud account: either platform's purge appends to it, and both honor it on sweep. Drive has no
// compare-and-swap on the write → one read-modify-write per purge OP (never N concurrent, which
// clobber to the last writer); OneDrive uses If-Match and retries on 412.
const MANIFEST = 'tombstones.json';

async function driveReadManifest(auth) {
  const found = await gFind(auth, MANIFEST);              // newest wins (dup names); { id, headRevisionId } | null
  if (!found) return { rev: null, ids: [], fileId: null };
  const r = await pf(`${GDRIVE}/files/${found.id}?alt=media`, { headers: auth });
  if (!r.ok) { classify(r.status); return { rev: found.headRevisionId, ids: [], fileId: found.id }; }
  let ids = []; try { ids = (JSON.parse(await r.text())?.ids) || []; } catch { ids = []; }
  return { rev: found.headRevisionId, ids, fileId: found.id };
}

async function driveWriteManifest(auth, fileId, ids) {
  const body = JSON.stringify({ ids });
  if (fileId) {
    const r = await pf(`${GUP}/files/${fileId}?uploadType=media&fields=id,headRevisionId`,
      { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body });
    if (!r.ok) classify(r.status);
    return;
  }
  const metadata = JSON.stringify({ name: MANIFEST, parents: ['appDataFolder'] });
  const multipart = `--boundary\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--boundary\r\nContent-Type: application/json\r\n\r\n${body}\r\n--boundary--`;
  const r = await pf(`${GUP}/files?uploadType=multipart&fields=id`,
    { method: 'POST', headers: { ...auth, 'Content-Type': 'multipart/related; boundary=boundary' }, body: multipart });
  if (!r.ok) classify(r.status);
}

async function azureReadManifest(auth) {
  const meta = await pf(`${GRAPH}/special/approot:/${MANIFEST}?$select=id,eTag`, { headers: auth });
  if (meta.status === 404) return { rev: null, ids: [], eTag: null };
  if (!meta.ok) { classify(meta.status); return { rev: null, ids: [], eTag: null }; }
  const { id, eTag } = await meta.json();
  const accessToken = (auth.Authorization || '').replace(/^Bearer /, '');
  const text = await azureContentGet(`${GRAPH}/items/${id}/content`, accessToken);  // via Rust (CSP bypass)
  if (text == null) return { rev: eTag, ids: [], eTag };
  let ids = []; try { ids = (JSON.parse(text)?.ids) || []; } catch { ids = []; }
  return { rev: eTag, ids, eTag };
}

async function azureWriteManifest(auth, eTag, ids) {
  const headers = { ...auth, 'Content-Type': 'application/json' };
  if (eTag) headers['If-Match'] = eTag;                   // conditional so a concurrent purge can't clobber
  const r = await pf(`${GRAPH}/special/approot:/${MANIFEST}:/content`,
    { method: 'PUT', headers, body: JSON.stringify({ ids }) });
  if (r.status === 412) return { precondition: true };
  if (!r.ok) classify(r.status);
  return { ok: true };
}

// Add ids to the manifest in a single read-modify-write (idempotent). ONE call per purge op.
async function appendTombstones(provider, auth, projectIds) {
  const toAdd = [...new Set((projectIds || []).filter(Boolean))];
  if (!toAdd.length) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (provider === 'google') {
      const { ids, fileId } = await driveReadManifest(auth);
      const merged = [...new Set([...ids, ...toAdd])];
      if (merged.length === ids.length) return;           // all already present
      await driveWriteManifest(auth, fileId, merged);      // Drive has no CAS; one RMW per op keeps it safe
      return;
    }
    const { ids, eTag } = await azureReadManifest(auth);   // azure (OneDrive)
    const merged = [...new Set([...ids, ...toAdd])];
    if (merged.length === ids.length) return;
    const res = await azureWriteManifest(auth, eTag, merged);
    if (res && res.precondition) continue;                 // concurrent op wrote first → re-read + retry
    return;
  }
}

export function createDesktopCloud() {
  return {
    async list() {
      const { provider, accessToken } = await token();
      const auth = { Authorization: `Bearer ${accessToken}` };
      let files = [];
      if (provider === 'google') {
        const r = await pf(`${GDRIVE}/files?spaces=appDataFolder&fields=files(id,name,modifiedTime,headRevisionId)`, { headers: auth });
        if (!r.ok) classify(r.status);
        const { files: fs } = await r.json();
        files = (fs || []).filter(f => /\.(oodbo|trash)$/.test(f.name)).map(f => ({
          projectId: f.name.replace(/\.(oodbo|trash)$/, ''), rev: f.headRevisionId,
          trashed: f.name.endsWith('.trash'), modifiedTime: f.modifiedTime,
        }));
      } else {
        const r = await pf(`${GRAPH}/special/approot/children?$select=id,name,eTag,cTag,lastModifiedDateTime`, { headers: auth });
        if (!r.ok) classify(r.status);
        const { value } = await r.json();
        files = (value || []).filter(f => /\.(oodbo|trash)$/.test(f.name)).map(f => ({
          projectId: f.name.replace(/\.(oodbo|trash)$/, ''), rev: f.eTag, cTag: f.cTag,
          trashed: f.name.endsWith('.trash'), modifiedTime: f.lastModifiedDateTime,
        }));
      }
      // Collapse Drive dup names to newest per (project, state) — matches api/storage.js.
      const newest = new Map();
      for (const f of files) { const k = f.projectId + (f.trashed ? '.t' : '.o'); const p = newest.get(k); if (!p || (f.modifiedTime || '') > (p.modifiedTime || '')) newest.set(k, f); }
      return [...newest.values()];
    },

    async load(projectId) {
      const { provider, accessToken } = await token();
      const auth = { Authorization: `Bearer ${accessToken}` };
      if (provider === 'google') {
        for (const trashed of [false, true]) {
          const hit = await gFind(auth, nameOf(projectId, trashed));
          if (!hit) continue;
          const r = await pf(`${GDRIVE}/files/${hit.id}?alt=media`, { headers: auth });
          if (!r.ok) { classify(r.status); return { notFound: true }; }
          return { xml: await r.text(), rev: hit.headRevisionId };
        }
        return { notFound: true };
      }
      for (const trashed of [false, true]) {
        const name = nameOf(projectId, trashed);
        const meta = await pf(`${GRAPH}/special/approot:/${name}?$select=id,eTag,cTag`, { headers: auth });
        if (meta.status === 404) continue;
        if (!meta.ok) { classify(meta.status); return { notFound: true }; }
        const m = await meta.json();
        const xml = await azureContentGet(`${GRAPH}/items/${m.id}/content`, accessToken);  // via Rust (CSP bypass)
        if (xml == null) return { notFound: true };
        return { xml, rev: m.eTag, cTag: m.cTag };
      }
      return { notFound: true };
    },

    async save(projectId, xml, { ifMatch } = {}) {
      const { provider, accessToken } = await token();
      const auth = { Authorization: `Bearer ${accessToken}` };
      const name = `${projectId}.oodbo`;
      if (provider === 'google') {
        const existing = await gFind(auth, name);   // newest wins — matches api/storage.js
        if (existing) {
          const r = await pf(`${GUP}/files/${existing.id}?uploadType=media&fields=headRevisionId`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/xml' }, body: xml });
          if (!r.ok) classify(r.status);
          return { ok: true, rev: (await r.json()).headRevisionId };
        }
        const r = await pf(`${GUP}/files?uploadType=multipart&fields=headRevisionId`, { method: 'POST', headers: { ...auth, 'Content-Type': 'multipart/related; boundary=b' }, body: gMultipart(name, xml) });
        if (!r.ok) classify(r.status);
        return { ok: true, rev: (await r.json()).headRevisionId };
      }
      // OneDrive: If-Match on eTag = CAS; 412 → precondition (row 4). Response carries eTag + cTag.
      const headers = { ...auth, 'Content-Type': 'application/xml', ...(ifMatch ? { 'If-Match': ifMatch } : {}) };
      const r = await pf(`${GRAPH}/special/approot:/${name}:/content`, { method: 'PUT', headers, body: xml });
      if (r.status === 412) return { precondition: true };
      if (!r.ok) classify(r.status);
      const m = await r.json();
      return { ok: true, rev: m.eTag, cTag: m.cTag };
    },

    async trash(projectId, xml) { const { provider, accessToken } = await token(); return rename(provider, accessToken, projectId, 'trash', xml); },
    async restore(projectId)    { const { provider, accessToken } = await token(); return rename(provider, accessToken, projectId, 'restore'); },

    async head(projectId) {
      const files = await this.list();
      const f = files.find(x => x.projectId === projectId && !x.trashed);
      return f ? { exists: true, rev: f.rev, cTag: f.cTag, trashed: false } : { exists: false };
    },

    async remove(projectId) {
      const { provider, accessToken } = await token();
      const auth = { Authorization: `Bearer ${accessToken}` };
      // Delete EVERY copy across both extensions (Drive dup names) — matches api/storage.js (0af93c5).
      if (provider === 'google') {
        for (const trashed of [false, true]) {
          let hit;
          while ((hit = await gFind(auth, nameOf(projectId, trashed)))) {
            const r = await pf(`${GDRIVE}/files/${hit.id}`, { method: 'DELETE', headers: auth });
            if (!r.ok && r.status !== 404) { classify(r.status); break; }
          }
        }
      } else {
        for (const trashed of [false, true]) {
          const r = await pf(`${GRAPH}/special/approot:/${nameOf(projectId, trashed)}`, { method: 'DELETE', headers: auth });
          if (!r.ok && r.status !== 404) classify(r.status);
        }
      }
      // Record the tombstone in the SAME cloud manifest the server writes, so a desktop-originated
      // purge is durable across devices exactly like a web one (was missing → resurrection bug).
      await appendTombstones(provider, auth, [projectId]);
      return { ok: true };
    },

    // Bulk permanent delete (§9 ext): remove every file, then ONE manifest read-modify-write for all
    // ids — emptying a bin must not fan out to N concurrent appends (Drive has no CAS → they clobber).
    async removeMany(projectIds) {
      const ids = [...new Set((projectIds || []).filter(Boolean))];
      if (!ids.length) return { ok: true };
      const { provider, accessToken } = await token();
      const auth = { Authorization: `Bearer ${accessToken}` };
      for (const projectId of ids) {
        if (provider === 'google') {
          for (const trashed of [false, true]) {
            let hit;
            while ((hit = await gFind(auth, nameOf(projectId, trashed)))) {
              const r = await pf(`${GDRIVE}/files/${hit.id}`, { method: 'DELETE', headers: auth });
              if (!r.ok && r.status !== 404) { classify(r.status); break; }
            }
          }
        } else {
          for (const trashed of [false, true]) {
            const r = await pf(`${GRAPH}/special/approot:/${nameOf(projectId, trashed)}`, { method: 'DELETE', headers: auth });
            if (!r.ok && r.status !== 404) classify(r.status);
          }
        }
      }
      await appendTombstones(provider, auth, ids);         // single manifest write for the whole batch
      return { ok: true };
    },

    // Read the purge-tombstone manifest, rev-gated (§9 ext). Same contract as cloud.js: pass the
    // last-seen rev; returns { rev, unchanged:true } when nothing changed (no content download),
    // else { rev, ids }. Reads the SAME cloud file the web server writes.
    async readTombstones(knownRev) {
      const { provider, accessToken } = await token();
      const auth = { Authorization: `Bearer ${accessToken}` };
      if (provider === 'google') {
        const found = await gFind(auth, MANIFEST);
        const rev = found?.headRevisionId || null;
        if (rev && knownRev && rev === knownRev) return { rev, unchanged: true };
        const full = found ? await driveReadManifest(auth) : { rev: null, ids: [] };
        return { rev: full.rev, ids: full.ids };
      }
      const full = await azureReadManifest(auth);          // azure (OneDrive)
      if (full.rev && knownRev && full.rev === knownRev) return { rev: full.rev, unchanged: true };
      return { rev: full.rev, ids: full.ids };
    },
  };
}
