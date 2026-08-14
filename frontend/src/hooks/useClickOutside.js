// mouaif web — useClickOutside hook
// Dismiss overlay/popups when tapping outside or pressing Escape.
// Uses setTimeout(0) registration to avoid immediately triggering on the opening click/touch.

import { useEffect } from 'preact/hooks';

export function useClickOutside(refOrRefs, onDismiss, active = true) {
  useEffect(() => {
    if (!active || !onDismiss) return;

    function handlePointer(e) {
      const refs = Array.isArray(refOrRefs) ? refOrRefs : [refOrRefs];
      const target = e.target;
      if (!target) return;

      const isInside = refs.some((r) => {
        const el = r && r.current ? r.current : (r instanceof Element ? r : null);
        return el && (el === target || el.contains(target));
      });

      if (!isInside) {
        onDismiss(e);
      }
    }

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onDismiss(e);
      }
    }

    const timerId = setTimeout(() => {
      document.addEventListener('mousedown', handlePointer);
      document.addEventListener('touchstart', handlePointer);
      document.addEventListener('keydown', handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timerId);
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [refOrRefs, onDismiss, active]);
}
