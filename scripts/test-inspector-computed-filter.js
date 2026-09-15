'use strict';
// Test for the Inspector Styles panel computed-list filtering.
//
// The Computed list is every property the browser resolves for an element —
// ~400 rows on a typical page — and it is rendered in a scroller that also
// holds a pinned preview and two other sections. This test locks in the
// three behaviours that make it usable instead of a wall:
//
//   * the search matches property names AND resolved values, because "which
//     property holds 12px?" and "what is making this red?" are the questions
//     the field exists to answer;
//   * the three filters mean three different things (all / set = declared
//     here / changed = edited here), so the empty state cannot be a single
//     message that reads like the panel is broken;
//   * the render cap is released on demand and never hides the count.
//
// computedFilter.js is pure, so all of it is assertable here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/computedFilter.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const context = vm.createContext({});
vm.runInContext(source, context);
const { filterComputed, matchesQuery, pageLimit, moreRows, pageEnd, moreAfter, familyOf, emptyMessage, statusLine } = context;
// `FILTERS`, `FILTER_IDS`, and `COMPUTED_PAGE` are top-level `const`s, which a
// vm script binds lexically rather than exposing as context properties.
const FILTERS = vm.runInContext('FILTERS', context);
const FILTER_IDS = vm.runInContext('FILTER_IDS', context);
const COMPUTED_PAGE = vm.runInContext('COMPUTED_PAGE', context);

// The module runs in its own realm, so arrays it returns have that realm's
// prototype and would fail deepStrictEqual against a host literal.
const arr = (x) => Array.from(x);
const props = (rows) => arr(rows).map((r) => r.prop);

const ROWS = [
  { prop: 'color', value: 'rgb(255, 0, 0)' },
  { prop: 'font-size', value: '12px' },
  { prop: 'margin-top', value: '0px' },
  { prop: 'padding', value: '10px' },
  { prop: '-webkit-text-fill-color', value: 'rgb(255, 0, 0)' },
  { prop: 'z-index', value: 'auto' }
];

