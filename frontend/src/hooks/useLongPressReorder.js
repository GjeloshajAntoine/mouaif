// mouaif web — useLongPressReorder hook
// Reorder the cards of a vertical list by pressing and holding a card's header
// and dragging it. A quick tap or a scroll that starts on the header is left to
// the browser: the card only lifts after the hold, so the page still scrolls.
//
//   const reorder = useLongPressReorder({ listRef, onReorder });
//   h('ul', { ref: listRef },
//     h('li', { 'data-reorder-id': id },
//       h('div', { onPointerDown: (e) => reorder.start(e, id), onContextMenu: reorder.suppress })))
//
// The drag is done on the DOM (the `translate` property, which composes with a
// card's entrance animation instead of being overridden by it), not through
// state, so a drag does not re-render the cards. `onReorder(ids)` is called
// once, on drop, with the new order; nothing is called if the order is unchanged.

import { useRef, useEffect } from 'preact/hooks';

export const HOLD_MS = 400;
// A finger that moves further than this before the hold fires is scrolling.
export const HOLD_SLOP_PX = 8;
const EDGE_PX = 72;        // how close to the scroller's edge the page scrolls
const SCROLL_MAX_PX = 14;  // per frame, at the very edge
const SETTLE_MS = 150;
const IGNORE = '.project-card__menu, button, a, input, textarea, select';

// reorderedIds(ids, dragId, pointerY, centers) -> ids with `dragId` moved to the
// slot under pointerY: after every other card whose original center (by id, in
// `centers`) is above it.
export function reorderedIds(ids, dragId, pointerY, centers) {
  const others = ids.filter((id) => id !== dragId);
  let at = 0;
  while (at < others.length && centers[others[at]] < pointerY) at++;
  others.splice(at, 0, dragId);
  return others;
}

// The nearest ancestor that scrolls vertically (the app scrolls `.app__main`,
// not the window), or the document's scrolling element when none does.
function scrollerOf(el) {
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement || document.documentElement;
}

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
}

