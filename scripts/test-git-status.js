'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { parsePorcelainStatus, parseBranchRefs, parseStashList, STASH_FORMAT } = require('../src/server-handlers-git.js');

const parsed = parsePorcelainStatus([
  '?? new file.txt',
  ' M tracked.js',
  'A  staged.js',
  'AM both.js'
].join('\0') + '\0');

assert.deepEqual(parsed.staged.map((file) => [file.path, file.status, file.statusText]), [
  ['staged.js', 'A', 'Added'],
  ['both.js', 'A', 'Added']
]);
assert.deepEqual(parsed.unstaged.map((file) => [file.path, file.status, file.statusText]), [
  ['new file.txt', '?', 'Untracked'],
  ['tracked.js', 'M', 'Modified'],
  ['both.js', 'M', 'Modified']
]);
assert.deepEqual(parsed.unstaged[0].paths, ['new file.txt']);

// With -z a rename is `XY <new>\0<old>\0`: the new path comes first.
const renamed = parsePorcelainStatus('RM new name.js\0old name.js\0 M after.js\0');
assert.deepEqual(renamed.staged.map((f) => [f.path, f.paths, f.statusText]), [
  ['old name.js -> new name.js', ['old name.js', 'new name.js'], 'Renamed']
]);
assert.deepEqual(renamed.unstaged.map((f) => [f.path, f.paths, f.statusText]), [
  ['new name.js', ['new name.js'], 'Modified'],
  ['after.js', ['after.js'], 'Modified']
]);

const refs = parseBranchRefs([
  'refs/heads/main',
  'refs/heads/feature/x',
  'refs/remotes/origin/HEAD',
  'refs/remotes/origin/main',
  'refs/remotes/origin/only-remote',
  'refs/remotes/upstream/feature/x',
  ''
].join('\n'));
assert.deepEqual(refs.branches, ['main', 'feature/x']);
assert.deepEqual(refs.remoteBranches, ['origin/only-remote']);

// Stash list against a real repo: two stashes, correct refs, no run-together.
const repo = mkdtempSync(join(tmpdir(), 'mouaif-git-stash-'));
try {
  const git = (...args) => execFileSync('git', ['-C', repo].concat(args), { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  writeFileSync(join(repo, 'a.txt'), 'b\n');
  git('stash', 'push', '-q', '-m', 'first stash');
  writeFileSync(join(repo, 'a.txt'), 'c\n');
  git('stash', 'push', '-q', '-m', 'second stash');
  const stashes = parseStashList(git('stash', 'list', '--format=' + STASH_FORMAT));
  assert.deepEqual(stashes.map((s) => s.index), ['stash@{0}', 'stash@{1}']);
  assert.match(stashes[0].subject, /: second stash$/);
  assert.match(stashes[1].subject, /: first stash$/);
  assert.ok(stashes.every((s) => s.date && !s.date.includes('\n')));
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log('git status parser tests passed');
