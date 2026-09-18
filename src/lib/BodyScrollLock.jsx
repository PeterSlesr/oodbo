import { useEffect } from 'react';

// Render as a child of any modal overlay to lock body scroll while it's open (the page must not
// scroll behind a dialog). Ref-counted so stacked overlays don't fight, and the original overflow
// is restored only when the last lock releases. Renders nothing.
let _locks = 0;
let _prevOverflow = '';

export default function BodyScrollLock() {
  useEffect(() => {
    if (_locks === 0) {
      _prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    _locks += 1;
    return () => {
      _locks -= 1;
      if (_locks === 0) document.body.style.overflow = _prevOverflow;
    };
  }, []);
  return null;
}
