'use strict';

const assert = require('node:assert/strict');
const { parsePorcelainStatus } = require('../src/server-handlers-git.js');

const parsed = parsePorcelainStatus([
  '?? new file.txt',
  ' M tracked.js',
  'A  staged.js',
  'AM both.js'
].join('\0') + '\0');

assert.deepEqual(parsed.staged.map((file) => [file.path, file.status]), [
  ['staged.js', 'A'],
  ['both.js', 'A']
]);
assert.deepEqual(parsed.unstaged.map((file) => [file.path, file.status, file.statusText]), [
  ['new file.txt', '?', 'Untracked'],
  ['tracked.js', 'M', 'Modified'],
  ['both.js', 'M', 'Modified']
]);

console.log('git status parser tests passed');
