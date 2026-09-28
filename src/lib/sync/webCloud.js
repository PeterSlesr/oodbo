// ── Web cloud layer: the engine's direct line to Google Drive (no server) ─────────
//
// The "unplugged" replacement for cloud.js. Same 7+ method contract (list/load/save/trash/
// restore/head/remove/removeMany/readTombstones) and the same typed outcomes
// (CloudAuthError/Transient/Quota, {notFound}, {precondition}) — but talks DIRECTLY to
// Google Drive's hidden appDataFolder with the LOCAL provider token, no /api/storage hop.
// A Google-only port of the proven desktopCloud.js Google branches (minus the Tauri glue);
// the engine, decision table, fork and migration never learn which cloud they got.
//
// `getToken` is injected (async → a valid Google access token) — exactly what
// providerSession.getValidProviderAccessToken supplies. Microsoft/OneDrive is deferred
// (it needs MSAL + a content-fetch path); this module handles Google Drive only for now.

import { CloudAuthError, CloudTransientError, CloudQuotaError } from './cloud.js';

const TIMEOUT_MS = 10_000;
const GDRIVE   = 'https://www.googleapis.com/drive/v3';
const GUP      = 'https://www.googleapis.com/upload/drive/v3';
const MANIFEST = 'tombstones.json';

const nameOf = (projectId, trashed) => `${projectId}.${trashed ? 'trash' : 'oodbo'}`;

// Non-2xx → typed error, except 404/412 which are control-flow the caller interprets (§10).
function classify(status) {
  if (status === 401) throw new CloudAuthError();
  if (status === 403) throw new CloudQuotaError();
  if (status === 404 || status === 412) return;
  throw new CloudTransientError(`http-${status}`);
}

// Bounded fetch; a network failure/timeout is the connectivity signal (§4) → CloudTransientError.
async function pf(url, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  catch (e) { throw new CloudTransientError(e?.name === 'AbortError' ? 'timeout' : `network:${e?.message || e}`); }
  finally { clearTimeout(timer); }
}

