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
      // Split on blank lines → paragraphs; collapse single newlines within a para
      const paras = ch.content.split(/\n{2,}/);
      for (const para of paras) {
        const t = para.replace(/\n/g, ' ').trim();
        if (!t) continue;
        renderText(t, 11, 'normal', 10);
      }
    }
  }

  return doc.output('blob');
}
