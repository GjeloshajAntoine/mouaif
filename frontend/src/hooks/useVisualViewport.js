// mouaif web — useVisualViewport hook
// Reacts to window.visualViewport resize and scroll changes (e.g. mobile virtual keyboard).

import { useEffect } from 'preact/hooks';

export function useVisualViewport(callback, active = true) {
  useEffect(() => {
    if (!active || typeof callback !== 'function') return;

    function handleViewport() {
      if (window.visualViewport) {
        callback(window.visualViewport);
      }
    }

    // Initial check
    handleViewport();

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', handleViewport);
      vv.addEventListener('scroll', handleViewport);
    }
    window.addEventListener('resize', handleViewport);
    window.addEventListener('orientationchange', handleViewport);

    return () => {
      if (vv) {
        vv.removeEventListener('resize', handleViewport);
        vv.removeEventListener('scroll', handleViewport);
      }
      window.removeEventListener('resize', handleViewport);
      window.removeEventListener('orientationchange', handleViewport);
    };
  }, [callback, active]);
}
