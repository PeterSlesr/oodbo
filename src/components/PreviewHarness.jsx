// ── DEV-ONLY UI preview harness ─────────────────────────────────────────────────
//
// Renders the real Home with a few seeded mock projects so homepage/chrome tweaks can be
// previewed on the local dev server WITHOUT signing in (OAuth + magic-link only redirect to
// prod, so localhost can't authenticate). Reached at /preview and gated by import.meta.env.DEV
// in App.jsx, so it is dead-code-eliminated from the production build and can never ship.

import React, { useEffect, useState } from 'react';
import Home from './Home.jsx';
import { openDB } from '../lib/sync/store.js';

const MOCK_OWNER = 'preview@oodbo.dev';
const mockUser = { email: MOCK_OWNER, name: 'Preview', provider: 'google' };

const now = '2026-08-25T21:00:00.000Z';
const ch = (id, title, content, level = 1) => ({
  id, title, content, level, createdAt: now, updatedAt: now,
  cursorPosition: content.length, annotations: [],
});

const mockProjects = [
  {
    id: 'prev-1', type: 'prose', title: 'War and Peace', createdAt: now, updatedAt: now,
    activeChapterId: 'p1c1',
    chapters: [
      ch('p1c1', 'Book One', 'Well, Prince, so Genoa and Lucca are now just family estates of the Buonapartes. But I warn you, if you don\'t tell me that this means war, if you still try to defend the infamies and horrors perpetrated by that Antichrist — I really believe he is Antichrist — I will have nothing more to do with you.'),
      ch('p1c2', 'The Soirée', 'It was in July, 1805, and the speaker was the well-known Anna Pávlovna Schérer, maid of honour and favourite of the Empress Márya Fëdorovna. With these words she greeted Prince Vasíli Kurágin, a man of high rank and importance, who was the first to arrive at her reception.'),
    ],
  },
  {
    id: 'prev-2', type: 'journal', title: 'Morning Pages', createdAt: now, updatedAt: '2026-08-24T08:00:00.000Z',
    activeChapterId: 'p2c1',
    chapters: [
      ch('p2c1', 'Aug 24', 'Woke before the alarm again. The light through the blinds was the colour of weak tea. I keep circling the same idea about the river and cannot decide if it is a metaphor or just a river.'),
    ],
  },
  {
    id: 'prev-3', type: 'prose', title: 'Notes on the Café Manuscript', createdAt: now, updatedAt: '2026-08-20T14:00:00.000Z',
    activeChapterId: 'p3c1',
    chapters: [
      ch('p3c1', 'Fragments', 'The résumé of the argument is simple enough, though naïve readers miss it. A fox appears, then a second fox, then a third — the pattern is the point, not any single animal.'),
      ch('p3c2', 'More Fragments', 'Intro line before the heading.\n## A Sub-heading\nThe content beneath a heading behaves like its own section for search and navigation.'),
    ],
  },
];

const mockTrashed = [
  { id: 'trash-1', title: 'Notes on the Café Manuscript (Draft 3)', createdAt: now, updatedAt: now,
    activeChapterId: 't1c1', chapters: [ch('t1c1', 'Old draft', 'Discarded fox fragments.')] },
  { id: 'trash-2', title: 'A Very Long Project Name That Used To Overflow The Tiny Bin Modal', createdAt: now, updatedAt: now,
    activeChapterId: 't2c1', chapters: [ch('t2c1', 'Scraps', 'More discarded material about the river.')] },
];

async function seed() {
  const empty = typeof location !== 'undefined' && location.search.includes('empty');
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('projects', 'readwrite');
      if (empty) {                                   // ?empty → clear the mock owner's projects (test the empty state)
        for (const p of [...mockProjects, ...mockTrashed]) tx.objectStore('projects').delete(p.id);
        tx.oncomplete = res; tx.onerror = rej;
        return;
      }
      for (const p of mockProjects) {
        tx.objectStore('projects').put({
          id: p.id, owner: MOCK_OWNER, pendingSync: false, lastSynced: now,
          trashed: false, deletedAt: null, data: p,
        });
      }
      for (const p of mockTrashed) {
        tx.objectStore('projects').put({
          id: p.id, owner: MOCK_OWNER, pendingSync: false, lastSynced: now,
          trashed: true, deletedAt: '2026-08-25T18:00:00.000Z', data: p,
        });
      }
      tx.oncomplete = res; tx.onerror = rej;
    });
  } catch {}
}

export default function PreviewHarness() {
  const [ready, setReady] = useState(false);
  useEffect(() => { seed().then(() => setReady(true)); }, []);
  if (!ready) return null;
  return (
    <Home
      user={mockUser}
      onOpenProject={(id) => { window.alert(`(preview) would open project: ${id}`); }}
      onNewProject={() => {}}
      onSignOut={() => {}}
      onSync={() => {}}
      syncTick={0}
      syncReconnect={false}
    />
  );
}
