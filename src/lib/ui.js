// ── UI primitives ─────────────────────────────────────────────────────────────
// Two factories, both taking the active theme, both returning plain inline-style objects.
// Every colour comes from the theme (no literals at call sites), and every button property is
// set explicitly — fontFamily, fontSize, background, border, color, cursor, appearance — so no
// property can fall through to a browser default (that is the bug this whole pass fixes).

// btn(th, variant, { mobile, outlined })
//   variants: 'primary' | 'secondary' | 'ghost' | 'destructive'
//   desktop: 12px Georgia, 8×16 padding.
//   - primary      → primaryBg / primaryText, no border
//   - secondary    → transparent, 1px chromeText border
//   - ghost        → transparent, no border, chromeMuted, underlined (3px offset), no padding
//   - destructive  → as primary but on danger / dangerText
//   - destructive + outlined → transparent, danger as border AND text (call site inverts to the
//     solid fill on hover by dropping `outlined`). Used for "Empty bin".
//   mobile:true    → 13px, minHeight 44, width 100%; ghost PROMOTES to secondary (an underlined
//                    text link is not a tap target).
export function btn(th, variant = 'primary', { mobile = false, outlined = false } = {}) {
  const base = {
    fontFamily: 'Georgia, serif',
    fontSize: 12,
    padding: '8px 16px',
    cursor: 'pointer',
    appearance: 'none',
    WebkitAppearance: 'none',
    borderRadius: 0,                 // square — the product's one corner style (see step 9 decision)
    lineHeight: 1.2,
    boxSizing: 'border-box',
    textAlign: 'center',
    textDecoration: 'none',
  };

  // On mobile an underlined text link is not a tap target — promote ghost to secondary.
  const v = (mobile && variant === 'ghost') ? 'secondary' : variant;

  let style;
  switch (v) {
    case 'secondary':
      style = { ...base, background: 'transparent', border: `1px solid ${th.chromeText}`, color: th.chromeText };
      break;
    case 'ghost':
      style = {
        ...base, background: 'transparent', border: 'none', color: th.chromeMuted,
        padding: 0, textDecoration: 'underline', textUnderlineOffset: '3px',
      };
      break;
    case 'destructive':
      style = outlined
        ? { ...base, background: 'transparent', border: `1px solid ${th.danger}`, color: th.danger }
        : { ...base, background: th.danger, border: '1px solid transparent', color: th.dangerText };
      break;
    case 'primary':
    default:
      style = { ...base, background: th.primaryBg, border: '1px solid transparent', color: th.primaryText };
      break;
  }

  if (mobile) style = { ...style, fontSize: 13, minHeight: 44, width: '100%' };
  return style;
}

// dialog(th, { mobile, destructive })
//   Returns overlay, box, title, rule, label, body, actions.
//   - title   → 18px, letter-spacing −0.01em
//   - rule    → 1px chromeText top border under the title (danger on destructive dialogs)
//   - label   → 10px uppercase, 0.14em tracking, chromeMuted
//   - actions → flex row, 14px gap, right-aligned, separated by a 1px chromeBorder rule;
//               on mobile a column of full-width buttons.
export function dialog(th, { mobile = false, destructive = false } = {}) {
  return {
    overlay: {
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', alignItems: mobile ? 'flex-end' : 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.45)', padding: mobile ? 0 : 20, boxSizing: 'border-box',
    },
    box: {
      background: th.chrome, color: th.chromeText,
      border: `1px solid ${th.chromeBorder}`,
      borderRadius: 0,               // square everywhere
      padding: mobile ? '20px 20px 24px' : '24px 26px',
      width: mobile ? '100%' : 'min(440px, 92vw)',
      maxHeight: mobile ? '92vh' : '82vh',
      display: 'flex', flexDirection: 'column',
      boxShadow: '0 10px 40px rgba(0,0,0,0.30)',
      fontFamily: 'Georgia, serif', boxSizing: 'border-box',
    },
    title: {
      fontFamily: 'Georgia, serif', fontSize: 18, fontWeight: 'normal',
      letterSpacing: '-0.01em', color: th.chromeText, margin: 0,
    },
    rule: {
      borderTop: `1px solid ${destructive ? th.danger : th.chromeText}`,
      margin: '12px 0 16px',
    },
    label: {
      fontFamily: 'Georgia, serif', fontSize: 10, textTransform: 'uppercase',
      letterSpacing: '0.14em', color: th.chromeMuted,
    },
    body: {
      fontFamily: 'Georgia, serif', fontSize: 14, lineHeight: 1.6, color: th.chromeText,
    },
    actions: {
      display: 'flex',
      flexDirection: mobile ? 'column' : 'row',
      gap: 14,
      justifyContent: mobile ? 'stretch' : 'flex-end',
      alignItems: mobile ? 'stretch' : 'center',
      borderTop: `1px solid ${th.chromeBorder}`,
      paddingTop: 14, marginTop: 16,
    },
  };
}
