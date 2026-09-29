import React, { useState, useEffect, useRef, useMemo } from 'react';
import FocusMode from './FocusMode.jsx';
import { searchProject } from '../lib/search/index.js';
import { EDITOR_THEMES } from '../lib/themes.js';
import { btn, dialog } from '../lib/ui.js';
import BodyScrollLock from '../lib/BodyScrollLock.jsx';
import GuestTour from './GuestTour.jsx';
import { exportDocx } from '../lib/docx.js';
import { exportPdf }  from '../lib/pdf.js';
import { publishShare, unpublishShare } from '../lib/share.js';
import { getShareAccessToken } from '../lib/providerSession.js';
import JSZip from 'jszip';
import { loadGuestDraft, saveGuestDraft } from '../lib/guestStore.js';
import { openDB } from '../lib/sync/store.js';   // single IDB opener (v4) — see store.js
import { serializeOodbo, parseOodbo } from '../lib/sync/canonical.js';   // single serializer
import { getEngine } from '../lib/sync/client.js';
import { saveForwardDraft, loadForwardDraft, clearForwardDraft } from '../lib/forwardDraft.js';
import OfflineBanner from './OfflineBanner.jsx';
import ReconnectBanner from './ReconnectBanner.jsx';
import { useOnline } from '../lib/useOnline.js';

