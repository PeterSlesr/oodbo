// ── oodbo canonical model: the single source of truth for .oodbo serialization
// and for content hashing used by the sync engine.
//
// WHY THIS FILE EXISTS (read before touching):
// The sync engine detects conflicts by comparing a SHA-256 hash of a project's
// *content* against a stored ancestor hash. If two devices could serialize the
// same logical content to two different canonical forms, the hash would differ
// and the engine would manufacture a phantom conflict ("false dirt"). Historically
// `projectToXml`/`xmlToProject` were duplicated in Editor.jsx and App.jsx; two
// copies is two possible canonical forms. This module is the ONE serializer/parser
// both must use, and the ONE definition of what "content" means for hashing.
//
// The hash is computed over an explicit ALLOWLIST of fields (canonicalModel below),
// derived from exactly what serializeOodbo writes to the file, minus fields that are
// ephemeral UI state or otherwise must not trigger a sync (spec §3.4). Building an
// allowlist — rather than hashing the whole object — is deliberate: it guarantees a
// live-only field (e.g. `collapsed`, `wordAssets`) or a not-in-file field can never
// leak into the hash and diverge live-object vs pulled-from-cloud.
//
// Field classification (format v1), grounded in what the serializer emits. Deviates
// from spec §3.4 by owner decision: createdAt/updatedAt and `type` are NOT hashed.
//   HASHED:
//     project:    id, title, conflictOf (only when set — see canonicalModel)
//     chapter:    id, level, ordering (array position), title, content
//     annotation: id, start, end, anchorType, colorIndex, anchorText, note
//   EXCLUDED (present in the file / model, but must not trigger sync):
//     activeChapterId  — ephemeral UI state (which chapter is open).
//     cursorPosition   — ephemeral UI state; optional chapter attr, present only after
//                        in-app editing. If hashed, merely opening + moving the caret on
//                        a 2nd device would register as dirty → phantom fork, and worse,
//                        resurrect a deliberately-trashed project (spec §9 T4, invariant 11).
//     createdAt        — immutable per entity; never distinguishes two versions of the same
//                        chapter/annotation, so it adds zero divergence signal and only risks
//                        false dirt from missing/fabricated values. (Owner decision, overrides
//                        §3.4's inclusion.)
//     updatedAt        — redundant: a real edit already changes the hash via content;
//                        hashing the timestamp can only add false dirt, never signal.
//     type             — project-mode metadata; a stray change is not worth a fork (owner
//                        decision). Re-add to the allowlist if it ever needs to gate sync.
//     oodbo version    — a format bump must not dirty every project.
//   NOT IN THE FILE (therefore never hashed): project.createdAt/updatedAt (serializeOodbo
//     does not write them), chapter.collapsed, project.wordAssets (live-object-only).

