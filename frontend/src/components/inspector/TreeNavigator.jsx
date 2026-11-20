// TreeNavigator — the Styles panel's element-tree navigation, after the
// "Mobile-first Web Inspector" design (merged board: drag tree + CSS editing).
//
// Three columns instead of nested indentation, so rows never get squeezed:
//   Parent   — the parent and its siblings (the row on the path is greyed in)
//   Siblings — the selected element and its siblings, full width
//   Children — the selected element's children
// A breadcrumb above jumps straight to any ancestor.
//
// Moving: tap a row; or drag anywhere on the block — vertical steps through
// siblings, sideways goes to the first child (right) or the parent (left); or
// wheel / arrow keys. While dragging, the row being headed for fills up in the
// drag direction, and the readout line spells out the distance in px. When
// there is nothing in that direction the selected row shows an orange bar on
// that side instead.
//
// Every hop is a CDP round-trip, so vertical drag steps move a local cursor
// through the sibling window and commit once the finger rests or lifts; a
// sideways hop commits immediately (the tree has to be re-read anyway).
import { h } from 'preact';
import { useRef, useState, useEffect } from 'preact/hooks';

const STEP_Y = 36;   // px of vertical drag per sibling
const STEP_X = 72;   // px of sideways drag per level
const COMMIT_MS = 220;

