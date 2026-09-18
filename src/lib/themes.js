// ── Editor chrome themes ──────────────────────────────────────────────────────
// Single source of truth for the four themes. Every colour used at a call site must come from
// one of these objects — no colour literals in components.
//
// `danger` / `dangerText` are the destructive-action tokens. They are picked PER THEME (not one
// shared literal): a red that reads on parchment's #f5f2eb won't hold on midnight's #0a0a0a, and
// slate/warm already carry accents (#7b9cf5, #c8922a) a red has to sit beside.
export const EDITOR_THEMES = {
  parchment: {
    label: 'Parchment',
    shell: '#f5f2eb', chrome: '#f5f2eb', chromeBorder: '#ddd6c9',
    chromeText: '#1f1f1f', chromeMuted: '#888', chromeFaint: '#bbb',
    page: '#fff', pageText: '#1f1f1f',
    active: '#ede9e1', activeBorder: '#111',
    primaryBg: '#111', primaryText: '#fff',
    danger: '#8c3a2e', dangerText: '#fff',
  },
  slate: {
    label: 'Slate',
    shell: '#12151a', chrome: '#1a1d23', chromeBorder: '#2e3340',
    chromeText: '#c9d1e9', chromeMuted: '#7a8599', chromeFaint: '#455070',
    page: '#fff', pageText: '#1f1f1f',
    active: '#252c3d', activeBorder: '#7b9cf5',
    primaryBg: '#7b9cf5', primaryText: '#fff',
    danger: '#e0705f', dangerText: '#fff',
  },
  midnight: {
    label: 'Midnight',
    shell: '#0a0a0a', chrome: '#111', chromeBorder: '#222',
    chromeText: '#ccc', chromeMuted: '#666', chromeFaint: '#3a3a3a',
    page: '#1a1a1a', pageText: '#d0d0d0',
    active: '#1e1e1e', activeBorder: '#555',
    primaryBg: '#333', primaryText: '#ccc',
    danger: '#d9614f', dangerText: '#fff',
  },
  warm: {
    label: 'Warm Dark',
    shell: '#1a1208', chrome: '#1f1810', chromeBorder: '#3a2c1a',
    chromeText: '#e8d9be', chromeMuted: '#9a7f5a', chromeFaint: '#5a4030',
    page: '#fff', pageText: '#1f1f1f',
    active: '#2e2010', activeBorder: '#c8922a',
    primaryBg: '#c8922a', primaryText: '#fff',
    danger: '#c4563a', dangerText: '#fff',
  },
};
