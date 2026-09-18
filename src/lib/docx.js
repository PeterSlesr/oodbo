import JSZip from 'jszip';

// ── Export helpers ─────────────────────────────────────────────────────────

function xe(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Detect whether any chapter has list lines (bullets or numbered).
function projectHasLists(chapters) {
  return (chapters || []).some(ch =>
    (ch.content || '').split('\n').some(l => /^(\s*)(•\s|\d+[.)]\s)/.test(l))
  );
}

// ── Comment helpers ────────────────────────────────────────────────────────

// Map an oodbo character offset in ch.content to { paraIndex, charPos }.
// paraIndex is 0-indexed within content.split('\n').
// charPos is the position within the Word paragraph text (list prefixes stripped).
function contentOffsetToWordPos(content, oodboOffset) {
  const lines = (content || '').split('\n');
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (oodboOffset >= pos && oodboOffset <= pos + line.length) {
      const charInLine = oodboOffset - pos;
      // Strip bullet prefix: "  • " style (optional indent + bullet + space)
      const bm = line.match(/^(\s*•\s)/);
      // Strip ordered prefix: "  1. " style (optional indent + number + sep + space)
      const nm = line.match(/^(\s*\d+[.)]\s)/);
      const prefix = bm ? bm[1].length : (nm ? nm[1].length : 0);
      return { paraIndex: i, charPos: Math.max(0, charInLine - prefix) };
    }
    pos += line.length + 1; // +1 for \n
  }
  return { paraIndex: Math.max(0, lines.length - 1), charPos: 0 };
}

