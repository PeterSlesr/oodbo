// ── Public share (Option A): a link to a file in the user's OWN visible Drive ─────
//
// No server, no viewer of ours. On publish we drop a file into the user's *visible* Drive
// (drive.file scope — only files this app creates), mark it "anyone with the link: reader",
// and hand back the plain Google Drive link. The reader opens it in Google's own viewer, so
// oodbo never hosts, stores, or serves the content — it's the user's file, in the user's
// Drive, served by Google. Proven end-to-end in public/spikeshare.html.
//
// `getShareToken` is injected (providerSession.getShareAccessToken) so this module stays a
// pure network helper the UI can call.

const GDRIVE = 'https://www.googleapis.com/drive/v3';
const GUP    = 'https://www.googleapis.com/upload/drive/v3';

// Public browser API key (restricted by referrer + to the Drive API). Safe to ship; it only
// lets the /s/<id> viewer read files that are already "anyone with the link".
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY || 'AIzaSyAF75R_JR7siWtcL7SIO5BLDIXrZH4zEwI';

// Anonymous read of a public share snapshot — the /s/<id> viewer's data source. No sign-in:
// only the API key, which works because the file is shared "anyone with the link" (proven spike).
export async function fetchPublicSnapshot(fileId) {
  const res = await fetch(`${GDRIVE}/files/${encodeURIComponent(fileId)}?alt=media&key=${API_KEY}`);
  if (!res.ok) throw new Error(`share fetch ${res.status}`);
  return res.json();
}

// The Drive location a shared file physically lives at — shown on the viewer for transparency
// ("Hosted at …"), so it's clear the content sits in the writer's own Drive, not on our site.
export function driveViewUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

async function must(res, what) {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res;
}

// Publish `blob` as a public file named `name` in the user's visible Drive.
// Returns { fileId, url } — url is the shareable Google Drive link.
export async function publishShare({ getShareToken, name, blob, mimeType = 'application/pdf' }) {
  const token = await getShareToken();
  const auth = { Authorization: `Bearer ${token}` };

  // 1) Create the file's metadata in visible Drive (no parents ⇒ "My Drive" root).
  const created = await must(await fetch(`${GDRIVE}/files?fields=id`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }), 'create').then(r => r.json());
  const fileId = created.id;

  // 2) Upload the actual bytes (binary-safe: send the Blob as the raw media body).
  await must(await fetch(`${GUP}/files/${fileId}?uploadType=media`, {
    method: 'PATCH', headers: { ...auth, 'Content-Type': mimeType }, body: blob,
  }), 'upload');

  // 3) Make it readable by anyone with the link.
  await must(await fetch(`${GDRIVE}/files/${fileId}/permissions`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  }), 'make-public');

  // 4) Get the shareable link.
  const meta = await must(await fetch(`${GDRIVE}/files/${fileId}?fields=webViewLink`, { headers: auth }), 'get-link')
    .then(r => r.json());

  return { fileId, url: meta.webViewLink };
}

// Unpublish: delete the shared file from the user's Drive (kills the link). 404 is fine
// (already gone). The user can also do this manually from their own Drive.
export async function unpublishShare({ getShareToken, fileId }) {
  const token = await getShareToken();
  const res = await fetch(`${GDRIVE}/files/${fileId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`unpublish failed: ${res.status}`);
  return { ok: true };
}
