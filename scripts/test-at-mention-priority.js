'use strict';

// Regression test for composer @-mention ordering. File matches must stay
// ahead of every other result type without disturbing order within groups.
let pass = 0;
let fail = 0;

function t(name, condition, actual) {
  if (condition) {
    pass++;
    console.log('  ok  - ' + name);
  } else {
    fail++;
    console.log('  FAIL- ' + name + ' :: ' + JSON.stringify(actual));
  }
}

async function run() {
  const { findExactCustomAction, prioritizeAtMentionFiles } = await import(
'../frontend/src/components/chat/atMention.js'
);

  const rankedMatches = [
    { id: 'tool:read_file', category: 'tools' },
    { id: 'file:src/read-file.js', category: 'files' },
    { id: 'agent:reviewer', category: 'agents' },
    { id: 'file:docs/read-file.md', category: 'files' },
    { id: 'model:current', category: 'model' }
  ];
  const result = prioritizeAtMentionFiles(rankedMatches);
  const ids = result.map(item => item.id);

  t('all file matches come before non-file matches',
    ids.join(',') === [
      'file:src/read-file.js',
      'file:docs/read-file.md',
      'tool:read_file',
      'agent:reviewer',
      'model:current'
    ].join(','), ids);
  t('relative ranking stays stable within both groups',
result[0] === rankedMatches[1] &&
result[1] === rankedMatches[3] &&
result[2] === rankedMatches[0] &&
result[3] === rankedMatches[2] &&
result[4] === rankedMatches[4], ids);
const action = { id: 'test', label: 'Run tests' };
const actions = [action];
t('exact action id bypasses a higher-ranked file suggestion',
findExactCustomAction('@test', actions) === action,
findExactCustomAction('@test', actions));
t('partial action ids still select from autocomplete',
findExactCustomAction('@tes', actions) === null,
findExactCustomAction('@tes', actions));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
