// Verifies the Git modal reducer (frontend/src/components/chat/gitModalState.js).
//
// The modal used to reload by blanking its body, which collapsed every open
// diff and section and wiped the success notice. These checks pin the
// replacement behaviour: a refresh keeps content, notices survive the
// reload, stale "Load more" pages are dropped, and section toggles persist.
import fs from 'node:fs';
import assert from 'node:assert/strict';

// Same data: URL load as scripts/test-git-count-format.mjs, so node does not
// warn about the CJS-typed package.
const source = fs.readFileSync(new URL('../frontend/src/components/chat/gitModalState.js', import.meta.url), 'utf8');
const m = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const { gitReducer: reduce, initialGitState: init, sectionOpen, hasMoreCommits, pathsFor, branchOptions, successText, failureText } = m;

const commits = (from, n) => Array.from({ length: n }, (_, i) => ({ hash: 'h' + (from + i), short: 's' + (from + i), subject: 'c' + (from + i) }));
const info = (extra) => Object.assign({ ok: true, branch: 'main', branches: ['main'], staged: [], unstaged: [], stashes: [], commits: commits(0, 20) }, extra);

// First load: loading -> ready.
let s = reduce(init, { type: 'load-start' });
assert.equal(s.status, 'loading');
s = reduce(s, { type: 'load-ok', data: info({ unstaged: [{ path: 'a.js' }] }) });
assert.equal(s.status, 'ready');
assert.equal(s.generation, 1);
assert.equal(s.commits.length, 20);

// Untouched sections follow content; a toggle sticks across reloads.
assert.equal(sectionOpen(s, 'unstaged'), true);
assert.equal(sectionOpen(s, 'staged'), false);
assert.equal(sectionOpen(s, 'commits'), false);
s = reduce(s, { type: 'toggle-section', id: 'unstaged' });
assert.equal(sectionOpen(s, 'unstaged'), false);

// A refresh keeps the body (status stays ready) and only flags refreshing.
s = reduce(s, { type: 'load-start' });
assert.equal(s.status, 'ready');
assert.equal(s.refreshing, true);
s = reduce(s, { type: 'load-ok', data: info({ unstaged: [{ path: 'a.js' }, { path: 'b.js' }] }) });
assert.equal(s.refreshing, false);
assert.equal(sectionOpen(s, 'unstaged'), false, 'user toggle survives reload');

// Action lifecycle: busy clears the old notice; done sets the new one after
// the reload, and clears the commit message on a commit.
s = reduce(s, { type: 'message', value: 'msg' });
s = reduce(s, { type: 'notice', notice: { text: 'old', tone: 'ok' } });
s = reduce(s, { type: 'busy', action: 'commit' });
assert.equal(s.busy, 'commit');
assert.equal(s.notice, null);
s = reduce(s, { type: 'load-start' });
s = reduce(s, { type: 'load-ok', data: info() });
assert.equal(s.busy, 'commit', 'busy spans the follow-up reload');
s = reduce(s, { type: 'done', clearMessage: true, notice: { text: successText('commit'), tone: 'ok' } });
assert.equal(s.busy, '');
assert.equal(s.commitMessage, '');
assert.deepEqual(s.notice, { text: 'Committed', tone: 'ok' });

// Confirm sheets: cannot be opened or cancelled while busy; done closes it.
s = reduce(s, { type: 'confirm', confirm: { kind: 'stash-drop', stash: { index: 'stash@{0}' } } });
assert.equal(s.confirm.kind, 'stash-drop');
s = reduce(s, { type: 'busy', action: 'stash-drop' });
assert.equal(reduce(s, { type: 'cancel-confirm' }).confirm.kind, 'stash-drop');
s = reduce(s, { type: 'done', notice: null });
assert.equal(s.confirm, null);

// Load more: appends the page, dedupes, and drops a page from an old generation.
const gen = s.generation;
s = reduce(s, { type: 'more-start' });
s = reduce(s, { type: 'more-ok', generation: gen, commits: commits(19, 21), total: 40 });
assert.equal(s.commits.length, 40, 'duplicate h19 dropped');
assert.equal(hasMoreCommits(s), false);
s = reduce(s, { type: 'load-ok', data: info() });
const stale = reduce(s, { type: 'more-ok', generation: gen, commits: commits(20, 20), total: 40 });
assert.equal(stale, s, 'stale page ignored');
assert.equal(hasMoreCommits(s), true, 'unknown total with a full page');
s = reduce(s, { type: 'more-error', generation: s.generation, error: 'boom' });
assert.equal(s.moreError, 'boom');

// A failed refresh keeps content; a failed first load shows the error.
const failedRefresh = reduce(reduce(s, { type: 'load-start' }), { type: 'load-error', error: 'offline' });
assert.equal(failedRefresh.status, 'ready');
assert.deepEqual(failedRefresh.notice, { text: 'offline', tone: 'error' });
const failedFirst = reduce(reduce(init, { type: 'load-start' }), { type: 'load-error', error: 'Not a git repository' });
assert.equal(failedFirst.status, 'error');

// Helpers.
assert.deepEqual(pathsFor({ path: 'old -> new', paths: ['old', 'new'] }), ['old', 'new']);
assert.deepEqual(pathsFor({ path: 'plain.js' }), ['plain.js']);
assert.deepEqual(branchOptions({ branches: ['main'], remoteBranches: ['origin/x'] }), [
  { name: 'main', remote: false },
  { name: 'origin/x', remote: true }
]);
assert.equal(failureText('pull', { stderr: '  ' }), 'git pull failed');
assert.equal(failureText('pull', { stderr: 'fatal: no remote' }), 'fatal: no remote');
assert.equal(successText('add'), '');

console.log('test-git-modal-state: OK');
