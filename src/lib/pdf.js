import { jsPDF } from 'jspdf';

// ── PDF export — direct blob download ─────────────────────────────────────

export function exportPdf(project) {
  const doc    = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW  = doc.internal.pageSize.getWidth();
  const pageH  = doc.internal.pageSize.getHeight();
  const margin = 72; // 1 inch
  const textW  = pageW - 2 * margin;

  let y = margin;

  function newPageIfNeeded(needed) {
    if (y + needed > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  }

  // Render a block of text, wrapping to textW, returning after last line
  function renderText(text, fontSize, style, lineGap) {
    doc.setFont('times', style);
    doc.setFontSize(fontSize);
    const lh    = fontSize * 1.55;
    const lines = doc.splitTextToSize(text, textW);
    for (const line of lines) {
      newPageIfNeeded(lh);
      doc.text(line, margin, y);
      y += lh;
    }
    y += lineGap;
  }

  // ── Project title ────────────────────────────────────────────────────────
  if (project.title) {
    renderText(project.title, 20, 'normal', 0);
    // rule under title
    doc.setLineWidth(0.5);
    doc.setDrawColor(180);
    doc.line(margin, y + 2, pageW - margin, y + 2);
    y += 20;
  }

  // ── Chapters ─────────────────────────────────────────────────────────────
  for (const ch of project.chapters || []) {
    if (!ch.title && !ch.content) continue;

    const level = ch.level || 1;

    if (ch.title) {
      y += 14;
      if (level === 1) {
        renderText(ch.title, 14, 'normal', 4);
      } else {
        renderText(ch.title, 12, 'italic', 4);
      }
    }

    if (ch.content) {
      // Preserve the writer's line breaks — forward-only writing is line-oriented, so every
      // newline is a real break and blank lines are paragraph gaps. Mirrors the share view's
      // white-space:pre-wrap; do NOT collapse single newlines to spaces (that smushed exports).
      doc.setFont('times', 'normal');
      doc.setFontSize(11);
      const lh = 11 * 1.55;
      for (const raw of ch.content.split('\n')) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) { y += lh * 0.6; continue; }   // blank line → paragraph gap
        for (const wrapped of doc.splitTextToSize(line, textW)) {
          newPageIfNeeded(lh);
          doc.text(wrapped, margin, y);
          y += lh;
        }
      }
      y += 10;   // trailing gap after the chapter body
    }
  }

  return doc.output('blob');
}
