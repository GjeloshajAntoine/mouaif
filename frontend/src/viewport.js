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

  // True only while a soft-keyboard is actually covering the bottom of the
  // visual viewport. On iOS Safari the keyboard is the *only* thing that
  // makes `visualViewport.height` smaller than `window.innerHeight` while a
  // text field is focused; without a keyboard, the visual viewport is also
  // smaller than innerHeight because it excludes the URL-bar / browser
  // chrome. So we gate the inset on input focus: never subtract chrome from
  // the shell, only real keyboard coverage.
  function keyboardIsUp() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName && el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea';
  }

  function apply() {
    // window.innerHeight doesn't shrink when the keyboard appears on iOS,
    // but visualViewport.height DOES. The delta is the keyboard height.
    // Ignoring vv.offsetTop here is deliberate: it reflects iOS scrolling
    // the page up to reveal the focused input, which is *above* the keyboard
    // and not something the shell should reserve.
    const inset = keyboardIsUp() ? Math.max(0, window.innerHeight - vv.height) : 0;

    const prev = root.style.getPropertyValue('--kb-inset');
    const val = Math.round(inset) + 'px';
    if (prev !== val) {
      // In CSS, `height: calc(100vh - var(--kb-inset, 0px))` reduces only
      // the composer/shell by the keyboard height. We also expose a boolean
      // flag so CSS can drop the home-indicator safe-area padding (the
      // system hides the indicator while the keyboard is open).
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