function main() {
  // --- the filter options are the documented three --------------------
  assert.deepStrictEqual(arr(FILTERS).map((f) => f.id), ['all', 'set', 'changed'],
    'the segmented control offers all / set / changed in that order');
  assert.deepStrictEqual(arr(FILTERS).map((f) => f.label), ['All', 'Declared', 'Changed'],
  'the labels name what each filter keeps: everything, what this element declares, what you changed');
assert.ok(arr(FILTERS).every((f) => typeof f.hint === 'string' && f.hint.length > 10),
  'every filter carries a sentence for its title / accessible name');
  assert.deepStrictEqual(arr(FILTER_IDS), ['all', 'set', 'changed']);
  assert.ok(COMPUTED_PAGE > 0 && COMPUTED_PAGE <= 100,
    'a page is large enough to scan and small enough to keep the scroll bounded');

  // --- query matching -------------------------------------------------
  assert.strictEqual(matchesQuery(ROWS[0], ''), true, 'an empty query matches everything');
  assert.strictEqual(matchesQuery(ROWS[0], '   '), true, 'a whitespace-only query matches everything');
  assert.strictEqual(matchesQuery(ROWS[0], 'COLOR'), true, 'matching is case-insensitive');
  assert.strictEqual(matchesQuery(ROWS[0], 'col'), true, 'matching is a substring match on the name');
  assert.strictEqual(matchesQuery(ROWS[0], '255, 0, 0'), true, 'the resolved value is searched too');
  assert.strictEqual(matchesQuery(ROWS[1], '12px'), true, 'a value-only match is kept — "what is 12px?" is the point');
  assert.strictEqual(matchesQuery(ROWS[5], 'disp'), false, 'a non-match is excluded');
  assert.strictEqual(matchesQuery(null, 'x'), false, 'a missing row never matches');

  // --- filters --------------------------------------------------------
  const setNames = new Set(['padding', 'color']);
  const changedNames = new Set(['padding']);
  assert.deepStrictEqual(props(filterComputed(ROWS, { filter: 'all' })),
    ['color', 'font-size', 'margin-top', 'padding', '-webkit-text-fill-color', 'z-index'],
    'the all filter keeps every row, in the order it was given (changed-first hoisting is upstream)');
  assert.deepStrictEqual(props(filterComputed(ROWS, { filter: 'set', setNames })),
    ['color', 'padding'],
    'the set filter keeps only properties this element declares itself');
  assert.deepStrictEqual(props(filterComputed(ROWS, { filter: 'changed', changedNames })),
    ['padding'],
    'the changed filter keeps only properties edited in this session');
  assert.deepStrictEqual(props(filterComputed(ROWS, { filter: 'set' })),
    [],
    'the set filter with no declared properties yields nothing rather than everything');
  assert.deepStrictEqual(props(filterComputed(ROWS, { filter: 'nonsense' })),
    props(filterComputed(ROWS, { filter: 'all' })),
    'an unknown filter id falls back to all instead of rendering an empty list');

  // --- filter and query compose (AND) ---------------------------------
  assert.deepStrictEqual(props(filterComputed(ROWS, { filter: 'set', setNames, query: 'pad' })),
    ['padding'], 'the query narrows the filter, it does not replace it');
  assert.deepStrictEqual(props(filterComputed(ROWS, { filter: 'set', setNames, query: 'color' })),
    ['color'], 'a name match inside the filter is kept');
  assert.deepStrictEqual(props(filterComputed(ROWS, { filter: 'changed', changedNames, query: '12px' })),
    [], 'a value match outside the filter is excluded');

  // --- degenerate inputs ----------------------------------------------
  assert.deepStrictEqual(arr(filterComputed(null, {})), [], 'no rows yields no rows');
  assert.deepStrictEqual(arr(filterComputed([null, ROWS[0]], {})).map((r) => r.prop), ['color'],
    'a hole in the row list is skipped, not rendered as a blank row');
  assert.deepStrictEqual(props(filterComputed(ROWS, {})), props(filterComputed(ROWS, { filter: 'all' })),
    'no options at all behaves like the default view');

  // --- paging is additive, never all-or-nothing -----------------------
  // A single "show all" control that reveals 406 rows at once defeats the
  // point of paging: on a phone that is ~11 000 px of rows in a 352 px
  // scroller. Each step adds one page, so the length stays bounded.
  assert.strictEqual(pageLimit(400, 0), COMPUTED_PAGE, 'the first page renders one page of rows');
  assert.strictEqual(pageLimit(400, 1), COMPUTED_PAGE * 2, 'a step adds exactly one more page');
  assert.strictEqual(pageLimit(400, 5), COMPUTED_PAGE * 6, 'steps accumulate by page');
  assert.strictEqual(pageLimit(400, 100), 400, 'paging clamps at the total — never past the end');
  assert.strictEqual(pageLimit(12, 0), 12, 'a short list is never padded or capped below its length');
  assert.strictEqual(pageLimit(12, 3), 12, 'a short list is unchanged by further steps');
  assert.strictEqual(pageLimit(0, 0), 0, 'an empty list pages to nothing');
  assert.strictEqual(pageLimit(undefined, 0), 0, 'a missing count pages to nothing');
  assert.strictEqual(pageLimit(400, -2), COMPUTED_PAGE, 'a negative step count is treated as the first page');
  assert.strictEqual(pageLimit(400, 'x'), COMPUTED_PAGE, 'a non-numeric step count is treated as the first page');

  // moreRows drives the button label, so it must never promise rows that
  // do not exist — the last step would otherwise offer a full page.
  assert.strictEqual(moreRows(400, 0), 340, 'the first page reports the remaining rows');
  assert.strictEqual(moreRows(400, 5), 40, 'the last partial step reports only what is left');
  assert.strictEqual(moreRows(400, 6), 0, 'a fully shown list reports nothing more');
  assert.strictEqual(moreRows(12, 0), 0, 'a list shorter than a page reports nothing more');
  assert.strictEqual(moreRows(0, 0), 0, 'an empty list reports nothing more');
  assert.strictEqual(pageLimit(400, 0) + moreRows(400, 0), 400, 'the page and the remainder always add up to the total');

  // --- the page cut respects a property family -------------------------
  //
  // The bug this exists for: the list is alphabetical, and `background-image`
  // sorts immediately after `background-color`. On a real element that put it at
  // index 60 — the first row of page two — so the gradient the element rendered
  // was invisible on the first page while `background-attachment`,
  // `background-blend-mode` and `background-clip` all showed, and the list read
  // as though it had no `background-image` at all.
  assert.strictEqual(familyOf('background-image'), 'background', 'a dashed name pages as its first segment');
  assert.strictEqual(familyOf('background'), 'background', 'an undashed name is its own family');
  assert.strictEqual(familyOf('color'), 'color', 'a family is not a prefix of another name: color is not column');
  assert.strictEqual(familyOf('column-gap'), 'column', 'each dashed name is judged on its own first segment');
  assert.strictEqual(familyOf('  Background-Image  '), 'background', 'family matching is case- and space-insensitive');
  assert.strictEqual(familyOf(''), '', 'a nameless row has no family');

  // A list whose 60th row (`background-color`) starts a family that continues
  // past the nominal cut. `pageEnd` extends to finish it.
  const runAt = (n, before) => []
    .concat(Array.from({ length: before }, (_, i) => ({ prop: 'aaa' + i })))
    .concat(Array.from({ length: n }, (_, i) => ({ prop: 'background-' + i })));
  const cutList = runAt(6, COMPUTED_PAGE - 1);
  assert.strictEqual(pageLimit(cutList.length, 0), COMPUTED_PAGE,
    'the nominal page is still one page of rows');
  assert.strictEqual(pageEnd(cutList, 0), COMPUTED_PAGE + 5,
    'the cut moves past the nominal page to finish the family it landed inside');
  assert.strictEqual(cutList[pageEnd(cutList, 0) - 1].prop, 'background-5',
    'the last rendered row is the last row of that family');
  assert.strictEqual(moreAfter(cutList, 0), 0,
    'nothing is left over when the extension consumed the rest of the list');
  assert.ok(moreAfter(cutList, 0) === cutList.length - pageEnd(cutList, 0),
    'the remainder is measured from the cut that was actually taken, not the nominal page');

  // A cut that already lands on a family boundary is left exactly where it was:
  // the extension must not make every page a different length.
  const cleanCut = Array.from({ length: 200 }, (_, i) => ({ prop: 'p' + String(i).padStart(3, '0') }));
  assert.strictEqual(pageEnd(cleanCut, 0), COMPUTED_PAGE,
    'a cut already between families is not moved');
  assert.strictEqual(moreAfter(cleanCut, 0), 200 - COMPUTED_PAGE,
    'a list with no family spanning the cut reports the plain remainder');

  // A pathologically long family is bounded, because a page that can grow
  // without limit is not a page.
  const hugeRun = runAt(400, 0);
  assert.ok(pageEnd(hugeRun, 0) <= COMPUTED_PAGE + 24,
    'the extension is capped, so one enormous family cannot drag the page open');

  // Edge cases: a short list and an empty one are never padded past their end.
  assert.strictEqual(pageEnd(cleanCut.slice(0, 10), 0), 10, 'a list shorter than a page renders whole');
  assert.strictEqual(pageEnd([], 0), 0, 'an empty list renders nothing');
  assert.strictEqual(pageEnd(null, 0), 0, 'a missing list renders nothing');
  assert.strictEqual(moreAfter([], 0), 0, 'an empty list has nothing more');
  assert.strictEqual(moreAfter(null, 0), 0, 'a missing list has nothing more');
  assert.strictEqual(pageEnd(cleanCut, 5), 200, 'the extension never pushes past the end of the list');

  // --- empty-state copy -----------------------------------------------
  assert.match(emptyMessage({ filter: 'changed' }), /Nothing changed yet/,
    'the changed filter explains itself rather than looking broken');
  assert.match(emptyMessage({ filter: 'set' }), /Nothing set on this element yet/,
    'the set filter explains itself');
  assert.match(emptyMessage({ query: 'zzz' }), /zzz/,
    'a query with no matches names the query back to the user');
  assert.match(emptyMessage({ query: 'zzz', filter: 'set' }), /zzz/,
    'the query is named even when a filter is also active');
  assert.match(emptyMessage({}), /No computed styles/,
    'the default empty state is about the element, not about a filter');

  // --- status line ----------------------------------------------------
  // The bar says what the list below holds, in words. The count alone cannot
  // distinguish "2 of 406 because you typed a search" from "2 of 406 because
  // the panel broke", which is the failure this line exists to prevent.
  assert.match(statusLine({ filter: 'all', shown: 406, total: 406 }),
  /all resolved/, 'the default status names the filter in force');
  assert.match(statusLine({ filter: 'set', shown: 12, total: 406 }),
  /Showing 12 of 406 · declared here/, 'the declared filter is spelled out');
  assert.match(statusLine({ filter: 'changed', shown: 3, total: 406 }),
  /you changed here/, 'the changed filter is spelled out');
  assert.match(statusLine({ filter: 'all', shown: 2, total: 406, query: 'px' }),
  /2 of 406 match “px”/, 'a search is named with the count it produced');
  assert.strictEqual(statusLine({ filter: 'nonsense', shown: -1, total: 'x' }),
  'Showing 0 of 0 · all resolved', 'an unknown filter and junk counts fall back safely');
  assert.ok(statusLine({ filter: 'all', shown: 406, total: 406 }).indexOf('\n') === -1,
  'the status line is one line');
  // --- the panel actually wires the filter in --------------------------
  // Guards against the module being orphaned: the matching rules are
  // worthless if the render path stops calling them, and the render cap is
  // only honest if the count in the bar is the unfiltered total.
  const panel = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/StylesPanel.jsx'), 'utf8');
  assert.ok(/import \{[^}]*filterComputed[^}]*\} from '\.\/computedFilter\.js'/.test(panel),
  'StylesPanel imports the computed filter');
  assert.ok(/import \{[^}]*statusLine[^}]*\} from '\.\/computedFilter\.js'/.test(panel),
  'StylesPanel imports the status line');
  assert.ok(/statusLine\(\{/.test(panel),
  'the status line is rendered from the live filter, count and query');
  assert.ok(/filterComputed\(orderedComputed, \{/.test(panel),
    'the computed list is filtered after it is ordered, so changed rows still lead');
  assert.ok(/pageEnd\(computedVisible, computedSteps\)/.test(panel),
    'the render cap is applied to the filtered list, cut on a family boundary');
  assert.ok(/moreAfter\(computedVisible, computedSteps\)/.test(panel),
    'the "show more" label is derived from the remaining rows, not the total');
  assert.ok(/setComputedSteps\(computedSteps \+ 1\)/.test(panel),
    'the control pages forward one step at a time rather than revealing everything');
  assert.ok(/onScroll: onPanelScroll/.test(panel),
    'the panel scroller pages the computed list in as the user reads to its end');
  assert.ok(/computedMoreRef\.current <= 0\) return;/.test(panel),
    'the scroll handler costs nothing once the list is fully shown');
  assert.ok(/computedPage\.map/.test(panel),
    'the list renders the paged rows, not the whole filtered set');
  assert.ok(/emptyMessage\(\{ query: computedQuery, filter: computedFilter \}\)/.test(panel),
    'the empty state is the filter-aware message');
  assert.ok(/computedVisible\.length \+ '\/' \+ computedRows\.length/.test(panel),
    'the bar shows how many of the total are visible');
  assert.ok(/setNames = new Set\(inlineRows\.map/.test(panel),
    'the set filter is fed from the element\'s own declared properties');
  assert.ok(/changedNames = new Set\(changed\)/.test(panel),
    'the changed filter is fed from the session edit set');
  assert.ok(/setComputedQueryState/.test(panel) && /steps: 0/.test(panel),
    'changing the query or the filter resets paging in the same update');

  console.log('PASS inspector computed filter (search, all/declared/changed, status line, paging, empty-state copy)');
}

main();
