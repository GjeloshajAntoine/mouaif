// Regression tests for @-mention ranking: prefix beats substring beats
// fuzzy, highlights point at the matched label characters, and fuzzy-only
// file hits never bury a real match of another type.
import { rankAtMentionItems, scoreAtMentionItem } from '../frontend/src/components/chat/atMention.js';

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

const items = [
  file('docs/features/at-mention.md'),
  file('frontend/src/components/chat/atMention.js'),
  file('src/chat-mention-helper.js'),
  file('src/tags.js'),
  tool('read_file'),
];

const ids = (list) => list.map(i => i.id);

const prefix = rankAtMentionItems(items, 'atm');
test('name prefix ranks first', prefix[0] && prefix[0].id === 'file:frontend/src/components/chat/atMention.js', ids(prefix));
test('prefix hit highlights the first characters', prefix[0] && prefix[0].hits.join(',') === '0,1,2', prefix[0]);

const sub = rankAtMentionItems(items, 'mention');
test('word-start matches rank, shortest name first',
  sub[0] && sub[0].id === 'file:frontend/src/components/chat/atMention.js', ids(sub));
test('all three mention files match', sub.length === 3, ids(sub));

const fuzzy = rankAtMentionItems(items, 'atmjs');
test('fuzzy subsequence finds atMention.js', fuzzy[0] && fuzzy[0].id === 'file:frontend/src/components/chat/atMention.js', ids(fuzzy));
test('fuzzy result is flagged', fuzzy[0] && fuzzy[0].fuzzy === true, fuzzy[0]);

const path = rankAtMentionItems(items, 'docs/feat');
test('path prefix matches a folder query', path.length === 1 && path[0].id === 'file:docs/features/at-mention.md', ids(path));

test('no match returns null', scoreAtMentionItem(items[3], 'zzz') === null);
test('exact name beats a prefix of the same query',
  scoreAtMentionItem(items[4], 'read_file').score > scoreAtMentionItem(tool('read_file_range'), 'read_file').score, null);

const stable = rankAtMentionItems([file('a/x.js'), file('b/x.js')], 'x.js');
test('ties keep catalog order', stable[0].id === 'file:a/x.js' && stable[1].id === 'file:b/x.js', ids(stable));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
