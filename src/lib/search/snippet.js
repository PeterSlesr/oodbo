// ── Snippet builder ─────────────────────────────────────────────────────────────
//
// Pure. Given a match range in a source string, return a trimmed context window with
// the highlight range expressed relative to the returned snippet text. Newlines/tabs
// are replaced 1:1 with spaces so offsets stay aligned; the UI renders the highlight as
// split spans (never dangerouslySetInnerHTML).

const RADIUS = 40;

export function makeSnippet(text, matchStart, matchEnd, radius = RADIUS) {
  const src  = String(text ?? '');
  const from = Math.max(0, matchStart - radius);
  const to   = Math.min(src.length, matchEnd + radius);
  const lead  = from > 0 ? '…' : '';
  const trail = to < src.length ? '…' : '';
  const body  = src.slice(from, to).replace(/[\n\r\t]/g, ' ');
  return {
    text:       lead + body + trail,
    matchStart: lead.length + (matchStart - from),
    matchEnd:   lead.length + (matchEnd - from),
  };
}
