// mouaif web — hash router
// Hash URLs only (no pushState paths); the Node server doesn't rewrite unknown paths to
// index.html, so deep links would 404 anyway; the hash is enough.
//
// This module is only the browser wiring: it keeps the shared `route`
// signal in sync with `window.location.hash` and exposes `nav()`. The
// hash → route mapping itself is a table in ./routes.js so it can be
// tested (and extended) without a DOM.
//
// Three ways to move, pick by meaning:
//   nav(path)     — go forward to a page (pushes a history entry).
//   back(path)    — return to a page: pops back to it when it is an earlier
//                   entry of this tab, otherwise replaces the current entry.
//                   Never pushes, so the system Back gesture cannot loop.
//   replace(path) — swap the current entry (e.g. a "new" form that became
//                   the saved item's editor).
// Every `<a class="view-back" href="#/…">` is routed through `back()` by the
// click listener at the bottom. See ./navHistory.js and
// docs/features/navigation-history.md.
//
// While a sheet is open, a guard entry with the page's own URL sits on top so
// the system Back closes the sheet instead of the page (./backLayers.js and
// docs/features/sheet-back-gesture.md).
import { route } from './api.js';
import { parseHash } from './routes.js';
import { addEntry, parseBook, sameRoute, stepsBack } from './navHistory.js';
import { closeTopLayer, openLayerCount, setBackLayerHistory } from './backLayers.js';

const BOOK_KEY = 'mouaif.navHistory';
const STATE_KEY = 'mouaifNav';
const SHEET_KEY = 'mouaifSheet';

let current = null;
// Set by replace(): the next hashchange is the same entry with a new hash,
// not a push.
let replacing = false;
// Set by nav()/replace() on a sheet guard: the new page takes the guard's
// place, so it is one step after the page the sheet was open on.
let consumingGuard = false;
// Set when the router moves off a guard itself (a closed sheet, a stale guard
// being skipped): the popstate that follows is not a Back press.
let ownPop = false;

function readBook() {
  try { return parseBook(window.sessionStorage.getItem(BOOK_KEY)); } catch { return parseBook(''); }
}
function writeBook(book) {
  try { window.sessionStorage.setItem(BOOK_KEY, JSON.stringify(book)); } catch { /* private mode: in-memory only */ }
}
function stateId() {
  const state = window.history.state;
  return state && typeof state[STATE_KEY] === 'number' ? state[STATE_KEY] : null;
}
function tagEntry(id) {
  try { window.history.replaceState({ ...(window.history.state || {}), [STATE_KEY]: id }, ''); } catch { /* best-effort */ }
}

// syncEntry(fresh) — work out which history entry is showing. `fresh` is the
// document's first entry (no in-app entry precedes it).
function syncEntry(fresh) {
  const book = readBook();
  const hash = window.location.hash || '';
  const known = stateId();
  if (known != null && book.entries[known]) {
    // Traversal (Back/Forward), a reload, or a synthetic hashchange.
    current = known;
    book.entries[known].hash = hash;
  } else if (replacing && current != null && book.entries[current]) {
    // location.replace() keeps the position but drops history.state.
    book.entries[current].hash = hash;
    tagEntry(current);
  } else {
    let prev = fresh ? null : current;
    if (consumingGuard && prev != null && book.entries[prev] && book.entries[prev].sheet) prev = book.entries[prev].prev;
    current = addEntry(book, hash, prev);
    tagEntry(current);
  }
  replacing = false;
  consumingGuard = false;
  writeBook(book);
}

// ---- Sheet guard -------------------------------------------------------

function onGuard() {
  const state = window.history.state;
  return !!(state && state[SHEET_KEY]);
}

// armGuard() — push the guard entry an open sheet sits on (once).
function armGuard() {
  if (onGuard()) return;
  const book = readBook();
  const id = addEntry(book, window.location.hash || '', current, true);
  try {
    window.history.pushState({ ...(window.history.state || {}), [STATE_KEY]: id, [SHEET_KEY]: true }, '');
  } catch { return; }
  current = id;
  writeBook(book);
}

// disarmGuard() — the last sheet closed by its own controls: step back off
// the guard so the next system Back leaves the page, as it should.
function disarmGuard() {
  if (!onGuard()) return;
  ownPop = true;
  window.history.back();
}

setBackLayerHistory({ arm: armGuard, disarm: disarmGuard });

function onPopState() {
  const before = current;
  syncEntry(false);
  if (ownPop) {
    ownPop = false;
    // A sheet opened while the old guard was being removed needs a new one.
    if (openLayerCount()) armGuard();
    return;
  }
  const book = readBook();
  const left = before != null ? book.entries[before] : null;
  if (onGuard()) {
    // A stale guard: its sheet closed when a link inside it pushed a page.
    // Keep going in the same direction so no Back press is wasted on it.
    if (openLayerCount()) return;
    ownPop = true;
    if (left && left.prev === current) window.history.back();
    else window.history.forward();
    return;
  }
  // Back from the guard onto the page under it: close the top sheet, and
  // guard the next one if sheets were stacked.
  if (left && left.sheet && left.prev === current && openLayerCount()) {
    closeTopLayer();
    if (openLayerCount()) armGuard();
  }
}

syncEntry(true);
// A reload while a sheet was open lands on its guard with no sheet: drop it.
if (onGuard()) { ownPop = true; window.history.back(); }
route.value = parseHash(window.location.hash);
window.addEventListener('popstate', onPopState);
window.addEventListener('hashchange', () => {
  syncEntry(false);
  route.value = parseHash(window.location.hash);
});
// A page restored from the back/forward cache kept its old `current`.
window.addEventListener('pageshow', (event) => { if (event.persisted) syncEntry(false); });

export function nav(toHash) {
  const next = '#/' + toHash;
  if (onGuard()) {
    // A link out of an open sheet replaces the guard, so the guard cannot
    // turn into a Back press that changes nothing later.
    if (window.location.hash === next) return;
    consumingGuard = true;
    window.location.replace(next);
    return;
  }
  window.location.hash = next;
}

export function replace(toHash) {
  const next = '#/' + toHash;
  if (window.location.hash === next) return;
  if (onGuard()) {
    // The page under the sheet keeps its entry; the guard's slot is the
    // only one that can be swapped without leaving it behind.
    consumingGuard = true;
    window.location.replace(next);
    return;
  }
  replacing = true;
  window.location.replace(next);
}

// replaceUrl(toHash) — rewrite the current entry's URL without routing (the
// agent editor renames itself in place without remounting the form).
export function replaceUrl(toHash) {
  try { window.history.replaceState(window.history.state, '', '#/' + toHash); } catch { return; }
  const book = readBook();
  if (current != null && book.entries[current]) {
    book.entries[current].hash = window.location.hash;
    writeBook(book);
  }
}

export function back(toHash) {
  const target = parseHash('#/' + toHash);
  const steps = stepsBack(readBook(), current, (hash) => sameRoute(parseHash(hash), target));
  if (steps > 0) window.history.go(-steps);
  else replace(toHash);
}

// Every header Back arrow is an `<a class="view-back" href="#/…">`. A plain
// tap goes through back(); a component that handles the click itself calls
// preventDefault() (its own listener runs first), and modified clicks keep
// the browser behavior (open in a new tab).
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target && event.target.closest ? event.target.closest('a.view-back') : null;
  if (!link) return;
  const href = link.getAttribute('href') || '';
  if (!href.startsWith('#/')) return;
  event.preventDefault();
  back(href.slice(2));
});
