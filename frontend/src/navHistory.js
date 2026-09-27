// frontend/src/navHistory.js — the in-app history chain, as data.
//
// Why it exists: every in-app Back control (the chat header ←, the settings
// `view-back` arrows, the redirect after a save or delete) used to *push* its
// target — `location.hash = '#/projects'`. The browser history then read
// `… list, chat, list`, so the system Back gesture (Android, iOS swipe, the
// browser button) reopened the page the user had just left: a loop. Deleting
// a chat and landing on the list left the deleted chat one Back away, and a
// save that returned to its list left the blank "new" form one Back away.
//
// The fix is to make in-app Back *go back*: when the target page is an
// earlier entry of this tab's own chain, `history.go(-n)` returns to it;
// otherwise (a deep link, a notification tap, a fresh launch) the current
// entry is *replaced*, so nothing is ever pushed by a Back.
//
// The browser does not expose its history list, so the router keeps a small
// book of the entries it has seen: each entry gets an id (stored in
// `history.state`, so it survives traversal and reload) and remembers the
// entry it was pushed from. A push is always exactly one step after the entry
// it came from, which is what makes the `prev` chain count real steps.
//
// Pure and DOM-free: router.js does the wiring, scripts/test-nav-history.mjs
// drives these functions directly.

export const MAX_ENTRIES = 200;
// How far back `stepsBack` walks. A drill-down deeper than this falls back to
// a replace, which is still loop-free.
export const MAX_STEPS = 50;

// emptyBook() — `{ seq, entries: { [id]: { hash, prev } } }`.
export function emptyBook() {
  return { seq: 0, entries: {} };
}

// parseBook(raw) — a book from its sessionStorage JSON; anything unreadable
// starts over (the worst case is one Back that replaces instead of popping).
export function parseBook(raw) {
  try {
    const book = JSON.parse(raw || '');
    if (book && typeof book.seq === 'number' && book.entries && typeof book.entries === 'object') return book;
  } catch { /* fall through */ }
  return emptyBook();
}

// addEntry(book, hash, prev) — record a new entry pushed from `prev` (null
// for the first entry of a document) and return its id. Old ids are pruned;
// a pruned `prev` just ends the chain early.
export function addEntry(book, hash, prev) {
  const id = ++book.seq;
  book.entries[id] = { hash: String(hash || ''), prev: prev == null ? null : prev };
  const floor = book.seq - MAX_ENTRIES;
  for (const key of Object.keys(book.entries)) {
    if (Number(key) <= floor) delete book.entries[key];
  }
  return id;
}

// stepsBack(book, current, matches) — how many history steps back the nearest
// entry whose hash satisfies `matches` sits along `current`'s chain, or 0 when
// there is none (the caller then replaces instead).
export function stepsBack(book, current, matches) {
  let entry = current == null ? null : book.entries[current];
  for (let steps = 1; entry && entry.prev != null && steps <= MAX_STEPS; steps += 1) {
    const prev = book.entries[entry.prev];
    if (!prev) return 0;
    if (matches(prev.hash)) return steps;
    entry = prev;
  }
  return 0;
}

// sameRoute(a, b) — two parsed routes name the same page with the same
// parameters, so `#/`, `#/projects` and `''` all count as the chat list and
// query order never matters.
export function sameRoute(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}
