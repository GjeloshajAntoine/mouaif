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
const { filterComputed, matchesQuery, pageLimit, moreRows, emptyMessage, statusLine } = context;
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
  assert.ok(/pageLimit\(computedVisible\.length, computedSteps\)/.test(panel),
    'the render cap is applied to the filtered list');
  assert.ok(/moreRows\(computedVisible\.length, computedSteps\)/.test(panel),
    'the "show more" label is derived from the remaining rows, not the total');
  assert.ok(/setComputedSteps\(computedSteps \+ 1\)/.test(panel),
    'the control pages forward one step at a time rather than revealing everything');
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