// A valid auth header, or the right typed error. A getToken() failure means the silent
// refresh needs the user → CloudAuthError (the engine surfaces "reconnect").
async function authHeaderFrom(getToken) {
  let accessToken;
  try { accessToken = await getToken(); }
  catch { throw new CloudAuthError(); }
  if (!accessToken) throw new CloudTransientError('no-token');
  return { Authorization: `Bearer ${accessToken}` };
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
async function rename(auth, projectId, action, xml) {
  const fromName = nameOf(projectId, action !== 'trash');   // trash: from .oodbo; restore: from .trash
  const toName   = nameOf(projectId, action === 'trash');
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

// ── Purge tombstones (§9 ext) — one tombstones.json in the SAME appDataFolder ─────
// Drive has no compare-and-swap on write → one read-modify-write per purge op (never N
// concurrent, which clobber to the last writer). Same manifest the desktop build writes,
// so a purge on any device/platform is honored everywhere.
async function driveReadManifest(auth) {
  const found = await gFind(auth, MANIFEST);
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
  const metadata  = JSON.stringify({ name: MANIFEST, parents: ['appDataFolder'] });
  const multipart = `--boundary\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--boundary\r\nContent-Type: application/json\r\n\r\n${body}\r\n--boundary--`;
  const r = await pf(`${GUP}/files?uploadType=multipart&fields=id`,
    { method: 'POST', headers: { ...auth, 'Content-Type': 'multipart/related; boundary=boundary' }, body: multipart });
  if (!r.ok) classify(r.status);
}

async function appendTombstones(auth, projectIds) {
  const toAdd = [...new Set((projectIds || []).filter(Boolean))];
  if (!toAdd.length) return;
  const { ids, fileId } = await driveReadManifest(auth);
  const merged = [...new Set([...ids, ...toAdd])];
  if (merged.length === ids.length) return;   // all already present
  await driveWriteManifest(auth, fileId, merged);
}

export function createWebCloud({ getToken }) {
  if (typeof getToken !== 'function') throw new Error('createWebCloud requires a getToken() function');
  return {
    async list() {
      const auth = await authHeaderFrom(getToken);
      const r = await pf(`${GDRIVE}/files?spaces=appDataFolder&fields=files(id,name,modifiedTime,headRevisionId)`, { headers: auth });
      if (!r.ok) classify(r.status);
      const { files: fs } = await r.json();
      const files = (fs || []).filter(f => /\.(oodbo|trash)$/.test(f.name)).map(f => ({
        projectId: f.name.replace(/\.(oodbo|trash)$/, ''), rev: f.headRevisionId,
        trashed: f.name.endsWith('.trash'), modifiedTime: f.modifiedTime,
      }));
      // Collapse Drive dup names to newest per (project, state) — matches desktopCloud/api.
      const newest = new Map();
      for (const f of files) {
        const k = f.projectId + (f.trashed ? '.t' : '.o');
        const p = newest.get(k);
        if (!p || (f.modifiedTime || '') > (p.modifiedTime || '')) newest.set(k, f);
      }
      return [...newest.values()];
    },

    async load(projectId) {
      const auth = await authHeaderFrom(getToken);
      for (const trashed of [false, true]) {
        const hit = await gFind(auth, nameOf(projectId, trashed));
        if (!hit) continue;
        const r = await pf(`${GDRIVE}/files/${hit.id}?alt=media`, { headers: auth });
        if (!r.ok) { classify(r.status); return { notFound: true }; }
        return { xml: await r.text(), rev: hit.headRevisionId };
      }
      return { notFound: true };
    },

    // Drive ignores ifMatch server-side (no conditional media write); the engine uses
    // pending-verify instead, so we accept and ignore the option for contract parity.
    async save(projectId, xml, { ifMatch } = {}) {   // eslint-disable-line no-unused-vars
      const auth = await authHeaderFrom(getToken);
      const name = `${projectId}.oodbo`;
      const existing = await gFind(auth, name);       // newest wins
      if (existing) {
        const r = await pf(`${GUP}/files/${existing.id}?uploadType=media&fields=headRevisionId`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/xml' }, body: xml });
        if (!r.ok) classify(r.status);
        return { ok: true, rev: (await r.json()).headRevisionId };
      }
      const r = await pf(`${GUP}/files?uploadType=multipart&fields=headRevisionId`, { method: 'POST', headers: { ...auth, 'Content-Type': 'multipart/related; boundary=b' }, body: gMultipart(name, xml) });
      if (!r.ok) classify(r.status);
      return { ok: true, rev: (await r.json()).headRevisionId };
    },

    async trash(projectId, xml) { const auth = await authHeaderFrom(getToken); return rename(auth, projectId, 'trash', xml); },
    async restore(projectId)    { const auth = await authHeaderFrom(getToken); return rename(auth, projectId, 'restore'); },

    async head(projectId) {
      const files = await this.list();
      const f = files.find(x => x.projectId === projectId && !x.trashed);
      return f ? { exists: true, rev: f.rev, trashed: false } : { exists: false };
    },

    async remove(projectId) {
      const auth = await authHeaderFrom(getToken);
      // Delete EVERY copy across both extensions (Drive dup names) — matches desktopCloud.
      for (const trashed of [false, true]) {
        let hit;
        while ((hit = await gFind(auth, nameOf(projectId, trashed)))) {
          const r = await pf(`${GDRIVE}/files/${hit.id}`, { method: 'DELETE', headers: auth });
          if (!r.ok && r.status !== 404) { classify(r.status); break; }
        }
      }
      await appendTombstones(auth, [projectId]);
      return { ok: true };
    },

    async removeMany(projectIds) {
      const ids = [...new Set((projectIds || []).filter(Boolean))];
      if (!ids.length) return { ok: true };
      const auth = await authHeaderFrom(getToken);
      for (const projectId of ids) {
        for (const trashed of [false, true]) {
          let hit;
          while ((hit = await gFind(auth, nameOf(projectId, trashed)))) {
            const r = await pf(`${GDRIVE}/files/${hit.id}`, { method: 'DELETE', headers: auth });
            if (!r.ok && r.status !== 404) { classify(r.status); break; }
          }
        }
      }
      await appendTombstones(auth, ids);         // single manifest write for the whole batch
      return { ok: true };
    },

    async readTombstones(knownRev) {
      const auth = await authHeaderFrom(getToken);
      const found = await gFind(auth, MANIFEST);
      const rev = found?.headRevisionId || null;
      if (rev && knownRev && rev === knownRev) return { rev, unchanged: true };
      const full = found ? await driveReadManifest(auth) : { rev: null, ids: [] };
      return { rev: full.rev, ids: full.ids };
    },
  };
}
