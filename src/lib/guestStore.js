// sessionStorage-only persistence for guest mode.
//
// One ephemeral draft, per browser tab. Guest content must NEVER touch
// localStorage, IndexedDB, or the server — sessionStorage is destroyed on
// tab close, which is the whole privacy premise of guest mode. Do not
// "improve" this with localStorage/IDB persistence.
export const GUEST_DRAFT_KEY = 'oodbo.guest.draft';

// Returns the guest draft as a one-element array (matching the Editor's
// projects-array shape), or [] when nothing is stored.
export function loadGuestDraft() {
  try {
    const raw = sessionStorage.getItem(GUEST_DRAFT_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw);
    return p ? [p] : [];
  } catch {
    return [];
  }
}

// Accepts a single project or an array (guest has exactly one draft).
// Strips transient/identity fields that have no place in an ephemeral draft.
export function saveGuestDraft(projectOrArray) {
  const p = Array.isArray(projectOrArray) ? projectOrArray[0] : projectOrArray;
  if (!p) return;
  try {
    const { wordAssets: _omit, owner: _owner, ...clean } = p;
    sessionStorage.setItem(GUEST_DRAFT_KEY, JSON.stringify(clean));
  } catch {}
}

export function clearGuestDraft() {
  try { sessionStorage.removeItem(GUEST_DRAFT_KEY); } catch {}
}

// Full text of the stored guest draft (all sections joined), or '' if none.
// Used by the auth screen to let a signing-up guest copy their writing —
// reads sessionStorage directly, never sent to any endpoint.
export function readGuestDraftText() {
  try {
    const raw = sessionStorage.getItem(GUEST_DRAFT_KEY);
    if (!raw) return '';
    const p = JSON.parse(raw);
    return (p?.chapters || []).map(ch => ch.content || '').join('\n\n').trim();
  } catch {
    return '';
  }
}
