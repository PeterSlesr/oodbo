// Single source of truth for "are we running inside the Tauri desktop shell?"
// Tauri injects window.__TAURI_INTERNALS__ into its WebView2; a plain browser tab never has it.
// Desktop seams (native save, AppData durability, PKCE OAuth, direct-to-Drive cloud) gate on this;
// the web build tree-shakes the desktop-only branches away.
export const IS_TAURI =
  typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
