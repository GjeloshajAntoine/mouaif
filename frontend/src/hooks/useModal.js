// useModal — the shared behaviour of every full-screen sheet.
//
// Each sheet used to re-implement the same three things, slightly
// differently: a `keydown` listener for Escape, a backdrop click, and a
// comment explaining that focus was not handled. This hook owns the first and
// the focus handling; the backdrop click stays with each component because
// the overlay markup is theirs.
//
//   const sheetRef = useModal({ onClose, initialFocus: 'none' });
//   return h('div', { class: 'gm__overlay', role: 'dialog', 'aria-modal': 'true' },
//     h('div', { class: 'gm__sheet', ref: sheetRef }, ...));
//
// What it does:
//   * Escape calls `onClose`, and `stopPropagation` so the key cannot also
//     reach whatever is behind the sheet (the composer, the transcript).
//   * Only the *top-most* sheet reacts — see ./modalStack.js. With the Git
//     confirm sheet open over the Git modal, Escape dismisses the confirm
//     sheet, not both.
//   * Tab cycles inside the sheet (Shift+Tab wraps backwards), so the sheet
//     can never be tabbed past into the app behind it.
//   * On close, focus returns to whatever was focused before the sheet
//     opened, so a keyboard user lands back on the button they tapped.
//
// What it deliberately does not do:
//   * No background scroll lock. `html, body` are already `overflow: hidden`
//     (frontend/src/base.css) and the overlay covers the viewport, so a
//     second lock would only add a way to get out of sync.
//   * No focus move on open by default. Auto-focusing a control in a sheet
//     pops the on-screen keyboard on iOS, which is wrong for a sheet the user
//     may only be reading; pass `initialFocus: 'first'` where focus belongs in
//     the sheet (a prompt's text field), and Tab still pulls focus in.
import { useEffect, useRef } from 'preact/hooks';
import { closeModal, isTopModal, openModal } from './modalStack.js';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

// focusableIn(root) — the controls Tab can reach, in document order. Hidden
// ones are skipped: a sheet that keeps a collapsed section in the DOM (the
// Git modal's file list sections, the CLI modal's hidden screen reader text)
// would otherwise trap Tab on an invisible control.
function focusableIn(root) {
  if (!root || !root.querySelectorAll) return [];
  const out = [];
  for (const el of root.querySelectorAll(FOCUSABLE)) {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') continue;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
    out.push(el);
  }
  return out;
}

export function useModal(options) {
  const opt = options || {};
  const { onClose, active = true, escape = true, trapFocus = true, restoreFocus = true, initialFocus = 'none' } = opt;

  const sheetRef = useRef(null);
  const openerRef = useRef(null);
  // The listener is registered once and reads the latest `onClose` through a
  // ref, so a parent that re-renders with a fresh arrow function does not
  // re-register the listener (and cannot miss a keystroke in the gap).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return undefined;
    const token = {};
    openModal(token);
    openerRef.current = typeof document === 'undefined' ? null : document.activeElement;

    if (initialFocus === 'first') {
      const [first] = focusableIn(sheetRef.current);
      if (first) first.focus();
      else if (sheetRef.current) {
        // Nothing focusable inside: make the sheet itself the focus target so
        // the keyboard cannot wander into the app behind it.
        sheetRef.current.setAttribute('tabindex', '-1');
        sheetRef.current.focus();
      }
    }

    function onKeyDown(event) {
      // A sheet under the top one must stay silent: the same Escape is the
      // top sheet's, and its Tab cycle is the one that should run.
      if (!isTopModal(token)) return;
      if (escape && event.key === 'Escape') {
        event.stopPropagation();
        if (closeRef.current) closeRef.current();
        return;
      }
      if (!trapFocus || event.key !== 'Tab') return;
      const items = focusableIn(sheetRef.current);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      const inside = !!(sheetRef.current && sheetRef.current.contains(current));
      if (event.shiftKey) {
        if (!inside || current === first) { event.preventDefault(); last.focus(); }
      } else if (!inside || current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      closeModal(token);
      const opener = openerRef.current;
      if (restoreFocus && opener && typeof opener.focus === 'function'
        && typeof document !== 'undefined' && document.contains(opener)) {
        opener.focus();
      }
    };
  }, [active, escape, trapFocus, restoreFocus, initialFocus]);

  return sheetRef;
}

// Exported for the hook's test and for a component that needs the same
// "which controls are reachable" answer (e.g. to decide whether to render a
// skip link).
export { focusableIn };