export function useLongPressReorder({ listRef, onReorder, idAttr = 'data-reorder-id' }) {
  const state = useRef(null);
  const latest = useRef({ onReorder });
  latest.current.onReorder = onReorder;

  function cards() {
    const list = listRef.current;
    return list ? Array.from(list.children).filter((el) => el.getAttribute(idAttr)) : [];
  }

  function clearStyles(list) {
    for (const el of cards()) {
      el.style.translate = '';
      el.style.scale = '';
      el.style.boxShadow = '';
      el.style.transition = '';
      el.removeAttribute('data-dragging');
    }
    if (list) list.removeAttribute('data-reordering');
  }

  function teardown() {
    const s = state.current;
    if (!s) return;
    clearTimeout(s.timer);
    cancelAnimationFrame(s.raf);
    clearTimeout(s.settle);
    window.removeEventListener('pointermove', s.onMove);
    window.removeEventListener('pointerup', s.onUp);
    window.removeEventListener('pointercancel', s.onCancel);
    window.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('touchmove', s.onTouchMove);
    try { s.head.releasePointerCapture(s.pointerId); } catch (e) {}
    state.current = null;
  }

  // Lay the cards out as they would sit in `order` and translate each one to
  // its slot; the dragged card follows the pointer instead.
  function place(s, order) {
    const gap = s.items.length > 1 ? s.items[1].top - (s.items[0].top + s.items[0].height) : 0;
    let top = s.items[0].top;
    const slots = {};
    for (const id of order) {
      slots[id] = top;
      top += s.byId[id].height + gap;
    }
    for (const item of s.items) {
      if (item.id === s.id) continue;
      item.el.style.translate = '0 ' + (slots[item.id] - item.top) + 'px';
    }
    s.slot = slots[s.id] - s.byId[s.id].top;
  }

  function frame(s) {
    if (state.current !== s || !s.active) return;
    // Near the top or bottom of the scrolling area the page scrolls under the
    // finger; everything below is in the scroller's content coordinates, so
    // the lifted card keeps following the finger while it does.
    const toTop = s.y - s.viewTop, toBottom = s.viewBottom - s.y;
    const dy = toTop < EDGE_PX ? -(1 - Math.max(toTop, 0) / EDGE_PX) : toBottom < EDGE_PX ? (1 - Math.max(toBottom, 0) / EDGE_PX) : 0;
    if (dy) s.box.scrollTop += Math.round(dy * SCROLL_MAX_PX);
    const pointerY = s.y - s.base + s.box.scrollTop;
    const offset = pointerY - s.startPageY;
    const me = s.byId[s.id];
    me.el.style.translate = '0 ' + offset + 'px';
    const centers = {};
    for (const item of s.items) centers[item.id] = item.top + item.height / 2;
    // The slot is chosen by where the finger is, not by the lifted card's
    // middle: the card is tall and held by its header, so its middle sits far
    // below the finger.
    s.order = reorderedIds(s.ids, s.id, pointerY, centers);
    place(s, s.order);
    s.raf = requestAnimationFrame(() => frame(s));
  }

  function activate(s) {
    s.active = true;
    const list = listRef.current;
    const els = cards();
    s.ids = els.map((el) => el.getAttribute(idAttr));
    s.box = scrollerOf(list);
    const isDoc = s.box === document.scrollingElement || s.box === document.documentElement;
    const boxRect = isDoc ? null : s.box.getBoundingClientRect();
    s.base = boxRect ? boxRect.top : 0;
    s.viewTop = boxRect ? Math.max(boxRect.top, 0) : 0;
    s.viewBottom = boxRect ? Math.min(boxRect.bottom, innerHeight) : innerHeight;
    s.items = els.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute(idAttr), el, top: r.top - s.base + s.box.scrollTop, height: r.height };
    });
    s.byId = Object.fromEntries(s.items.map((item) => [item.id, item]));
    s.startPageY = s.startY - s.base + s.box.scrollTop;
    s.order = s.ids.slice();
    list.setAttribute('data-reordering', '1');
    s.byId[s.id].el.setAttribute('data-dragging', '1');
    // From here the page must not scroll under the finger; a non-passive
    // touchmove listener is the one thing that stops it once the hold fired.
    s.onTouchMove = (e) => { if (e.cancelable) e.preventDefault(); };
    document.addEventListener('touchmove', s.onTouchMove, { passive: false });
    try { s.head.setPointerCapture(s.pointerId); } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) {}
    s.raf = requestAnimationFrame(() => frame(s));
  }

  function finish(commit) {
    const s = state.current;
    if (!s) return;
    const list = listRef.current;
    if (!s.active) { teardown(); return; }
    if (s.finishing) return;
    s.finishing = true;
    cancelAnimationFrame(s.raf);
    const changed = commit && s.order.join() !== s.ids.join();
    window.removeEventListener('pointermove', s.onMove);
    const end = () => {
      const ids = s.order.slice();
      teardown();
      if (changed) latest.current.onReorder(ids);
      // The offsets are relative to the old DOM order, so they must go in the
      // same frame the cards are re-ordered, or every moved card is displaced
      // a second time until they do. Preact renders in a microtask queued by
      // onReorder's state update; this one is queued after it, so both run
      // before the browser paints. (The frames are a fallback, not the plan.)
      Promise.resolve().then(() => clearStyles(list));
      requestAnimationFrame(() => requestAnimationFrame(() => clearStyles(list)));
    };
    const me = s.byId[s.id].el;
    // Land softly: slide into the slot while the lift (scale, shadow) eases
    // off, so clearing the dragging marker afterwards changes nothing visible.
    me.style.transition = reducedMotion() ? '' : ['translate', 'scale', 'box-shadow'].map((x) => x + ' ' + SETTLE_MS + 'ms ease').join(', ');
    me.style.translate = '0 ' + (changed ? s.slot : 0) + 'px';
    me.style.scale = '1';
    me.style.boxShadow = 'none';
    if (!changed) place(s, s.ids);
    if (reducedMotion()) end();
    else s.settle = setTimeout(end, SETTLE_MS + 20);
  }

  function start(e, id) {
    if (state.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest(IGNORE)) return;
    if (!listRef.current || cards().length < 2) return;
    const s = {
      id, pointerId: e.pointerId, head: e.currentTarget, startX: e.clientX, startY: e.clientY,
      y: e.clientY, active: false, timer: 0, raf: 0, settle: 0
    };
    s.onMove = (ev) => {
      if (ev.pointerId !== s.pointerId) return;
      s.y = ev.clientY;
      if (!s.active && Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY) > HOLD_SLOP_PX) teardown();
    };
    s.onUp = (ev) => { if (ev.pointerId === s.pointerId) finish(true); };
    s.onCancel = (ev) => { if (ev.pointerId === s.pointerId) finish(false); };
    s.onKey = (ev) => {
      if (ev.key === 'Escape' && s.active) { ev.preventDefault(); ev.stopPropagation(); finish(false); }
    };
    window.addEventListener('pointermove', s.onMove);
    window.addEventListener('pointerup', s.onUp);
    window.addEventListener('pointercancel', s.onCancel);
    window.addEventListener('keydown', s.onKey, true);
    state.current = s;
    s.timer = setTimeout(() => { if (state.current === s) activate(s); }, HOLD_MS);
  }

  useEffect(() => () => { const list = listRef.current; teardown(); clearStyles(list); }, []);

  return {
    start,
    // The hold must not open the browser's context menu / text selection.
    suppress: (e) => e.preventDefault(),
    isDragging: () => !!(state.current && state.current.active)
  };
}