// Guest onboarding tour (desktop only) — steps anchor to [data-tour] elements.
// Copy is placeholder; final wording is Paul's.
const TOUR_STEPS = [
  { selector: '[data-tour="forward"]',        side: 'bottom', title: 'Forward mode',      body: 'The heart of Forward Only: write without editing or deleting — you can only move forward. Click Forward to try it.' },
  { selector: '[data-tour="notes"]',          side: 'bottom', dodgeLeft: 220, title: 'Notes', body: 'Select any text to leave a margin note — an idea, a fix for later — without breaking your flow.' },
  { selector: '[data-tour="rename"]',         side: 'bottom', ringMinWidth: 170, title: 'Name your project', body: 'Click the title any time to rename your project.' },
  { selector: '[data-tour="section"]',        side: 'right',  title: 'Sections',          body: 'Your writing is organized into sections. Click one to jump to it, drag to reorder, or click the copy icon to copy a section’s text.' },
  { selector: '[data-tour="section-title"]',  side: 'bottom', ringInsetBottom: 12, title: 'Name your section', body: 'Click the section title any time to rename it.' },
  { selector: '[data-tour="section-header"]', side: 'right', expandSelector: '[data-tour="section-header-menu"]', title: 'Heading level', body: 'Set a section’s heading — H1, H2, H3 — to give your document structure.' },
  { selector: '[data-tour="new-section"]',    side: 'right', extraRings: ['[data-tour="new-section-plus"]'], title: 'Add a section', body: 'Add a section whenever you’re ready to move on — from here, or “Add section after” in a section’s ⋯ menu. Each new section opens straight into Forward mode.' },
  { selector: '[data-tour="delete-section"]', side: 'right', title: 'Delete a section', body: 'Open a section’s ⋯ menu and choose “Delete section” — you’ll be asked to confirm first.' },
  { selector: '[data-tour="share"]',          side: 'right', title: 'Share your work', body: 'Publish a whole project or a single section as a read-only link, or share a progress card — all from here.' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
// "1 word" / "2 words" — never the "1 words" that slipped through everywhere.
const plWords = (n) => `${Number(n).toLocaleString()} word${Number(n) === 1 ? '' : 's'}`;

function genId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}


// The single serializer/parser lives in lib/sync/canonical.js (the one canonical form the
// sync engine hashes). These aliases keep the existing call sites unchanged.
const projectToXml = serializeOodbo;
const xmlToProject = parseOodbo;

// Editor chrome themes now live in src/lib/themes.js (imported above) — single source of truth,
// with the danger/dangerText destructive tokens.

function journalChapterTitle() {
  const now  = new Date();
  const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time}`;
}

// Trim whitespace and expand a selection to whole-word boundaries, so an annotation excerpt never
// reads like "ot terrible " — the leading "n" is restored and the trailing space dropped.
function snapRange(text, a, b) {
  let s = Math.max(0, Math.min(a, b));
  let e = Math.min((text || '').length, Math.max(a, b));
  const word = (c) => !!c && /\w/.test(c);
  while (s < e && /\s/.test(text[s])) s++;                                   // trim leading whitespace
  while (e > s && /\s/.test(text[e - 1])) e--;                              // trim trailing whitespace
  while (s > 0 && word(text[s - 1]) && word(text[s])) s--;                  // expand start to word start
  while (e < text.length && word(text[e]) && word(text[e - 1])) e++;        // expand end to word end
  return { start: s, end: e };
}

// Compact "last synced" — time only when today, else short date + time. Never seconds.
function fmtSync(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const t = d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? t
      : `${d.toLocaleDateString('en', { month: 'short', day: 'numeric' })} ${t}`;
  } catch { return ''; }
}

function newChapter(order, journalMode, level = 1) {
  return {
    id:          crypto.randomUUID(),
    level,
    title:       journalMode ? journalChapterTitle() : `Section ${order}`,
    content:     '',
    annotations: [],
    collapsed:   false,
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString()
  };
}

// Split a chapter's content at ## heading boundaries into structural sections.
// Annotations are remapped to their correct section (offsets adjusted).
function splitChapterIntoSections(ch) {
  const content     = ch.content || '';
  const annotations = ch.annotations || [];
  const now         = ch.updatedAt || new Date().toISOString();
  const lines       = content.split('\n');
  const boundaries  = [];   // { headingStart, level, title, contentStart }
  let pos = 0;

  for (const line of lines) {
    const m = line.match(/^(#{2,9}) (.+)$/);
    if (m) boundaries.push({ headingStart: pos, level: m[1].length, title: m[2], contentStart: pos + line.length + 1 });
    pos += line.length + 1;
  }

  if (boundaries.length === 0) return [{ ...ch, level: ch.level ?? 1, collapsed: ch.collapsed ?? false }];

  const sections = [];
  const firstHeadingPos = boundaries[0].headingStart;

  // Section 0 — the original H1 chapter, content up to first sub-heading
  const s0Content = content.slice(0, firstHeadingPos).replace(/\n$/, '');
  sections.push({
    ...ch,
    level:       ch.level ?? 1,
    content:     s0Content,
    collapsed:   ch.collapsed ?? false,
    annotations: annotations.filter(a => a.anchorType === 'title' || a.start < firstHeadingPos),
  });

  // Sub-sections
  for (let i = 0; i < boundaries.length; i++) {
    const b        = boundaries[i];
    const nextStart = i + 1 < boundaries.length ? boundaries[i + 1].headingStart : content.length;
    const rawContent = content.slice(b.contentStart, nextStart).replace(/\n$/, '');
    const secAnns  = annotations
      .filter(a => a.anchorType !== 'title' && a.start >= b.contentStart && a.start < nextStart)
      .map(a => ({ ...a, start: a.start - b.contentStart, end: Math.min(a.end, nextStart) - b.contentStart }));
    sections.push({
      id:          crypto.randomUUID(),
      level:       b.level,
      title:       b.title,
      content:     rawContent,
      annotations: secAnns,
      collapsed:   false,
      createdAt:   now,
      updatedAt:   now,
    });
  }
  return sections;
}

function migrateProject(project) {
  const chapters = project.chapters || [];
  if (chapters.length === 0 || chapters[0].level !== undefined) return project;
  const newChapters = chapters.flatMap(ch => splitChapterIntoSections(ch));
  return { ...project, chapters: newChapters };
}

function newProject() {
  const ch = newChapter(1);
  return { id: genId(), title: 'My Project', chapters: [ch], activeChapterId: ch.id };
}

// Guest mode starts with two sections so the tour can demo drag-and-drop reorder.
function newGuestProject() {
  const a = newChapter(1);
  const b = newChapter(2);
  return { id: genId(), title: 'My Project', chapters: [a, b], activeChapterId: a.id };
}

const NAME_ADJ = [
  'amber','ancient','broad','calm','clear','crisp','deep','distant',
  'early','faint','fleet','gentle','golden','grand','high','hushed',
  'jade','keen','light','lone','long','low','lunar','mild','moonlit',
  'muted','narrow','open','pale','patient','quiet','radiant','rare',
  'rising','scattered','silver','slow','soft','spare','still','strong',
  'swift','tall','thin','tidal','vast','vivid','warm','wide','wild',
];
const NAME_VERB = [
  'blooming','burning','carrying','chasing','climbing','crossing','curving',
  'dancing','diving','drifting','echoing','finding','flowing','flying',
  'gathering','glowing','growing','holding','humming','keeping','kindling',
  'leaning','lifting','lingering','listening','moving','opening','passing',
  'pouring','reaching','rising','roaming','running','seeking','sending',
  'settling','shining','singing','soaring','spinning','spreading','standing',
  'stirring','streaming','sweeping','touching','tracing','waking','wandering',
  'weaving',
];
const NAME_NOUN = [
  'basin','bloom','bridge','cedar','cliff','coast','comet','crest',
  'current','dawn','delta','depth','drift','dune','ember','field',
  'flame','flight','forest','glacier','glen','harbor','hill','horizon',
  'inlet','island','journey','lake','lantern','leaf','light','maple',
  'meadow','mesa','moon','mountain','oak','ocean','orbit','path','peak',
  'pine','plain','plateau','reef','ridge','river','shore','signal','sky',
  'slope','source','spring','star','stone','stream','summit','tide',
  'timber','trail','valley','vessel','wave','wood',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randomProjectName(existing) {
  const taken = new Set((existing || []).map(p => p.title));
  let name, attempts = 0;
  do {
    name = `${pick(NAME_ADJ)} ${pick(NAME_VERB)} ${pick(NAME_NOUN)}`;
    attempts++;
  } while (taken.has(name) && attempts < 50);
  return name;
}

// ── Multi-project storage helpers ─────────────────────────────────────────────
const PROJECTS_KEY   = 'fwd:projects';

// Async, IDB-first. Falls back to localStorage on first run, migrating to IDB.
// Returns [] (not a seeded project) — caller decides what to show on empty.
async function loadProjects(ownerEmail) {
  // Guest: the only source is the per-tab sessionStorage draft.
  if (_guest) return loadGuestDraft();

  // 1. Try IDB
  const fromIDB = await loadProjectsFromIDB(ownerEmail);
  if (fromIDB.length) return fromIDB.map(migrateProject);

  // 2. IDB empty — fall back to localStorage and migrate
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (raw) {
      const all = JSON.parse(raw).map(migrateProject);
      const owner = ownerEmail || '';
      const owned = owner
        ? all.filter(p => !p.owner || p.owner === owner)
        : all.filter(p => !p.owner); // guest: only unowned projects
      if (owned.length) {
        // Migrate to IDB
        await Promise.all(owned.map(p => saveProjectToIDB(
          owner ? { ...p, owner } : p,
          { pendingSync: false }
        )));
        return owned;
      }
    }
    // Legacy single-project
    const legacy = localStorage.getItem('fwd:project');
    if (legacy) {
      const p = migrateProject({ ...JSON.parse(legacy), id: JSON.parse(legacy).id || genId() });
      const stamped = ownerEmail ? { ...p, owner: ownerEmail } : p;
      await saveProjectToIDB(stamped, { pendingSync: false });
      return [stamped];
    }
  } catch {}

  return [];
}

// Current signed-in user's email — used to stamp projects on save
let _ownerEmail = null;

// Guest mode: when true, all persistence is redirected to sessionStorage
// (via guestStore) and never touches localStorage / IndexedDB. Set per render
// from the Editor's `guest` prop, same pattern as _ownerEmail.
let _guest = false;

// Full save: all projects to IDB + localStorage. Used for structural changes
// (import, delete, reorder) where the whole array may have changed.
function saveProjects(ps) {
  if (_guest) { saveGuestDraft(ps); return; }
  const stamped = ps.map(({ wordAssets: _, ...p }) => _ownerEmail ? { ...p, owner: _ownerEmail } : p);
  Promise.all(stamped.map(p => saveProjectToIDB(p, { pendingSync: true }))).catch(() => {});
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(stamped)); } catch {}
}

// Lightweight: only write the active project to IDB — used on every typing debounce.
// Other projects are untouched; localStorage is flushed separately on navigate/unload.
function saveActiveProjectIDB(project) {
  if (!project) return;
  if (_guest) { saveGuestDraft(project); return; }
  const { wordAssets: _, ...p } = project;
  const stamped = _ownerEmail ? { ...p, owner: _ownerEmail } : p;
  saveProjectToIDB(stamped, { pendingSync: true }).catch(() => {});
}

// Write the full projects array to localStorage — called on navigate away and unload.
function flushLocalStorage(ps) {
  if (_guest) { saveGuestDraft(ps); return; }
  try {
    const stamped = ps.map(({ wordAssets: _, ...p }) => _ownerEmail ? { ...p, owner: _ownerEmail } : p);
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(stamped));
  } catch {}
}

function saveActiveId(id, email) {
  if (_guest) return; // guest is a single draft — nothing to persist, and no localStorage
  try { localStorage.setItem(`fwd:active-project-id:${email || ''}`, id); } catch {}
}

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
// Single opener lives in lib/sync/store.js (v4: adds syncRecords + syncMeta). All
// three former copies (here, App.jsx, Home.jsx) now alias it so the DB is never opened
// at two versions (which would throw VersionError).
const openHandleDB = openDB;

// Project store helpers
// Each entry: { id, owner, pendingSync, lastSynced, data: projectObject }
async function loadProjectsFromIDB(ownerEmail) {
  try {
    const db = await openHandleDB();
    const all = await new Promise(res => {
      const req = db.transaction('projects', 'readonly').objectStore('projects').getAll();
      req.onsuccess = () => res(req.result ?? []);
      req.onerror   = () => res([]);
    });
    const owner = ownerEmail || '';
    return all
      .filter(e => owner ? e.owner === owner : !e.owner)
      .map(e => e.data);
  } catch { return []; }
}

async function saveProjectToIDB(project, { pendingSync = true, lastSynced = null } = {}) {
  try {
    const db = await openHandleDB();
    const owner = project.owner || '';
    // Account-isolation guard (defense-in-depth): the 'projects' store is keyed by id alone, so a
    // save under a different owner would silently move a project between accounts. Never reassign
    // an existing id to a different, non-empty owner. On the web this is a no-op in normal flow
    // (account switches are a full page reload), but it closes the door if identity ever changes
    // in-process. Mirrors the desktop guard.
    const existing = await new Promise(res => {
      const r = db.transaction('projects', 'readonly').objectStore('projects').get(project.id);
      r.onsuccess = () => res(r.result || null);
      r.onerror   = () => res(null);
    });
    if (existing && (existing.owner || '') && (existing.owner || '') !== owner) return;
    await new Promise((res, rej) => {
      const entry = { id: project.id, owner, pendingSync, lastSynced, data: project };
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(entry);
      tx.oncomplete = res; tx.onerror = rej;
    });
  } catch {}
}

async function getWordAssets(projectId) {
  try {
    const db = await openHandleDB();
    return await new Promise(res => {
      const req = db.transaction('wordAssets', 'readonly').objectStore('wordAssets').get(projectId);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = () => res(null);
    });
  } catch { return null; }
}

async function setWordAssets(projectId, assets) {
  try {
    const db = await openHandleDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('wordAssets', 'readwrite');
      tx.objectStore('wordAssets').put(assets, projectId);
      tx.oncomplete = res; tx.onerror = rej;
    });
  } catch {}
}

async function deleteWordAssets(projectId) {
  try {
    const db = await openHandleDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('wordAssets', 'readwrite');
      tx.objectStore('wordAssets').delete(projectId);
      tx.oncomplete = res; tx.onerror = rej;
    });
  } catch {}
}

async function getFileHandle(projectId) {
  try {
    const db = await openHandleDB();
    return await new Promise(res => {
      const req = db.transaction('handles', 'readonly').objectStore('handles').get(projectId);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = () => res(null);
    });
  } catch { return null; }
}

async function setFileHandle(projectId, handle) {
  try {
    const db = await openHandleDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, projectId);
      tx.oncomplete = res; tx.onerror = rej;
    });
  } catch {}
}

async function deleteFileHandle(projectId) {
  try {
    const db = await openHandleDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').delete(projectId);
      tx.oncomplete = res; tx.onerror = rej;
    });
  } catch {}
}

const FSA_SUPPORTED = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

function countWords(text) {
  return (text || '').trim() ? (text || '').trim().split(/\s+/).filter(Boolean).length : 0;
}

// ── Share-progress card ─────────────────────────────────────────────────────
// Renders a square PNG "progress card" for a project onto a canvas and returns it.
// Pure drawing — no React, no DOM beyond an offscreen canvas.
function wrapCardText(ctx, text, maxWidth) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

// "Saturday the 11th of July, 2026" — long log-style date for the progress card.
function logDate(d = new Date()) {
  const n = d.getDate();
  const v = n % 100;
  const suffix = ['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th';
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
  const month   = d.toLocaleDateString('en-US', { month: 'long' });
  return `${weekday} the ${n}${suffix} of ${month}, ${d.getFullYear()}`;
}

function renderProgressCard({ title, words, sections, colors, entryLabel, dateStr }) {
  const W = 1080, H = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const { bg, panel, border, text, muted, accent, accentText } = colors;
  const cx = W / 2;

  // Outer + inner panel
  ctx.fillStyle = bg;    ctx.fillRect(0, 0, W, H);
  const M = 72;
  ctx.fillStyle = panel; ctx.fillRect(M, M, W - 2 * M, H - 2 * M);
  ctx.fillStyle = accent; ctx.fillRect(M, M, W - 2 * M, 10);        // accent hairline at top
  ctx.strokeStyle = border; ctx.lineWidth = 2;
  ctx.strokeRect(M + 1, M + 1, W - 2 * M - 2, H - 2 * M - 2);

  ctx.textAlign = 'center';

  // Eyebrow
  ctx.fillStyle = muted;
  ctx.font = 'italic 30px Georgia, serif';
  ctx.fillText('a forward-only draft', cx, M + 130);

  // Title — pick the largest size that fits within 3 lines
  const maxTitleWidth = W - 2 * M - 120;
  let titleSize = 76, titleLines;
  for (const size of [76, 66, 58, 50, 44]) {
    ctx.font = `bold ${size}px Georgia, serif`;
    titleLines = wrapCardText(ctx, title || 'Untitled', maxTitleWidth).slice(0, 3);
    titleSize = size;
    if (wrapCardText(ctx, title || 'Untitled', maxTitleWidth).length <= 3) break;
  }
  ctx.fillStyle = text;
  ctx.font = `bold ${titleSize}px Georgia, serif`;
  const titleLineH = titleSize * 1.18;
  const titleBlockH = titleLines.length * titleLineH;
  let ty = 372 - titleBlockH / 2 + titleSize * 0.85;
  for (const ln of titleLines) { ctx.fillText(ln, cx, ty); ty += titleLineH; }

  // Divider
  ctx.strokeStyle = border; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx - 90, 560); ctx.lineTo(cx + 90, 560); ctx.stroke();

  // Stats — two columns
  const colGap = 190;
  const stat = (x, num, label) => {
    ctx.fillStyle = text;
    ctx.font = '600 108px Georgia, serif';
    ctx.fillText(num, x, 720);
    ctx.fillStyle = muted;
    ctx.font = '28px Georgia, serif';
    ctx.fillText(label, x, 772);
  };
  stat(cx - colGap, words.toLocaleString(), words === 1 ? 'word' : 'words');
  const secLabel = (entryLabel || 'section') + (sections === 1 ? '' : 's');
  stat(cx + colGap, sections.toLocaleString(), secLabel);

  // Date — same small register as the stat labels; turns the card into a dated entry
  if (dateStr) {
    ctx.textAlign = 'center';
    ctx.fillStyle = muted;
    ctx.font = '28px Georgia, serif';
    ctx.fillText(dateStr, cx, 858);
  }

  // Footer — "written by a human at write.mercoogs.com" (brand emphasised)
  const footY = 930;
  const phrase = 'written by a human at ';
  const brand  = 'write.mercoogs.com';
  ctx.textAlign = 'left';
  ctx.font = 'italic 34px Georgia, serif';
  const wPhrase = ctx.measureText(phrase).width;
  ctx.font = 'bold 34px Georgia, serif';
  const wBrand = ctx.measureText(brand).width;
  const startX = cx - (wPhrase + wBrand) / 2;
  ctx.fillStyle = muted;
  ctx.font = 'italic 34px Georgia, serif';
  ctx.fillText(phrase, startX, footY);
  ctx.fillStyle = accent === panel ? text : accent;
  ctx.font = 'bold 34px Georgia, serif';
  ctx.fillText(brand, startX + wPhrase, footY);

  return canvas;
}

// Cross-browser caretRangeFromPoint (Chrome + Firefox)
function caretRangeFromPoint(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    r.collapse(true);
    return r;
  }
  return null;
}

// ── Editor DOM helpers ────────────────────────────────────────────────────────

// Get character offset of the cursor within a contenteditable element
function getCursorOffset(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

// Place cursor at a character offset within a contenteditable element
function scrollCursorIntoView(scrollEl) {
  if (!scrollEl) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const rect  = range.getBoundingClientRect();
  if (!rect) return;
  const containerRect = scrollEl.getBoundingClientRect();
  const relativeTop   = rect.top - containerRect.top + scrollEl.scrollTop;
  scrollEl.scrollTop  = Math.max(0, relativeTop - scrollEl.clientHeight / 2);
}

function setCursorOffset(el, targetOffset) {
  const sel = window.getSelection();
  if (!sel) return;
  let remaining = targetOffset;
  let found = false;
  function walk(node) {
    if (found) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (remaining <= node.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        found = true;
        return;
      }
      remaining -= node.length;
    } else {
      for (const child of node.childNodes) walk(child);
    }
  }
  walk(el);
  if (!found) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// Get {start, end} character offsets for the current selection within el,
// or null if the selection is collapsed / outside el
function getSelectionOffsets(el) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return null;
  const preStart = document.createRange();
  preStart.selectNodeContents(el);
  preStart.setEnd(range.startContainer, range.startOffset);
  const start = preStart.toString().length;
  const preEnd = document.createRange();
  preEnd.selectNodeContents(el);
  preEnd.setEnd(range.endContainer, range.endOffset);
  const end = preEnd.toString().length;
  return start === end ? null : { start, end };
}

// ── Annotation colour palettes ────────────────────────────────────────────────
// Each entry: [idle (margin bar + text highlight), active (margin bar focused)]
// One 6-colour palette per editor theme.
const ANN_PALETTES = {
  parchment: [
    ['rgba(255, 210, 100, 0.50)', 'rgba(230, 155,  15, 0.85)'], // amber
    ['rgba(110, 185, 255, 0.45)', 'rgba( 30, 115, 230, 0.80)'], // blue
    ['rgba(140, 220, 140, 0.45)', 'rgba( 35, 165,  55, 0.80)'], // green
    ['rgba(255, 155, 190, 0.45)', 'rgba(215,  45, 110, 0.80)'], // pink
    ['rgba(200, 160, 255, 0.45)', 'rgba(120,  45, 220, 0.80)'], // purple
    ['rgba(130, 220, 210, 0.45)', 'rgba( 10, 155, 150, 0.80)'], // teal
    ['rgba(255, 135,  75, 0.45)', 'rgba(220,  80,  25, 0.80)'], // coral
    ['rgba(175, 195,  80, 0.45)', 'rgba(115, 150,  20, 0.80)'], // olive
  ],
  slate: [
    ['rgba( 80, 155, 255, 0.55)', 'rgba( 80, 155, 255, 0.90)'], // cobalt
    ['rgba(175, 125, 255, 0.50)', 'rgba(155,  80, 255, 0.90)'], // violet
    ['rgba( 60, 210, 200, 0.45)', 'rgba( 10, 195, 185, 0.90)'], // cyan
    ['rgba(255, 120, 155, 0.50)', 'rgba(230,  55,  95, 0.90)'], // rose
    ['rgba(145, 225,  95, 0.45)', 'rgba( 75, 195,  35, 0.90)'], // lime
    ['rgba(255, 195,  65, 0.45)', 'rgba(215, 155,  10, 0.90)'], // gold
    ['rgba(255, 150,  65, 0.50)', 'rgba(230, 110,  15, 0.90)'], // orange
    ['rgba( 80, 230, 170, 0.45)', 'rgba( 20, 200, 140, 0.90)'], // mint
  ],
  midnight: [
    ['rgba( 90, 175, 255, 0.50)', 'rgba(110, 190, 255, 0.80)'], // electric blue
    ['rgba( 75, 215, 130, 0.45)', 'rgba( 80, 230, 140, 0.80)'], // neon green
    ['rgba(255, 110,  80, 0.45)', 'rgba(255, 120,  85, 0.75)'], // ember
    ['rgba(185, 115, 255, 0.45)', 'rgba(195, 125, 255, 0.80)'], // purple
    ['rgba( 45, 210, 205, 0.40)', 'rgba( 50, 220, 215, 0.80)'], // cyan
    ['rgba(245, 175,  55, 0.45)', 'rgba(250, 185,  60, 0.80)'], // gold
    ['rgba(255,  80, 200, 0.45)', 'rgba(240,  50, 185, 0.75)'], // magenta
    ['rgba(185, 185, 185, 0.40)', 'rgba(205, 205, 205, 0.75)'], // silver
  ],
  warm: [
    ['rgba(210,  90,  50, 0.40)', 'rgba(220, 100,  55, 0.80)'], // rust
    ['rgba(195, 155,  30, 0.45)', 'rgba(200, 160,  35, 0.85)'], // ochre
    ['rgba( 70, 150,  70, 0.40)', 'rgba( 75, 160,  75, 0.80)'], // forest
    ['rgba(155,  45,  75, 0.35)', 'rgba(160,  50,  80, 0.75)'], // burgundy
    ['rgba(170, 110,  65, 0.40)', 'rgba(180, 120,  70, 0.80)'], // sienna
    ['rgba(110, 150, 100, 0.40)', 'rgba(115, 160, 105, 0.80)'], // sage
    ['rgba(195, 120,  75, 0.40)', 'rgba(200, 130,  80, 0.80)'], // clay
    ['rgba( 90, 130,  55, 0.40)', 'rgba( 95, 140,  60, 0.80)'], // moss
  ],
};

function annIdle(colorIndex, palette)   { return palette[(colorIndex || 0) % palette.length][0]; }
function annActive(colorIndex, palette) { return palette[(colorIndex || 0) % palette.length][1]; }

// Create a DOM Range spanning [startOff, endOff] character offsets within el.
// Used to measure real visual Y positions via getClientRects().
function createRangeForOffsets(el, startOff, endOff) {
  const range = document.createRange();
  let pos = 0, startSet = false, endSet = false;
  function walk(node) {
    if (startSet && endSet) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (!startSet && pos + node.length >= startOff) {
        range.setStart(node, startOff - pos); startSet = true;
      }
      if (startSet && !endSet && pos + node.length >= endOff) {
        range.setEnd(node, endOff - pos); endSet = true;
      }
      pos += node.length;
    } else { for (const c of node.childNodes) walk(c); }
  }
  walk(el);
  if (!endSet) { try { range.setEnd(el, el.childNodes.length); } catch(_) {} }
  return range;
}

// Rebuild the contenteditable's DOM nodes from plain text + annotation marks.
// Uses an event-based segmenter so overlapping annotations are all rendered.
// Does NOT save/restore cursor — caller must do that if the element is focused.
function buildEditorDOM(el, text, annotations) {
  const contentAnns = (annotations || [])
    .filter(a => a.anchorType !== 'title' && a.start < text.length && a.end > a.start);

  el.innerHTML = '';

  if (contentAnns.length === 0) {
    if (text) el.appendChild(document.createTextNode(text));
    return;
  }

  const events = [];
  for (const ann of contentAnns) {
    events.push({ pos: Math.max(0, ann.start),           type: 'start', ann });
    events.push({ pos: Math.min(ann.end, text.length),   type: 'end',   ann });
  }
  events.sort((a, b) => a.pos - b.pos || (a.type === 'end' ? -1 : 1));

  const segments = [];
  const covering = new Map();
  let pos = 0;

  for (const evt of events) {
    const p = evt.pos;
    if (p > pos) segments.push({ text: text.slice(pos, p), anns: [...covering.values()] });
    pos = p;
    if (evt.type === 'start') covering.set(evt.ann.id, evt.ann);
    else                       covering.delete(evt.ann.id);
  }
  if (pos < text.length) segments.push({ text: text.slice(pos), anns: [] });

  for (const seg of segments) {
    if (seg.anns.length === 0) {
      el.appendChild(document.createTextNode(seg.text));
    } else {
      const mark = document.createElement('mark');
      mark.dataset.annIds        = seg.anns.map(a => a.id).join(',');
      mark.style.backgroundColor = 'transparent';
      mark.appendChild(document.createTextNode(seg.text));
      el.appendChild(mark);
    }
  }
}

// Adjust annotation character offsets after the user edits the text.
// cursor: position of caret after the edit, delta: newLen - oldLen
function adjustAnnotationOffsets(annotations, oldText, newText, cursor) {
  const delta = newText.length - oldText.length;
  if (delta === 0) return annotations;

  const changePos = delta > 0 ? cursor - delta : cursor;
  const deleteEnd = delta < 0 ? cursor - delta : cursor;

  return annotations.map(ann => {
    if (ann.anchorType === 'title') return ann;
    let { start, end } = ann;
    if (delta > 0) {
      if (start >= changePos) start += delta;
      if (end   >= changePos) end   += delta;
    } else {
      if (start >= deleteEnd)      start += delta;
      else if (start > changePos)  start  = changePos;
      if (end   >= deleteEnd)      end   += delta;
      else if (end   > changePos)  end    = changePos;
    }
    start = Math.max(0, start);
    end   = Math.max(start, Math.max(0, end));
    return { ...ann, start, end };
  });
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_PAD_PX = 94.5;   // 2.5cm at 96 dpi
const TEXT_OFFSET = 38 + 16; // title input height + editor padding-top
const LINE_H      = 15 * 1.8;
const ICON_H      = 18;

// Fallback-only estimate used when DOM measurement isn't available yet.
function estimateLineY(content, charOffset) {
  const lineNum = (content.slice(0, charOffset).match(/\n/g) || []).length;
  return TEXT_OFFSET + lineNum * LINE_H;
}

// Takes a { annId → rawY } map (from DOM measurements) and returns
// an array of { y, anns[] } groups, one per visual text row.
function layoutMarkers(anns, rawYs) {
  const items = anns
    .map(ann => ({ ann, rawY: rawYs[ann.id] ?? PAGE_PAD_PX + 6 }))
    .sort((a, b) => a.rawY - b.rawY);

  // Group annotations whose measured Y values land within the same visual line.
  // LINE_H * 0.75 ≈ 20px — tight enough to avoid merging adjacent lines.
  const groups = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && item.rawY - last.rawY < LINE_H * 0.75) {
      last.anns.push(item.ann);
    } else {
      groups.push({ rawY: item.rawY, anns: [item.ann] });
    }
  }

  // Nudge groups downward so they don't overlap each other
  for (let i = 1; i < groups.length; i++) {
    if (groups[i].rawY < groups[i - 1].rawY + ICON_H) {
      groups[i].rawY = groups[i - 1].rawY + ICON_H;
    }
  }

  return groups.map(g => ({ y: g.rawY, anns: g.anns }));
}

const MS_STORE_URL = 'https://marketplace.microsoft.com/en-us/product/office/WA200011123';

// ── Component ─────────────────────────────────────────────────────────────────

export default function Editor({ user, onSignIn, onSignOut, onGoHome = null, welcomeProject = null, openProjectId = null, newProjectType = null, jumpTarget = null, searchTerm = '', syncReconnect = false, onReconnect = null, guest = false }) {
  // Stamp saves with the current user's email so different accounts on the same
  // device never see each other's projects. Set before any state initialisation.
  _ownerEmail = user?.email || null;
  // Guest mode redirects all persistence to sessionStorage (see guestStore).
  _guest = !!guest;

  const [projects,       setProjects]       = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(welcomeProject?.id || '');
  const [dbReady,        setDbReady]         = useState(false);
  const fallbackProjectRef = useRef(null); // stable placeholder while projects are still loading — see usage below
  // Keep latestProjectsRef current so debounced saves always write the newest state
  useEffect(() => { latestProjectsRef.current = projects; }, [projects]);

  // Flush full localStorage snapshot on tab close / refresh so the backup stays current
  useEffect(() => {
    function onUnload() {
      flushLocalStorage(latestProjectsRef.current.length ? latestProjectsRef.current : projects);
    }
    window.addEventListener('beforeunload', onUnload);
    // Guest drafts live only in sessionStorage; beforeunload is unreliable
    // (especially mobile Safari), so also flush on pagehide and when the tab
    // is hidden. Gated to guest so non-guest write frequency is unchanged.
    function onHide() { if (document.visibilityState === 'hidden') onUnload(); }
    if (_guest) {
      window.addEventListener('pagehide', onUnload);
      document.addEventListener('visibilitychange', onHide);
    }
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      if (_guest) {
        window.removeEventListener('pagehide', onUnload);
        document.removeEventListener('visibilitychange', onHide);
      }
    };
  }, []);

  // Track which welcome chapter is active — not persisted to localStorage
  const [activeWelcomeChapterId, setActiveWelcomeChapterId] = useState(
    () => welcomeProject?.activeChapterId || welcomeProject?.chapters?.[0]?.id || null
  );
  const [fsaDegraded,    setFsaDegraded]    = useState(false);
  const [isMobile,       setIsMobile]       = useState(() => window.innerWidth < 768);
  const [sidebarOpen,    setSidebarOpen]    = useState(false);
  const [sheetOffset,    setSheetOffset]    = useState(0);

  const [focusOpen, setFocusOpen]         = useState(false);
  // Covers the brief editor mount when jumping Home → Forward, so you don't see the project
  // (and any recovery prompt) flash before the Forward overlay opens. Seeded from the mount-time
  // jumpTarget so the cover is on the VERY FIRST paint — otherwise the editor flashes for one
  // frame before the effect can set it.
  const [focusJumpCover, setFocusJumpCover] = useState(() => jumpTarget?.mode === 'focus');
  const [focusAutoPublish, setFocusAutoPublish] = useState(false);
  const [draftRecovery,   setDraftRecovery]   = useState(null);  // a crashed Forward draft offered for recovery
  const [confirmDialog,   setConfirmDialog]   = useState(null);  // themed destructive confirm: { title, body, confirmLabel, onConfirm }
  const [focusResumeText, setFocusResumeText] = useState('');    // seeds FocusMode when resuming a draft
  const [findOpen,  setFindOpen]          = useState(false); // in-project find bar (Ctrl/Cmd-F)
  const [findQuery, setFindQuery]         = useState('');
  const [findIdx,   setFindIdx]           = useState(0);
  const [findActive, setFindActive]       = useState(null);  // { chapterId, offset, length } current match
  const [findRects,  setFindRects]        = useState([]);    // overlay highlight rects (page-layout coords)
  const [sectionWarn, setSectionWarn]     = useState(null);  // { threshold } when the active section gets long
  const [forwardIntro, setForwardIntro]   = useState(false); // one-time "forward only" intro on first Forward entry
  const warnShownRef  = useRef({});                           // chapterId -> highest word threshold already warned
  const sizeCheckTimer = useRef(null);                        // 1.5s debounce for the long-section warning
  const preFocusCursorRef                 = useRef(0); // cursor offset saved before entering Forward mode
  const [saved, setSaved]                 = useState(true);
  const [titleEditing, setTitleEditing]   = useState(false);
  const [zoom, setZoom]                   = useState(() => {
    const v = parseFloat(localStorage.getItem(`fwd:zoom:${user?.email || ''}`));
    return isNaN(v) ? 1 : v;
  });
  const [annPanelOpen, setAnnPanelOpen]   = useState(!!welcomeProject); // open by default for guests
  const [addingAnn, setAddingAnn]         = useState(false);
  const [annInput, setAnnInput]           = useState('');
  const [annHint,  setAnnHint]            = useState('');
  const [newProjectPrompt, setNewProjectPrompt] = useState(false);
  const [exportOpen,   setExportOpen]           = useState(false);  // export-format menu (guest + signed-in)

  const [expandedAnnId, setExpandedAnnId]     = useState(null);
  const [editingAnnId,  setEditingAnnId]      = useState(null);
  const [editingNote, setEditingNote]         = useState('');
  const [levelPickerOpen, setLevelPickerOpen] = useState(false);
  const [themeMenuOpen,   setThemeMenuOpen]   = useState(false); // theme text-button dropdown (replaces the native select)
  const themeMenuRef = useRef(null);
  const [hoveredChapter, setHoveredChapter]   = useState(null);  // section row whose ··· control is revealed
  const [secMenuId,       setSecMenuId]       = useState(null);  // section row whose ··· menu is open
  const secMenuRef = useRef(null);
  const [sidebarWidth,       setSidebarWidth]       = useState(() => {
    const v = parseInt(localStorage.getItem(`fwd:sidebar-width:${user?.email || ''}`), 10);
    if (!isNaN(v)) return Math.max(160, Math.min(480, v));
    // First visit: 30% of viewport width, capped at 480px
    return Math.min(480, Math.round(window.innerWidth * 0.3));
  });
  const [sidebarHandleHover, setSidebarHandleHover] = useState(false);

  // welcomeProject is always prepended to the list when provided
  const allProjects = (welcomeProject ? [welcomeProject, ...projects] : [...projects])
    .sort((a, b) => {
      const ta = a.type || '';
      const tb = b.type || '';
      return ta.localeCompare(tb) || (a.title || '').localeCompare(b.title || '');
    });
  // Fallback while projects are still loading (brief window before loadProjects()
  // resolves) — cached once per mount so its chapters/annotations array keep a
  // stable identity across renders. newProject() called directly here would
  // return a brand-new object (new id, new empty annotations array) on every
  // render, which several effects further down key off activeChapter.annotations
  // by reference — a fresh reference each render made those effects think their
  // dependency changed every time, triggering setState in a loop (React's
  // "Maximum update depth exceeded").
  if (!fallbackProjectRef.current) fallbackProjectRef.current = newProject();
  const project     = allProjects.find(p => p.id === activeProjectId) || allProjects[0] || fallbackProjectRef.current;
  // readOnly whenever the welcome project is the active one
  const isReadOnly  = welcomeProject !== null && project.id === welcomeProject.id;
  const isJournal      = project.type === 'journal' || !!project.journalMode;
  const usesDateTitle  = project.type === 'journal' || project.type === 'log' || !!project.journalMode;
  const usesEntryLabel = isJournal || project.type === 'log';

  const editorRef          = useRef(null);
  const titleRef           = useRef(null);
  const mainScrollRef      = useRef(null);
  const pageRef            = useRef(null);
  const selectionRef       = useRef({ start: 0, end: 0, anchorType: 'content' });
  const selectionSourceRef = useRef('content');
  // Snapshot of the last non-empty selection — survives button taps that collapse
  // the browser selection before startAddAnnotation/saveAnnotation can read it.
  const pendingSelRef      = useRef({ start: 0, end: 0, anchorType: 'content' });
  const annIdsRef          = useRef('');
  const dragIdRef          = useRef(null);
  const pendingJumpRef     = useRef(null); // { cursor, mode } applied after next DOM rebuild
  const pendingFindSelRef  = useRef(null); // { offset, length } find selection applied after a chapter switch
  const pendingSearchLandRef = useRef(false); // land on first hit once hits resolve (homepage search open)
  const findInputRef       = useRef(null);
  const focusOpenRef       = useRef(false); // mirror of focusOpen for the Ctrl+F listener closure
  // Forward-mode crash-recovery draft (see lib/forwardDraft.js).
  const focusSessionRef    = useRef(null);  // { projectId, chapterId, cursor } captured when Forward opens
  const focusDraftTimer    = useRef(null);  // trailing debounce handle for the draft write
  const focusDraftMaxTimer = useRef(null);  // maxWait ceiling — guarantees a write during unbroken typing
  const pendingDraftRef    = useRef(null);  // latest draft awaiting the debounce (also flushed on unload)
  const cursorSaveTimer    = useRef(null); // debounce handle for cursor position persistence
  const persistTimer       = useRef(null); // debounce handle for IDB/localStorage persistence
  const persistMaxTimer    = useRef(null); // maxWait ceiling — guarantees an IDB write during unbroken typing (hard-crash guard)
  const latestProjectsRef  = useRef([]);  // mirror of projects state for debounced saves
  const importRef          = useRef(null);
  const levelPickerRef     = useRef(null);
  const sidebarDragRef     = useRef(null); // { startX, startWidth } while dragging
  const projectRef         = useRef(project);
  const lastSyncedRef      = useRef((() => {  // ISO timestamp of last successful cloud push/pull
    try { return localStorage.getItem(`fwd:lastSynced:${user?.email || ''}`) || null; } catch { return null; }
  })());
  function setLastSynced(ts) {
    lastSyncedRef.current = ts;
    try { localStorage.setItem(`fwd:lastSynced:${user?.email || ''}`, ts); } catch {}
  }
  const [syncStatus,  setSyncStatus]  = useState('idle'); // 'idle'|'syncing'|'synced'|'error'|'offline'
  const [syncError,   setSyncError]   = useState('');    // last error detail for debugging
  const online = useOnline();
  const [dragOverId,  setDragOverId]  = useState(null);
  const [markerYs,    setMarkerYs]    = useState({});
  const [copiedId,    setCopiedId]    = useState(null);
  const [shareModal,   setShareModal]   = useState(false);  // share dialog open
  const [shareLinks,    setShareLinks]    = useState({});  // { [shareKey]: driveUrl } — derived from project.shares
  const [shareStatuses, setShareStatuses] = useState(() => {  // { [shareId]: 'reported'|'blocked'|'active' }
    try { return JSON.parse(localStorage.getItem(`fwd:share-statuses:${user?.email || ''}`) || '{}'); } catch { return {}; }
  });
  const [shareLoading,  setShareLoading]  = useState(null);   // share key currently creating/updating
  const [shareCopied,   setShareCopied]   = useState(null);   // share id just copied
  const [progressModal, setProgressModal] = useState(false);  // "share progress" card dialog
  const [progressUrl,   setProgressUrl]   = useState('');     // data URL of the generated card
  const [progressSaved, setProgressSaved] = useState(false);  // "saved ✓" flash after download
  const [progressCopied, setProgressCopied] = useState('');   // '' | 'image' | 'text' — copy flash
  const [progressMeta,  setProgressMeta]  = useState(null);   // { title, words, sections, secWord, dateStr, textLine }
  const progressCanvasRef = useRef(null);                     // last-generated card canvas (for blob/share)
  const [guestCopied,   setGuestCopied]   = useState(false);  // "copied ✓" flash on guest copy-all
  const [showGuestHint, setShowGuestHint] = useState(() => {  // onboarding pointer to the Forward button
    try { return guest && !sessionStorage.getItem('oodbo.guest.hintSeen'); } catch { return !!guest; }
  });
  const [tourPromptOpen, setTourPromptOpen] = useState(() => {  // desktop-only "take a tour" offer on first land
    try { return guest && window.innerWidth >= 768 && !sessionStorage.getItem('oodbo.guest.tourSeen'); } catch { return false; }
  });
  const [tourStep,    setTourStep]    = useState(null);  // null = tour not running; 0..n = current step
  const [tourSkipped, setTourSkipped] = useState(false);
  const [editorTheme, setEditorTheme] = useState(
    () => localStorage.getItem(`fwd:editor-theme:${user?.email || ''}`) || 'parchment'
  );

  const th         = EDITOR_THEMES[editorTheme] || EDITOR_THEMES.parchment;
  const annPalette = ANN_PALETTES[editorTheme]  || ANN_PALETTES.parchment;
  const dg         = dialog(th, { mobile: isMobile });   // dialog primitive styles for this render
  const dgD        = dialog(th, { mobile: isMobile, destructive: true });   // destructive variant (danger rule)

  function handleZoom(val) {
    setZoom(val);
    localStorage.setItem(`fwd:zoom:${user?.email || ''}`, val);
  }

  // Fallback: anchor download, no picker, no FSA. Used when FSA unavailable or permission denied.
  function triggerDownload(proj) {
    const p    = proj || project;
    const blob = new Blob([projectToXml(p)], { type: 'application/xml' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${(p.title || 'oodbo').replace(/[^a-z0-9]/gi, '-')}.oodbo`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Export the active project (free for everyone, incl. guests) ──────────────
  // Mirrors Home's export menu but for the one open project — a guest's writing
  // is ephemeral, so an export is their way to keep it. No "export all": there's
  // only one project in this context.
  const exportSafeName = (t) => (t || 'oodbo').replace(/[^a-z0-9]/gi, '-');
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }
  function projectToTxt(p) {
    const lines = [];
    if (p.title) { lines.push(p.title.toUpperCase()); lines.push('='.repeat(p.title.length)); lines.push(''); }
    for (const ch of p.chapters || []) {
      if (ch.title) { lines.push(ch.title); lines.push('-'.repeat(ch.title.length)); }
      if (ch.content) lines.push(ch.content);
      lines.push('');
    }
    return lines.join('\n');
  }
  function projectToMd(p) {
    const lines = [];
    if (p.title) { lines.push(`# ${p.title}`); lines.push(''); }
    for (const ch of p.chapters || []) {
      if (ch.title) { lines.push(`${'#'.repeat((ch.level || 1) + 1)} ${ch.title}`); lines.push(''); }
      if (ch.content) { lines.push(ch.content); lines.push(''); }
    }
    return lines.join('\n');
  }
  async function handleExport(fmt) {
    setExportOpen(false);
    const p    = project;
    const base = exportSafeName(p.title);
    try {
      if (fmt === 'oodbo') {
        downloadBlob(new Blob([projectToXml(p)], { type: 'application/xml' }), `${base}.oodbo`);
      } else if (fmt === 'docx') {
        downloadBlob(await exportDocx(p), `${base}.docx`);
      } else if (fmt === 'pdf') {
        downloadBlob(exportPdf(p), `${base}.pdf`);
      } else if (fmt === 'txt') {
        downloadBlob(new Blob([projectToTxt(p)], { type: 'text/plain' }), `${base}.txt`);
      } else if (fmt === 'md') {
        downloadBlob(new Blob([projectToMd(p)], { type: 'text/markdown' }), `${base}.md`);
      }
    } catch {
      setConfirmDialog({ title: 'Export failed', body: `Could not export the .${fmt} file.`, notice: true });
    }
  }

  // ── FSA save functions ─────────────────────────────────────────────────────

  // requestPerm=true  → requestPermission (user-initiated, may show browser prompt)
  // requestPerm=false → queryPermission   (background, never prompts)
  async function writeFSA(handle, xml, requestPerm = true) {
    if (handle.requestPermission) {
      const method = requestPerm ? 'requestPermission' : 'queryPermission';
      const perm   = await handle[method]({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('permission-denied');
    }
    const w = await handle.createWritable();
    await w.write(xml);
    await w.close();
  }

  async function handleSave() {
    if (!FSA_SUPPORTED) { triggerDownload(); return; }

    const xml = projectToXml(project);
    let handle = await getFileHandle(project.id);

    if (!handle) {
      // First save for this project — open picker
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: `${(project.title || 'oodbo').replace(/[^a-z0-9]/gi, '-')}.oodbo`,
          types: [{ description: 'oodbo project', accept: { 'application/xml': ['.oodbo'] } }],
        });
        await setFileHandle(project.id, handle);
      } catch { return; } // user cancelled picker
    }

    try {
      await writeFSA(handle, xml, true); // may prompt Firefox for permission
      setFsaDegraded(false);
    } catch (err) {
      if (err.message === 'permission-denied') {
        // User denied — fall back to download for this session, Save As hides
        setFsaDegraded(true);
        triggerDownload();
      } else {
        // Stale handle (file moved/deleted) — clear it, then open picker to re-establish
        await deleteFileHandle(project.id);
        try {
          const fresh = await window.showSaveFilePicker({
            suggestedName: `${(project.title || 'oodbo').replace(/[^a-z0-9]/gi, '-')}.oodbo`,
            types: [{ description: 'oodbo project', accept: { 'application/xml': ['.oodbo'] } }],
          });
          await setFileHandle(project.id, fresh);
          await writeFSA(fresh, xml, true);
          setFsaDegraded(false);
        } catch { /* picker cancelled or failed — do nothing */ }
      }
    }
  }

  async function handleSaveAs() {
    if (!FSA_SUPPORTED) return;
    const xml = projectToXml(project);
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `${(project.title || 'oodbo').replace(/[^a-z0-9]/gi, '-')}.oodbo`,
        types: [{ description: 'oodbo project', accept: { 'application/xml': ['.oodbo'] } }],
      });
      await setFileHandle(project.id, handle);
      await writeFSA(handle, xml, true);
      setFsaDegraded(false);
    } catch (err) {
      if (err.message === 'permission-denied') setFsaDegraded(true);
      // user cancelled picker → do nothing
    }
  }

  // ── Import ─────────────────────────────────────────────────────────────────

  function handleImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (file.name.toLowerCase().endsWith('.zip')) {
      const reader = new FileReader();
      reader.onload = async ev => {
        try {
          const zip = await JSZip.loadAsync(ev.target.result);
          const names = Object.keys(zip.files).filter(n => {
            const low = n.toLowerCase();
            return (low.endsWith('.oodbo') || low.endsWith('.xml')) && !zip.files[n].dir;
          });
          if (names.length === 0) { setConfirmDialog({ title: 'Import failed', body: 'No .oodbo files found in the zip.', notice: true }); return; }
          const imported = [];
          for (const name of names) {
            try {
              const content = await zip.files[name].async('string');
              const proj = xmlToProject(content);
              if (!proj.id) proj.id = genId();
              imported.push(proj);
            } catch { /* skip invalid */ }
          }
          if (imported.length === 0) { setConfirmDialog({ title: 'Import failed', body: 'Could not read any .oodbo files from the zip.', notice: true }); return; }
          setProjects(prev => {
            let next = [...prev];
            for (const proj of imported) {
              const idx = next.findIndex(p => p.id === proj.id);
              if (idx >= 0) next[idx] = proj; else next.push(proj);
            }
            saveProjectsDirty(next);
            return next;
          });
          const lastId = imported[imported.length - 1].id;
          setActiveProjectId(lastId);
          saveActiveId(lastId, user?.email);
        } catch { setConfirmDialog({ title: 'Import failed', body: 'Could not read the zip file.', notice: true }); }
      };
      reader.readAsArrayBuffer(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const imported = xmlToProject(ev.target.result);
        if (!imported.id) imported.id = genId();
        setProjects(prev => {
          const exists = prev.find(p => p.id === imported.id);
          const next   = exists ? prev.map(p => p.id === imported.id ? imported : p) : [...prev, imported];
          saveProjectsDirty(next);
          return next;
        });
        setActiveProjectId(imported.id);
        saveActiveId(imported.id, user?.email);
      } catch { setConfirmDialog({ title: 'Import failed', body: "Could not read the file. Make sure it's a valid .oodbo file.", notice: true }); }
    };
    reader.readAsText(file);
  }

  // ── Project operations ─────────────────────────────────────────────────────

  function switchProject(id) {
    setActiveProjectId(id);
    saveActiveId(id, user?.email);
  }

  function addProject() {
    setNewProjectPrompt(true);
  }

  function createProjectOfType(type) {
    const ch = newChapter(1, type === 'journal' || type === 'log');
    const p  = { id: genId(), title: randomProjectName(projects), type, chapters: [ch], activeChapterId: ch.id };
    setProjects(prev => { const next = [...prev, p]; saveProjects(next); return next; });
    setActiveProjectId(p.id);
    saveActiveId(p.id, user?.email);
    setNewProjectPrompt(false);
    setFocusAutoPublish(true);
    setFocusOpen(true);
  }

  // Push the active project if dirty, then navigate home.
  // Fire-and-forget push — don't block the user waiting for upload.
  function handleGoHome(msg) {
    // Flush the full localStorage snapshot now — it was deferred during typing
    clearTimeout(persistTimer.current);
    clearTimeout(persistMaxTimer.current); persistMaxTimer.current = null;
    flushLocalStorage(latestProjectsRef.current.length ? latestProjectsRef.current : projects);

    // Push the active project now (user-initiated → no jitter); fire-and-forget so we
    // don't block navigation. A failure just leaves it dirty for the next sweep.
    getEngine()?.syncOne(projectRef.current?.id, { userInitiated: true });
    if (onGoHome) onGoHome(msg);
  }

  const activeChapter = project.chapters.find(c => c.id === (isReadOnly ? activeWelcomeChapterId : project.activeChapterId))
    || project.chapters[0];

  // In-project find (Ctrl/Cmd-F): ordered, cyclable hits over the whole in-memory project.
  // Recomputes only while the bar is open — closed → no cost. See src/lib/search.
  const findHits = useMemo(
    () => (findOpen && findQuery.trim() ? searchProject(project, findQuery) : []),
    [findOpen, findQuery, project],
  );

  // ── Async startup: load projects from IDB ─────────────────────────────────
  useEffect(() => {
    const ownerEmail = user?.email || null;
    loadProjects(ownerEmail).then(async ps => {
      // Creating a brand-new project (navigated from homepage type picker)
      if (openProjectId === 'new') {
        const type = newProjectType || 'story';
        const ch   = newChapter(1, type === 'journal' || type === 'log');
        const p    = { id: genId(), title: randomProjectName(ps), type, chapters: [ch], activeChapterId: ch.id };
        const loaded = [...ps, p];
        setProjects(loaded);
        saveProjectsDirty(loaded);
        setActiveProjectId(p.id);
        saveActiveId(p.id, user?.email);
        setDbReady(true);
        // Arm the outbox and push the new project immediately (row 0a bootstrap-create).
        getEngine()?.markDirty(p.id, p);
        getEngine()?.syncOne(p.id, { userInitiated: true });
        // Open Forward mode immediately for the new project
        setFocusAutoPublish(true);
        setFocusOpen(true);
        return;
      }

      // App.jsx handles the first-time device pull before Editor ever mounts.
      // By the time we get here, IDB is already populated (or the user has no cloud).
      const loaded = ps.length ? ps : (welcomeProject ? [] : [guest ? newGuestProject() : newProject()]);
      setProjects(loaded);

      // Prefer openProjectId prop, then localStorage, then first available
      const targetId = (openProjectId && openProjectId !== 'new') ? openProjectId
                     : localStorage.getItem(`fwd:active-project-id:${user?.email || ''}`);
      let activeId;
      if (welcomeProject) {
        const match = targetId && loaded.find(p => p.id === targetId);
        activeId = match ? targetId : welcomeProject.id;
      } else {
        const match = targetId && loaded.find(p => p.id === targetId);
        activeId = match ? targetId : (loaded[0]?.id ?? '');
      }
      setActiveProjectId(activeId);
      setDbReady(true);

      // Sync the opened project (pull if a device pushed newer; push if we're dirty).
      // Cross-device project discovery is handled by the launch sweep in App.jsx.
      if (getEngine()) runSync(eng => eng.syncOne(activeId));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // projects are saved synchronously inside setProjects callbacks above;
  // just track the saved indicator
  useEffect(() => { setSaved(true); }, [projects]);

  useEffect(() => { projectRef.current  = project;  }, [project]);

  // Tell the engine which project is open, so a remote change to IT boots the reader to
  // home (§6) rather than swapping content underneath them. Cleared when leaving.
  useEffect(() => {
    getEngine()?.setOpenProject(activeProjectId || null);
    return () => getEngine()?.setOpenProject(null);
  }, [activeProjectId]);

  // Conflict resolution lives ENTIRELY on the homepage now — the amber dot opens the branch
  // tree, and that's the only path in. Opening a conflicted project used to pop the compare
  // dialog here (spec §8.2), but that meant you couldn't just open your work without being
  // asked to resolve first. Opening a project now simply opens it; the fork waits, badged, in
  // the list until you choose to deal with it via the dot.

  // Run an engine sweep and reflect the outcome in the little sync indicator.
  async function runSync(fn) {
    const eng = getEngine();
    if (!eng) return;
    setSyncStatus('syncing');
    const r = await fn(eng);
    if (r?.halted)         setSyncStatus('error');
    else if (r?.transient) setSyncStatus('offline');
    else { setSyncStatus('synced'); setLastSynced(new Date().toISOString()); }
  }
  const projectsRef = useRef(projects);
  useEffect(() => { projectsRef.current = projects; }, [projects]);

  // Each project has its own FSA handle and permission state — reset on switch
  useEffect(() => { setFsaDegraded(false); }, [activeProjectId]);

  // Hydrate wordAssets from IndexedDB whenever the active project changes.
  // Projects are saved to localStorage without wordAssets (binary blobs live in IDB).
  useEffect(() => {
    getWordAssets(activeProjectId).then(assets => {
      if (!assets) return;
      setProjects(prev => prev.map(p =>
        p.id === activeProjectId ? { ...p, wordAssets: assets } : p
      ));
    });
  }, [activeProjectId]);

  // Keep isMobile in sync when the viewport resizes
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = e => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Track visual viewport (keyboard appearance) so the bottom sheet stays
  // just above the keyboard. When keyboard appears, vv.height shrinks and
  // sheetOffset increases, pushing the sheet up by the keyboard height.
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    function handleVV() {
      setSheetOffset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    }
    vv.addEventListener('resize', handleVV);
    vv.addEventListener('scroll', handleVV);
    return () => {
      vv.removeEventListener('resize', handleVV);
      vv.removeEventListener('scroll', handleVV);
    };
  }, [isMobile]);

  // Track selection continuously via selectionchange — more reliable than
  // onMouseUp/onKeyUp alone, especially on mobile (touch events don't fire mouseup).
  useEffect(() => {
    function onSelectionChange() {
      // Title input
      const titleEl = titleRef.current;
      if (titleEl && document.activeElement === titleEl && titleEl.selectionStart !== titleEl.selectionEnd) {
        const snap = { start: titleEl.selectionStart, end: titleEl.selectionEnd, anchorType: 'title' };
        selectionRef.current       = snap;
        pendingSelRef.current      = snap;
        selectionSourceRef.current = 'title';
        return;
      }
      // Contenteditable editor
      const offsets = getSelectionOffsets(editorRef.current);
      if (offsets) {
        const snap = { ...offsets, anchorType: 'content' };
        selectionRef.current       = snap;
        pendingSelRef.current      = snap;
        selectionSourceRef.current = 'content';
      }
    }
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  useEffect(() => {
    if (!FSA_SUPPORTED) return;
    const id = setInterval(async () => {
      const p      = projectRef.current;
      const handle = await getFileHandle(p.id);
      if (!handle) return;
      // queryPermission only — never prompt mid-session.
      // If permission not yet granted, skip silently; manual Save will request it.
      // If handle is stale, skip silently; manual Save will detect and clear it.
      try { await writeFSA(handle, projectToXml(p), false); } catch { /* skip */ }
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Cloud sync helpers ────────────────────────────────────────────────────────

  // Share subsystem is deferred (no server). These are stubbed so the app builds without
  // Supabase/api; share calls reach no backend and fail gracefully until the share rework.
  async function getCloudSession() { return null; }

  async function cloudFetch(path, options = {}) {
    return fetch(path, { ...options, headers: { ...options.headers } });
  }

  // If the user arrived via "Try it free →", open Forward mode automatically
  useEffect(() => {
    if (!user || isReadOnly) return;
    if (sessionStorage.getItem('fwd:try-it')) {
      sessionStorage.removeItem('fwd:try-it');
      setFocusAutoPublish(true);
      setFocusOpen(true);
    }
  }, [!!user, isReadOnly]);

  // The 60s dirty-push and the reconnect drain now live at the App level (the background
  // sweep + `online` handler drain the outbox every 60s and on reconnect, from any view).
  // Here we only keep the indicator reflecting online/offline state.
  useEffect(() => {
    if (!navigator.onLine) setSyncStatus(s => (s === 'idle' || s === 'synced') ? 'offline' : s);

    function handleOnline() {
      setSyncStatus(s => s === 'offline' ? 'idle' : s);
    }
    function handleOffline() {
      setSyncStatus('offline');
    }

    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online',  handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.provider]);

  // ── Share helpers ────────────────────────────────────────────────────────────

  function shareKey(projectId, chapterId) {
    return chapterId ? `${projectId}:${chapterId}` : projectId;
  }

  async function handleShare(chapterId) {
    if (!user) { onSignIn(); return; }
    const p   = projectRef.current;
    const key = shareKey(p.id, chapterId);
    setShareLoading(key);
    try {
      // Build a JSON snapshot (whole project, or one section) that OUR /s/<id> viewer renders.
      const sec      = chapterId ? p.chapters.find(c => c.id === chapterId) : null;
      const title    = (sec ? sec.title : p.title) || 'Untitled';
      const sections = sec
        ? [{ title: sec.title || '', content: sec.content || '', level: sec.level || 1 }]
        : (p.chapters || []).map(c => ({ title: c.title || '', content: c.content || '', level: c.level || 1 }));
      const snapshot = { v: 1, title, sections, author: user.email || '', publishedAt: new Date().toISOString() };
      const blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });
      const safe = (title.replace(/[^\w .-]+/g, ' ').trim() || 'oodbo');
      // Re-sharing ("update snapshot") publishes a fresh file — delete the previous one first
      // so we don't leave orphaned public files piling up in the user's Drive.
      const slot = chapterId || '__project__';
      const prevShare = (p.shares || {})[slot];
      if (prevShare?.fileId) {
        try { await unpublishShare({ getShareToken: getShareAccessToken, fileId: prevShare.fileId }); } catch {}
      }
      // Publish the snapshot to the user's visible Drive as "anyone with the link" (Option B).
      const { fileId } = await publishShare({ getShareToken: getShareAccessToken, name: `${safe}.oodbo.json`, blob, mimeType: 'application/json' });
      const url = `${window.location.origin}/s/${fileId}`;   // our branded viewer link
      // Record the share ON the project (syncs → visible on every device).
      setProjects(prev => {
        const next = prev.map(pr => pr.id === p.id
          ? { ...pr, shares: { ...(pr.shares || {}), [slot]: { fileId, url } } }
          : pr);
        saveProjectsDirty(next);
        return next;
      });
      setShareLinks(prev => ({ ...prev, [key]: url }));
    } catch (e) {
      console.warn('share failed:', e);
    }
    setShareLoading(null);
  }

  async function handleUnshare(chapterId) {
    const p    = projectRef.current;
    const key  = shareKey(p.id, chapterId);
    const slot = chapterId || '__project__';
    // Read the fileId from the LIVE project (projectRef can lag behind the last setProjects),
    // so we actually delete the Drive file instead of skipping it.
    const info = (projects.find(x => x.id === p.id)?.shares || {})[slot];
    if (info?.fileId) {
      try { await unpublishShare({ getShareToken: getShareAccessToken, fileId: info.fileId }); }
      catch (e) { console.warn('unpublish failed:', e); }
    }
    setProjects(prev => {
      const next = prev.map(pr => {
        if (pr.id !== p.id) return pr;
        const shares = { ...(pr.shares || {}) };
        delete shares[slot];
        return { ...pr, shares };
      });
      saveProjectsDirty(next);
      return next;
    });
    setShareLinks(prev => { const n = { ...prev }; delete n[key]; return n; });
  }

  // shareLinks now stores the full Drive URL per slot, so this is identity (kept so the
  // share modal's existing callers don't need to change).
  function shareUrl(u) { return u; }

  // Single source of truth = the synced project.shares; keep shareLinks in step with it.
  useEffect(() => {
    const map = {};
    for (const pr of projects) {
      for (const [slot, info] of Object.entries(pr.shares || {})) {
        if (!info?.url) continue;
        map[shareKey(pr.id, slot === '__project__' ? null : slot)] = info.url;
      }
    }
    setShareLinks(map);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  // ── Share-progress card helpers ──────────────────────────────────────────────
  function cardFileName() {
    const slug = (progressMeta?.title || project.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'draft';
    return `oodbo-${slug}.png`;
  }

  function openProgressCard() {
    const p = projectRef.current || project;
    const words    = (p.chapters || []).reduce((n, c) => n + countWords(c.content), 0);
    const sections = (p.chapters || []).length;
    const title    = p.title || 'Untitled';
    const secWord  = usesEntryLabel
      ? (sections === 1 ? 'entry' : 'entries')
      : (sections === 1 ? 'section' : 'sections');
    const dateStr  = logDate();
    // Plain-text companion line — carries the alt-text meaning into threads/screenreaders.
    const textLine = `"${title}"\n${plWords(words)}, ${sections} ${secWord}, ${dateStr}. A forward-only draft, written by a human at write.mercoogs.com`;
    const canvas = renderProgressCard({
      title, words, sections, dateStr,
      entryLabel: usesEntryLabel ? 'entry' : 'section',
      // Card always uses the parchment palette, independent of the editor theme.
      colors: {
        bg: '#f5f2eb', panel: '#fff', border: '#ddd6c9',
        text: '#1f1f1f', muted: '#888', accent: '#111',
      },
    });
    progressCanvasRef.current = canvas;
    setProgressUrl(canvas.toDataURL('image/png'));
    setProgressMeta({ title, words, sections, secWord, dateStr, textLine });
    setProgressSaved(false);
    setProgressCopied('');
    setProgressModal(true);
  }

  function handleDownloadProgress() {
    if (!progressUrl) return;
    const a = document.createElement('a');
    a.href = progressUrl;
    a.download = cardFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setProgressSaved(true);
    setTimeout(() => setProgressSaved(false), 1600);
  }

  const canCopyImage = typeof navigator !== 'undefined' && !!navigator.clipboard
    && typeof navigator.clipboard.write === 'function' && typeof window.ClipboardItem !== 'undefined';

  // Copy the card image to the clipboard, bundling the plain-text line in the same
  // ClipboardItem where the browser allows it (the paste target then picks the type
  // it can use). Falls back to image-only if multi-type write is rejected.
  async function handleCopyImage() {
    const canvas = progressCanvasRef.current;
    if (!canvas) return;
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const text = progressMeta?.textLine || '';
      try {
        try {
          await navigator.clipboard.write([new window.ClipboardItem({
            'image/png': blob,
            'text/plain': new Blob([text], { type: 'text/plain' }),
          })]);
        } catch {
          await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
        }
        setProgressCopied('image');
        setTimeout(() => setProgressCopied(''), 1600);
      } catch { /* clipboard unavailable */ }
    }, 'image/png');
  }

  async function handleCopyProgressText() {
    try {
      await navigator.clipboard.writeText(progressMeta?.textLine || '');
      setProgressCopied('text');
      setTimeout(() => setProgressCopied(''), 1600);
    } catch { /* clipboard unavailable */ }
  }

  // Fetch the status of all known share links for the current user.
  // Called when the share modal opens so the UI reflects server-side state.
  async function loadShareStatuses() {
    try {
      const res = await cloudFetch('/api/share');
      if (!res.ok) return;
      const { shares } = await res.json();
      const statusMap = {};
      // Build a map of shareId → status string
      for (const s of (shares ?? [])) {
        statusMap[s.id] = s.active ? 'active'
          : (s.inactive_reason === 'reported' ? 'reported'
          : s.inactive_reason === 'blocked'   ? 'blocked'
          : 'removed');
      }
      // Also sync shareLinks — remove any IDs that the server has no record of
      // or that were user_deleted (status 'removed')
      setShareLinks(prev => {
        const next = { ...prev };
        let changed = false;
        for (const [key, sid] of Object.entries(next)) {
          if (statusMap[sid] === 'removed' || statusMap[sid] === undefined) {
            // Only prune if server explicitly says it's user_deleted or missing
            // Keep reported/blocked entries so we can show the grey state
          }
        }
        return changed ? next : prev;
      });
      setShareStatuses(statusMap);
      try { localStorage.setItem(`fwd:share-statuses:${user?.email || ''}`, JSON.stringify(statusMap)); } catch {}
    } catch {}
  }

  // Periodic pull every 5 min — boots to home if another device has a newer version
  useEffect(() => {
    if (!user?.provider) return;
    const id = setInterval(() => { if (getEngine()) runSync(eng => eng.syncOne(projectRef.current?.id)); }, 5 * 60_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.provider]);

  // Sidebar drag-to-resize (desktop only)
  useEffect(() => {
    function onMove(e) {
      if (!sidebarDragRef.current) return;
      const next = Math.max(160, Math.min(480, sidebarDragRef.current.startWidth + e.clientX - sidebarDragRef.current.startX));
      setSidebarWidth(next);
    }
    function onUp() {
      if (!sidebarDragRef.current) return;
      sidebarDragRef.current = null;
      setSidebarWidth(prev => { localStorage.setItem(`fwd:sidebar-width:${user?.email || ''}`, prev); return prev; });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
  }, []);

  // Close level picker on outside click
  useEffect(() => {
    if (!levelPickerOpen) return;
    function onOutside(e) {
      if (levelPickerRef.current && !levelPickerRef.current.contains(e.target)) {
        setLevelPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [levelPickerOpen]);

  // Close theme menu on outside click
  useEffect(() => {
    if (!themeMenuOpen) return;
    const onOutside = (e) => { if (themeMenuRef.current && !themeMenuRef.current.contains(e.target)) setThemeMenuOpen(false); };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [themeMenuOpen]);

  // Close section ··· menu on outside click
  useEffect(() => {
    if (!secMenuId) return;
    const onOutside = (e) => { if (secMenuRef.current && !secMenuRef.current.contains(e.target)) setSecMenuId(null); };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [secMenuId]);

  // Re-render editor when switching sections
  // In readOnly mode activeWelcomeChapterId drives chapter selection instead of project.activeChapterId
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    buildEditorDOM(el, activeChapter.content, activeChapter.annotations || []);
    annIdsRef.current = (activeChapter.annotations || []).map(a => a.id).join(',');
    // Apply jump-back-in cursor/mode if one is pending from a jumpTarget
    if (pendingJumpRef.current) {
      const { cursor, mode } = pendingJumpRef.current;
      pendingJumpRef.current = null;
      if (mode === 'focus') {
        setFocusJumpCover(true);   // hide the editor/prompt flash until Forward opens
        preFocusCursorRef.current = cursor;
        setTimeout(() => enterForward(), 50);   // resumes a pending draft rather than blank-clobbering
      } else {
        setTimeout(() => {
          if (!editorRef.current) return;
          editorRef.current.focus();
          setCursorOffset(editorRef.current, cursor);
          scrollCursorIntoView(mainScrollRef.current);
        }, 80);
      }
    }
    // Apply a pending find highlight after a chapter switch (find bar cycling / homepage deep-link)
    if (pendingFindSelRef.current) {
      const { chapterId, offset, length } = pendingFindSelRef.current;
      pendingFindSelRef.current = null;
      setFindActive({ chapterId, offset, length });
      setTimeout(() => scrollRangeIntoView(offset, length), 80);
    }
  }, [project.activeChapterId, activeWelcomeChapterId]);

  // Apply jumpTarget from home screen "jump back in" card
  useEffect(() => {
    if (!jumpTarget) return;
    const { chapterId, cursorPosition, mode } = jumpTarget;
    const cursor = cursorPosition ?? 0;
    pendingJumpRef.current = { cursor, mode: mode ?? 'edit' };
    if (chapterId && chapterId !== project.activeChapterId) {
      // Switching chapter — DOM rebuild effect will apply pending jump
      updateProject({ activeChapterId: chapterId });
    } else {
      // Already on the right chapter — apply immediately
      const { cursor: c, mode: m } = pendingJumpRef.current;
      pendingJumpRef.current = null;
      if (m === 'focus') {
        setFocusJumpCover(true);   // hide the editor/prompt flash until Forward opens
        preFocusCursorRef.current = c;
        setTimeout(() => enterForward(), 50);   // resumes a pending draft rather than blank-clobbering
      } else {
        setTimeout(() => {
          if (!editorRef.current) return;
          editorRef.current.focus();
          setCursorOffset(editorRef.current, c);
          scrollCursorIntoView(mainScrollRef.current);
        }, 80);
      }
    }
  }, [jumpTarget]);

  // Keep a ref mirror of focusOpen for the document-level Ctrl+F listener (stable closure).
  useEffect(() => { focusOpenRef.current = focusOpen; }, [focusOpen]);

  // Ctrl/Cmd-F opens the in-project find bar (overrides the browser's own find in the editor).
  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        if (focusOpenRef.current) return;   // Forward mode overlay owns the screen
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => { findInputRef.current?.focus(); findInputRef.current?.select(); }, 0);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Homepage search deep-link: open the find bar pre-filled and (once hits resolve) land on the
  // first hit — the one case where we auto-navigate. A normal (non-search) project open carries
  // term='' → ensure any leftover bar is closed.
  useEffect(() => {
    if (searchTerm && searchTerm.trim()) {
      setFindOpen(true);
      setFindQuery(searchTerm);
      setFindIdx(-1);
      pendingSearchLandRef.current = true;   // land on the first hit once findHits is available
      setTimeout(() => { findInputRef.current?.focus(); findInputRef.current?.select(); }, 60);
    } else {
      setFindOpen(false);
      setFindQuery('');
      setFindIdx(-1);
      pendingSearchLandRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, openProjectId]);

  // One-shot: after a homepage-search open, jump to the first hit as soon as hits exist (the
  // project loads async). Guarded by pendingSearchLandRef so it never fires on plain edits.
  useEffect(() => {
    if (pendingSearchLandRef.current && findHits.length) {
      pendingSearchLandRef.current = false;
      setFindIdx(0);
      goToHit(findHits[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findHits]);

  // Re-render editor when annotations are added or removed (not just offset-adjusted)
  useEffect(() => {
    const currentIds = (activeChapter.annotations || []).map(a => a.id).join(',');
    if (currentIds === annIdsRef.current) return;
    annIdsRef.current = currentIds;
    const el = editorRef.current;
    if (!el) return;
    const hasFocus = el.contains(document.activeElement);
    const offset   = hasFocus ? getCursorOffset(el) : null;
    buildEditorDOM(el, activeChapter.content, activeChapter.annotations || []);
    if (offset !== null) setCursorOffset(el, offset);
  }, [activeChapter?.annotations]);

  // Measure annotation Y positions using Range.getClientRects() for accurate margin bar placement
  // (word-wrap aware). DEBOUNCED 300ms — matched to the save debounce so this reflow-per-annotation
  // work lands on the same "you've paused" boundary rather than during a brief think-pause. Each
  // getClientRects forces a reflow; running it per keystroke (content is a dep) was a real cost on
  // large sections. The bars settle a beat after you stop typing.
  useEffect(() => {
    const measure = () => {
      const pageEl   = pageRef.current;
      const editorEl = editorRef.current;
      const anns     = activeChapter.annotations || [];
      if (!pageEl || !editorEl || anns.length === 0) { setMarkerYs({}); return; }
      const pageRect = pageEl.getBoundingClientRect();
      const ys = {};
      for (const ann of anns) {
        if (ann.anchorType === 'title') { ys[ann.id] = PAGE_PAD_PX + 6; continue; }
        const rects = Array.from(createRangeForOffsets(editorEl, ann.start, ann.end).getClientRects())
          .filter(r => r.width > 1);
        // Subtract bar height so the bar's bottom edge aligns with the text bottom,
        // rather than the bar's top edge — prevents it looking like a line divider.
        const BAR_H = 5;
        ys[ann.id] = rects.length > 0
          ? Math.max(0, (rects[0].bottom - pageRect.top) / zoom - BAR_H)
          : PAGE_PAD_PX + estimateLineY(activeChapter.content, ann.start);
      }
      setMarkerYs(ys);
    };
    const t = setTimeout(measure, 300);
    return () => clearTimeout(t);
  }, [activeChapter.annotations, activeChapter.content, zoom, project.activeChapterId]);

  // Compute the search-highlight overlay rects from the current match (findActive). Recomputes
  // on zoom / content / chapter change so the highlight tracks the text. No selection, no focus.
  useEffect(() => {
    const editorEl = editorRef.current, pageEl = pageRef.current;
    if (!findActive || !editorEl || !pageEl
        || findActive.chapterId !== project.activeChapterId || findActive.length <= 0) {
      setFindRects(prev => (prev.length ? [] : prev));  // no-op when already empty → no re-render per keystroke
      return;
    }
    const pageRect = pageEl.getBoundingClientRect();
    const rects = Array.from(createRangeForOffsets(editorEl, findActive.offset, findActive.offset + findActive.length).getClientRects())
      .filter(r => r.width > 0.5)
      .map(r => ({
        left:   (r.left - pageRect.left) / zoom,
        top:    (r.top  - pageRect.top)  / zoom,
        width:  r.width  / zoom,
        height: r.height / zoom,
      }));
    setFindRects(rects);
  }, [findActive, project.activeChapterId, activeChapter.content, zoom]);

  // When an annotation is focused, highlight its text with the pastel fill.
  // Nothing shows in the editor until the user clicks a note or margin bar.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.querySelectorAll('mark[data-ann-ids]').forEach(m => {
      m.style.background = 'transparent';
    });
    if (expandedAnnId) {
      const ann = (activeChapter.annotations || []).find(a => a.id === expandedAnnId);
      el.querySelectorAll('mark[data-ann-ids]').forEach(m => {
        if (m.dataset.annIds.split(',').includes(expandedAnnId)) {
          m.style.background = annIdle(ann?.colorIndex, annPalette);
        }
      });
    }
  }, [expandedAnnId, editorTheme]);

  // Wrapper: mark dirty + debounce persistence.
  // React state is already updated by the caller — this only handles persistence.
  // Dirtiness is derived by the engine from the content hash (markDirty below), not a flag.
  // On each debounce flush, only the active project is written to IDB.
  // localStorage is flushed separately on navigate away and page unload.
  // Write the active project to IDB (and arm the sync outbox). Clears BOTH persist timers so the
  // trailing debounce and the maxWait ceiling coalesce into a single write.
  function flushActiveToIDB() {
    clearTimeout(persistTimer.current);    persistTimer.current = null;
    clearTimeout(persistMaxTimer.current); persistMaxTimer.current = null;
    const active = latestProjectsRef.current.find(p => p.id === activeProjectId);
    if (!active) return;
    saveActiveProjectIDB(active);
    getEngine()?.markDirty(activeProjectId, active);   // arm the outbox (derived dirty)
  }

  function saveProjectsDirty(ps) {
    latestProjectsRef.current = ps;
    // Trailing debounce: write ~300ms after you stop typing.
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(flushActiveToIDB, 300);
    // maxWait ceiling: a trailing debounce alone NEVER fires during unbroken typing, so a HARD crash
    // mid-burst (power loss / OS kill — no unload event fires) could lose back to the last pause.
    // Guarantee an IDB write at least once/second, mirroring FocusMode's forward-draft ceiling. An
    // extra write per second is nothing; the 300ms debounce still handles the common (paused) case.
    if (!persistMaxTimer.current) persistMaxTimer.current = setTimeout(flushActiveToIDB, 1000);
    // Long-section warning on a SEPARATE, longer quiet period (1.5s) so the banner never appears
    // mid-typing — a banner shifts layout, so it must wait until the writer has clearly stopped.
    clearTimeout(sizeCheckTimer.current);
    sizeCheckTimer.current = setTimeout(() => {
      checkSectionSize(latestProjectsRef.current.find(p => p.id === activeProjectId));
    }, 1500);
  }

  // Warn once when the ACTIVE section crosses 50k words, then again each +10k. A single huge section
  // is what makes the editor reflow slowly (see handleEditorInput), so we nudge splitting BEFORE it
  // bites. Called only after 1.5s of quiet; word count is O(section) but off the typing path.
  // Threshold state is per-chapter so switching sections doesn't re-warn.
  function checkSectionSize(project) {
    if (isReadOnly || !project) return;
    const ch = project.chapters.find(c => c.id === project.activeChapterId) || project.chapters[0];
    if (!ch) return;
    const text  = (ch.content || '').trim();
    const words = text ? text.split(/\s+/).length : 0;
    const BASE = 50000, STEP = 10000;
    const threshold = words >= BASE ? BASE + Math.floor((words - BASE) / STEP) * STEP : 0;
    if (threshold > (warnShownRef.current[ch.id] || 0)) {
      warnShownRef.current[ch.id] = threshold;
      setSectionWarn({ threshold });
    }
  }

  function updateProject(changes) {
    setProjects(prev => {
      const next = prev.map(p => p.id === activeProjectId ? { ...p, ...changes } : p);
      saveProjectsDirty(next);
      return next;
    });
    setSaved(false);
  }

  function updateChapter(id, changes) {
    setProjects(prev => {
      const next = prev.map(p => {
        if (p.id !== activeProjectId) return p;
        return {
          ...p,
          chapters: p.chapters.map(c =>
            c.id === id ? { ...c, ...changes, updatedAt: new Date().toISOString() } : c
          )
        };
      });
      saveProjectsDirty(next);
      return next;
    });
    setSaved(false);
  }

  // ── Editor event handlers ──────────────────────────────────────────────────

  function handleEditorInput(e) {
    const el      = e.currentTarget;
    const newText = (el.innerText || '').replace(/\n$/, '');
    const oldText = activeChapter.content;
    const cursor  = getCursorOffset(el);
    const adjusted = adjustAnnotationOffsets(
      activeChapter.annotations || [], oldText, newText, cursor
    );
    updateChapter(activeChapter.id, { content: newText, annotations: adjusted });

    // Save cursor position debounced — avoids a full state update on every keystroke
    clearTimeout(cursorSaveTimer.current);
    const chapterId = activeChapter.id;
    cursorSaveTimer.current = setTimeout(() => {
      updateChapter(chapterId, { cursorPosition: cursor });
    }, 500);
  }


  function handleEditorKeyDown(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
    }

    // Ctrl/Cmd+Enter → enter Forward mode
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !isReadOnly) {
      e.preventDefault();
      openFocusMode();
      return;
    }

    // Ctrl/Cmd+Shift+8 → start/continue bullet list
    // Ctrl/Cmd+Shift+7 → start/continue numbered list
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === '8' || e.key === '7')) {
      e.preventDefault();
      const el = editorRef.current;
      if (!el) return;
      const content   = activeChapter.content || '';
      const cursor    = getCursorOffset(el);
      const lineStart = content.lastIndexOf('\n', cursor - 1) + 1;
      const lineText  = content.slice(lineStart, cursor);
      const isBullet  = e.key === '8';
      const marker    = isBullet ? '• ' : '1. ';
      // If already on an empty line insert the marker; otherwise start a new line
      const insert = lineText.trim() === '' ? marker : '\n' + marker;
      document.execCommand('insertText', false, insert);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const el = editorRef.current;
      if (!el) { document.execCommand('insertText', false, '\n'); return; }
      const content   = activeChapter.content || '';
      const cursor    = getCursorOffset(el);
      const lineStart = content.lastIndexOf('\n', cursor - 1) + 1;
      const lineText  = content.slice(lineStart, cursor);

      // Bullet list continuation: optional indent + • marker
      const bm = lineText.match(/^(\s*)•\s?/);
      if (bm) {
        const afterMarker = lineText.slice(bm[0].length).trim();
        if (!afterMarker) {
          // Empty bullet item — exit list (just a newline, orphaned marker is deletable)
          document.execCommand('insertText', false, '\n');
        } else {
          document.execCommand('insertText', false, '\n' + bm[1] + '• ');
        }
        return;
      }

      // Numbered list continuation: optional indent + number + separator
      const nm = lineText.match(/^(\s*)(\d+)([.)]\s?)/);
      if (nm) {
        const afterMarker = lineText.slice(nm[0].length).trim();
        if (!afterMarker) {
          document.execCommand('insertText', false, '\n');
        } else {
          const sep = nm[3].trimEnd() + ' ';
          document.execCommand('insertText', false, '\n' + nm[1] + (parseInt(nm[2], 10) + 1) + sep);
        }
        return;
      }

      document.execCommand('insertText', false, '\n');
    }
  }

  function handleEditorPaste(e) {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }

  // ── Chapter management ─────────────────────────────────────────────────────

  function deleteChapter(id) {
    let next = project.chapters.filter(c => c.id !== id);
    if (next.length === 0) next = [newChapter(1, usesDateTitle)];
    const newActiveId = next.find(c => c.id === project.activeChapterId)
      ? project.activeChapterId
      : next[0].id;
    deleteWordAssets(id);
    setProjects(prev => {
      const updated = prev.map(p => p.id !== activeProjectId ? p : {
        ...p, activeChapterId: newActiveId,
        chapters: next,
      });
      saveProjectsDirty(updated);
      return updated;
    });
    setSaved(false);
  }

  // Insert a new section of the same level as `afterId`, right after that
  // section's entire subtree (before the next peer or ancestor).
  function addChapterAfter(afterId) {
    const chs    = project.chapters;
    const idx    = chs.findIndex(c => c.id === afterId);
    if (idx === -1) return;
    const level  = chs[idx].level || 1;
    const ch     = newChapter(chs.length + 1, usesDateTitle, level);
    // Find end of subtree: first following chapter at same or higher level in hierarchy
    let insertIdx = chs.length;
    for (let i = idx + 1; i < chs.length; i++) {
      if ((chs[i].level || 1) <= level) { insertIdx = i; break; }
    }
    setProjects(prev => {
      const next = prev.map(p => {
        if (p.id !== activeProjectId) return p;
        const newChs = [...p.chapters];
        newChs.splice(insertIdx, 0, ch);
        return { ...p, chapters: newChs, activeChapterId: ch.id };
      });
      saveProjectsDirty(next);
      return next;
    });
    setFocusAutoPublish(true);
    setFocusOpen(true);
  }

  // "+ New section" toolbar button — adds after the active section's subtree
  function addChapter() {
    addChapterAfter(project.activeChapterId);
  }

  function selectChapter(id) {
    if (isReadOnly) {
      setActiveWelcomeChapterId(id);
      if (isMobile) setSidebarOpen(false);
      // Scroll to top so readers start at the top of the new chapter
      setTimeout(() => { if (mainScrollRef.current) mainScrollRef.current.scrollTop = 0; }, 0);
      return;
    }
    updateProject({ activeChapterId: id });
    if (isMobile) setSidebarOpen(false);
  }

  // Entry point from welcome/homepage — requires account
  function handleTryIt() {
    sessionStorage.setItem('fwd:try-it', '1');
    onSignIn();
  }

  // Guest mode: copy the full draft to the clipboard — the ONLY way a guest
  // keeps their writing (nothing is persisted beyond the tab).
  function handleCopyGuest() {
    const text = (project.chapters || [])
      .map(ch => ch.content || '')
      .join('\n\n')
      .trim();
    navigator.clipboard.writeText(text).then(() => {
      setGuestCopied(true);
      setTimeout(() => setGuestCopied(false), 2000);
    }).catch(() => {});
  }

  function dismissGuestHint() {
    setShowGuestHint(false);
    try { sessionStorage.setItem('oodbo.guest.hintSeen', '1'); } catch {}
  }

  function markTourSeen() {
    try { sessionStorage.setItem('oodbo.guest.tourSeen', '1'); } catch {}
    try { if (user?.email) localStorage.setItem(`oodbo.tourSeen:${user.email}`, '1'); } catch {}
  }

  // Guest onboarding pointer: inject the bounce keyframes once, and dismiss the
  // hint the moment the guest actually opens Forward mode (they've found it).
  useEffect(() => {
    if (!guest) return;
    if (!document.getElementById('oodbo-hint-kf')) {
      const el = document.createElement('style');
      el.id = 'oodbo-hint-kf';
      el.textContent = '@keyframes oodboHintBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(5px)}}';
      document.head.appendChild(el);
    }
  }, [guest]);
  const prevFocusRef = useRef(false);
  useEffect(() => {
    if (!guest) return;
    const was = prevFocusRef.current;
    prevFocusRef.current = focusOpen;
    if (!was && focusOpen) {
      // Entering Forward mode: they've found Forward, so retire the callout and
      // the tour prompt. A running tour is kept — it's only paused (via `hidden`).
      setShowGuestHint(false);
      try { sessionStorage.setItem('oodbo.guest.hintSeen', '1'); } catch {}
      setTourPromptOpen(false);
      if (tourStep === null) markTourSeen();
    } else if (was && !focusOpen && tourStep === 0) {
      // Returning from a "try it" excursion launched on the Forward step —
      // continue the tour at the next step rather than repeating Forward.
      setTourStep(1);
    }
  }, [focusOpen, guest, tourStep]);

  // Signed-in onboarding: a first project opens straight into Forward mode, and not everyone arrives
  // via /guest. The first time a signed-in user comes OUT of Forward mode, offer the same tour guests
  // get — ONCE per user (persisted by email), large-screen only (the tour anchors to desktop chrome).
  // Also advances a running tour past the Forward step, the way the guest effect above does.
  const prevSignedFocusRef = useRef(false);
  useEffect(() => {
    if (guest) return;
    const was = prevSignedFocusRef.current;
    prevSignedFocusRef.current = focusOpen;
    if (was && !focusOpen) {                       // just exited Forward mode
      if (tourStep === 0) { setTourStep(1); return; }
      if (tourStep === null && !isMobile && user?.email) {
        try {
          const key = `oodbo.tourSeen:${user.email}`;
          if (!localStorage.getItem(key)) { localStorage.setItem(key, '1'); setTourPromptOpen(true); }
        } catch {}
      }
    } else if (!was && focusOpen) {                // entering Forward mode
      setTourPromptOpen(false);                    // retire the tour offer if it was up
      if (user?.email) {                           // first-ever entry → one-time "forward only" intro
        try {
          const key = `oodbo.forwardIntroSeen:${user.email}`;
          if (!localStorage.getItem(key)) { localStorage.setItem(key, '1'); setForwardIntro(true); }
        } catch {}
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusOpen, guest, isMobile, tourStep, user?.email]);

  function reorderChapters(fromId, toId) {
    if (fromId === toId) return;
    setProjects(prev => {
      const next = prev.map(p => {
        if (p.id !== activeProjectId) return p;
        const chs      = [...p.chapters];
        const fromIdx  = chs.findIndex(c => c.id === fromId);
        if (fromIdx === -1) return p;
        const fromLevel = chs[fromIdx].level || 1;
        // Collect the full subtree: the dragged section + all deeper descendants
        let subtreeEnd = fromIdx + 1;
        while (subtreeEnd < chs.length && (chs[subtreeEnd].level || 1) > fromLevel) subtreeEnd++;
        const group = chs.splice(fromIdx, subtreeEnd - fromIdx);
        // Re-find toId after the splice (indices shifted)
        const newToIdx = chs.findIndex(c => c.id === toId);
        if (newToIdx === -1) {
          // toId was inside the dragged subtree — can't drop on own child; append
          chs.push(...group);
        } else {
          chs.splice(newToIdx, 0, ...group);
        }
        return { ...p, chapters: chs };
      });
      saveProjectsDirty(next);
      return next;
    });
  }

  // ── Annotations ────────────────────────────────────────────────────────────

  function captureSelection(source) {
    selectionSourceRef.current = source;
    if (source === 'title') {
      const el = titleRef.current;
      if (el && el.selectionStart !== el.selectionEnd) {
        selectionRef.current = { start: el.selectionStart, end: el.selectionEnd, anchorType: 'title' };
      }
    } else {
      const offsets = getSelectionOffsets(editorRef.current);
      if (offsets) selectionRef.current = { ...offsets, anchorType: 'content' };
    }
  }

  const MAX_LINE_ANNOTATIONS = 24;

  function showHint(msg) {
    setAnnHint(msg);
  }

  // Toggle the notes panel. If opening and text is already selected,
  // jump straight into the new-note form rather than making the user
  // click "Add note" as a second step.
  function handleNotesToggle() {
    if (annPanelOpen) { setAnnPanelOpen(false); return; }
    setAnnPanelOpen(true);
    if (pendingSelRef.current.start !== pendingSelRef.current.end) {
      startAddAnnotation();
    }
  }

  function startAddAnnotation() {
    const { start, end, anchorType = 'content' } = pendingSelRef.current;
    if (start === end) {
      showHint('Select some text in the document first.');
      return;
    }
    // Enforce per-line limit
    if (anchorType !== 'title') {
      const content   = activeChapter.content;
      const lineStart = content.lastIndexOf('\n', start - 1) + 1;
      const nlEnd     = content.indexOf('\n', start);
      const lineEnd   = nlEnd === -1 ? content.length : nlEnd;
      const lineCount = (activeChapter.annotations || []).filter(a =>
        a.anchorType !== 'title' && a.start >= lineStart && a.start < lineEnd
      ).length;
      if (lineCount >= MAX_LINE_ANNOTATIONS) {
        showHint(`This line already has ${MAX_LINE_ANNOTATIONS} notes. Edit an existing one, or annotate a different span.`);
        return;
      }
    }
    setAnnHint('');
    setAddingAnn(true);
    setAnnInput('');
  }

  // Colour a new annotation by its position within its line group — offset each row by 1 so no two
  // vertically adjacent bars share a colour. Deterministic, so the draft form can preview the swatch.
  function annColorIndex(start, anchorType) {
    const existingAnns = activeChapter.annotations || [];
    let pos;
    if (anchorType === 'title') {
      pos = existingAnns.filter(a => a.anchorType === 'title').length;
    } else {
      const lineStart = activeChapter.content.lastIndexOf('\n', start - 1) + 1;
      const nlEnd     = activeChapter.content.indexOf('\n', start);
      const lineEnd   = nlEnd === -1 ? activeChapter.content.length : nlEnd;
      pos = existingAnns.filter(a => a.anchorType !== 'title' && a.start >= lineStart && a.start < lineEnd).length;
    }
    const pLen = annPalette.length;
    return (pos + Math.floor(pos / pLen)) % pLen;
  }

  function saveAnnotation() {
    const raw = pendingSelRef.current;
    if (raw.start === raw.end) return;
    const anchorType = raw.anchorType || 'content';
    const sourceText = anchorType === 'title' ? activeChapter.title : activeChapter.content;
    const { start, end } = snapRange(sourceText, raw.start, raw.end);   // trim + snap to word boundaries
    if (start === end) return;
    const anchorText = sourceText.slice(start, end);
    const colorIndex = annColorIndex(start, anchorType);

    const ann = {
      id:         crypto.randomUUID(), start, end, anchorText, anchorType,
      colorIndex,
      note:       annInput.trim(), createdAt: new Date().toISOString()
    };
    updateChapter(activeChapter.id, {
      annotations: [...(activeChapter.annotations || []), ann]
    });
    setAddingAnn(false);
    setAnnInput('');
    setExpandedAnnId(ann.id);
    pendingSelRef.current = { start: 0, end: 0, anchorType: 'content' };
  }

  function deleteAnnotation(annId) {
    updateChapter(activeChapter.id, {
      annotations: (activeChapter.annotations || []).filter(a => a.id !== annId)
    });
    if (expandedAnnId === annId) setExpandedAnnId(null);
    if (editingAnnId  === annId) setEditingAnnId(null);
  }

  function goToAnnotation(ann) {
    if (ann.anchorType === 'title') {
      // On mobile, skip focus — would summon the keyboard uninvited
      if (!isMobile) {
        titleRef.current?.focus();
        titleRef.current?.setSelectionRange(ann.start, ann.start);
      }
    } else {
      const el = editorRef.current;
      if (!el) return;
      // On mobile, scroll only — focusing the contenteditable opens the keyboard
      if (!isMobile) {
        el.focus();
        setCursorOffset(el, ann.start);
      }
      if (mainScrollRef.current) {
        // markerYs[ann.id] is the bar's top in page-layout coordinates (pre-zoom).
        // Scroll coordinate = layout position × zoom (CSS zoom doesn't affect scrollTop units).
        const measuredY = markerYs[ann.id];
        const scrollY   = measuredY !== undefined
          ? measuredY * zoom
          : (PAGE_PAD_PX + estimateLineY(activeChapter.content, ann.start)) * zoom;
        mainScrollRef.current.scrollTop = Math.max(0, scrollY - 180);
      }
    }
  }

  // ── In-project find navigation ────────────────────────────────────────────────
  // The match is highlighted with an OVERLAY (findRects), never a DOM selection — so the
  // editor caret never moves into it. That was the bug: a real selection let focus land in
  // the contenteditable, and a second Enter then replaced the match with a newline. The
  // overlay "mimics focus" (a highlight) with no caret, so Enter keeps cycling in the find box.
  function scrollRangeIntoView(offset, length) {
    const editorEl = editorRef.current, scrollEl = mainScrollRef.current, pageEl = pageRef.current;
    if (!editorEl || !scrollEl || !pageEl) return;
    const rects = createRangeForOffsets(editorEl, offset, offset + Math.max(1, length)).getClientRects();
    if (!rects.length) return;
    const pageRect = pageEl.getBoundingClientRect();
    const topPre = (rects[0].top - pageRect.top) / zoom;         // pre-zoom layout coord
    scrollEl.scrollTop = Math.max(0, topPre * zoom - scrollEl.clientHeight / 2);
  }

  function goToHit(hit) {
    if (!hit) return;
    const needSwitch = hit.chapterId && hit.chapterId !== project.activeChapterId;

    if (hit.field === 'annotationNote' || hit.field === 'annotationAnchor') {
      const openAnn = () => {
        const ch  = project.chapters.find(c => c.id === hit.chapterId);
        const ann = ch?.annotations?.find(a => a.id === hit.annotationId);
        if (!ann) return;
        setAnnPanelOpen(true); setExpandedAnnId(ann.id); setEditingAnnId(null);  // expandedAnnId highlights its anchor
        if (ann.anchorType !== 'title') {
          const len = Math.max(1, (ann.end ?? ann.start) - ann.start);
          setFindActive({ chapterId: hit.chapterId, offset: ann.start, length: len });
          scrollRangeIntoView(ann.start, len);
        } else { setFindActive(null); }
      };
      if (needSwitch) { setFindActive(null); updateProject({ activeChapterId: hit.chapterId }); setTimeout(openAnn, 120); }
      else openAnn();
      return;
    }

    if (hit.field === 'projectTitle' || hit.field === 'chapterTitle') {
      // Titles aren't in the content flow — land on the chapter, no content highlight.
      if (needSwitch) { setFindActive(null); updateProject({ activeChapterId: hit.chapterId }); }
      else { setFindActive(null); if (mainScrollRef.current) mainScrollRef.current.scrollTop = 0; }
      return;
    }

    // 'content' | 'heading' → offset is into chapter content. Highlight via overlay, never select.
    if (needSwitch) {
      pendingFindSelRef.current = { chapterId: hit.chapterId, offset: hit.offset, length: hit.length };
      setFindActive(null);
      updateProject({ activeChapterId: hit.chapterId });
    } else {
      setFindActive({ chapterId: hit.chapterId, offset: hit.offset, length: hit.length });
      setTimeout(() => scrollRangeIntoView(hit.offset, hit.length), 0);
    }
  }

  // Navigate to the next (+1) / previous (-1) match. Selection only moves here — never while
  // typing. findIdx = -1 means "typed but not navigated yet": first ↓ → first hit, first ↑ → last.
  function findNav(dir) {
    if (!findHits.length) return;
    const base = findIdx < 0 ? (dir > 0 ? -1 : 0) : findIdx;
    const idx  = (((base + dir) % findHits.length) + findHits.length) % findHits.length;
    setFindIdx(idx);
    goToHit(findHits[idx]);
  }

  function closeFind() {
    setFindOpen(false);
    setFindQuery('');
    setFindIdx(0);
    setFindActive(null);
    setTimeout(() => editorRef.current?.focus(), 0);
  }

  function toggleAnnotation(ann) {
    goToAnnotation(ann);
    if (expandedAnnId === ann.id) {
      setExpandedAnnId(null);
      setEditingAnnId(null);
    } else {
      setAnnPanelOpen(true);
      setExpandedAnnId(ann.id);
      setEditingAnnId(null); // open in read mode; user must click Edit to write
    }
  }

  function startEditingAnnotation(ann) {
    setEditingAnnId(ann.id);
    setEditingNote(ann.note || '');
  }

  function saveAnnotationEdit(annId) {
    updateChapter(activeChapter.id, {
      annotations: (activeChapter.annotations || []).map(a =>
        a.id === annId ? { ...a, note: editingNote.trim() } : a
      )
    });
    setEditingAnnId(null);
  }

  function cancelAnnotationEdit() {
    setEditingAnnId(null);
  }

  // ── Focus Mode ─────────────────────────────────────────────────────────────

  // Every user-facing way into Forward routes through here so that entering Forward on a chapter
  // with a pending crash draft RESUMES it rather than starting blank (a blank session's first
  // keystroke would silently overwrite the same project+chapter key). Keep/discard then happen
  // via Forward's own publish/cancel — the same options, no separate prompt at this entry.
  async function enterForward({ cursor } = {}) {
    if (typeof cursor === 'number') preFocusCursorRef.current = cursor;
    if (!guest) {
      // Read the LIVE project/chapter from the ref, not the render closure. The jump-back-in
      // paths call this from a setTimeout whose closure predates the chapter switch, so the
      // closure's activeChapter is stale — which made a cold-start resume silently miss.
      const proj    = projectRef.current;
      const chId    = proj?.activeChapterId;
      const chapter = proj?.chapters?.find(c => c.id === chId);
      const d = proj?.id ? await loadForwardDraft(proj.id) : null;
      if (d && d.chapterId === chId && d.text?.trim()) {
        preFocusCursorRef.current = typeof d.cursor === 'number'
          ? Math.min(d.cursor, (chapter?.content || '').length)
          : preFocusCursorRef.current;
        setFocusResumeText(d.text);
        setDraftRecovery(null);   // entering Forward supersedes the standalone recovery prompt
      }
    }
    setFocusOpen(true);
  }

  function openFocusMode() {
    const el = editorRef.current;
    preFocusCursorRef.current = el
      ? (getCursorOffset(el) ?? (activeChapter.content?.length ?? 0))
      : (activeChapter.content?.length ?? 0);
    enterForward();
  }

  function restoreCursorAfterFocus(offset) {
    requestAnimationFrame(() => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      setCursorOffset(el, offset);
      scrollCursorIntoView(mainScrollRef.current);
    });
  }

  // ── Forward-mode crash recovery ────────────────────────────────────────────
  // FocusMode reports live text here; we debounce a write to IDB (lib/forwardDraft.js) keyed
  // by the session's project+chapter, so a crash mid-session costs no more than the debounce
  // window — parity with editing in the editor. Cleared on clean exit (publish/cancel).
  function clearDraftTimers() {
    if (focusDraftTimer.current)    { clearTimeout(focusDraftTimer.current);    focusDraftTimer.current = null; }
    if (focusDraftMaxTimer.current) { clearTimeout(focusDraftMaxTimer.current); focusDraftMaxTimer.current = null; }
  }
  function onFocusDraftChange(text) {
    if (guest) return;   // guest work isn't persisted anywhere — don't leave orphan drafts
    const sess = focusSessionRef.current;
    if (!sess) return;
    if (!text.trim()) {   // empty session → nothing to recover
      pendingDraftRef.current = null;
      clearDraftTimers();
      clearForwardDraft(sess.projectId, sess.chapterId);
      return;
    }
    pendingDraftRef.current = { projectId: sess.projectId, chapterId: sess.chapterId, cursor: sess.cursor, text };
    const fire = () => { clearDraftTimers(); if (pendingDraftRef.current) saveForwardDraft(pendingDraftRef.current); };
    // Trailing debounce: fire ~400ms after you stop, so a pause captures the final state promptly.
    if (focusDraftTimer.current) clearTimeout(focusDraftTimer.current);
    focusDraftTimer.current = setTimeout(fire, 400);
    // maxWait ceiling: a trailing debounce alone NEVER fires during unbroken typing, so a crash mid-
    // tear could lose everything since your last pause. This guarantees a write at least once per
    // ~1s, bounding worst-case loss to ~1s of typing regardless of speed. The draft is a few KB, so
    // an extra write per second is nothing.
    if (!focusDraftMaxTimer.current) focusDraftMaxTimer.current = setTimeout(fire, 1000);
  }
  function flushForwardDraft() {
    clearDraftTimers();
    if (pendingDraftRef.current) saveForwardDraft(pendingDraftRef.current);
  }
  function endForwardSession() {   // clear timers + the persisted draft for the just-ended session
    const sess = focusSessionRef.current;
    clearDraftTimers();
    pendingDraftRef.current = null;
    if (sess) clearForwardDraft(sess.projectId, sess.chapterId);
    focusSessionRef.current = null;
  }

  // Recovery actions on the offered draft.
  function resumeForwardDraft() {
    const d = draftRecovery; if (!d) return;
    setDraftRecovery(null);
    if (d.chapterId && d.chapterId !== project.activeChapterId && project.chapters.some(c => c.id === d.chapterId)) {
      updateProject({ activeChapterId: d.chapterId });
    }
    const ch = project.chapters.find(c => c.id === d.chapterId);
    preFocusCursorRef.current = typeof d.cursor === 'number' ? Math.min(d.cursor, (ch?.content || '').length) : (ch?.content || '').length;
    setFocusResumeText(d.text);
    setFocusOpen(true);
  }
  function addForwardDraft() {
    const d = draftRecovery; if (!d) return;
    setDraftRecovery(null);
    const ch = project.chapters.find(c => c.id === d.chapterId) || activeChapter;
    if (!ch) { clearForwardDraft(d.projectId, d.chapterId); return; }
    const content    = ch.content || '';
    const at         = typeof d.cursor === 'number' ? Math.min(d.cursor, content.length) : content.length;
    const before     = content.slice(0, at), after = content.slice(at);
    const insert     = (before.length > 0 && !/\s$/.test(before)) ? ' ' + d.text : d.text;
    const newContent = before + insert + after;
    const newCursor  = before.length + insert.length;
    updateChapter(ch.id, { content: newContent, cursorPosition: newCursor });
    // The editor is an uncontrolled contenteditable, so a state change alone is invisible.
    if (ch.id === project.activeChapterId) {
      // Content-only change to the active chapter doesn't trip the switch effect — rebuild the DOM.
      requestAnimationFrame(() => {
        const el = editorRef.current;
        if (!el) return;
        buildEditorDOM(el, newContent, ch.annotations || []);
        el.focus();
        setCursorOffset(el, newCursor);
        scrollCursorIntoView(mainScrollRef.current);
      });
    } else {
      // A different chapter: switching to it fires the "re-render on section switch" effect,
      // which rebuilds the DOM from the (now updated) content.
      updateProject({ activeChapterId: ch.id });
    }
    clearForwardDraft(d.projectId, d.chapterId);
  }
  function discardForwardDraft() {
    const d = draftRecovery; setDraftRecovery(null);
    if (d) clearForwardDraft(d.projectId, d.chapterId);
  }

  // Capture the session key when Forward opens; reset the resume seed when it closes.
  useEffect(() => {
    if (focusOpen) {
      focusSessionRef.current = { projectId: activeProjectId, chapterId: activeChapter?.id || null, cursor: preFocusCursorRef.current };
      // Hold the cover THROUGH FocusMode's ~280ms fade-in — the overlay is semi-transparent while
      // it fades, so clearing the cover immediately lets the editor bleed through (the "project
      // flash"). Drop it once FocusMode is opaque. (z790 cover sits just under FocusMode's z800.)
      const id = setTimeout(() => setFocusJumpCover(false), 320);
      return () => clearTimeout(id);
    } else {
      setFocusResumeText('');
    }
  }, [focusOpen]);

  // Safety: never let the jump cover stick if Forward somehow fails to open.
  useEffect(() => {
    if (!focusJumpCover) return;
    const id = setTimeout(() => setFocusJumpCover(false), 1500);
    return () => clearTimeout(id);
  }, [focusJumpCover]);

  // Flush the pending draft when the tab is hidden/closed — best-effort, narrows the window.
  useEffect(() => {
    const onHide = () => { if (focusOpenRef.current) flushForwardDraft(); };
    const onVis  = () => { if (document.visibilityState === 'hidden') onHide(); };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVis);
    return () => { window.removeEventListener('pagehide', onHide); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // On opening a project, offer any crashed Forward draft that belongs to it. Per project+chapter
  // keying means other projects' drafts are never touched or considered.
  useEffect(() => {
    if (!activeProjectId || guest || isReadOnly) return;
    let cancelled = false;
    loadForwardDraft(activeProjectId).then(d => {
      if (cancelled || !d || focusOpenRef.current) return;
      setDraftRecovery(d);
    });
    return () => { cancelled = true; };
  }, [activeProjectId]);

  function onFocusPublish(text, startNew) {
    if (startNew) {
      // New section inherits the current section's level and is inserted
      // immediately after the current section's subtree — before the next peer
      // or ancestor, not blindly at the end of the document.
      const level = activeChapter?.level || 1;
      const ch    = newChapter(project.chapters.length + 1, usesDateTitle, level);
      ch.content  = text;
      setProjects(prev => {
        const next = prev.map(p => {
          if (p.id !== activeProjectId) return p;
          const chs    = [...p.chapters];
          const curIdx = chs.findIndex(c => c.id === p.activeChapterId);
          // Walk forward past any deeper sections (the current section's children).
          // Insert before the first chapter at the same level or higher in the hierarchy
          // (i.e., same or lower level number). Default: append at end.
          let insertIdx = chs.length;
          for (let i = curIdx + 1; i < chs.length; i++) {
            if ((chs[i].level || 1) <= level) { insertIdx = i; break; }
          }
          chs.splice(insertIdx, 0, ch);
          return { ...p, chapters: chs, activeChapterId: ch.id };
        });
        saveProjectsDirty(next);
        return next;
      });
      restoreCursorAfterFocus(text.length);
    } else {
      const insertAt     = preFocusCursorRef.current;
      const content      = activeChapter.content || '';
      const before       = content.slice(0, insertAt);
      const after        = content.slice(insertAt);
      // Prepend a space if the cursor sits immediately after a non-whitespace character
      const insertText   = (before.length > 0 && !/\s$/.test(before)) ? ' ' + text : text;
      const newContent   = before + insertText + after;
      const newCursorPos = before.length + insertText.length;
      updateChapter(activeChapter.id, { content: newContent, cursorPosition: newCursorPos });
      // Contenteditable is uncontrolled — update the DOM directly
      const el = editorRef.current;
      if (el) {
        buildEditorDOM(el, newContent, activeChapter.annotations || []);
        // Focus and place cursor at end of inserted text, then scroll it into view
        el.focus();
        setCursorOffset(el, newCursorPos);
        scrollCursorIntoView(mainScrollRef.current);
      }
    }
    setFocusOpen(false);
    setFocusAutoPublish(false);
    // Clear the recovery draft AFTER the insert has been applied — never before. If a crash
    // hits the sliver between insert and clear, recovery may offer already-published text (a
    // possible duplicate the user can delete), which is the safe failure vs. losing the draft.
    endForwardSession();
  }

  // ── Sign-out ───────────────────────────────────────────────────────────────
  // Projects stay in localStorage, stamped with the user's email.
  // On next load, loadProjects filters by email so other users never see them.

  async function requestSignOut() {
    await onSignOut();
  }

  // ── Derived values ─────────────────────────────────────────────────────────

  const displayName = user ? (user.name || user.email.split('@')[0]) : null;
  const totalWords  = project.chapters.reduce((n, c) => n + countWords(c.content), 0);
  const activeAnns  = [...(activeChapter.annotations || [])].sort((a, b) => {
    if (a.anchorType === 'title' && b.anchorType !== 'title') return -1;
    if (b.anchorType === 'title' && a.anchorType !== 'title') return  1;
    return a.start - b.start;
  });
  const annCount    = activeAnns.length;

  // Guest-only onboarding pointer at the Forward button — until you click it,
  // oodbo looks like a plain text box; this draws the eye to the actual feature.
  const guestHintEl = (guest && showGuestHint && (isMobile || tourSkipped) && tourStep === null) ? (
    <div style={s.guestHint}>
      <div style={s.guestHintArrow} />
      <span style={s.guestHintText}>
        New here? Click <strong style={{ color: '#fff', fontStyle: 'normal' }}>Forward Mode</strong> to write without looking back.
      </span>
      <button style={s.guestHintClose} onClick={dismissGuestHint} aria-label="Dismiss">×</button>
    </div>
  ) : null;

  // Footer links — shared between the desktop footer bar and the mobile sidebar.
  const footerLinkStyle = { fontFamily: 'Georgia, serif', fontSize: 10, color: th.chromeFaint, fontStyle: 'italic', textDecoration: 'none' };
  const footerDotStyle  = { color: th.chromeFaint, fontSize: 10 };
  const footerLinksEl = (
    <>
      <a href="/privacy" target="_blank" rel="noopener noreferrer" style={footerLinkStyle}>privacy</a>
      <span style={footerDotStyle}>·</span>
      <a href="/terms" target="_blank" rel="noopener noreferrer" style={footerLinkStyle}>terms</a>
      <span style={footerDotStyle}>·</span>
      <a href={MS_STORE_URL} target="_blank" rel="noopener noreferrer" style={footerLinkStyle}>MS Word</a>
    </>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  // Wait for IDB to load — typically <5ms, imperceptible
  if (!dbReady) return null;

  return (
    <div style={{ ...s.shell, background: th.shell }}>

      {/* In-project find bar (Ctrl/Cmd-F). Floats over the page; cycles matches like the browser's find. */}
      {findOpen && (
        <div style={{
          position: 'fixed', top: 64, right: 24, zIndex: 700,
          display: 'flex', alignItems: 'center', gap: 6,
          background: th.chrome, border: `1px solid ${th.chromeBorder}`,
          borderRadius: 0, padding: '6px 8px', boxShadow: '0 4px 18px rgba(0,0,0,0.22)',
        }}>
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={e => { setFindQuery(e.target.value); setFindIdx(-1); setFindActive(null); }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); findNav(e.shiftKey && e.key === 'Enter' ? -1 : 1); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); findNav(-1); }
              else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
            }}
            placeholder="Find in project"
            style={{ border: 'none', outline: 'none', background: 'transparent', color: th.chromeText, fontSize: 14, width: 170 }}
          />
          <span style={{ fontSize: 12, color: th.chromeMuted, minWidth: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {findHits.length
              ? (findIdx >= 0 ? `${findIdx + 1}/${findHits.length}` : `${findHits.length} found`)
              : (findQuery.trim() ? 'none' : '')}
          </span>
          <button title="Previous (↑ / Shift+Enter)" disabled={!findHits.length} onClick={() => findNav(-1)}
            style={{ ...s.findNavBtn, color: th.chromeText, opacity: findHits.length ? 1 : 0.35 }}>↑</button>
          <button title="Next (↓ / Enter)" disabled={!findHits.length} onClick={() => findNav(1)}
            style={{ ...s.findNavBtn, color: th.chromeText, opacity: findHits.length ? 1 : 0.35 }}>↓</button>
          <button title="Close (Esc)" onClick={closeFind}
            style={{ ...s.findNavBtn, color: th.chromeMuted }}>✕</button>
        </div>
      )}

      {/* Long-section warning — a very large single section slows editing (reflow cost). Dismissible.
          Only appears after 1.5s of quiet (see sizeCheckTimer), never mid-typing. */}
      {sectionWarn && !isReadOnly && (
        <div style={s.sectionWarn}>
          <span style={s.sectionWarnText}>
            This section is about {sectionWarn.threshold.toLocaleString()} words. Long sections can make
            typing slow — consider starting a new section for what comes next.
          </span>
          <button style={s.sectionWarnDismiss} onClick={() => setSectionWarn(null)}>dismiss</button>
        </div>
      )}

      {/* First child of the flex column, so it pushes the page down instead of covering it.
          Gated exactly like the sync indicator below: no cloud, nothing to be offline from. */}
      {syncReconnect && !isReadOnly && user?.provider
        ? <ReconnectBanner provider={user.provider} onReconnect={onReconnect} />
        : !online && !isReadOnly && user?.provider && <OfflineBanner />}

      {/* Guest banner — a guest's writing is ephemeral, so the actions here (copy / export /
          sign in) are how they keep it. In the editor, !user only ever means guest mode. */}
      {!isReadOnly && !user && guest && (
        <div style={{ ...s.trialBanner, background: '#1f1f1f' }}>
          <span>Guest mode — nothing here is saved. Export it, or sign in free to keep it in your own cloud.</span>
          <span style={s.trialActions}>
            <button style={{ ...s.trialSignIn, color: '#fff', fontStyle: 'normal' }} onClick={handleCopyGuest}>
              {guestCopied ? 'copied ✓' : 'copy your writing'}
            </button>
            <span style={s.trialDot}>·</span>
            <button style={s.trialSignIn} onClick={() => setExportOpen(true)}>export</button>
            <span style={s.trialDot}>·</span>
            <button style={s.trialSignIn} onClick={onSignIn}>sign in</button>
            {!isMobile && (
              <>
                <span style={s.trialDot}>·</span>
                <button style={s.trialSignIn} onClick={() => { setTourPromptOpen(false); setTourSkipped(false); setTourStep(0); }}>take a tour</button>
              </>
            )}
          </span>
        </div>
      )}

      {/* Onboarding tour — large-screen only. Guests get it on landing; signed-in users get it on
          their first exit from Forward mode (see the effects above). */}
      {!isMobile && tourPromptOpen && (
        <div style={s.tourPrompt}>
          <p style={s.tourPromptText}>New to oodbo? Take a quick tour of the basics.</p>
          <div style={s.tourPromptBtns}>
            <button style={s.tourPromptSkip} onClick={() => { setTourPromptOpen(false); setTourSkipped(true); markTourSeen(); }}>Skip</button>
            <button style={s.tourPromptGo} onClick={() => { setTourPromptOpen(false); setTourSkipped(false); setTourStep(0); }}>Take the tour</button>
          </div>
        </div>
      )}
      {!isMobile && tourStep !== null && (
        <GuestTour
          steps={TOUR_STEPS}
          index={tourStep}
          onIndex={setTourStep}
          hidden={focusOpen}
          panelOpen={annPanelOpen}
          menuOpen={levelPickerOpen}
          onClose={() => { setTourStep(null); markTourSeen(); }}
        />
      )}

      {/* Header */}
      <header style={{ ...s.header, background: th.chrome, borderBottom: `1px solid ${th.chromeBorder}` }}>
        {isMobile ? (
          <>
            <button
              style={{ ...s.hamburgerBtn, color: th.chromeText }}
              onClick={() => setSidebarOpen(o => !o)}
              aria-label="Toggle sidebar"
            >☰</button>
            <span style={s.spacer}/>
            {user && onGoHome
              ? <button style={{ ...s.brand, color: th.chromeText, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }} onClick={handleGoHome}>Forward Only</button>
              : <span   style={{ ...s.brand, color: th.chromeText }}>Forward Only</span>
            }
            <span style={s.spacer}/>
            {isReadOnly ? (
              <>
                {annCount > 0 && (
                  <button
                    style={{ ...s.notesBtn, color: th.chromeMuted, border: `1px solid ${th.chromeBorder}`, ...(annPanelOpen ? { background: th.primaryBg, color: th.primaryText, border: `1px solid ${th.primaryBg}` } : {}) }}
                    onClick={handleNotesToggle}
                  >Notes · {annCount}</button>
                )}
                <button style={{ ...s.focusBtn, background: th.primaryBg, color: th.primaryText, border: `1px solid ${th.primaryBg}` }} onClick={handleTryIt}>Try it</button>
              </>
            ) : (
              <>
                <button
                  style={{ ...s.notesBtn, color: th.chromeMuted, border: `1px solid ${th.chromeBorder}`, ...(annPanelOpen ? { background: th.primaryBg, color: th.primaryText, border: `1px solid ${th.primaryBg}` } : {}) }}
                  onClick={handleNotesToggle}
                >Notes{annCount > 0 ? ` · ${annCount}` : ''}</button>
                <span style={s.guestHintWrap}>
                  <button style={{ ...s.focusBtn, background: th.primaryBg, color: th.primaryText, border: `1px solid ${th.primaryBg}` }} onClick={openFocusMode}>Forward Mode</button>
                  {guestHintEl}
                </span>
              </>
            )}
          </>
        ) : (
          <>
            {user && onGoHome
              ? <button style={{ ...s.brand, color: th.chromeText, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }} onClick={handleGoHome}>Forward Only</button>
              : <span   style={{ ...s.brand, color: th.chromeText }}>Forward Only</span>
            }
            {!isReadOnly && (titleEditing ? (
              <input
                style={{ ...s.projTitleInput, color: th.chromeMuted, borderBottom: `1px solid ${th.chromeBorder}` }}
                value={project.title}
                maxLength={60}
                onChange={e => updateProject({ title: e.target.value })}
                onBlur={() => setTitleEditing(false)}
                onKeyDown={e => { if (e.key === 'Enter') setTitleEditing(false); }}
                autoFocus
              />
            ) : (
              <span data-tour="rename" style={{ ...s.projTitle, color: th.chromeMuted }} onClick={() => setTitleEditing(true)} title="Click to rename">
                {project.title}
              </span>
            ))}
            <span style={s.spacer}/>
            {isReadOnly ? (
              <>
                {annCount > 0 && (
                  <button
                    style={{ ...s.notesBtn, color: th.chromeMuted, border: `1px solid ${th.chromeBorder}`, ...(annPanelOpen ? { background: th.primaryBg, color: th.primaryText, border: `1px solid ${th.primaryBg}` } : {}) }}
                    onClick={handleNotesToggle}
                  >Notes · {annCount}</button>
                )}
                <button style={{ ...s.focusBtn, background: th.primaryBg, color: th.primaryText, border: `1px solid ${th.primaryBg}` }} onClick={handleTryIt}>Try it free</button>
                <button style={{ ...s.notesBtn, color: th.chromeMuted, border: `1px solid ${th.chromeBorder}` }} onClick={onSignIn}>Sign in</button>
              </>
            ) : (
              <>
                <div ref={themeMenuRef} style={{ position: 'relative', display: 'inline-block' }}>
                  <button
                    style={{ fontFamily: 'Georgia, serif', fontSize: 11, background: 'transparent', border: 'none', color: th.chromeMuted, cursor: 'pointer', padding: '4px 2px', whiteSpace: 'nowrap' }}
                    onClick={() => setThemeMenuOpen(o => !o)}
                  >{EDITOR_THEMES[editorTheme]?.label || 'Theme'} ▾</button>
                  {themeMenuOpen && (
                    <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, minWidth: 130, background: th.chrome, border: `1px solid ${th.chromeBorder}`, boxShadow: '0 6px 20px rgba(0,0,0,0.18)', zIndex: 30, padding: '4px 0' }}>
                      {Object.entries(EDITOR_THEMES).map(([k, v]) => (
                        <button key={k}
                          style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: 'Georgia, serif', fontSize: 12, background: editorTheme === k ? th.active : 'transparent', color: th.chromeText, border: 'none', padding: '7px 14px', cursor: 'pointer' }}
                          onClick={() => { setEditorTheme(k); localStorage.setItem(`fwd:editor-theme:${user?.email || ''}`, k); setThemeMenuOpen(false); }}
                        >{v.label}</button>
                      ))}
                    </div>
                  )}
                </div>
                <span style={{ ...s.wordCount, color: th.chromeFaint }}>{plWords(totalWords)}</span>
                <span style={{ ...s.savedDot, color: th.chromeFaint }} title={saved ? 'Saved' : 'Saving…'}>{saved ? '✓' : '…'}</span>
                <button
                  data-tour="notes"
                  style={{ ...s.notesBtn, minWidth: 74, textAlign: 'center', color: th.chromeMuted, border: `1px solid ${th.chromeBorder}`, ...(annPanelOpen ? { background: th.primaryBg, color: th.primaryText, border: `1px solid ${th.primaryBg}` } : {}) }}
                  onClick={handleNotesToggle}
                >Notes{annCount > 0 ? ` · ${annCount}` : ''}</button>
                <span style={s.guestHintWrap}>
                  <button data-tour="forward" style={{ ...s.focusBtn, minWidth: 92, textAlign: 'center', background: th.primaryBg, color: th.primaryText, border: `1px solid ${th.primaryBg}` }} onClick={openFocusMode}>Forward Mode</button>
                  {guestHintEl}
                </span>
              </>
            )}
          </>
        )}
      </header>

      {/* Body */}
      <div style={s.body}>

        {/* Mobile sidebar overlay */}
        {isMobile && sidebarOpen && (
          <div style={s.sidebarOverlay} onClick={() => setSidebarOpen(false)} />
        )}

        {/* Left sidebar */}
        <aside style={{
          ...s.sidebar,
          background: th.chrome,
          borderRight: isMobile ? `1px solid ${th.chromeBorder}` : 'none',
          ...(isMobile ? {
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            zIndex: 700,
            transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
            transition: 'transform 0.25s ease',
            boxShadow: sidebarOpen ? '2px 0 16px rgba(0,0,0,0.18)' : 'none',
          } : {
            width: sidebarWidth,
          })
        }}>

          {/* Mobile close bar — full-width sidebar covers the header/hamburger */}
          {isMobile && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px 10px 14px', borderBottom: `1px solid ${th.chromeBorder}`, flexShrink: 0 }}>
              <span style={{ fontFamily: 'Georgia, serif', fontSize: 12, color: th.chromeMuted, fontStyle: 'italic' }}>oodbo</span>
              <button
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 20, color: th.chromeMuted, lineHeight: 1, padding: '0 2px' }}
                onClick={() => setSidebarOpen(false)}
                aria-label="Close sidebar"
              >×</button>
            </div>
          )}

          {/* Home link — logged-in users only */}
          {user && !isReadOnly && onGoHome && (
            <div style={{ ...s.projectRow, borderBottom: `1px solid ${th.chromeBorder}` }}>
              <button
                style={{ fontFamily: 'Georgia, serif', fontSize: 13, background: 'transparent', border: 'none', color: th.chromeText, cursor: 'pointer', padding: 0, flex: 1, textAlign: 'left' }}
                onClick={handleGoHome}
              >← Projects</button>
            </div>
          )}

          {/* Project title — mobile sidebar only (desktop shows it in the header) */}
          {isMobile && !isReadOnly && (
            <div style={{ padding: '8px 12px', borderBottom: `1px solid ${th.chromeBorder}` }}>
              {titleEditing ? (
                <input
                  style={{ ...s.projTitleInput, color: th.chromeMuted, borderBottom: `1px solid ${th.chromeBorder}`, width: '100%', fontSize: 13 }}
                  value={project.title}
                  maxLength={60}
                  onChange={e => updateProject({ title: e.target.value })}
                  onBlur={() => setTitleEditing(false)}
                  onKeyDown={e => { if (e.key === 'Enter') setTitleEditing(false); }}
                  autoFocus
                />
              ) : (
                <button
                  style={{ fontFamily: 'Georgia, serif', fontSize: 13, background: 'transparent', border: 'none', color: th.chromeMuted, cursor: 'pointer', padding: 0, textAlign: 'left', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  onClick={() => setTitleEditing(true)}
                  title="Tap to rename"
                >{project.title || 'Untitled'}</button>
              )}
            </div>
          )}

          {/* Scrollable chapter list */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {(() => {
            // Build the visible list in one forward pass so collapse state
            // propagates through the full ancestor chain, not just the direct parent.
            // collapsedAtLevel tracks the level of the deepest active collapsed ancestor.
            const visibleChapters = [];
            let collapsedAtLevel = null;
            for (const ch of project.chapters) {
              const level = ch.level || 1;
              // Exiting the collapsed subtree? Reset when we reach same-or-higher level.
              if (collapsedAtLevel !== null && level <= collapsedAtLevel) collapsedAtLevel = null;
              // Inside a collapsed subtree — skip.
              if (collapsedAtLevel !== null) continue;
              visibleChapters.push(ch);
              // This chapter is collapsed — mark its children as hidden.
              if (ch.collapsed) collapsedAtLevel = level;
            }
            return visibleChapters.map(ch => {
              const idx = project.chapters.findIndex(c => c.id === ch.id);
              const hasChildren = idx + 1 < project.chapters.length && (project.chapters[idx + 1].level || 1) > (ch.level || 1);
              return (
                <div
                  key={ch.id}
                  data-tour={idx === 0 ? 'section' : undefined}
                  style={{
                    ...s.chapterItem,
                    paddingLeft: 8 + ((ch.level || 1) - 1) * 12,
                    ...(ch.id === (isReadOnly ? activeWelcomeChapterId : project.activeChapterId) ? { ...s.chapterActive, background: th.active, borderLeft: `2px solid ${th.activeBorder}` } : {}),
                    ...(ch.id === dragOverId              ? s.chapterDragOver : {})
                  }}
                  onClick={() => selectChapter(ch.id)}
                  onMouseEnter={() => setHoveredChapter(ch.id)}
                  onMouseLeave={() => setHoveredChapter(null)}
                  onDragOver={isReadOnly ? undefined : (e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverId(ch.id); })}
                  onDrop={isReadOnly ? undefined : (e => {
                    e.preventDefault();
                    reorderChapters(dragIdRef.current, ch.id);
                    dragIdRef.current = null;
                    setDragOverId(null);
                  })}
                  onDragEnd={isReadOnly ? undefined : (() => { dragIdRef.current = null; setDragOverId(null); })}
                >
                  {!isReadOnly && (
                    <span
                      draggable
                      title="Drag to reorder"
                      style={{ ...s.dragHandle, color: th.chromeFaint }}
                      onDragStart={e => { e.stopPropagation(); dragIdRef.current = ch.id; e.dataTransfer.setData('text/plain', ch.id); e.dataTransfer.effectAllowed = 'move'; }}
                    >⠿</span>
                  )}
                  {/* Fixed-width collapse slot — always reserves space so titles stay aligned */}
                  {!isReadOnly && (
                    <span style={{ width: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                      {hasChildren && (
                        <button
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, fontSize: 9, color: th.chromeFaint, userSelect: 'none', lineHeight: 1 }}
                          onMouseDown={e => e.stopPropagation()}
                          onClick={e => { e.stopPropagation(); updateChapter(ch.id, { collapsed: !ch.collapsed }); }}
                          title={ch.collapsed ? 'Expand' : 'Collapse'}
                        >{ch.collapsed ? '▶' : '▼'}</button>
                      )}
                    </span>
                  )}
                  {!isReadOnly && (
                    <button
                      style={s.copyBtn}
                      title="Copy section text"
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(ch.content || '').then(() => {
                          setCopiedId(ch.id);
                          setTimeout(() => setCopiedId(null), 1500);
                        });
                      }}
                    >{copiedId === ch.id
                        ? <svg width="11" height="11" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="1.5,6 4,9 9.5,2" stroke={th.chromeMuted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        : <svg width="11" height="11" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3.5" y="0.5" width="7" height="8" rx="1" stroke={th.chromeMuted} strokeWidth="1"/><rect x="0.5" y="2.5" width="7" height="8" rx="1" fill={th.chrome} stroke={th.chromeMuted} strokeWidth="1"/></svg>
                      }</button>
                  )}
                  <span style={{ ...s.chapterTitle, color: th.chromeText }}>{ch.title}</span>
                  {!isReadOnly && <span style={{ ...s.chapterWc, color: th.chromeMuted }}>{plWords(countWords(ch.content))}</span>}
                  {!isReadOnly && (
                    <div
                      style={{ position: 'relative', flexShrink: 0, opacity: (hoveredChapter === ch.id || secMenuId === ch.id) ? 1 : 0, transition: 'opacity 0.1s' }}
                      ref={secMenuId === ch.id ? secMenuRef : null}
                    >
                      <button
                        data-tour={idx === 0 ? 'delete-section' : undefined}
                        style={{ ...s.chapterDeleteBtn, color: th.chromeMuted, fontSize: 15, letterSpacing: '0.04em' }}
                        title="Section actions"
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); setSecMenuId(secMenuId === ch.id ? null : ch.id); }}
                      >⋯</button>
                      {secMenuId === ch.id && (
                        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 3, minWidth: 150, background: th.chrome, border: `1px solid ${th.chromeBorder}`, boxShadow: '0 6px 20px rgba(0,0,0,0.18)', zIndex: 401, padding: '4px 0' }}>
                          <button
                            data-tour={idx === 0 ? 'new-section-plus' : undefined}
                            style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: 'Georgia, serif', fontSize: 12, background: 'transparent', color: th.chromeText, border: 'none', padding: '8px 12px', cursor: 'pointer' }}
                            onMouseDown={e => e.stopPropagation()}
                            onClick={e => { e.stopPropagation(); addChapterAfter(ch.id); setSecMenuId(null); }}
                          >Add section after</button>
                          <button
                            style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: 'Georgia, serif', fontSize: 12, background: 'transparent', color: th.danger, border: 'none', padding: '8px 12px', cursor: 'pointer' }}
                            onMouseDown={e => e.stopPropagation()}
                            onClick={e => {
                              e.stopPropagation();
                              setSecMenuId(null);
                              setConfirmDialog({ title: `Delete “${ch.title || 'this section'}”?`, body: 'This can’t be undone.', confirmLabel: 'Delete section', onConfirm: () => deleteChapter(ch.id) });
                            }}
                          >Delete section</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            });
          })()}
          {/* Drop zone at end of list — lets users drag a section to the bottom position */}
          {!isReadOnly && (
            <div
              style={{
                height: 20,
                margin: '0 8px 2px',
                borderTop: dragOverId === '__end__' ? '2px solid #111' : '2px solid transparent',
              }}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverId('__end__'); }}
              onDragLeave={() => setDragOverId(null)}
              onDrop={e => {
                e.preventDefault();
                reorderChapters(dragIdRef.current, '__end__');
                dragIdRef.current = null;
                setDragOverId(null);
              }}
            />
          )}
          {!isReadOnly && <button data-tour="new-section" style={{ ...btn(th, 'primary', { mobile: isMobile }), display: 'block', width: 'calc(100% - 24px)', margin: '8px 12px' }} onClick={addChapter}>{usesEntryLabel ? '+ New entry' : '+ New section'}</button>}
          </div>{/* end scrollable chapter list */}
          {/* Save to a local file — shown when there's no cloud sync (guests + any non-provider
              session); signed-in cloud users persist automatically, so they don't need it. */}
          {!isReadOnly && !(user?.provider) && (
            <div style={{ ...s.sideFileActions, borderTop: `1px solid ${th.chromeBorder}` }}>
              <button style={{ ...s.sideFileBtn, color: th.chromeMuted }} onClick={handleSave}>Save</button>
              {FSA_SUPPORTED && !fsaDegraded && (
                <>
                  <span style={{ color: th.chromeFaint }}>·</span>
                  <button style={{ ...s.sideFileBtn, color: th.chromeMuted }} onClick={handleSaveAs}>Save As</button>
                </>
              )}
              <span style={{ color: th.chromeFaint }}>·</span>
              <button style={{ ...s.sideFileBtn, color: th.chromeMuted }} onClick={() => setExportOpen(true)}>Export</button>
            </div>
          )}
          {/* Share links — underlined text, not buttons (lower weight than "+ New section") */}
          {!isReadOnly && (
            <div data-tour="share" style={{ padding: '6px 12px 4px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
              <button style={{ ...btn(th, 'ghost'), fontSize: 11, fontStyle: 'italic' }} onClick={() => { if (!user) { onSignIn(); return; } setShareModal(true); }}>share</button>
              <button style={{ ...btn(th, 'ghost'), fontSize: 11, fontStyle: 'italic' }} onClick={openProgressCard}>share progress</button>
            </div>
          )}

          {/* Cloud sync status — hidden in readOnly mode */}
          {!isReadOnly && user?.provider && (
            <div style={{ padding: '6px 12px 2px', fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic', color: syncStatus === 'error' ? '#a03030' : syncStatus === 'offline' ? '#888' : th.chromeFaint }}>
              {syncStatus === 'syncing' && 'Syncing…'}
              {syncStatus === 'synced'  && `Synced ${lastSyncedRef.current ? fmtSync(lastSyncedRef.current) : '✓'}`}
              {/* When the banner is up it has already said "offline" in the loudest voice the
                  app has, so don't say it a second time in the quietest — just add the one
                  thing it can't: how far behind the cloud copy actually is. The banner keys
                  off navigator.onLine, while this also covers a request that failed on a
                  connection that claims to be up, so it still says it plainly in that case. */}
              {syncStatus === 'offline' && (
                online
                  ? `Can’t reach your cloud — changes will sync when it’s back${lastSyncedRef.current ? ` · last synced ${fmtSync(lastSyncedRef.current)}` : ''}`
                  : (lastSyncedRef.current ? `Last synced ${fmtSync(lastSyncedRef.current)}` : 'Not synced yet')
              )}
              {syncStatus === 'error'   && (
                syncError === 'reauth' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <span style={{ color: '#a03030' }}>Storage disconnected.</span>
                    <button
                      style={{ fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'normal', padding: '3px 8px', background: '#a03030', color: '#fff', border: 'none', cursor: 'pointer', alignSelf: 'flex-start' }}
                      onClick={async () => { await onSignOut(); onSignIn(); }}
                    >Reconnect</button>
                  </div>
                ) : (
                  <span title={syncError || 'Unknown error'} style={{ cursor: 'help', borderBottom: '1px dotted #a03030' }}>
                    {`Sync failed${lastSyncedRef.current ? ` · last synced ${fmtSync(lastSyncedRef.current)}` : ''}`}
                  </span>
                )
              )}
            </div>
          )}

          {/* Theme selector — mobile sidebar only (desktop has it in the header). Text button + menu. */}
          {isMobile && !isReadOnly && (
            <div style={{ padding: '8px 12px 4px', borderTop: `1px solid ${th.chromeBorder}`, position: 'relative' }} ref={themeMenuRef}>
              <button
                style={{ fontFamily: 'Georgia, serif', fontSize: 13, background: 'transparent', border: 'none', color: th.chromeText, cursor: 'pointer', padding: '4px 0' }}
                onClick={() => setThemeMenuOpen(o => !o)}
              >Theme: {EDITOR_THEMES[editorTheme]?.label || ''} ▾</button>
              {themeMenuOpen && (
                <div style={{ position: 'absolute', bottom: '100%', left: 12, marginBottom: 4, minWidth: 160, background: th.chrome, border: `1px solid ${th.chromeBorder}`, boxShadow: '0 -6px 20px rgba(0,0,0,0.18)', zIndex: 30, padding: '4px 0' }}>
                  {Object.entries(EDITOR_THEMES).map(([k, v]) => (
                    <button key={k}
                      style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: 'Georgia, serif', fontSize: 13, minHeight: 44, boxSizing: 'border-box', background: editorTheme === k ? th.active : 'transparent', color: th.chromeText, border: 'none', padding: '9px 14px', cursor: 'pointer' }}
                      onClick={() => { setEditorTheme(k); localStorage.setItem(`fwd:editor-theme:${user?.email || ''}`, k); setThemeMenuOpen(false); }}
                    >{v.label}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Account — in readOnly mode show Try / Sign in CTA instead */}
          {isReadOnly ? (
            <div style={{ ...s.sideAccountRow, borderTop: `1px solid ${th.chromeBorder}`, flexDirection: 'column', alignItems: 'flex-start', gap: 8, padding: '12px 12px 8px' }}>
              <button
                style={{ fontFamily: 'Georgia, serif', fontSize: 13, padding: '8px 16px', background: th.primaryBg, color: th.primaryText, border: `1px solid ${th.primaryBg}`, cursor: 'pointer', width: '100%' }}
                onClick={handleTryIt}
              >Try it free</button>
              <button
                style={{ fontFamily: 'Georgia, serif', fontSize: 12, padding: '6px 16px', background: 'transparent', color: th.chromeMuted, border: `1px solid ${th.chromeBorder}`, cursor: 'pointer', width: '100%' }}
                onClick={onSignIn}
              >Sign in</button>
            </div>
          ) : guest ? null : (
            <div style={{ ...s.sideAccountRow, borderTop: `1px solid ${th.chromeBorder}` }}>
              {displayName
                ? <span style={{ ...s.sideAccountName, color: th.chromeMuted }}>{displayName}</span>
                : <button style={{ ...s.sideFileBtn, color: th.chromeMuted }} onClick={onSignIn}>sign in</button>
              }
              <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {/* Quiet way back to the tour — the only place it can replay is here,
                    where its editor targets exist. Desktop only (the tour is). */}
                {user && !isMobile && !isReadOnly && (
                  <button
                    style={{ ...s.sideFileBtn, color: th.chromeFaint }}
                    title="Replay the tour"
                    onClick={() => { setTourPromptOpen(false); setTourSkipped(false); setTourStep(0); }}
                  >tour</button>
                )}
                {user && (
                  <button style={{ ...s.sideFileBtn, color: th.chromeFaint }} onClick={requestSignOut}>sign out</button>
                )}
              </span>
            </div>
          )}
          {isMobile && (
            <div style={{ padding: '4px 12px 10px', display: 'flex', gap: 8 }}>
              {footerLinksEl}
            </div>
          )}

        </aside>

        {/* Sidebar resize handle — desktop only, sits between aside and main */}
        {!isMobile && (
          <div
            style={{
              width: 5, flexShrink: 0, cursor: 'ew-resize',
              background: sidebarHandleHover || sidebarDragRef.current
                ? th.activeBorder : th.chromeBorder,
              transition: 'background 0.15s',
              userSelect: 'none',
            }}
            onMouseEnter={() => setSidebarHandleHover(true)}
            onMouseLeave={() => setSidebarHandleHover(false)}
            onMouseDown={e => {
              e.preventDefault();
              sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
            }}
          />
        )}

        {/* Editor panel */}
        <main style={s.main}>
          <div
            ref={mainScrollRef}
            style={{ ...s.mainScroll, background: th.shell, ...(isMobile ? { padding: 0, paddingBottom: annPanelOpen ? '55vh' : 0 } : {}) }}
            onClick={e => { if (e.target === e.currentTarget) editorRef.current?.focus(); }}
          >
            <div
              ref={pageRef}
              style={{ ...s.page, zoom, position: 'relative', background: th.page, minHeight: '100%', ...(isMobile ? s.pageMobile : {}) }}
              onClick={e => { if (e.target === e.currentTarget) editorRef.current?.focus(); }}
            >
              {/* Search-match highlight overlay — "mimics focus" (a highlight) with no caret/selection,
                  so pressing Enter in the find bar keeps cycling instead of editing the match. */}
              {findRects.map((r, i) => (
                <div key={i} aria-hidden="true" style={{
                  position: 'absolute', left: r.left, top: r.top, width: r.width, height: r.height,
                  background: 'rgba(255, 190, 60, 0.45)', borderRadius: 2, pointerEvents: 'none', zIndex: 6,
                }} />
              ))}

              {/* Margin annotation markers — desktop only (no right margin on mobile) */}
              {!isMobile && activeAnns.length > 0 && (() => {
                // Only draw a bar once its Y has actually been measured (markerYs entry present).
                // A newly-added annotation has no entry until the measure effect runs, so without
                // this it would flash at the default/top position for ~300ms before dropping to its
                // line. Filtering here makes the bar simply appear in place instead.
                const measuredAnns = activeAnns.filter(a => markerYs[a.id] !== undefined);
                if (measuredAnns.length === 0) return null;
                const groups = layoutMarkers(measuredAnns, markerYs);
                return groups.map(group => {
                  // Split into rows of max 4 so the bar doesn't get too busy
                  const rows = [];
                  for (let i = 0; i < group.anns.length; i += 8) rows.push(group.anns.slice(i, i + 8));
                  // Stack rows UPWARD: bottom row sits at group.y (flush with text bottom),
                  // extra rows climb into the line above rather than spilling below it.
                  const stackTop = group.y - (rows.length - 1) * 7; // 5px bar + 2px gap
                  return (
                    <div
                      key={group.anns.map(a => a.id).join('-')}
                      style={{ ...s.annMarker, top: stackTop, height: 'auto', display: 'flex', flexDirection: 'column', gap: 2, background: 'none' }}
                    >
                      {rows.map((row, ri) => (
                        <div key={ri} style={{ display: 'flex', height: 5, gap: 1 }}>
                          {row.map(ann => (
                            <div
                              key={ann.id}
                              title={ann.note || ann.anchorText}
                              style={{
                                flex: 1,
                                height: '100%',
                                background: expandedAnnId === ann.id ? annActive(ann.colorIndex, annPalette) : annIdle(ann.colorIndex, annPalette),
                                opacity:    expandedAnnId === ann.id ? 1 : 0.7,
                                cursor: 'pointer',
                                transition: 'opacity 0.15s, background 0.15s'
                              }}
                              onClick={() => toggleAnnotation(ann)}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  );
                });
              })()}

              {/* Section title */}
              {(() => {
                const titleFontSize = [28, 22, 18, 16, 15, 14, 14, 13, 13][(activeChapter.level || 1) - 1] || 15;
                return (
                  <input
                    ref={titleRef}
                    data-tour="section-title"
                    style={{ ...s.chapterTitleInput, color: th.pageText, fontSize: titleFontSize, ...(isReadOnly ? { cursor: 'default', userSelect: 'text' } : {}) }}
                    value={activeChapter.title}
                    maxLength={50}
                    readOnly={isReadOnly}
                    onChange={isReadOnly ? undefined : (e => updateChapter(activeChapter.id, { title: e.target.value }))}
                    onFocus={() => { if (!isReadOnly && isMobile && annPanelOpen) setAnnPanelOpen(false); }}
                    onMouseUp={isReadOnly ? undefined : (() => captureSelection('title'))}
                    onSelect={isReadOnly ? undefined : (() => captureSelection('title'))}
                    onKeyDown={isReadOnly ? undefined : (e => {
                      if (e.key === 'Enter') { e.preventDefault(); editorRef.current?.focus(); }
                    })}
                  />
                );
              })()}

              {/* Level badge */}
              {!isReadOnly && !usesDateTitle && (
                <div ref={levelPickerRef} style={{ position: 'relative', display: 'inline-block', marginBottom: 8 }}>
                  <button
                    data-tour="section-header"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => setLevelPickerOpen(v => !v)}
                    style={{
                      fontFamily: 'Georgia, serif', fontSize: 9, padding: '1px 6px',
                      background: 'transparent', border: `1px solid ${th.chromeBorder}`,
                      color: th.chromeMuted, cursor: 'pointer', letterSpacing: '0.02em',
                      userSelect: 'none',
                    }}
                  >{activeChapter.level === 1 ? 'H1' : activeChapter.level === 0 ? '¶' : `H${activeChapter.level}`}</button>
                  {levelPickerOpen && (
                    <div data-tour="section-header-menu" style={{
                      position: 'absolute', top: '100%', left: 0, marginTop: 3, zIndex: 401,
                      background: th.chrome, border: `1px solid ${th.chromeBorder}`,
                      boxShadow: '0 4px 16px rgba(0,0,0,0.18)', minWidth: 80, paddingTop: 4, paddingBottom: 4,
                    }}>
                      {[1,2,3,4,5,6,7,8,9].map(lvl => (
                        <button key={lvl}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => { updateChapter(activeChapter.id, { level: lvl }); setLevelPickerOpen(false); }}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left',
                            fontFamily: 'Georgia, serif', fontSize: 10, padding: '2px 10px',
                            background: activeChapter.level === lvl ? th.active : 'transparent',
                            color: th.chromeText, border: 'none', cursor: 'pointer',
                          }}
                        >H{lvl}{lvl === 1 ? ' — chapter' : lvl === 2 ? ' — section' : ''}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Contenteditable writing area */}
              <div
                ref={editorRef}
                contentEditable={isReadOnly ? false : true}
                suppressContentEditableWarning
                className="fwd-editor"
                style={{ ...s.editor, color: th.pageText, ...(isReadOnly ? { cursor: 'default', userSelect: 'text' } : {}) }}
                onFocus={isReadOnly ? undefined : (() => { if (isMobile && annPanelOpen) setAnnPanelOpen(false); })}
                onInput={isReadOnly ? undefined : handleEditorInput}
                onKeyDown={isReadOnly ? undefined : handleEditorKeyDown}
                onPaste={isReadOnly ? undefined : handleEditorPaste}
                onMouseUp={isReadOnly ? undefined : (() => captureSelection('content'))}
                onKeyUp={isReadOnly ? undefined : (() => captureSelection('content'))}
                data-placeholder={isReadOnly ? '' : 'Begin writing here, or click Forward Mode…'}
                spellCheck={!isReadOnly}
              />

            </div>
          </div>
        </main>

        {/* Annotations panel */}
        {annPanelOpen && (
          <>
            <aside style={{
              ...s.annPanel,
              background: th.chrome,
              borderLeft: `1px solid ${th.chromeBorder}`,
              ...(isMobile ? {
                position: 'fixed',
                bottom: sheetOffset,
                left: 0,
                right: 0,
                width: '100%',
                height: '55vh',
                zIndex: 650,
                borderLeft: 'none',
                borderTop: `1px solid ${th.chromeBorder}`,
                boxShadow: '0 -4px 20px rgba(0,0,0,0.12)',
                // Clear the home indicator when the sheet sits at the viewport bottom.
                paddingBottom: 'env(safe-area-inset-bottom)',
              } : {})
            }}>
            {/* Drag handle pill — signals bottom sheet on mobile */}
            {isMobile && <div style={{ ...s.sheetHandle, background: th.chromeFaint }} />}
            <div style={{ ...s.annPanelHead, borderBottom: `1px solid ${th.chromeBorder}` }}>
              <span style={{ ...s.annPanelLabel, color: th.chromeMuted }}>Notes{activeAnns.length > 0 ? ` · ${activeAnns.length}` : ''}</span>
              {!isReadOnly && (
                <button
                  style={{ ...s.annAddBtn, color: th.chromeMuted }}
                  onMouseDown={e => e.preventDefault()}
                  onClick={startAddAnnotation}
                  title="Select text first, then click to add a note"
                >+ Add</button>
              )}
              {isMobile && (
                <button
                  style={{ ...s.annCloseBtn, color: th.chromeMuted }}
                  onClick={() => setAnnPanelOpen(false)}
                  aria-label="Close notes"
                >×</button>
              )}
            </div>
            {annHint && (
              <div style={{ ...s.annHintBox, background: th.active, borderBottom: `1px solid ${th.chromeBorder}` }}>
                <p style={{ ...s.annHintMsg, color: th.chromeText }}>{annHint}</p>
                <button style={{ ...s.annHintOk, background: th.primaryBg, color: th.primaryText, border: `1px solid ${th.primaryBg}` }} onClick={() => setAnnHint('')}>OK</button>
              </div>
            )}

            {addingAnn && (
              <div style={{ ...s.annForm, borderBottom: `1px solid ${th.chromeBorder}` }}>
                {(() => {
                  const src = pendingSelRef.current.anchorType === 'title' ? activeChapter.title : activeChapter.content;
                  const { start, end } = snapRange(src, pendingSelRef.current.start, pendingSelRef.current.end);
                  const t  = src.slice(start, end);
                  const ci = annColorIndex(start, pendingSelRef.current.anchorType || 'content');
                  return (
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ ...s.annBubble, background: annIdle(ci, annPalette), alignSelf: 'center' }} />
                      <span style={s.annFormAnchor}>&ldquo;{t.length > 80 ? t.slice(0, 80) + '…' : t}&rdquo;</span>
                    </div>
                  );
                })()}
                <textarea
                  style={s.annFormInput}
                  value={annInput}
                  onChange={e => { setAnnInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
                  ref={el => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }}
                  placeholder="Your note…"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.altKey)) { e.preventDefault(); saveAnnotation(); }
                    if (e.key === 'Escape') { setAddingAnn(false); setAnnInput(''); pendingSelRef.current = { start: 0, end: 0, anchorType: 'content' }; }
                  }}
                />
                <p style={{ fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic', color: th.chromeFaint, margin: '6px 0 8px' }}>Ctrl / ⌘ + Enter to save</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={btn(th, 'ghost')} onClick={() => { setAddingAnn(false); setAnnInput(''); pendingSelRef.current = { start: 0, end: 0, anchorType: 'content' }; }}>Cancel</button>
                  <button style={btn(th, 'primary')} onClick={saveAnnotation}>Save</button>
                </div>
              </div>
            )}

            <div style={s.annList}>
              {activeAnns.length === 0 && !addingAnn && (
                <p style={s.annEmpty}>{isReadOnly ? 'No notes on this section.' : 'Select text, then click + Add.'}</p>
              )}
              {activeAnns.map(ann => {
                const isExpanded = expandedAnnId === ann.id;
                return (
                  <div key={ann.id} style={{ ...s.annItem, borderBottom: `1px solid ${th.active}`, ...(isExpanded ? { ...s.annItemExpanded, background: th.active } : {}) }}>
                    <div style={s.annItemRow} onClick={() => toggleAnnotation(ann)}>
                      <span style={{
                        ...s.annBubble,
                        background: expandedAnnId === ann.id ? annActive(ann.colorIndex, annPalette) : annIdle(ann.colorIndex, annPalette)
                      }} />
                      <span style={s.annItemPreview}>&ldquo;{ann.anchorText}&rdquo;</span>
                      {!isReadOnly && (
                        <button
                          style={{ ...s.annDeleteBtn, color: th.danger }}
                          onMouseDown={e => e.stopPropagation()}
                          onClick={e => { e.stopPropagation(); setConfirmDialog({ title: 'Delete this note?', body: 'This can’t be undone.', confirmLabel: 'Delete', onConfirm: () => deleteAnnotation(ann.id) }); }}
                          title="Delete note"
                        >×</button>
                      )}
                    </div>
                    {isExpanded && editingAnnId !== ann.id && (
                      <div style={s.annExpanded}>
                        {ann.note
                          ? <p style={s.annNoteText}>{ann.note}</p>
                          : <p style={s.annNotePlaceholder}>No note yet.</p>
                        }
                        {!isReadOnly && <button style={{ ...btn(th, 'ghost'), marginTop: 8 }} onClick={() => startEditingAnnotation(ann)}>Edit</button>}
                      </div>
                    )}
                    {isExpanded && editingAnnId === ann.id && (
                      <div style={s.annExpanded}>
                        <textarea
                          style={s.annFormInput}
                          value={editingNote}
                          onChange={e => { setEditingNote(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
                          ref={el => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; el.focus(); setTimeout(() => el.setSelectionRange(el.value.length, el.value.length), 0); } }}
                          placeholder="Your note…"
                          onKeyDown={e => {
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.altKey)) { e.preventDefault(); saveAnnotationEdit(ann.id); }
                            if (e.key === 'Escape') cancelAnnotationEdit();
                          }}
                        />
                        <p style={{ fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic', color: th.chromeFaint, margin: '6px 0 8px' }}>Ctrl / ⌘ + Enter to save</p>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button style={btn(th, 'ghost')} onClick={cancelAnnotationEdit}>Cancel</button>
                          <button style={btn(th, 'primary')} onClick={() => saveAnnotationEdit(ann.id)}>Save</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            </aside>
          </>
        )}

      </div>

      {/* Footer — zoom controls, hidden on mobile */}
      <style>{`
        .fwd-zoom::-webkit-slider-thumb { width:10px; height:10px; }
        .fwd-zoom::-moz-range-thumb     { width:10px; height:10px; border:none; background:#aaa; border-radius:50%; }
        .fwd-zoom::-webkit-slider-runnable-track { height:2px; }
        .fwd-zoom::-moz-range-track              { height:2px; }
        .fwd-editor:empty::before {
          content: attr(data-placeholder);
          color: ${th.chromeFaint};
          pointer-events: none;
        }
        .fwd-editor mark {
          background-color: transparent;
          color: inherit;
          outline: none;
        }
        ${isMobile ? `
        .fwd-editor mark {
          text-decoration: underline dotted;
          text-decoration-color: ${th.chromeMuted};
          text-underline-offset: 3px;
        }
        ` : ''}
      `}</style>
      {!isMobile && (
        <div style={s.editorFooter}>
          <div style={s.footerLinks}>{footerLinksEl}</div>
          <div style={s.zoomControls}>
            <button style={s.zoomBtn} onClick={() => handleZoom(Math.max(0.7, Math.round((zoom - 0.05) * 100) / 100))} title="Zoom out">−</button>
            <input type="range" min={0.7} max={1.5} step={0.05} value={zoom} onChange={e => handleZoom(parseFloat(e.target.value))} className="fwd-zoom" style={s.zoomSlider}/>
            <button style={s.zoomBtn} onClick={() => handleZoom(Math.min(1.5, Math.round((zoom + 0.05) * 100) / 100))} title="Zoom in">+</button>
            <span style={s.zoomLabel} onClick={() => handleZoom(1)} title="Reset to 100%">Zoom {Math.round(zoom * 100)}%</span>
          </div>
        </div>
      )}

      {/* New project type picker */}
      {newProjectPrompt && (
        <div style={isMobile ? s.deleteOverlay : s.typePickerAnchor}>
          <div style={{ ...s.typePickerModal, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box' }}>
            <p style={s.deleteTitle}>What are you starting?</p>
            {[
              { type: 'journal',    label: 'Journal',    desc: 'Dated entries, written forward' },
              { type: 'story',      label: 'Story',      desc: 'Long-form narrative' },
              { type: 'essay',      label: 'Essay',      desc: 'Structured argument or analysis' },
              { type: 'brainstorm', label: 'Brainstorm', desc: 'Rapid capture, no structure needed' },
              { type: 'log',        label: 'Log',        desc: 'Record-keeping and notes' },
            ].map(({ type, label, desc }) => (
              <button key={type} style={s.typePickerBtn} onClick={() => createProjectOfType(type)}>
                <span style={s.typePickerLabel}>{label}</span>
                <span style={s.typePickerDesc}>{desc}</span>
              </button>
            ))}
            <button style={s.deleteGhost} onClick={() => setNewProjectPrompt(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Export format menu — the active project, any format (free for everyone, incl. guests) */}
      {exportOpen && (
        <div style={dg.overlay} onClick={() => setExportOpen(false)}>
          <BodyScrollLock />
          <div style={dg.box} onClick={e => e.stopPropagation()}>
            <p style={dg.title}>Export “{project.title || 'Untitled'}”</p>
            <div style={dg.rule} />
            <p style={dg.body}>Download this project to your device.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                ['oodbo', 'oodbo file (.oodbo)'],
                ['docx',  'Word (.docx)'],
                ['pdf',   'PDF (.pdf)'],
                ['txt',   'Plain text (.txt)'],
                ['md',    'Markdown (.md)'],
              ].map(([fmt, label]) => (
                <button key={fmt}
                  style={{ ...btn(th, 'secondary', { mobile: isMobile }), textAlign: 'left', width: '100%' }}
                  onClick={() => handleExport(fmt)}
                >{label}</button>
              ))}
            </div>
            <div style={dg.actions}>
              <button style={btn(th, 'ghost', { mobile: isMobile })} onClick={() => setExportOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Share modal */}
      {shareModal && (() => {
        const p              = projectRef.current;
        const projectShareId = shareLinks[shareKey(p.id, null)];
        const sectionShareId = shareLinks[shareKey(p.id, activeChapter?.id)];
        const dot = { color: th.chromeFaint, fontSize: 10, margin: '0 4px' };

        // Render a share slot based on the share's current status. `slotChapterId`
        // identifies which slot this is (null = full project) so the loading/copied
        // animations fire only on the row actually being actioned.
        const shareSlot = (slotChapterId, shareId, onShare, onRemove) => {
          const status    = shareId ? (shareStatuses[shareId] ?? 'active') : null;
          const isLoading = shareLoading === shareKey(p.id, slotChapterId);
          const isCopied  = shareCopied === shareId;

          if (!shareId) {
            // No share yet
            return (
              <button style={{ fontFamily: 'Georgia, serif', fontSize: 11, padding: '5px 12px', background: th.primaryBg, color: th.primaryText, border: 'none', cursor: 'pointer', marginTop: 4 }} onClick={onShare} disabled={isLoading}>
                {isLoading ? 'creating…' : 'Create link'}
              </button>
            );
          }

          if (status === 'reported') {
            return (
              <div style={{ marginTop: 6 }}>
                <p style={{ fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic', color: th.chromeMuted, margin: '0 0 2px' }}>
                  under review — link hidden pending moderation
                </p>
                <p style={{ fontFamily: 'Georgia, serif', fontSize: 10, color: th.chromeFaint, margin: 0, fontStyle: 'italic' }}>
                  no actions available while under review
                </p>
              </div>
            );
          }

          if (status === 'blocked') {
            return (
              <div style={{ marginTop: 6 }}>
                <p style={{ fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic', color: '#a03030', margin: '0 0 2px' }}>
                  permanently removed — sharing policy violation
                </p>
                <p style={{ fontFamily: 'Georgia, serif', fontSize: 10, color: th.chromeFaint, margin: 0, fontStyle: 'italic' }}>
                  this project can no longer be shared
                </p>
              </div>
            );
          }

          // Active share
          return (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  readOnly
                  value={shareUrl(shareId)}
                  style={{ flex: 1, fontFamily: 'Georgia, serif', fontSize: 10, border: `1px solid ${th.chromeBorder}`, background: th.active, color: th.chromeText, padding: '4px 6px', outline: 'none' }}
                  onFocus={e => e.target.select()}
                />
                <button
                  style={{ fontFamily: 'Georgia, serif', fontSize: 10, padding: '4px 8px', background: isCopied ? '#4a7c4a' : th.primaryBg, color: th.primaryText, border: 'none', cursor: 'pointer', flexShrink: 0, transition: 'background 0.2s' }}
                  onClick={() => { navigator.clipboard.writeText(shareUrl(shareId)); setShareCopied(shareId); setTimeout(() => setShareCopied(c => c === shareId ? null : c), 1500); }}
                >{isCopied ? '✓ Copied' : 'Copy'}</button>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={{ fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic', background: 'transparent', border: 'none', color: th.chromeMuted, cursor: 'pointer', padding: 0 }} onClick={onShare} disabled={isLoading}>
                  {isLoading ? 'updating…' : 'Update snapshot'}
                </button>
                <span style={dot}>·</span>
                <button style={{ fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic', background: 'transparent', border: 'none', color: '#a03030', cursor: 'pointer', padding: 0 }} onClick={onRemove}>
                  Remove link
                </button>
              </div>
            </div>
          );
        };

        // ── Share options ──────────────────────────────────────────────────────
        return (
          <div style={dg.overlay} onClick={() => setShareModal(false)}>
            <BodyScrollLock />
            <div style={{ ...dg.box, ...(isMobile ? {} : { width: 400 }) }} onClick={e => e.stopPropagation()}>
              <p style={dg.title}>Share</p>
              <div style={dg.rule} />

              {/* Full project */}
              <div style={{ marginBottom: 16 }}>
                <p style={{ fontFamily: 'Georgia, serif', fontSize: 12, color: th.chromeText, margin: '0 0 4px' }}>
                  <strong style={{ fontWeight: 'normal' }}>Full project</strong>
                  <span style={{ ...dot, marginLeft: 6 }} />
                  <span style={{ fontSize: 10, color: th.chromeMuted, fontStyle: 'italic' }}>{p.title || 'Untitled'}</span>
                </p>
                {shareSlot(null, projectShareId, () => handleShare(null), () => handleUnshare(null))}
              </div>

              {/* Current section */}
              <div style={{ borderTop: `1px solid ${th.chromeBorder}`, paddingTop: 14 }}>
                <p style={{ fontFamily: 'Georgia, serif', fontSize: 12, color: th.chromeText, margin: '0 0 4px' }}>
                  <strong style={{ fontWeight: 'normal' }}>This section</strong>
                  <span style={{ ...dot, marginLeft: 6 }} />
                  <span style={{ fontSize: 10, color: th.chromeMuted, fontStyle: 'italic' }}>{activeChapter?.title || 'Untitled section'}</span>
                </p>
                {(() => {
                  // If the full-project link is blocked/reported, section shares are locked too
                  const projectStatus = projectShareId ? (shareStatuses[projectShareId] ?? 'active') : null;
                  if (!sectionShareId && (projectStatus === 'reported' || projectStatus === 'blocked')) {
                    return shareSlot(activeChapter?.id, projectShareId, null, null);
                  }
                  return shareSlot(activeChapter?.id, sectionShareId, () => handleShare(activeChapter?.id), () => handleUnshare(activeChapter?.id));
                })()}
              </div>

              <div style={dg.actions}>
                <button style={btn(th, 'ghost', { mobile: isMobile })} onClick={() => setShareModal(false)}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Share progress card modal */}
      {progressModal && (
        <div style={dg.overlay} onClick={() => setProgressModal(false)}>
          <BodyScrollLock />
          <div
            style={{ ...dg.box, ...(isMobile ? {} : { width: 460 }) }}
            onClick={e => e.stopPropagation()}
          >
            <p style={dg.title}>Share progress</p>
            <div style={dg.rule} />
            <p style={{ ...dg.body, color: th.chromeMuted, margin: '0 0 12px' }}>A card for the eye, a text line for the thread.</p>

            {/* Scrollable preview — the card image can be tall; keep the action buttons pinned below. */}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginBottom: 12 }}>
              {progressUrl && (
                <img
                  src={progressUrl}
                  alt={progressMeta?.textLine || 'Progress card preview'}
                  style={{ width: '100%', display: 'block', border: `1px solid ${th.chromeBorder}`, marginBottom: 10 }}
                />
              )}

              {/* Plain-text companion line — the accessible/thread-friendly version */}
              <p style={{ fontFamily: 'Georgia, serif', fontSize: 12, lineHeight: 1.5, color: th.chromeText, margin: 0, border: `1px solid ${th.chromeBorder}`, background: th.shell, padding: '10px 12px' }}>
                “{progressMeta?.title}”<br />
                {plWords(progressMeta?.words || 0)}, {progressMeta?.sections} {progressMeta?.secWord}, {progressMeta?.dateStr}. A forward-only draft, written by a human at{' '}
                <a href="https://write.mercoogs.com" target="_blank" rel="noreferrer" style={{ color: th.primaryBg }}>write.mercoogs.com</a>
              </p>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                style={{ ...btn(th, 'primary', { mobile: isMobile }), flex: 1 }}
                onClick={canCopyImage ? handleCopyImage : handleDownloadProgress}
              >{canCopyImage ? (progressCopied === 'image' ? '✓ Copied' : 'Copy card') : (progressSaved ? '✓ Saved' : 'Save card')}</button>
              <button
                style={{ ...btn(th, 'secondary', { mobile: isMobile }), flex: 1 }}
                onClick={handleCopyProgressText}
              >{progressCopied === 'text' ? '✓ Copied' : 'Copy text'}</button>
            </div>

            <div style={dg.actions}>
              <button style={btn(th, 'ghost', { mobile: isMobile })} onClick={() => setProgressModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Transition cover for Home → Forward jumps: a full-screen panel in the Forward theme's
          colour that hides the editor (and any recovery prompt) mounting underneath. It sits at
          z790, just UNDER FocusMode (z800), so it stays up THROUGH the ~280ms fade-in (kept via
          the timed clear in the effect above) — otherwise the editor bleeds through the
          semi-transparent overlay. Do NOT gate on !focusOpen or it vanishes the moment Forward
          opens, before the fade completes. */}
      {focusJumpCover && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 790,
          background: (() => {
            try {
              const t = localStorage.getItem('fwd:focus-theme') || 'dark-white';
              return { 'dark-white': '#000', 'dark-green': '#0a0a0a', 'dark-amber': '#0a0800', 'light': '#f5f2eb' }[t] || '#000';
            } catch { return '#000'; }
          })(),
        }} />
      )}

      {focusOpen && (
        <FocusMode
          chapter={activeChapter}
          introOpen={forwardIntro}
          onIntroDismiss={() => setForwardIntro(false)}
          onPublish={onFocusPublish}
          onCancel={() => {
            setFocusOpen(false);
            setFocusAutoPublish(false);
            restoreCursorAfterFocus(preFocusCursorRef.current);
            endForwardSession();   // explicit discard clears the recovery draft
          }}
          journalMode={isJournal}
          autoPublish={focusAutoPublish}
          prefix={(activeChapter?.content || '').slice(0, preFocusCursorRef.current)}
          initialText={focusResumeText}
          onDraftChange={onFocusDraftChange}
        />
      )}

      {/* Forward-mode crash recovery — offered on opening a project that has an unrecovered
          draft. Overlay click = "later" (keeps the draft); only Discard drops it. */}
      {/* Themed dialog — replaces window.confirm (destructive) and window.alert (notice). */}
      {confirmDialog && (() => {
        const d = confirmDialog.notice ? dg : dgD;   // notice = neutral rule; confirm = danger rule
        return (
          <div style={d.overlay} onClick={() => setConfirmDialog(null)}>
            <BodyScrollLock />
            <div style={{ ...d.box, ...(isMobile ? {} : { width: 380 }) }} onClick={e => e.stopPropagation()}>
              <p style={d.title}>{confirmDialog.title}</p>
              <div style={d.rule} />
              {confirmDialog.body && <p style={{ ...d.body, color: th.chromeMuted }}>{confirmDialog.body}</p>}
              <div style={d.actions}>
                {!confirmDialog.notice && (
                  <button style={btn(th, 'ghost', { mobile: isMobile })} onClick={() => setConfirmDialog(null)}>Cancel</button>
                )}
                <button
                  style={btn(th, confirmDialog.notice ? 'primary' : 'destructive', { mobile: isMobile })}
                  onClick={() => { const fn = confirmDialog.onConfirm; setConfirmDialog(null); fn?.(); }}
                >{confirmDialog.confirmLabel || 'OK'}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {draftRecovery && !focusOpen && !focusJumpCover && (() => {
        const secTitle = (project.chapters.find(c => c.id === draftRecovery.chapterId)?.title) || 'this section';
        const preview  = draftRecovery.text.trim().replace(/\s+/g, ' ').slice(0, 160);
        const n        = countWords(draftRecovery.text);
        return (
          <div style={dg.overlay} onClick={() => setDraftRecovery(null)}>
            <BodyScrollLock />
            <div style={{ ...dg.box, ...(isMobile ? {} : { width: 440 }) }} onClick={e => e.stopPropagation()}>
              <p style={dg.title}>Recover Forward writing</p>
              <div style={dg.rule} />
              <p style={{ ...dg.body, color: th.chromeMuted, margin: '0 0 8px' }}>
                A Forward session closed before it was saved — {plWords(n)} still waiting:
              </p>
              <p style={{ fontFamily: 'Georgia, serif', fontSize: 12, fontStyle: 'italic', lineHeight: 1.5, color: th.chromeText, border: `1px solid ${th.chromeBorder}`, background: th.shell, padding: '10px 12px', margin: '0 0 4px', maxHeight: 130, overflowY: 'auto' }}>
                …{preview}{draftRecovery.text.trim().length > 160 ? '…' : ''}
              </p>
              <div style={dg.actions}>
                <button style={btn(th, 'ghost', { mobile: isMobile })} onClick={discardForwardDraft}>Discard</button>
                <button style={btn(th, 'secondary', { mobile: isMobile })} onClick={addForwardDraft}>Add to “{secTitle}”</button>
                <button style={btn(th, 'primary', { mobile: isMobile })} onClick={resumeForwardDraft}>Resume</button>
              </div>
            </div>
          </div>
        );
      })()}


    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  trialBanner: {
    background: '#1f1f1f', color: '#aaa', fontFamily: 'Georgia, serif',
    fontSize: 11, fontStyle: 'italic', padding: '5px 20px',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0
  },
  trialActions: { display: 'flex', alignItems: 'center', gap: 8 },
  trialBuy:    { color: '#fff', textDecoration: 'none', fontStyle: 'normal' },
  trialDot:    { color: '#555' },
  trialSignIn: {
    fontFamily: 'Georgia, serif', fontSize: 11, fontStyle: 'italic',
    background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', padding: 0
  },
  guestHintWrap: { position: 'relative', display: 'inline-flex' },
  guestHint: {
    position: 'absolute', top: 'calc(100% + 10px)', right: 0, width: 220,
    background: '#1f1f1f', color: '#e8e2d5',
    fontFamily: 'Georgia, serif', fontSize: 12, fontStyle: 'italic', lineHeight: 1.5,
    padding: '10px 26px 10px 12px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
    zIndex: 60,
    animation: 'oodboHintBounce 1.5s ease-in-out infinite',
  },
  guestHintArrow: {
    position: 'absolute', top: -5, right: 40, width: 10, height: 10,
    background: '#1f1f1f', transform: 'rotate(45deg)',
  },
  guestHintText: { display: 'block' },
  guestHintClose: {
    position: 'absolute', top: 5, right: 8,
    background: 'transparent', border: 'none', color: '#8a8578',
    fontSize: 15, lineHeight: 1, cursor: 'pointer', padding: 0, fontStyle: 'normal',
  },
  tourPrompt: {
    position: 'fixed', right: 20, bottom: 20, width: 260, zIndex: 902,
    background: '#1f1f1f', color: '#e8e2d5', fontFamily: 'Georgia, serif',
    padding: '14px 16px', boxShadow: '0 10px 30px rgba(0,0,0,0.28)',
  },
  tourPromptText: { fontSize: 13, lineHeight: 1.5, margin: '0 0 12px' },
  tourPromptBtns: { display: 'flex', justifyContent: 'flex-end', gap: 10, alignItems: 'center' },
  tourPromptSkip: {
    fontFamily: 'Georgia, serif', fontSize: 12, fontStyle: 'italic',
    background: 'transparent', border: 'none', color: '#8a8578', cursor: 'pointer', padding: 0,
  },
  tourPromptGo: {
    fontFamily: 'Georgia, serif', fontSize: 12,
    background: '#f5f2eb', border: '1px solid #f5f2eb', color: '#1f1f1f',
    cursor: 'pointer', padding: '6px 14px',
  },
  shell: {
    height: '100vh', overflow: 'hidden', display: 'flex',
    flexDirection: 'column', background: '#f5f2eb'
  },
  findNavBtn: {
    border: 'none', background: 'transparent', cursor: 'pointer',
    fontSize: 15, lineHeight: 1, padding: '2px 5px', borderRadius: 0,
  },
  sectionWarn: {
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    background: '#fbf3d8', borderBottom: '1px solid #e8dca8',
    padding: '8px 20px', flexShrink: 0,
    fontFamily: 'Georgia, serif', fontSize: 13, color: '#6b5d2a',
  },
  sectionWarnText: { flex: 1, minWidth: 200, fontStyle: 'italic' },
  sectionWarnDismiss: {
    fontFamily: 'Georgia, serif', fontSize: 12, background: 'transparent', border: 'none',
    color: '#8a7c48', cursor: 'pointer', fontStyle: 'italic', flexShrink: 0,
  },
  header: {
    background: '#f5f2eb', borderBottom: '1px solid #ddd6c9',
    padding: '0 20px', height: 44,
    display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0
  },
  brand: {
    fontFamily: 'Georgia, serif', fontSize: 17, fontWeight: 'normal',
    letterSpacing: '-0.02em', color: '#111', marginRight: 4
  },
  projTitle: {
    fontFamily: 'Georgia, serif', fontSize: 13, color: '#888',
    fontStyle: 'italic', cursor: 'text'
  },
  projTitleInput: {
    fontFamily: 'Georgia, serif', fontSize: 13, color: '#555', fontStyle: 'italic',
    background: 'transparent', border: 'none', borderBottom: '1px solid #ddd6c9',
    outline: 'none', padding: '0 0 1px 0', width: 160
  },
  spacer:    { flex: 1 },
  wordCount: { fontFamily: 'Georgia, serif', fontSize: 11, color: '#aaa' },
  savedDot:  { fontFamily: 'Georgia, serif', fontSize: 11, color: '#aaa' },
  headerThemeSelect: {
    fontFamily: 'Georgia, serif', fontSize: 10,
    padding: '3px 6px', cursor: 'pointer', outline: 'none',
  },
  focusBtn: {
    fontFamily: 'Georgia, serif', fontSize: 12, padding: '5px 14px',
    background: '#111', color: '#fff', border: '1px solid #111', cursor: 'pointer'
  },
  notesBtn: {
    fontFamily: 'Georgia, serif', fontSize: 12, padding: '5px 14px',
    background: 'transparent', color: '#999', border: '1px solid #ddd6c9', cursor: 'pointer'
  },
  notesBtnActive: { background: '#111', color: '#fff', border: '1px solid #111' },
  greeting: { fontFamily: 'Georgia, serif', fontSize: 11, color: '#aaa', fontStyle: 'italic' },
  signOut: {
    fontFamily: 'Georgia, serif', fontSize: 12, background: 'transparent',
    border: '1px solid #ddd6c9', color: '#999', cursor: 'pointer',
    fontStyle: 'italic', padding: '5px 14px'
  },
  body:    { flex: 1, display: 'flex', overflow: 'hidden' },
  sidebar: {
    width: 200, // default — overridden inline on desktop by sidebarWidth state
    borderRight: '1px solid #ddd6c9', background: '#f5f2eb',
    display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden',
  },
  projectRow: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '8px 8px 8px 10px',
  },
  projectSelect: {
    fontFamily: 'Georgia, serif', fontSize: 11, flex: 1, minWidth: 0,
    border: '1px solid', padding: '3px 4px', cursor: 'pointer', outline: 'none',
    textOverflow: 'ellipsis', overflow: 'hidden',
  },
  projectIconBtn: {
    fontFamily: 'Georgia, serif', fontSize: 14, lineHeight: 1,
    background: 'transparent', border: 'none', cursor: 'pointer',
    padding: '2px 4px', flexShrink: 0,
  },
  sideHead: {
    fontFamily: 'Georgia, serif', fontSize: 9, textTransform: 'uppercase',
    letterSpacing: '0.1em', color: '#bbb', padding: '14px 14px 6px'
  },
  chapterItem: {
    padding: '8px 14px 8px 8px', cursor: 'pointer', flexShrink: 0,
    display: 'flex', alignItems: 'baseline', gap: 6, borderLeft: '2px solid transparent'
  },
  dragHandle: { cursor: 'grab', color: '#ccc', fontSize: 11, flexShrink: 0, userSelect: 'none', lineHeight: 1 },
  chapterDeleteBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    fontSize: 14, lineHeight: 1, padding: '0 0 0 2px', flexShrink: 0,
  },
  copyBtn: {
    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
    color: '#ccc', flexShrink: 0, lineHeight: 1, userSelect: 'none',
    display: 'flex', alignItems: 'center'
  },
  chapterActive:   { borderLeft: '2px solid #111', background: '#ede9e1' },
  chapterDragOver: { borderTop: '2px solid #111' },
  chapterTitle: { fontFamily: 'Georgia, serif', fontSize: 12, color: '#1f1f1f', flex: 1 },
  chapterWc:    { fontFamily: 'Georgia, serif', fontSize: 11, color: '#999' },
  addChapter: {
    fontFamily: 'Georgia, serif', fontSize: 11, color: '#aaa', background: 'transparent',
    border: 'none', cursor: 'pointer', padding: '10px 14px', textAlign: 'left', fontStyle: 'italic'
  },
  typePickerAnchor: {
    position: 'fixed', top: 33, left: 200, zIndex: 900,
  },
  typePickerModal: {
    background: '#f5f2eb', borderTop: '3px solid #111',
    padding: '24px 24px 18px', width: 280, fontFamily: 'Georgia, serif',
    boxShadow: '2px 4px 16px rgba(0,0,0,0.18)',
  },
  typePickerBtn: {
    fontFamily: 'Georgia, serif', fontSize: 12, width: '100%',
    padding: '9px 12px', background: '#111', color: '#fff',
    border: '1px solid #111', cursor: 'pointer', marginBottom: 8,
    textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2,
  },
  typePickerLabel: { fontStyle: 'normal' },
  typePickerDesc:  { fontSize: 10, color: '#aaa', fontStyle: 'italic' },
  sideFileActions: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 14px 14px',
  },
  sideFileBtn: {
    fontFamily: 'Georgia, serif', fontSize: 11, fontStyle: 'italic',
    background: 'transparent', border: 'none', cursor: 'pointer',
    padding: 0
  },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' },
  mainScroll: {
    flex: 1, overflowY: 'auto', display: 'flex', justifyContent: 'center',
    alignItems: 'flex-start', padding: '0 24px', cursor: 'text', background: '#f5f2eb'
  },
  page: {
    width: '100%', maxWidth: 680, display: 'flex', flexDirection: 'column',
    cursor: 'auto', background: '#fff',
    paddingLeft: '2.5cm', paddingRight: '2.5cm',
    paddingTop: '2.5cm', paddingBottom: '5cm', boxSizing: 'border-box'
  },
  annMarker: {
    position: 'absolute', right: 0, width: '2.5cm', height: 3,
    borderRadius: 1, cursor: 'pointer', transition: 'opacity 0.15s, background 0.15s'
  },
  chapterTitleInput: {
    fontFamily: 'Georgia, serif', fontSize: 22, fontWeight: 'normal', color: '#111',
    background: 'transparent', border: 'none', padding: '0 0 12px 0',
    outline: 'none', letterSpacing: '-0.01em', width: '100%'
  },
  editor: {
    fontFamily: 'Georgia, serif', fontSize: 15, lineHeight: 1.8, color: '#1f1f1f',
    background: 'transparent', padding: '16px 0 0 0',
    outline: 'none', minHeight: 400, width: '100%', boxSizing: 'border-box',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'text'
  },
  editorFooter: {
    borderTop: '1px solid #eee', height: 30, padding: '0 14px',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4, flexShrink: 0
  },
  footerLinks:   { display: 'flex', alignItems: 'center', gap: 8 },
  zoomControls:  { display: 'flex', alignItems: 'center', gap: 4 },
  zoomBtn: {
    fontFamily: 'Georgia, serif', fontSize: 14, background: 'transparent', border: 'none',
    color: '#999', cursor: 'pointer', padding: '0 3px', lineHeight: 1, userSelect: 'none'
  },
  zoomSlider: { width: 72, cursor: 'pointer', accentColor: '#aaa', opacity: 0.7 },
  zoomLabel: {
    fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic', color: '#bbb',
    cursor: 'pointer', marginLeft: 4, userSelect: 'none', width: 30, textAlign: 'left'
  },

  // ── Annotations panel ──────────────────────────────────────────
  annPanel: {
    width: 220, borderLeft: '1px solid #ddd6c9', background: '#f5f2eb',
    display: 'flex', flexDirection: 'column', flexShrink: 0, overflowY: 'auto'
  },
  annPanelHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 14px 8px', borderBottom: '1px solid #ddd6c9', flexShrink: 0
  },
  annPanelLabel: {
    fontFamily: 'Georgia, serif', fontSize: 12, color: '#888',
  },
  annAddBtn: {
    fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic',
    background: 'transparent', border: 'none', color: '#999', cursor: 'pointer', padding: 0
  },
  annForm: { padding: '10px 14px', borderBottom: '1px solid #ddd6c9', flexShrink: 0 },
  annFormAnchor: {
    fontFamily: 'Georgia, serif', fontSize: 11, fontStyle: 'italic',
    color: '#888', marginBottom: 8, lineHeight: 1.5
  },
  annFormInput: {
    fontFamily: 'Georgia, serif', fontSize: 12, width: '100%', minHeight: 80,
    border: '1px solid #ddd6c9', background: '#fff', padding: '6px 8px',
    resize: 'none', outline: 'none', overflow: 'hidden',
    boxSizing: 'border-box', lineHeight: 1.6, color: '#1f1f1f'
  },
  annFormActions: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' },
  annFormHint: {
    marginLeft: 'auto', fontFamily: 'Georgia, serif', fontSize: 10,
    fontStyle: 'italic', color: '#bbb',
  },
  annSaveBtn: {
    fontFamily: 'Georgia, serif', fontSize: 11, padding: '4px 12px',
    background: '#111', color: '#fff', border: '1px solid #111', cursor: 'pointer'
  },
  annCancelBtn: {
    fontFamily: 'Georgia, serif', fontSize: 11, padding: '4px 10px',
    background: 'transparent', color: '#999', border: '1px solid #ddd6c9', cursor: 'pointer'
  },
  annList:  { flex: 1, overflowY: 'auto' },
  annEmpty: {
    fontFamily: 'Georgia, serif', fontSize: 11, fontStyle: 'italic',
    color: '#bbb', padding: '16px 14px', lineHeight: 1.6
  },
  annItem:         { borderBottom: '1px solid #ede9e1', cursor: 'pointer' },
  annItemExpanded: { background: '#ede9e1' },
  annItemRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px 8px 12px' },
  annBubble:  { width: 9, height: 9, borderRadius: 2, flexShrink: 0, display: 'inline-block' },
  annItemPreview: {
    fontFamily: 'Georgia, serif', fontSize: 11, fontStyle: 'italic', color: '#666',
    flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis'
  },
  annDeleteBtn: {
    fontFamily: 'Georgia, serif', fontSize: 14, background: 'transparent', border: 'none',
    color: '#ccc', cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0
  },
  annExpanded: { padding: '0 12px 10px' },
  annNoteText: {
    fontFamily: 'Georgia, serif', fontSize: 12, color: '#444',
    lineHeight: 1.6, margin: '0 0 8px', whiteSpace: 'pre-wrap'
  },
  annNotePlaceholder: {
    fontFamily: 'Georgia, serif', fontSize: 11, fontStyle: 'italic',
    color: '#bbb', margin: '0 0 8px'
  },
  annEditBtn: {
    fontFamily: 'Georgia, serif', fontSize: 11, fontStyle: 'italic',
    background: 'transparent', border: 'none', color: '#999',
    cursor: 'pointer', padding: 0
  },

  // ── Sidebar bottom sections ───────────────────────────────────
  sideBottomSection: {
    padding: '10px 14px',
    flexShrink: 0,
  },
  sideThemeSelect: {
    fontFamily: 'Georgia, serif', fontSize: 11,
    width: '100%', border: '1px solid', padding: '4px 6px',
    cursor: 'pointer', outline: 'none',
  },
  sideAccountRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '6px 14px 14px', flexShrink: 0,
  },
  sideAccountName: {
    fontFamily: 'Georgia, serif', fontSize: 11, fontStyle: 'italic',
  },

  // ── Mobile ────────────────────────────────────────────────────
  hamburgerBtn: {
    fontFamily: 'Georgia, serif', fontSize: 18, lineHeight: 1,
    background: 'transparent', border: 'none', cursor: 'pointer',
    padding: '0 4px', flexShrink: 0,
  },
  sidebarOverlay: {
    position: 'fixed', inset: 0, zIndex: 699,
    background: 'rgba(0,0,0,0.35)',
  },
  pageMobile: {
    paddingLeft: 16, paddingRight: 16,
    paddingTop: 24, paddingBottom: '3cm',
  },
  sheetHandle: {
    width: 36, height: 4, borderRadius: 2,
    margin: '8px auto 4px', flexShrink: 0,
  },
  annCloseBtn: {
    fontFamily: 'Georgia, serif', fontSize: 18, lineHeight: 1,
    background: 'transparent', border: 'none', cursor: 'pointer',
    padding: '0 0 0 8px', color: '#999', flexShrink: 0,
  },

  // ── Delete project modal ───────────────────────────────────────
  deleteOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 900,
  },
  deleteModal: {
    background: '#f5f2eb', borderTop: '3px solid #c0392b',
    padding: '24px 24px 18px', width: 300, maxWidth: 'calc(100vw - 32px)',
    boxSizing: 'border-box', fontFamily: 'Georgia, serif',
  },
  deleteTitle: { fontSize: 15, color: '#111', marginBottom: 4 },
  deleteSub:   { fontSize: 11, color: '#888', fontStyle: 'italic', marginBottom: 16 },
  deleteBtn: {
    fontFamily: 'Georgia, serif', fontSize: 12, width: '100%',
    padding: '9px 12px', background: '#111', color: '#fff',
    border: '1px solid #111', cursor: 'pointer', marginBottom: 8, textAlign: 'left',
  },
  deleteBtnDanger: { background: '#c0392b', border: '1px solid #c0392b' },
  getOodboModal: {
    background: '#f5f2eb', borderTop: '3px solid #111',
    padding: '24px 24px 18px', width: 320, maxWidth: 'calc(100vw - 32px)',
    boxSizing: 'border-box', fontFamily: 'Georgia, serif',
  },
  getOodboSecondary: {
    fontFamily: 'Georgia, serif', fontSize: 12, width: '100%',
    padding: '9px 12px', background: 'transparent', color: '#111',
    border: '1px solid #ddd6c9', cursor: 'pointer', marginBottom: 8, textAlign: 'left',
  },
  deleteGhost: {
    fontFamily: 'Georgia, serif', fontSize: 11, background: 'transparent',
    border: 'none', color: '#888', cursor: 'pointer', fontStyle: 'italic', padding: 0,
  },

  // ── Annotation hint modal ──────────────────────────────────────
  annHintBox: {
    padding: '10px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    flexShrink: 0,
  },
  annHintMsg: {
    fontFamily: 'Georgia, serif',
    fontSize: 12,
    lineHeight: 1.5,
    margin: 0,
  },
  annHintOk: {
    fontFamily: 'Georgia, serif',
    fontSize: 11,
    padding: '4px 14px',
    cursor: 'pointer',
    alignSelf: 'flex-start',
  },
};

