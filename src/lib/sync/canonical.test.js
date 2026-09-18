import { describe, it, expect } from 'vitest';
import {
  serializeOodbo, parseOodbo, canonicalHash, canonicalString, hashXml, __test,
} from './canonical.js';

// ── A legacy copy of projectToXml, frozen here verbatim from Editor.jsx / App.jsx
// (which are byte-identical). The parity test proves serializeOodbo has not drifted
// from the format currently on disk / in the cloud. If this test fails, existing
// files would re-serialize differently — a format change, not a refactor.
function legacyProjectToXml(project) {
  const xe = s => (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  <project id="${xe(project.id)}">
    <title>${xe(project.title)}</title>
    <type>${xe(project.type || '')}</type>
    <activeChapterId>${xe(project.activeChapterId)}</activeChapterId>
    <chapters>${chapters}
    </chapters>
  </project>
</oodbo>`;
}

const sample = () => ({
  id: 'trc6x45nul5cqqja',
  type: '',
  title: 'conflict res 1',
  activeChapterId: 'c1',
  createdAt: '2026-07-08T06:39:56.895Z',
  updatedAt: '2026-07-14T11:02:01.630Z',
  chapters: [
    {
      id: 'c1', level: 1, title: 'ch1',
      content: '\nThis is new. :) conflict resolution\n',
      createdAt: '2026-07-08T06:39:56.895Z',
      updatedAt: '2026-07-14T11:02:01.630Z',
      cursorPosition: 12,
      annotations: [
        { id: 'a1', start: 0, end: 4, anchorType: 'content', colorIndex: 3,
          createdAt: '2026-07-08T06:40:00.000Z', anchorText: 'This', note: 'a note' },
      ],
    },
    {
      id: 'c2', level: 2, title: 'ch2', content: 'second chapter',
      createdAt: '2026-07-09T00:00:00.000Z', updatedAt: '2026-07-09T00:00:00.000Z',
      annotations: [],
    },
  ],
});

describe('serializeOodbo — parity with legacy format', () => {
  it('is byte-identical to the legacy projectToXml for a representative project', () => {
    const p = sample();
    expect(serializeOodbo(p)).toBe(legacyProjectToXml(p));
  });

  it('matches legacy for a chapter without cursorPosition (attribute omitted)', () => {
    const p = sample();
    delete p.chapters[0].cursorPosition;
    expect(serializeOodbo(p)).toBe(legacyProjectToXml(p));
    expect(serializeOodbo(p)).not.toContain('cursorPosition');
  });

  it('escapes XML-significant characters identically', () => {
    const p = sample();
    p.chapters[0].content = 'a & b < c > d " e';
    p.title = 'A & B';
    expect(serializeOodbo(p)).toBe(legacyProjectToXml(p));
  });
});

describe('parseOodbo — round-trip', () => {
  it('preserves all content fields through serialize → parse', () => {
    const p = sample();
    const round = parseOodbo(serializeOodbo(p));
    expect(round.id).toBe(p.id);
    expect(round.title).toBe(p.title);
    expect(round.chapters).toHaveLength(2);
    expect(round.chapters[0].content).toBe(p.chapters[0].content); // prose incl. leading/trailing \n
    expect(round.chapters[0].cursorPosition).toBe(12);
    expect(round.chapters[0].annotations[0]).toMatchObject({
      start: 0, end: 4, anchorType: 'content', colorIndex: 3, anchorText: 'This', note: 'a note',
    });
    expect(round.chapters[1].level).toBe(2);
  });

  it('throws on invalid XML', () => {
    expect(() => parseOodbo('<not-xml <<<')).toThrow();
  });
});

describe('canonicalHash — excluded fields never manufacture dirt (invariant 11)', () => {
  it('is stable when cursorPosition changes', async () => {
    const a = sample();
    const b = sample(); b.chapters[0].cursorPosition = 9999;
    expect(await canonicalHash(a)).toBe(await canonicalHash(b));
  });

  it('is stable when a chapter GAINS a cursorPosition it did not have', async () => {
    const a = sample(); delete a.chapters[0].cursorPosition;
    const b = sample(); b.chapters[0].cursorPosition = 7;
    expect(await canonicalHash(a)).toBe(await canonicalHash(b));
  });

  it('is stable when activeChapterId changes', async () => {
    const a = sample();
    const b = sample(); b.activeChapterId = 'c2';
    expect(await canonicalHash(a)).toBe(await canonicalHash(b));
  });

  it('is stable when updatedAt changes (chapter and project)', async () => {
    const a = sample();
    const b = sample();
    b.updatedAt = '2099-01-01T00:00:00.000Z';
    b.chapters[0].updatedAt = '2099-01-01T00:00:00.000Z';
    expect(await canonicalHash(a)).toBe(await canonicalHash(b));
  });

  it('is stable when live-only fields (collapsed, wordAssets) are present', async () => {
    const a = sample();
    const b = sample();
    b.chapters[0].collapsed = true;
    b.wordAssets = { foo: 'bar' };
    expect(await canonicalHash(a)).toBe(await canonicalHash(b));
  });

  it('ignores the oodbo version attribute (format bump must not dirty)', async () => {
    const xml1 = serializeOodbo(sample());
    const xml2 = xml1.replace('<oodbo version="1">', '<oodbo version="2">');
    expect(await hashXml(xml1)).toBe(await hashXml(xml2));
  });

  it('is stable when createdAt changes (chapter and annotation) — timestamps not hashed', async () => {
    const a = sample();
    const b = sample();
    b.chapters[0].createdAt = '1999-01-01T00:00:00.000Z';
    b.chapters[0].annotations[0].createdAt = '1999-01-01T00:00:00.000Z';
    expect(await canonicalHash(a)).toBe(await canonicalHash(b));
  });

  it('is stable when project type changes — type not hashed', async () => {
    const a = sample(); a.type = '';
    const b = sample(); b.type = 'journal';
    expect(await canonicalHash(a)).toBe(await canonicalHash(b));
  });
});

describe('canonicalHash — real content changes DO change the hash', () => {
  it('changes when prose content changes', async () => {
    const a = sample();
    const b = sample(); b.chapters[0].content += 'X';
    expect(await canonicalHash(a)).not.toBe(await canonicalHash(b));
  });

  it('treats trailing-newline prose as significant (whitespace-inside-content rule)', async () => {
    const a = sample(); a.chapters[0].content = 'abc';
    const b = sample(); b.chapters[0].content = 'abc\n';
    expect(await canonicalHash(a)).not.toBe(await canonicalHash(b));
  });

  it('changes when an annotation note changes', async () => {
    const a = sample();
    const b = sample(); b.chapters[0].annotations[0].note = 'different';
    expect(await canonicalHash(a)).not.toBe(await canonicalHash(b));
  });

  it('changes when chapter order changes', async () => {
    const a = sample();
    const b = sample(); b.chapters.reverse();
    expect(await canonicalHash(a)).not.toBe(await canonicalHash(b));
  });
});

describe('hashXml — deterministic, no fabricated defaults (spec §3.4 / §12)', () => {
  it('is pure: same XML → same hash', async () => {
    const xml = serializeOodbo(sample());
    expect(await hashXml(xml)).toBe(await hashXml(xml));
  });

  it('hashes identically whether or not createdAt/updatedAt are present (timestamps excluded)', async () => {
    const withTs = `<?xml version="1.0" encoding="UTF-8"?>
<oodbo version="1">
  <project id="p"><title>t</title><type></type><activeChapterId>c</activeChapterId>
    <chapters>
    <chapter id="c" level="1" createdAt="2026-01-01T00:00:00.000Z" updatedAt="2026-05-05T00:00:00.000Z">
      <title>x</title><content>hello</content><annotations>
      </annotations>
    </chapter>
    </chapters>
  </project>
</oodbo>`;
    const withoutTs = withTs
      .replace(' createdAt="2026-01-01T00:00:00.000Z"', '')
      .replace(' updatedAt="2026-05-05T00:00:00.000Z"', '');
    expect(await hashXml(withTs)).toBe(await hashXml(withoutTs));
    // the canonical model carries no timestamp field at all
    expect(Object.keys(__test.canonicalModel(__test.extractRaw(withTs)).chapters[0]))
      .not.toContain('createdAt');
  });

  it('agrees with canonicalHash(model) for a normal file (live-object vs pulled-from-cloud)', async () => {
    const p = sample();
    expect(await hashXml(serializeOodbo(p))).toBe(await canonicalHash(p));
  });

  // Regression: XML readback (§2.11) folds CRLF and lone CR to LF, but the live in-memory model
  // can hold CRLF from Windows-pasted text. If canonicalHash(model) hashed those verbatim while
  // hashXml(file) saw the folded form, every such project would self-conflict — a never-synced
  // one forks against itself on reconcile, and each unsynced fork forks again (a fork storm).
  it('agrees with canonicalHash(model) when content has Windows line endings (no phantom conflict)', async () => {
    const crlf = { ...sample() };
    crlf.chapters = crlf.chapters.map(c => ({ ...c, content: 'line one\r\nline two\rline three' }));
    expect(await hashXml(serializeOodbo(crlf))).toBe(await canonicalHash(crlf));
  });

  it('canonicalHash is line-ending invariant (CRLF == CR == LF for the same prose)', async () => {
    const mk = eol => { const p = sample(); p.chapters = p.chapters.map(c => ({ ...c, content: `a${eol}b` })); return p; };
    const lf = await canonicalHash(mk('\n'));
    expect(await canonicalHash(mk('\r\n'))).toBe(lf);
    expect(await canonicalHash(mk('\r'))).toBe(lf);
  });

  it('is a 64-char hex SHA-256 digest', async () => {
    const h = await hashXml(serializeOodbo(sample()));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// `conflictOf` marks a fork as the second version OF another project. It lives in the FILE so
// the pairing reaches the other device — the device that forked is otherwise the only one that
// knows a conflict happened.
describe('conflictOf — pairs a fork to its original', () => {
  it('costs an ordinary project NOTHING: no key, so no hash change, so no mass re-dirty', () => {
    // The load-bearing test. Unconditionally adding a field to the hash would change the hash
    // of every project ever written — every device would find everything dirty and re-push it
    // all at once, and simultaneous re-pushes from two devices is a mass fork. Absent must
    // therefore serialize to byte-identical JSON, not to `conflictOf: ""`.
    expect(Object.keys(JSON.parse(canonicalString(sample())))).toEqual(['id', 'title', 'chapters']);
    expect(canonicalString(sample())).not.toContain('conflictOf');
  });

  it('is byte-identical to the legacy XML when absent', () => {
    expect(serializeOodbo(sample())).toBe(legacyProjectToXml(sample()));
  });

  it('IS hashed when set — so clearing it (resolving) pushes and reaches the other device', async () => {
    const plain  = sample();
    const forked = { ...sample(), conflictOf: 'p-original' };
    expect(await canonicalHash(forked)).not.toBe(await canonicalHash(plain));
    // And clearing it returns to exactly the original hash — resolution is a real change.
    const { conflictOf, ...resolved } = forked;
    expect(await canonicalHash(resolved)).toBe(await canonicalHash(plain));
  });

  it('survives the round trip to file and back', () => {
    const xml = serializeOodbo({ ...sample(), conflictOf: 'p-original' });
    expect(xml).toContain('conflictOf="p-original"');
    expect(parseOodbo(xml).conflictOf).toBe('p-original');
  });

  it('hashes the same from the file as from the live object (no device disagreement)', async () => {
    const forked = { ...sample(), conflictOf: 'p-original' };
    expect(await hashXml(serializeOodbo(forked))).toBe(await canonicalHash(forked));
  });

  it('an ordinary project parses back with no conflictOf at all', () => {
    expect(parseOodbo(serializeOodbo(sample()))).not.toHaveProperty('conflictOf');
  });
});

describe('canonicalString — structure sanity', () => {
  it('includes only allowlisted fields; excludes UI state and all timestamps', () => {
    const s = canonicalString(sample());
    for (const excluded of ['cursorPosition', 'activeChapterId', 'updatedAt', 'createdAt']) {
      expect(s).not.toContain(excluded);
    }
    expect(s).not.toContain('2026-07'); // no created/updated timestamp values leaked
    expect(s).toContain('This is new'); // content present
    expect(s).toContain('anchorType'); // allowlisted annotation field still present
  });
});
