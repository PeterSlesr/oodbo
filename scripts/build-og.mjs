// Generates the static social-preview card public/og.png (1200×630) from a self-contained
// CRT/phosphor SVG. Fonts are embedded as base64 so the pixel look survives rasterisation.
// Run: node scripts/build-og.mjs   (no server, no runtime cost — a build-time asset.)
import sharp from 'sharp';
import { readFileSync } from 'fs';

const b64 = (p) => readFileSync(new URL(`../public/fonts/${p}`, import.meta.url)).toString('base64');
const VT  = b64('vt323-latin.woff2');
const STM = b64('sharetechmono-latin.woff2');

const W = 1200, H = 630;
const GREEN = '#b8ff4a', DIM = '#6a9930', FAINT = '#2a3d14', BG = '#080c04', PANEL = '#0d1408';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <style>
      @font-face { font-family:'VT323'; src:url(data:font/woff2;base64,${VT}) format('woff2'); }
      @font-face { font-family:'STM';   src:url(data:font/woff2;base64,${STM}) format('woff2'); }
    </style>
    <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="2" y="2" fill="#000000" opacity="0.18"/>
    </pattern>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="${PANEL}" stroke="${FAINT}" stroke-width="2"/>
  <rect x="40" y="40" width="${W - 80}" height="10" fill="${GREEN}"/>

  <text x="70" y="104" font-family="STM" font-size="22" fill="${DIM}" letter-spacing="6">// FORWARD-ONLY WRITING</text>

  <text x="${W / 2}" y="330" font-family="VT323" font-size="150" fill="${GREEN}" text-anchor="middle" filter="url(#glow)" textLength="1040" lengthAdjust="spacingAndGlyphs">FORWARD ONLY</text>

  <text x="${W / 2}" y="406" font-family="STM" font-size="30" fill="${DIM}" text-anchor="middle" letter-spacing="3">distraction-free forward-only writing</text>

  <text x="${W / 2}" y="548" font-family="STM" font-size="24" fill="${GREEN}" text-anchor="middle" letter-spacing="4">write.mercoogs.com</text>

  <rect width="${W}" height="${H}" fill="url(#scan)"/>
</svg>`;

import { fileURLToPath } from 'url';
const outPath = fileURLToPath(new URL('../public/og.png', import.meta.url));
await sharp(Buffer.from(svg), { density: 96 }).resize(W, H).png().toFile(outPath);
console.log('wrote', outPath);