export function TreeNavigator(props) {
  const tree = props.tree;
  const sib = tree && tree.siblings;
  const par = tree && tree.parents;
  const kids = (tree && tree.children) || [];
  const selfAt = sib ? sib.at : -1;

  // cursor — the sibling index the selection is heading to (local, before the
  // hop is committed). Reset whenever a new tree arrives.
  const [cursor, setCursor] = useState(selfAt);
  const [drag, setDrag] = useState(null); // { axis, dx, dy }
  const g = useRef({ o: null, axis: null, moved: false, timer: 0, cursor: selfAt });
  const rootRef = useRef(null);
  const wheelRef = useRef(null);
  useEffect(() => { setCursor(selfAt); g.current.cursor = selfAt; }, [tree]);
  useEffect(() => () => clearTimeout(g.current.timer), []);
  // The interesting end of the breadcrumb is the selected element, so the
  // strip is scrolled to its end whenever a new tree arrives.
  const crumbsRef = useRef(null);
  useEffect(() => { const c = crumbsRef.current; if (c) c.scrollLeft = c.scrollWidth; }, [tree]);

  const sibItems = (sib && sib.items) || [];
  const posOf = (index) => sibItems.findIndex((s) => s.index === index);
  const curPos = posOf(cursor);

  function commitSoon(index) {
    clearTimeout(g.current.timer);
    g.current.timer = setTimeout(() => commit(index), COMMIT_MS);
  }
  function commit(index) {
    clearTimeout(g.current.timer);
    if (index == null || index === selfAt || index < 0) return;
    props.onSelect(1, index);
  }
  // step — 'prev' | 'next' | 'parent' | 'child'. Returns false at a wall.
  function step(dir) {
    if (dir === 'prev' || dir === 'next') {
      const p = posOf(g.current.cursor);
      const to = sibItems[p + (dir === 'next' ? 1 : -1)];
      if (!to) return false;
      g.current.cursor = to.index;
      setCursor(to.index);
      commitSoon(to.index);
      return true;
    }
    if (dir === 'child') {
      // From a cursor that moved off the real selection, "child" means that
      // sibling's first child: commit the sibling first, the tree follows.
      if (g.current.cursor !== selfAt) { commit(g.current.cursor); return true; }
      if (!kids.length) return false;
      props.onSelect(0, 0);
      return true;
    }
    if (dir === 'parent') {
      if (!tree || !tree.ancestors || !tree.ancestors.length) return false;
      clearTimeout(g.current.timer);
      props.onSelect(1, null);
      return true;
    }
    return false;
  }
  function has(dir) {
    if (dir === 'prev') return curPos > 0;
    if (dir === 'next') return curPos >= 0 && curPos < sibItems.length - 1;
    if (dir === 'child') return g.current.cursor !== selfAt || kids.length > 0;
    if (dir === 'parent') return !!(tree && tree.ancestors && tree.ancestors.length);
    return false;
  }

  function down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    g.current.o = { x: e.clientX, y: e.clientY };
    g.current.axis = null;
    g.current.moved = false;
    g.current.mouse = e.pointerType === 'mouse';
    setDrag({ axis: null, dx: 0, dy: 0 });
  }
  function move(e) {
    const s = g.current;
    if (!s.o) return;
    const f = s.mouse ? 2 / 3 : 1;
    const SY = Math.round(STEP_Y * f), SX = Math.round(STEP_X * f), LOCK = s.mouse ? 6 : 12;
    let dx = e.clientX - s.o.x, dy = e.clientY - s.o.y;
    if (!s.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= LOCK) {
      s.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      s.moved = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    }
    if (s.axis === 'y' && Math.abs(dx) > Math.abs(dy) + 16) { s.axis = 'x'; s.o.y = e.clientY; dy = 0; }
    else if (s.axis === 'x' && Math.abs(dy) > Math.abs(dx) + 16) { s.axis = 'y'; s.o.x = e.clientX; dx = 0; }
    if (s.axis === 'y') {
      dx = 0;
      while (Math.abs(dy) >= SY) {
        const d = dy > 0 ? 1 : -1;
        if (!step(d > 0 ? 'next' : 'prev')) { dy = d * SY; break; }
        s.o.y += d * SY;
        dy -= d * SY;
      }
    } else if (s.axis === 'x') {
      dy = 0;
      if (Math.abs(dx) >= SX) {
        const d = dx > 0 ? 1 : -1;
        if (step(d > 0 ? 'child' : 'parent')) {
          s.o = { x: e.clientX, y: e.clientY }; s.axis = null; dx = 0;
        } else dx = d * SX;
      }
    }
    setDrag({ axis: s.axis, dx, dy, sx: SX, sy: SY });
  }
  function up() {
    const s = g.current;
    if (!s.o) return;
    s.o = null; s.axis = null;
    setTimeout(() => { s.moved = false; }, 80);
    setDrag(null);
    if (s.cursor !== selfAt) commit(s.cursor);
  }
  function key(e) {
    const dir = { ArrowUp: 'prev', ArrowDown: 'next', ArrowLeft: 'parent', ArrowRight: 'child' }[e.key];
    if (!dir) return;
    e.preventDefault();
    step(dir);
  }
  // Wheel — a non-passive listener, so the block doesn't scroll the panel
  // while it is being used as a trackpad.
  wheelRef.current = (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : 1;
    let x = e.deltaX * unit, y = e.deltaY * unit;
    if (e.shiftKey && Math.abs(x) < Math.abs(y)) { x = y; y = 0; }
    const s = g.current, now = Date.now();
    if (!s.w || now - s.w.t > 250) s.w = { x: 0, y: 0, t: now };
    s.w.t = now;
    if (Math.abs(x) > Math.abs(y)) {
      s.w.x += x; s.w.y = 0;
      if (Math.abs(s.w.x) >= 80) { step(s.w.x > 0 ? 'child' : 'parent'); s.w.x = 0; }
    } else {
      s.w.y += y; s.w.x = 0;
      if (Math.abs(s.w.y) >= 40) { step(s.w.y > 0 ? 'next' : 'prev'); s.w.y = 0; }
    }
  };
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const fn = (e) => wheelRef.current(e);
    el.addEventListener('wheel', fn, { passive: false });
    return () => el.removeEventListener('wheel', fn);
  }, [!!tree]);

  if (!tree) return null;

  // Drag feedback: which row fills, how far, and the readout line.
  const axis = drag && drag.axis;
  let dir = null;
  // A distance of exactly 0 (just after a step) has no direction yet: keep
  // the one the drag was heading in, rather than snapping to next/child.
  if (axis === 'y') dir = drag.dy > 0 ? 'next' : drag.dy < 0 ? 'prev' : g.current.lastDir;
  if (axis === 'x') dir = drag.dx > 0 ? 'child' : drag.dx < 0 ? 'parent' : g.current.lastDir;
  if (dir) g.current.lastDir = dir;
  const lim = axis === 'y' ? drag.sy : (drag && drag.sx);
  const dist = Math.round(Math.abs(axis === 'y' ? drag.dy : (drag ? drag.dx : 0)));
  const pct = dir ? Math.round(Math.min(1, dist / lim) * 100) : 0;
  const can = dir ? has(dir) : false;
  const sibTarget = dir === 'next' ? sibItems[curPos + 1] : (dir === 'prev' ? sibItems[curPos - 1] : null);
  const parentPos = par ? par.items.findIndex((p) => p.index === par.at) : -1;

  const words = { prev: 'previous', next: 'next', parent: 'parent', child: 'child' };
  const targetLabel = dir === 'next' || dir === 'prev' ? (sibTarget && sibTarget.label)
    : dir === 'child' ? (cursor !== selfAt ? (sibItems[curPos] || {}).label : (kids[0] || {}).label)
      : dir === 'parent' ? (tree.ancestors[0] || {}).label : '';
  let readout = 'Drag, scroll or arrow keys: up/down for siblings, sideways for depth';
  if (drag) readout = 'Locks to one axis after ' + (g.current.mouse ? 6 : 12) + ' px';
  if (dir) readout = can ? dist + ' / ' + lim + ' px to ' + words[dir] + ': ' + targetLabel : 'No ' + words[dir] + ' here';

  const fillTo = { next: 'to bottom', prev: 'to top', child: 'to right', parent: 'to left' };
  function row(item, col, opts) {
    const isSel = !!opts.sel, onPath = !!opts.path, isTarget = !!opts.target && can;
    const style = {};
    if (isTarget) style.backgroundImage = 'linear-gradient(' + fillTo[dir] + ', var(--tnav-fill) ' + pct + '%, transparent ' + pct + '%)';
    const cls = 'tnav__row tnav__row--' + col
      + (isSel ? ' is-sel' : '') + (onPath ? ' is-path' : '') + (isTarget ? ' is-target' : '')
      + (isSel && dir && !can ? ' is-wall-' + dir : '');
    const badge = item.kids ? (col === 'mid' ? item.kids + ' ›' : '›') : '';
    return h('button', {
      type: 'button',
      class: cls,
      style,
      key: col + '-' + (item.index != null ? item.index : item.label) + '-' + opts.i,
      'aria-current': isSel ? 'true' : undefined,
      title: item.label,
      onClick: () => { if (!g.current.moved) opts.go(); },
      onKeyDown: key
    },
    h('span', { class: 'tnav__label' }, item.label),
    badge ? h('span', { class: 'tnav__badge', 'aria-hidden': 'true' }, badge) : null);
  }

  const crumbs = tree.ancestors.slice().reverse();
  const left = par ? par.items.map((p, i) => row(p, 'left', {
    i, path: p.index === par.at, target: dir === 'parent' && i === parentPos,
    go: () => props.onSelect(2, p.index)
  })) : [];
  const mid = sib ? sibItems.map((s, i) => row(s, 'mid', {
    i, sel: s.index === cursor, target: (dir === 'next' || dir === 'prev') && sibTarget && s.index === sibTarget.index,
    go: () => { clearTimeout(g.current.timer); if (s.index !== selfAt) props.onSelect(1, s.index); }
  })) : [row({ label: tree.label, kids: tree.childCount }, 'mid', { i: 0, sel: true, go: () => {} })];
  const right = cursor === selfAt ? kids.map((c, i) => row(c, 'right', {
    i, target: dir === 'child' && i === 0, go: () => props.onSelect(0, i)
  })) : [];
  const more = (list) => (list && list.count > list.items.length
    ? h('span', { class: 'tnav__more' }, list.count + ' total') : null);

  return h('div', { class: 'tnav' },
    h('div', { class: 'tnav__crumbs', ref: crumbsRef, role: 'group', 'aria-label': 'Parent elements, root first' },
      crumbs.map((a) => [
        h('button', { type: 'button', class: 'tnav__crumb', key: 'c' + a.levels, onClick: () => props.onSelect(a.levels, null) }, a.label),
        h('span', { class: 'tnav__sep', 'aria-hidden': 'true', key: 's' + a.levels }, '›')
      ]),
      h('span', { class: 'tnav__crumb is-here', 'aria-current': 'true' }, tree.label)),
    h('div', {
      class: 'tnav__pad' + (axis ? ' is-dragging' : ''),
      ref: rootRef,
      onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up
    },
    h('div', { class: 'tnav__col tnav__col--left' },
      h('span', { class: 'tnav__head' }, 'Parent'), left, more(par)),
    h('div', { class: 'tnav__col tnav__col--mid' },
      h('span', { class: 'tnav__head' }, 'Siblings'), mid, more(sib)),
    h('div', { class: 'tnav__col tnav__col--right' },
      h('span', { class: 'tnav__head' }, right.length ? 'Children' : 'No children'), right,
      cursor === selfAt && tree.childCount > kids.length ? h('span', { class: 'tnav__more' }, '+' + (tree.childCount - kids.length)) : null)),
    h('p', { class: 'tnav__readout' + (dir && !can ? ' is-wall' : (dir ? ' is-live' : '')), role: 'status' }, readout));
}
