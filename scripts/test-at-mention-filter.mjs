// Regression tests for the @-mention category filter.
//
// Picking a category chip (e.g. "Tools") and then typing a query must keep
// the category applied: the popup used to ignore `activeFilter` whenever a
// query was present, so writing widened the search back to every category
// even though the chip still read as active.
import { filterAtMentionItems } from '../frontend/src/components/chat/atMention.js';

let pass = 0;
let fail = 0;
function test(name, condition, actual) {
  if (condition) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + ' :: ' + JSON.stringify(actual)); }
}

function file(p) {
  const name = p.split('/').pop();
  return { id: 'file:' + p, label: name, insert: p, category: 'files', searchText: (name + ' ' + p).toLowerCase() };
}
function tool(n) {
  return { id: 'tool:' + n, label: n, insert: n, category: 'tools', searchText: n.toLowerCase() };
}
function agent(n) {
  return { id: 'agent:' + n, label: n, insert: n, category: 'agents', searchText: (n + ' agent').toLowerCase() };
}

const items = [
  file('src/read-file.js'),
  tool('read_file'),
  tool('write_file'),
  agent('reader'),
];
const ids = (list) => list.map(i => i.id);

// At rest, no filter: each category is capped but all appear.
const rest = filterAtMentionItems(items, '', null);
test('at rest all categories are present', new Set(rest.map(i => i.category)).size === 3, ids(rest));

// Filter only, no query: full category list.
const toolsOnly = filterAtMentionItems(items, '', 'tools');
test('filter without a query shows only that category',
  toolsOnly.length === 2 && toolsOnly.every(i => i.category === 'tools'), ids(toolsOnly));

// Filter + query: the regression. `read` matches a file, a tool, and an agent.
const unfiltered = filterAtMentionItems(items, 'read', null);
test('query without a filter spans every category', unfiltered.length === 3, ids(unfiltered));

const filteredQuery = filterAtMentionItems(items, 'read', 'tools');
test('query with a filter stays inside the category',
  filteredQuery.length === 1 && filteredQuery[0].id === 'tool:read_file', ids(filteredQuery));

const filteredNoMatch = filterAtMentionItems(items, 'zzz', 'tools');
test('query with no in-category match returns empty',
  filteredNoMatch.length === 0, ids(filteredNoMatch));

// A fuzzy file match must not leak past an active non-file filter.
const fuzzyAcrossFilter = filterAtMentionItems(items, 'rfjs', 'tools');
test('fuzzy file hit is not returned under a tools filter',
  fuzzyAcrossFilter.every(i => i.category === 'tools'), ids(fuzzyAcrossFilter));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