// ── XML escaping (identical to the legacy xe() in Editor.jsx / App.jsx) ──────────
function xe(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function genId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// ── serializeOodbo: model → .oodbo XML (the ONE storage serializer) ─────────────
// Byte-for-byte identical to the legacy projectToXml in both Editor.jsx and App.jsx.
// Verified by parity tests before any call site is swapped (Phase 5).
export function serializeOodbo(project) {
  const chapters = (project.chapters || []).map(ch => {
    const anns = (ch.annotations || []).map(ann => `
        <annotation id="${xe(ann.id)}" start="${ann.start}" end="${ann.end}" anchorType="${xe(ann.anchorType)}" colorIndex="${ann.colorIndex || 0}" createdAt="${xe(ann.createdAt)}">
          <anchorText>${xe(ann.anchorText)}</anchorText>
          <note>${xe(ann.note)}</note>
        </annotation>`).join('');
    return `
    <chapter id="${xe(ch.id)}" level="${ch.level || 1}" createdAt="${xe(ch.createdAt)}" updatedAt="${xe(ch.updatedAt)}"${ch.cursorPosition != null ? ` cursorPosition="${ch.cursorPosition}"` : ''}>
      <title>${xe(ch.title)}</title>
      <content>${xe(ch.content)}</content>
      <annotations>${anns}
      </annotations>
    </chapter>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<oodbo version="1">
  <project id="${xe(project.id)}"${project.conflictOf ? ` conflictOf="${xe(project.conflictOf)}"` : ''}>
    <title>${xe(project.title)}</title>
    <type>${xe(project.type || '')}</type>
    <activeChapterId>${xe(project.activeChapterId)}</activeChapterId>
    <chapters>${chapters}
    </chapters>
  </project>
</oodbo>`;
}

// ── Internal XML → raw field extraction ─────────────────────────────────────────
// Extracts exactly what is in the file, with NO fabricated defaults (no now(), no
// randomUUID). Missing attributes stay '' / undefined so that hashing is
// deterministic across devices (spec §3.4: a missing createdAt must not become a
// per-parse timestamp). Used by both parseOodbo (lenient app parse) and the hash path.
function extractRaw(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid .oodbo XML');

  const txt  = (parent, tag) => parent.querySelector(tag)?.textContent ?? '';
  const attr = (el, a)       => (el.getAttribute(a) ?? '');

  const chapters = Array.from(doc.querySelectorAll('chapter')).map(ch => ({
    id:             attr(ch, 'id'),
    level:          attr(ch, 'level'),
    createdAt:      attr(ch, 'createdAt'),
    updatedAt:      attr(ch, 'updatedAt'),
    cursorPosition: attr(ch, 'cursorPosition'),
    title:          txt(ch, 'title'),
    content:        txt(ch, 'content'),
    annotations: Array.from(ch.querySelectorAll('annotation')).map(ann => ({
      id:         attr(ann, 'id'),
      start:      attr(ann, 'start'),
      end:        attr(ann, 'end'),
      anchorType: attr(ann, 'anchorType'),
      colorIndex: attr(ann, 'colorIndex'),
      createdAt:  attr(ann, 'createdAt'),
      anchorText: txt(ann, 'anchorText'),
      note:       txt(ann, 'note'),
    })),
  }));

  const projectEl = doc.querySelector('project');
  return {
    id:              projectEl?.getAttribute('id') ?? '',
    conflictOf:      projectEl?.getAttribute('conflictOf') ?? '',
    title:           txt(doc, 'project > title'),
    type:            txt(doc, 'project > type'),
    activeChapterId: txt(doc, 'activeChapterId'),
    chapters,
  };
}

// ── parseOodbo: .oodbo XML → app model (lenient, for LOADING into the UI) ────────
// Mirrors the legacy xmlToProject: fabricates ids/timestamps for missing fields so
// the app always has a usable object. NEVER feed this into the hash — the fabricated
// defaults are non-deterministic. Throws on invalid XML (callers that want a
// null-on-error contract should use a try/catch, as App.jsx's callers already do).
export function parseOodbo(xmlString) {
  const raw = extractRaw(xmlString);
  const now = () => new Date().toISOString();
  const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : genId());

  const chapters = raw.chapters.map(ch => ({
    id:             ch.id || uuid(),
    level:          parseInt(ch.level, 10) || 1,
    createdAt:      ch.createdAt || now(),
    updatedAt:      ch.updatedAt || now(),
    cursorPosition: ch.cursorPosition ? parseInt(ch.cursorPosition, 10) : undefined,
    title:          ch.title,
    content:        ch.content,
    annotations: ch.annotations.map(a => ({
      id:         a.id || uuid(),
      start:      parseInt(a.start, 10) || 0,
      end:        parseInt(a.end, 10) || 0,
      anchorType: a.anchorType || 'content',
      colorIndex: parseInt(a.colorIndex, 10) || 0,
      createdAt:  a.createdAt || now(),
      anchorText: a.anchorText,
      note:       a.note,
    })),
  }));

  return {
    id:              raw.id || genId(),
    title:           raw.title || 'Untitled',
    ...(raw.conflictOf ? { conflictOf: raw.conflictOf } : {}),
    ...(raw.type ? { type: raw.type } : {}),
    activeChapterId: chapters.find(c => c.id === raw.activeChapterId) ? raw.activeChapterId : chapters[0]?.id,
    chapters,
  };
}

// ── canonicalModel: model → allowlisted, deterministically-typed content object ──
// The exact set of fields that define "content" for conflict detection. Everything
// outside this allowlist is invisible to the hash by construction. Accepts either an
// app model object or extractRaw() output; coerces types explicitly and maps
// null/undefined/missing to stable sentinels ('' for strings, 0 for numbers) so the
// same logical content always produces the same object regardless of source.
function canonicalModel(p) {
  // Normalize line endings to LF. XML parsing (§2.11) ALWAYS collapses CRLF and lone CR to LF on
  // readback, so hashing the raw in-memory model (which can hold CRLF from Windows-pasted text)
  // against a serialize→reparse readback would manufacture a phantom conflict for any project with
  // a Windows line ending — a never-synced project then forks against itself (reconcile has no
  // ancestor to break the tie) and each fork, also unsynced, forks again: a fork storm. Folding CRLF
  // here — the single chokepoint both canonicalHash(model) and hashXml(file) flow through — makes
  // the two sides agree. No-op for LF-only content, so existing hashes are unchanged.
  const str = v => (v == null ? '' : String(v).replace(/\r\n?/g, '\n'));
  const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };
  return {
    id:    str(p.id),
    title: str(p.title),
    // Present ONLY when set, which is what keeps this backward-compatible: a project with no
    // conflictOf serializes to byte-identical JSON, so adding this field did not change a
    // single existing hash. Had it always been emitted, every project on every device would
    // have gone dirty at once — and two devices re-pushing everything simultaneously is a
    // mass fork, the exact catastrophe this engine exists to avoid.
    //
    // It IS hashed when present, deliberately: clearing it (resolving a conflict) has to
    // change the hash, or the resolution would never be pushed and the other device would
    // badge the pair forever.
    ...(p.conflictOf ? { conflictOf: str(p.conflictOf) } : {}),
    chapters: (p.chapters || []).map(ch => ({
      id:      str(ch.id),
      level:   int(ch.level, 1),
      title:   str(ch.title),
      content: str(ch.content),
      annotations: (ch.annotations || []).map(a => ({
        id:         str(a.id),
        start:      int(a.start, 0),
        end:        int(a.end, 0),
        anchorType: a.anchorType == null || a.anchorType === '' ? 'content' : String(a.anchorType),
        colorIndex: int(a.colorIndex, 0),
        anchorText: str(a.anchorText),
        note:       str(a.note),
      })),
    })),
  };
}

// Deterministic canonical string for a project MODEL. JSON.stringify over an object
// built in fixed key order is itself deterministic (insertion order preserved for
// string keys), and carries prose (including newlines) verbatim inside string values
// while no structural/pretty-print whitespace exists to vary. This is the "serialize
// deterministically" of spec §3.4, realized as canonical JSON rather than canonical
// XML to sidestep XML-whitespace/C14N fragility.
export function canonicalString(project) {
  return JSON.stringify(canonicalModel(project));
}

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const buf   = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Hash a project MODEL (live in-memory object or app model). Async (WebCrypto).
export function canonicalHash(project) {
  return sha256Hex(canonicalString(project));
}

// Hash .oodbo XML content deterministically, WITHOUT the lenient fabricated defaults
// of parseOodbo. This is the correct entry point for hashing content downloaded from
// the cloud (and for migration, spec §12) so that a file missing e.g. createdAt hashes
// identically on every device instead of picking up a per-parse now().
export function hashXml(xmlString) {
  return canonicalHash(extractRaw(xmlString));
}

// Test-only surface (not part of the engine's public contract).
export const __test = { extractRaw, canonicalModel, xe };
