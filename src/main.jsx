import React from 'react';
import { createRoot } from 'react-dom/client';
import './crt.css';
import App from './App.jsx';
import PWAUpdateBanner from './components/PWAUpdateBanner.jsx';
import { IS_TAURI } from './lib/platform.js';

// Desktop (Tauri) serves its assets locally from the embedded bundle — already instant + offline — so a
// service worker adds nothing and actively HURTS: it shadows a freshly built binary with stale precached
// JS (that's how a rebuilt desktop app kept running old code). So on desktop we NEVER register one (the
// PWAUpdateBanner hook is the only registration path — omitting it means no registration), AND we tear
// down any SW + caches a prior build left behind so existing installs self-heal. The PWA stays on for web.
if (IS_TAURI && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister())).catch(() => {});
  if (typeof caches !== 'undefined') caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
}

createRoot(document.getElementById('root')).render(
  <>
    <App />
    {!IS_TAURI && <PWAUpdateBanner />}
  </>
);
