// mouaif web — transcript windowing
//
// After every older page has loaded the whole chat stays in the DOM, and
// `content-visibility: auto` only skips style/layout/paint: every off-screen
// row still holds its full subtree (markdown, code blocks, tool bodies). This
// takes those subtrees out of the document while the row is far from the
// viewport.
//
// The shared `virtual-list.js` (fixed height, absolutely positioned recycled
// nodes) does not fit the transcript: rows have variable height, are built
// and keyed by the reconciler, and are looked up as elements by the stream,
// card index, scroll nav and jump-to-run. So the row element itself always
// stays where it is — keyed, ordered, carrying its data-* attributes and its
// classes — and only its children move into a detached fragment. The row is
// pinned to the height it had, so hibernating is geometry-neutral: the
// scrollbar and scroll position do not move.
//
// A row wakes when it comes back within the observer margin, and on demand
// via `row._wake()` before code reaches inside it (findToolCard, the expanded-state
// snapshot, jump-to-run). Rows that may be written to from the stream, or
// whose subtree cannot leave the document without losing state (iframes
// reload, media stops), are never hibernated.

// Screens above and below the viewport kept fully mounted.
const MARGIN = '200% 0px 200% 0px';
// Newest rows never hibernate: the stream finalises their meta lines.
const KEEP_TAIL = 4;

const NEVER = [
  '[data-live]',
  '[data-auth-call-id]',
  '[data-mcp-app-card]',
  '.tool-card--mcp-app',
  '.tool-card--subagent',
  '.tool-card--progress',
  '.tool-card--authorization',
  '.tool-card--ask-user',
  '.tool-card--ext-renderer',
  '[data-sys-prompt]',
  '[data-tools-card]',
  '[data-agent-files-card]',
  '[data-skills-card]',
].join(',');
const STATEFUL = 'iframe,video,audio,canvas,object,embed';

export function isHibernated(row) {
  return !!(row && row._hibernated);
}

function isRow(node) {
  if (!node || node.nodeType !== 1 || !node.classList) return false;
  return node.classList.contains('chat-msg') || node.classList.contains('tool-card');
}

function eligible(row, root) {
  if (!isRow(row) || row._hibernated || row.parentNode !== root) return false;
  if (row.matches(NEVER)) return false;
  // A call still waiting for its result is updated in place by the stream.
  if (row.classList.contains('tool-card--call') && !row.classList.contains('tool-card--result')) return false;
  if (row.querySelector(STATEFUL)) return false;
  const active = row.ownerDocument && row.ownerDocument.activeElement;
  if (active && active !== row && row.contains(active)) return false;
  // Keep the tail mounted.
  let n = 0;
  for (let s = row.nextElementSibling; s; s = s.nextElementSibling) {
    if (isRow(s) && ++n >= KEEP_TAIL) return true;
  }
  return false;
}

function hibernate(row, height) {
  if (!(height > 0)) return;
  const frag = row.ownerDocument.createDocumentFragment();
  while (row.firstChild) frag.appendChild(row.firstChild);
  row._hibernated = { frag, height: row.style.height, minHeight: row.style.minHeight };
  // Callers outside this module wake a row through this property, so they
  // need no import (the vm test harnesses strip imports).
  row._wake = () => wakeRow(row);
  row.style.height = height + 'px';
  row.style.minHeight = height + 'px';
  row.setAttribute('data-hibernated', '1');
}

// wakeRow(row) — put a hibernated row's subtree back. Safe on any node.
export function wakeRow(row) {
  const h = row && row._hibernated;
  if (!h) return row;
  row._hibernated = null;
  row._wake = null;
  // Children added while hibernated (a builder appending to the empty row)
  // stay after the restored ones.
  row.insertBefore(h.frag, row.firstChild);
  row.style.height = h.height;
  row.style.minHeight = h.minHeight;
  row.removeAttribute('data-hibernated');
  return row;
}

// wakeAll(root) — wake every hibernated row under `root`.
export function wakeAll(root) {
  if (!root || !root.children) return;
  for (const child of Array.from(root.children)) if (child._hibernated) wakeRow(child);
}

// createTranscriptWindow(root) -> { dispose() }
//
// Observes the transcript's direct child rows; rows the reconciler adds or
// removes are picked up by a MutationObserver, so no builder needs to know.
export function createTranscriptWindow(root) {
  if (!root || typeof IntersectionObserver !== 'function' || typeof MutationObserver !== 'function') {
    return { dispose() {} };
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const row = e.target;
      if (e.isIntersecting) wakeRow(row);
      else if (eligible(row, root)) hibernate(row, e.boundingClientRect.height);
    }
  }, { root, rootMargin: MARGIN });
  const observed = new Set();
  const watch = (node) => {
    if (isRow(node) && !observed.has(node)) { observed.add(node); io.observe(node); }
  };
  const unwatch = (node) => {
    if (observed.has(node) && node.parentNode !== root) {
      observed.delete(node);
      io.unobserve(node);
      // A removed row may be re-inserted elsewhere (moved) or kept by a
      // cache; give it back its subtree.
      wakeRow(node);
    }
  };
  for (const child of Array.from(root.children)) watch(child);
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.removedNodes) unwatch(n);
      for (const n of r.addedNodes) watch(n);
    }
  });
  mo.observe(root, { childList: true });
  return {
    dispose() {
      mo.disconnect();
      io.disconnect();
      observed.clear();
      wakeAll(root);
    },
  };
}
