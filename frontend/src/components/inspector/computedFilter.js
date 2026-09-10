// Inspector computed-style filtering.
//
// The Computed list is every property the browser can resolve for an
// element — around 400 rows on a typical page. That is the panel's most
// complete read-out and its least usable one: on a 360 px phone it is a
// multi-screen wall where the one property being hunted for is
// indistinguishable from the 399 that are not.
//
// This module is the pure half of the fix: given the rows, a search string,
// one of three filters, and the sets of "declared here" / "changed here"
// property names, it returns the rows to render and the cap to render them
// under. Pure (plain data in, plain data out) so
// `scripts/test-inspector-computed-filter.js` can cover the matching rules
// and the paging without a browser or a Preact render.
//
// Kept out of stylesOrder.js on purpose: that module owns *ordering* the
// list (changed-first hoisting), this one owns *selecting* from it, and the
// panel composes the two.

// FILTERS — the segmented control's options, in render order.
//
//   all     — every computed property (the default; complete read-out)
//   set     — only properties this element declares itself, in its inline
//             style or via an edit made in this session. This is the
//             "what is this element actually doing" view: a page's
//             computed wall is mostly inherited and default values.
//   changed — only what the user edited in this session, which is the
//             "what did I just do" view.
export const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'set', label: 'Set' },
  { id: 'changed', label: 'Changed' }
];

export const FILTER_IDS = FILTERS.map((f) => f.id);

// COMPUTED_PAGE — how many rows are rendered before the list asks to be
// expanded. 400 rows is 400 DOM nodes inside a scroller that also holds the
// pinned preview and two other sections; paging the list keeps the first
// paint cheap on a phone while leaving every row reachable.
export const COMPUTED_PAGE = 120;

const EMPTY = new Set();

// matchesQuery — a row matches when the text appears in its property name
// or its resolved value. Matching the value is the case that makes search
// worth having: "why is this 12px?" is answered by finding which property
// holds 12px, and matching `rgb(255, 0, 0)` finds every red thing at once.
// Case-insensitive, substring, no fuzzy matching — a partial match that
// quietly reorders results is worse than no results on a list this long.
export function matchesQuery(row, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return true;
  if (!row) return false;
  const prop = String(row.prop || '').toLowerCase();
  if (prop.indexOf(q) !== -1) return true;
  return String(row.value == null ? '' : row.value).toLowerCase().indexOf(q) !== -1;
}

// filterComputed — the rows to render, in the order they were given
// (changed-first, from stylesOrder.js).
export function filterComputed(rows, opts) {
  const options = opts || {};
  const filter = FILTER_IDS.indexOf(options.filter) === -1 ? 'all' : options.filter;
  const setNames = options.setNames || EMPTY;
  const changedNames = options.changedNames || EMPTY;
  const query = options.query;
  const out = [];
  for (const row of rows || []) {
    if (!row) continue;
    if (filter === 'set' && !setNames.has(row.prop)) continue;
    if (filter === 'changed' && !changedNames.has(row.prop)) continue;
    if (!matchesQuery(row, query)) continue;
    out.push(row);
  }
  return out;
}

// pageLimit — how many of the filtered rows to render. `showAll` comes from
// the panel's "Show all" action and is reset whenever the query or the
// filter changes, so narrowing the list never leaves a stale expanded view.
export function pageLimit(matched, showAll) {
  if (!Number.isFinite(matched) || matched <= 0) return 0;
  return showAll ? matched : Math.min(matched, COMPUTED_PAGE);
}

// emptyMessage — why the list is empty, in the user's terms. The three
// cases look identical on screen (nothing rendered) and mean three
// different things, and "nothing matches" in front of a filter the user
// forgot they set is the classic way a panel reads as broken.
export function emptyMessage(opts) {
  const options = opts || {};
  const query = String(options.query == null ? '' : options.query).trim();
  if (query) return 'No property matches “' + query + '”.';
  if (options.filter === 'changed') return 'Nothing changed yet — edited properties appear here.';
  if (options.filter === 'set') return 'Nothing set on this element yet — tap a declared row or a chip to add one.';
  return 'No computed styles for this element.';
}
