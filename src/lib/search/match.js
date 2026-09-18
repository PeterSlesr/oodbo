// ── Match one project ───────────────────────────────────────────────────────────
//
// Pure. Given a project (the canonical in-memory model) and a folded needle, return
// every hit in DOCUMENT ORDER — project title, then per chapter: chapter title, content
// (by offset), then annotations (note + anchored text). Document order is what the
// in-project find bar cycles through (Ctrl/Cmd-F style); the homepage uses the same hits
// to decide which projects match and to pick a preview snippet.
//
// Every content/heading/annotation hit carries a `cursorPosition` = a character offset
// into the target chapter's content, which the Editor's jumpTarget places the caret at.

import { findRanges } from './fold.js';
import { makeSnippet } from './snippet.js';

// Ranking weights (higher = more relevant). 'heading' scores like a chapter title.
const FIELD_WEIGHT = {
  projectTitle: 100, chapterTitle: 40, heading: 40,
  annotationNote: 20, annotationAnchor: 15, content: 10,
};

// Is the line containing `offset` an inline markdown heading (## … ######)? Only used to
// relabel a content hit for ranking — caret placement still uses the raw offset.
function isHeadingAt(content, offset) {
  const lineStart = content.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return /^#{2,9} /.test(content.slice(lineStart, lineStart + 10));
}

export function matchProject(project, needle) {
  const hits = [];
  if (!project || !needle) return hits;
  const projectId = project.id;
  const projectTitle = project.title || '';

  for (const r of findRanges(projectTitle, needle)) {
    hits.push(makeHit({
      projectId, projectTitle, field: 'projectTitle',
      chapterId: project.chapters?.[0]?.id ?? null, source: projectTitle, r, cursorPosition: 0,
    }));
  }

  for (const ch of project.chapters || []) {
    const chapterId = ch.id;
    const title   = ch.title || '';
    const content = ch.content || '';

    for (const r of findRanges(title, needle)) {
      hits.push(makeHit({ projectId, projectTitle, field: 'chapterTitle', chapterId, source: title, r, cursorPosition: 0 }));
    }
    for (const r of findRanges(content, needle)) {
      const field = isHeadingAt(content, r.start) ? 'heading' : 'content';
      hits.push(makeHit({ projectId, projectTitle, field, chapterId, source: content, r, cursorPosition: r.start }));
    }
    for (const ann of ch.annotations || []) {
      const at = ann.start ?? 0;
      for (const r of findRanges(ann.note || '', needle)) {
        hits.push(makeHit({ projectId, projectTitle, field: 'annotationNote', chapterId, source: ann.note || '', r, cursorPosition: at, annotationId: ann.id }));
      }
      for (const r of findRanges(ann.anchorText || '', needle)) {
        hits.push(makeHit({ projectId, projectTitle, field: 'annotationAnchor', chapterId, source: ann.anchorText || '', r, cursorPosition: at, annotationId: ann.id }));
      }
    }
  }
  return hits;
}

function makeHit({ projectId, projectTitle, field, chapterId, source, r, cursorPosition, annotationId }) {
  return {
    projectId, projectTitle, field, chapterId,
    offset: r.start, length: r.end - r.start,
    cursorPosition,
    ...(annotationId ? { annotationId } : {}),
    snippet: makeSnippet(source, r.start, r.end),
    score: FIELD_WEIGHT[field] ?? 10,
  };
}
