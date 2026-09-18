import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',   // was 'prompt' — auto-update so a stale SW can't strand a web tab on
                                    // pre-encryption JS after the cutover (old JS chokes on oodbo-enc:… ciphertext)
      includeAssets: ['icon-pwa.svg', 'icon-80.png', 'welcome_a7f3e2.oodbo'],
      manifest: {
        name: 'oodbo',
        short_name: 'oodbo',
        description: 'Draft without looking back',
        start_url: '/',
        display: 'standalone',
        background_color: '#f5f2eb',
        theme_color: '#f5f2eb',
        icons: [
          { src: 'icon-pwa.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
          { src: 'icon-80.png',  sizes: '80x80', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,oodbo}'],
        // Never precache the Word add-in pages — they must always hit the network so
        // an add-in update lands on next open (Office WebView2 caching is aggressive
        // enough already). Pairs with the navigateFallbackDenylist below and the
        // Cache-Control: no-cache headers on these paths in vercel.json.
        globIgnores: ['**/taskpane.html', '**/dialog.html', '**/addin-auth.html', '**/forward-demo.html'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/privacy/, /^\/terms/, /^\/faq/, /^\/download/, /^\/features/, /^\/blog/, /^\/forward-demo\.html/, /^\/dl(\/|$)/, /^\/share\//, /^\/dialog\.html/, /^\/taskpane\.html/, /^\/addin-auth\.html/],
        runtimeCaching: [
          { urlPattern: /^\/api\//, handler: 'NetworkOnly' },
        ],
      },
    }),
  ],
  // Pin the dev port: Tauri's devUrl and me.js's dev CORS allowlist both assume
  // localhost:5173. strictPort makes Vite fail loudly instead of silently bumping
  // to 5174 (which strands the desktop window blank + trips dev CORS 401s).
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
  },
});
