// ── Search public API ───────────────────────────────────────────────────────────
//
// Pure entry points over the canonical in-memory project model. The UI (homepage box,
// in-project find bar) and the desktop build both call these unchanged; the only I/O
// seam is source.js (which set of projects to hand in).

import { fold } from './fold.js';
import { matchProject } from './match.js';

// In-project search: ordered hits to cycle through (Ctrl/Cmd-F style), in document order.
export function searchProject(project, queryStr) {
  const needle = fold((queryStr || '').trim());
  if (!needle) return [];
  return matchProject(project, needle);
}

// Homepage search: the projects that contain the query, ranked. Each result carries the
// hit count and the single best (highest-scoring) hit for a preview snippet + deep-link.
export function searchAll(projects, queryStr) {
  const needle = fold((queryStr || '').trim());
  if (!needle) return [];
  const results = [];
  for (const project of projects || []) {
    const hits = matchProject(project, needle);
    if (hits.length === 0) continue;
    const best = hits.reduce((a, b) => (b.score > a.score ? b : a), hits[0]);
    results.push({
      projectId:    project.id,
      projectTitle: project.title || '',
      updatedAt:    project.updatedAt || '',
      trashed:      !!project._trashed,
      hitCount:     hits.length,
      best,
    });
  }
  results.sort((a, b) =>
    (b.best.score - a.best.score) ||
    (b.hitCount - a.hitCount) ||
    String(b.updatedAt).localeCompare(String(a.updatedAt))
  );
  return results;
}

export { fold, findRanges } from './fold.js';
