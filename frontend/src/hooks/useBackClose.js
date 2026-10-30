// useBackClose — let the system Back gesture close a sheet, picker or viewer.
//
//   useBackClose(open, () => setOpen(false));
//
// While `active` is true the layer is registered with ../backLayers.js, which
// has the router keep a guard history entry on top of the page: Back (Android
// button, iOS edge swipe, the browser's Back) then runs `onClose` instead of
// leaving the page. Closing the layer any other way releases the guard.
//
// `useModal` already calls this for every sheet built on it; use it directly
// only for an overlay that does not use `useModal` (a native <dialog>, a
// popover, a full-screen mode).
import { useEffect, useRef } from 'preact/hooks';
import { openBackLayer } from '../backLayers.js';

export function useBackClose(active, onClose) {
  // Read the latest `onClose` through a ref so a parent re-rendering with a
  // fresh arrow function does not re-register (and re-push) the layer.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return undefined;
    return openBackLayer(() => { if (closeRef.current) closeRef.current(); });
  }, [active]);
}
