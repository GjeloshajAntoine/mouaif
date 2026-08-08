// mouaif web — VisualViewport keyboard inset
//
// iOS Safari (and iOS standalone PWAs) ignore the Chromium-only
// `interactive-widget=resizes-content` viewport directive: when the
// soft keyboard opens, the *layout* viewport (100dvh on .app__shell)
// does not shrink — only the visual viewport (vv) does. So a
// bottom-anchored composer/textarea stays pinned to the bottom of the
// layout viewport, which is either hidden behind the keyboard (PWA)
// or forces iOS to auto-scroll the whole page to reveal the focused
// input (browser), leaving an empty margin under it.
//
// This module watches window.visualViewport and publishes the
// keyboard inset (visible viewport subtracted from the layout
// viewport) as a CSS variable --kb-inset on <html>. The shell then
// sizes itself with 100dvh - var(--kb-inset) so the composer rises
// above the keyboard everywhere (Android + Chrome via the meta tag is
// already a no-op because there vv.height already tracks the layout
// viewport and the inset computes to 0).

let cleanup = null;

export function initVisualViewportInset() {
  if (cleanup) return cleanup;
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const root = document.documentElement;

  function apply() {
    // keyboardInset = (layout height above the visible area) - (vv.offsetTop
    // is browser chrome that is NOT covered by the keyboard and that the
    // shell should not also reserve). Only subtract real keyboard coverage:
    //   inset = max(0, window.innerHeight - vv.offsetTop - vv.height)
    // If the browser chrome pushes the visual viewport down (offsetTop > 0),
    // iOS Safari does not reduce `innerHeight` — it pushes the whole document
    // up. But we subtract it here to avoid double-counting.
    //
    // Also, if the keyboard pushes up past the bottom safe area (home indicator),
    // we don't want to double-count `--safe-bottom` which the shell padding
    // already adds. So we clamp the inset to at least 0.
    
    // Fallback: visual viewport is fully available.
    // window.innerHeight doesn't shrink when keyboard appears on iOS,
    // but vv.height DOES shrink. The difference is the keyboard height!
    // Offset is ignored since it reflects scrolling due to input focus, 
    // but the actual height delta between the full window and visual viewport 
    // is what is covered by the keyboard.
    const inset = Math.max(0, window.innerHeight - vv.height);
    
    const prev = root.style.getPropertyValue('--kb-inset');
    const val = Math.round(inset) + 'px';
    if (prev !== val) {
      // In CSS, `height: calc(100vh - var(--kb-inset, 0px))` handles the reduction.
      // We also expose a boolean flag to let CSS know if the keyboard is open,
      // which is useful for removing safe-area-inset-bottom padding.
      root.style.setProperty('--kb-inset', val);
      if (inset > 40) root.classList.add('keyboard-open');
      else root.classList.remove('keyboard-open');
    }
  }

  apply();
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', apply);
  // iOS fires visualViewport resize unreliably during keyboard animation;
  // focusin/focusout on any editable element fire for sure. Re-measure
  // on those too (debounced with rAF so we coalesce bursts).
  let raf = 0;
  function onFocus() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; apply(); });
  }
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('focusout', onFocus, true);

  cleanup = () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    window.removeEventListener('orientationchange', apply);
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('focusout', onFocus, true);
    root.style.removeProperty('--kb-inset');
    cleanup = null;
  };
  return cleanup;
}