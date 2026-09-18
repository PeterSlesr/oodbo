import { useState, useEffect } from 'react';
import { isCloudReachable, subscribeReachable } from './sync/client.js';

// Whether your writing is currently getting to the cloud. TWO signals, because neither is
// sufficient alone:
//
//   navigator.onLine — instant, but only reports whether the machine has a network
//     INTERFACE, not whether anything is on the other end. Its own spec says false is
//     meaningful and true guarantees nothing. Drop Wi-Fi on a laptop that also has a VPN, an
//     Ethernet port, or a virtual adapter (Hyper-V, WSL, VirtualBox — routine on Windows) and
//     it stays true, no 'offline' event fires, and nothing on screen changes. DevTools'
//     offline toggle DOES fire it, which is exactly why this looks fine in devtools and fails
//     on a real disconnect. Trust it only when it says false.
//
//   the sync engine — knows for certain, because it watches real requests fail, so it catches
//     everything above plus captive portals and the cloud itself being down. The cost is that
//     it only learns by trying: a failed sweep after an edit (≤60s), the editor's 5-minute
//     pull, or a sweep on arriving at the homepage.
//
// Either saying "no" means no. Together the fast one covers the clean cases instantly and the
// truthful one covers everything else within a sweep.
//
// This deliberately does NOT poll to find out sooner. An idle heartbeat would break the
// engine's rule that an empty outbox does zero network — and it would be answering a question
// nobody is asking, since offline only matters once there are unsent edits, and making an
// edit is itself what triggers the sweep that notices.
export function useOnline() {
  const [browserOnline, setBrowserOnline] = useState(() =>
    (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const [reachable, setReachable] = useState(isCloudReachable);

  useEffect(() => {
    const up   = () => setBrowserOnline(true);
    const down = () => setBrowserOnline(false);
    window.addEventListener('online',  up);
    window.addEventListener('offline', down);
    // Re-read on mount: these events fire on CHANGE only, so a tab loaded while already
    // offline would otherwise never hear about it.
    setBrowserOnline(navigator.onLine !== false);
    // And re-sync to the engine, in case it failed a request before this mounted.
    setReachable(isCloudReachable());
    const unsub = subscribeReachable(setReachable);
    return () => {
      window.removeEventListener('online',  up);
      window.removeEventListener('offline', down);
      unsub();
    };
  }, []);

  return browserOnline && reachable;
}
