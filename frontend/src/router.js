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
import { route } from './api.js';
import { parseHash } from './routes.js';
import { addEntry, parseBook, sameRoute, stepsBack } from './navHistory.js';

const BOOK_KEY = 'mouaif.navHistory';
const STATE_KEY = 'mouaifNav';

let current = null;
// Set by replace(): the next hashchange is the same entry with a new hash,
// not a push.
let replacing = false;

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
    current = addEntry(book, hash, fresh ? null : current);
    tagEntry(current);
  }
  replacing = false;
  writeBook(book);
}

syncEntry(true);
route.value = parseHash(window.location.hash);
window.addEventListener('hashchange', () => {
  syncEntry(false);
  route.value = parseHash(window.location.hash);
});
// A page restored from the back/forward cache kept its old `current`.
window.addEventListener('pageshow', (event) => { if (event.persisted) syncEntry(false); });

export function nav(toHash) {
  window.location.hash = '#/' + toHash;
}

export function replace(toHash) {
  const next = '#/' + toHash;
  if (window.location.hash === next) return;
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