// Build word/comments.xml. annEntries is [{ ann, wordId }] in global order.
function buildCommentsXml(annEntries) {
  const items = annEntries.map(({ ann, wordId }) => {
    // Normalise ISO date: remove sub-second precision if present
    const date = (ann.createdAt || '').replace(/\.\d+Z$/, 'Z') || '2026-01-01T00:00:00Z';
    return `  <w:comment w:id="${wordId}" w:author="oodbo" w:date="${date}" w:initials="o">` +
      `<w:p><w:r><w:t xml:space="preserve">${xe(ann.note || '')}</w:t></w:r></w:p>` +
      `</w:comment>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n` +
    items + `\n</w:comments>`;
}

function injectCommentsRel(relsXml) {
  if (/comments\.xml/i.test(relsXml)) return relsXml;
  const ids  = [...relsXml.matchAll(/Id="rId(\d+)"/gi)].map(m => parseInt(m[1], 10));
  const next = ids.length ? Math.max(...ids) + 1 : 1;
  const TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
  return relsXml.replace('</Relationships>',
    `  <Relationship Id="rId${next}" Type="${TYPE}" Target="comments.xml"/>\n</Relationships>`);
}

function injectCommentsContentType(ctXml) {
  if (/comments\.xml/i.test(ctXml)) return ctXml;
  const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
  return ctXml.replace('</Types>',
    `  <Override PartName="/word/comments.xml" ContentType="${CT}"/>\n</Types>`);
}

// ── Body XML builder ───────────────────────────────────────────────────────

// annMap: { 'heading': { starts, ends }, 0: { starts, ends }, ... } or null.
// Keys are 'heading' for the chapter title paragraph, or 0-based line index for body.
// Each entry: { starts: [{ wordId, charPos }, ...], ends: [{ wordId, charPos }, ...] }
function chapterToBodyXml(ch, bulletNumId, orderedNumId, annMap) {

  // Build run XML for `text`, splitting at exact character positions where
  // comment markers land. Annotations that start/end mid-paragraph are
  // injected between character-split runs rather than wrapping the whole run.
  function buildRuns(text, key) {
    const entry  = annMap?.[key];
    const starts = (entry?.starts || []).slice().sort((a, b) => a.charPos - b.charPos);
    const ends   = (entry?.ends   || []).slice().sort((a, b) => a.charPos - b.charPos);

    if (!starts.length && !ends.length) {
      return text ? `<w:r><w:t xml:space="preserve">${xe(text)}</w:t></w:r>` : '';
    }

    // Merge start/end events sorted by position.
    // At equal positions ends come first: a range ending where another starts
    // avoids a zero-length highlighted span.
    const events = [
      ...starts.map(({ wordId, charPos }) => ({ pos: charPos, type: 'start', wordId })),
      ...ends.map(  ({ wordId, charPos }) => ({ pos: charPos, type: 'end',   wordId })),
    ].sort((a, b) => a.pos - b.pos || (a.type === 'end' ? -1 : 1));

    let result = '';
    let cursor = 0;
    for (const ev of events) {
      const chunk = text.slice(cursor, ev.pos);
      if (chunk) result += `<w:r><w:t xml:space="preserve">${xe(chunk)}</w:t></w:r>`;
      cursor = ev.pos;
      if (ev.type === 'start') {
        result += `<w:commentRangeStart w:id="${ev.wordId}"/>`;
      } else {
        result += `<w:commentRangeEnd w:id="${ev.wordId}"/>` +
          `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>` +
          `<w:commentReference w:id="${ev.wordId}"/></w:r>`;
      }
    }
    const tail = text.slice(cursor);
    if (tail) result += `<w:r><w:t xml:space="preserve">${xe(tail)}</w:t></w:r>`;
    return result;
  }

  const lines = (ch.content || '').split('\n');

  // Heading paragraph (chapter title)
  let result = `<w:p><w:pPr><w:pStyle w:val="Heading${ch.level || 1}"/></w:pPr>` +
    `${buildRuns(ch.title || 'Untitled', 'heading')}</w:p>`;

  lines.forEach((line, i) => {
    // Legacy ## headings (backward compat with old content)
    const hm = line.match(/^(#{2,9}) ([\s\S]*)$/);
    if (hm) {
      result += `<w:p><w:pPr><w:pStyle w:val="Heading${hm[1].length}"/></w:pPr>` +
        `${buildRuns(hm[2], i)}</w:p>`;
      return;
    }

    // Bullet list: optional indent + • marker
    const bm = line.match(/^(\s*)•\s(.*)$/);
    if (bm) {
      const ilvl = Math.min(8, Math.floor(bm[1].length / 2));
      const nId  = bulletNumId || 1;
      result += `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${nId}"/></w:numPr></w:pPr>` +
        `${buildRuns(bm[2], i)}</w:p>`;
      return;
    }

    // Ordered list: optional indent + number + separator
    const nm = line.match(/^(\s*)(\d+)[.)]\s(.*)$/);
    if (nm) {
      const ilvl = Math.min(8, Math.floor(nm[1].length / 2));
      const nId  = orderedNumId || 2;
      result += `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${nId}"/></w:numPr></w:pPr>` +
        `${buildRuns(nm[3], i)}</w:p>`;
      return;
    }

    // Empty line with no annotations → minimal paragraph
    const runs = buildRuns(line, i);
    if (!runs) { result += '<w:p/>'; return; }

    result += `<w:p>${runs}</w:p>`;
  });

  return result;
}

// ── Fallback static files (used when no original assets are available) ─────

const FALLBACK_DOC_ATTRS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const FALLBACK_PKG_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const FALLBACK_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const FALLBACK_DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

const FALLBACK_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="200" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="160" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading4">
    <w:name w:val="heading 4"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="3"/><w:spacing w:before="120" w:after="40"/></w:pPr>
    <w:rPr><w:b/><w:i/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading5">
    <w:name w:val="heading 5"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="4"/><w:spacing w:before="80" w:after="40"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading6">
    <w:name w:val="heading 6"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="5"/><w:spacing w:before="80" w:after="40"/></w:pPr>
    <w:rPr><w:b/><w:i/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading7">
    <w:name w:val="heading 7"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="6"/><w:spacing w:before="80" w:after="40"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading8">
    <w:name w:val="heading 8"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="7"/><w:spacing w:before="80" w:after="40"/></w:pPr>
    <w:rPr><w:b/><w:i/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading9">
    <w:name w:val="heading 9"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="8"/><w:spacing w:before="80" w:after="40"/></w:pPr>
    <w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>
  </w:style>
</w:styles>`;

// Minimal numbering definitions: numId 1 = bullet, numId 2 = decimal.
const FALLBACK_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="◦"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="▪"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="2160" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%3."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="2160" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

// Inject a numbering relationship into an existing document.xml.rels string.
function injectNumberingRel(relsXml) {
  if (/numbering/i.test(relsXml)) return relsXml; // already present
  const ids  = [...relsXml.matchAll(/Id="rId(\d+)"/gi)].map(m => parseInt(m[1], 10));
  const next = ids.length ? Math.max(...ids) + 1 : 1;
  const TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';
  return relsXml.replace('</Relationships>',
    `  <Relationship Id="rId${next}" Type="${TYPE}" Target="numbering.xml"/>\n</Relationships>`);
}

// Inject a numbering content type into an existing [Content_Types].xml string.
function injectNumberingContentType(ctXml) {
  if (/numbering/i.test(ctXml)) return ctXml; // already present
  const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
  return ctXml.replace('</Types>',
    `  <Override PartName="/word/numbering.xml" ContentType="${CT}"/>\n</Types>`);
}

// ── Export ─────────────────────────────────────────────────────────────────

const BINARY_EXTS_EXPORT = new Set(['png','jpg','jpeg','gif','svg','wmf','emf','tif','tiff',
                                     'ttf','otf','woff','woff2','bin','fntdata']);

export async function exportDocx(project) {
  const assets       = project.wordAssets || {};
  const zipFiles     = assets.zipFiles    || {};
  const docAttrs     = assets.docAttrs    || FALLBACK_DOC_ATTRS;
  const bulletNumId  = assets.bulletNumId || null;
  const orderedNumId = assets.orderedNumId || null;
  const needsLists   = projectHasLists(project.chapters);

  // ── Build annotation index ────────────────────────────────────────────────
  // Assign a sequential Word comment ID to every annotation across all chapters.
  // annEntries is ordered by chapter then annotation; IDs match this order.
  const annEntries = [];          // [{ ann, wordId }] — input for buildCommentsXml
  const chapterAnnMaps = new Map(); // chapterId → annMap for chapterToBodyXml

  for (const ch of project.chapters || []) {
    // Sort by document position so comment IDs in comments.xml are assigned
    // in the same order the markers appear in document.xml. Word's click-to-focus
    // logic breaks when IDs don't monotonically match document appearance order.
    const anns = (ch.annotations || [])
      .filter(a => a.note?.trim())
      .slice()
      .sort((a, b) => {
        if (a.anchorType === 'title' && b.anchorType !== 'title') return -1;
        if (a.anchorType !== 'title' && b.anchorType === 'title') return  1;
        return a.start - b.start;
      });
    if (!anns.length) continue;
    const annMap = {};
    for (const ann of anns) {
      const wordId = annEntries.length;
      annEntries.push({ ann, wordId });

      // Determine which paragraph gets the start marker and which gets the end.
      // For cross-paragraph annotations these will differ, so the highlight
      // spans correctly across the line break in Word.
      let startKey, startCharPos, endKey, endCharPos;
      if (ann.anchorType === 'title') {
        startKey = endKey = 'heading';
        startCharPos = ann.start;
        endCharPos   = ann.end;
      } else {
        const sp = contentOffsetToWordPos(ch.content || '', ann.start);
        const ep = contentOffsetToWordPos(ch.content || '', ann.end);
        startKey = sp.paraIndex;  startCharPos = sp.charPos;
        endKey   = ep.paraIndex;  endCharPos   = ep.charPos;
      }

      if (!annMap[startKey]) annMap[startKey] = { starts: [], ends: [] };
      annMap[startKey].starts.push({ wordId, charPos: startCharPos });

      if (!annMap[endKey]) annMap[endKey] = { starts: [], ends: [] };
      annMap[endKey].ends.push({ wordId, charPos: endCharPos });
    }
    chapterAnnMaps.set(ch.id, annMap);
  }
  const needsComments = annEntries.length > 0;

  // ── Build document body ───────────────────────────────────────────────────
  const bodyContent = (project.chapters || [])
    .map(ch => chapterToBodyXml(ch, bulletNumId, orderedNumId, chapterAnnMaps.get(ch.id) || null))
    .join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${docAttrs}>
  <w:body>${bodyContent}<w:sectPr/></w:body>
</w:document>`;

  const zip = new JSZip();

  if (Object.keys(zipFiles).length > 0) {
    // Restore the full original ZIP snapshot, then overlay regenerated files.
    for (const [path, content] of Object.entries(zipFiles)) {
      const ext = path.split('.').pop().toLowerCase();
      if (BINARY_EXTS_EXPORT.has(ext)) {
        zip.file(path, content, { base64: true });
      } else {
        let patched = content;
        if (path === 'word/_rels/document.xml.rels') {
          if (needsLists)    patched = injectNumberingRel(patched);
          if (needsComments) patched = injectCommentsRel(patched);
        }
        if (path === '[Content_Types].xml') {
          if (needsLists)    patched = injectNumberingContentType(patched);
          if (needsComments) patched = injectCommentsContentType(patched);
        }
        zip.file(path, patched);
      }
    }
    if (needsLists) zip.file('word/numbering.xml', FALLBACK_NUMBERING);
  } else {
    // Native project — build minimal valid archive.
    let ctXml   = FALLBACK_CONTENT_TYPES;
    let relsXml = FALLBACK_DOC_RELS;
    if (needsComments) {
      ctXml   = injectCommentsContentType(ctXml);
      relsXml = injectCommentsRel(relsXml);
    }
    zip.file('[Content_Types].xml',          ctXml);
    zip.file('_rels/.rels',                  FALLBACK_PKG_RELS);
    zip.file('word/styles.xml',              FALLBACK_STYLES);
    zip.file('word/_rels/document.xml.rels', relsXml);
    if (needsLists) zip.file('word/numbering.xml', FALLBACK_NUMBERING);
  }

  if (needsComments) zip.file('word/comments.xml', buildCommentsXml(annEntries));
  zip.file('word/document.xml', documentXml);

  return zip.generateAsync({
    type:     'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    // DEFLATE like a normal .docx — the package is XML, so STORE bloats it needlessly.
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
