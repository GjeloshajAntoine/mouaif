'use strict';

// Git REST handlers. Extracted from the original single-file
// http-server.js. Shared helpers live in src/server-shared.js.

const { spawn } = require('node:child_process');
const { sendJSON, readJsonOr400, xyToText } = require('./server-shared.js');

// ---- Git API ----------------------------------------------------------------
//
// Lightweight git operations run directly against the project directory.
// Routes:
//   POST /api/git  body: { projectDir, action, args?, files?, message?, track? }
//     -> { ok, stdout, stderr, exitCode }
//
// Supported actions: status, diff, log, add, unstage, commit, branch, checkout,
// stash, stash-apply, stash-pop, stash-drop, push, pull, cherry-pick, revert
// These are read-safe or explicit-save commands. `commit` requires a
// `message`; `add` / `unstage` take a `files` array. `push` and `pull` talk
// to the configured remote (2 min timeout, allow-listed flags only).
// `checkout`, `cherry-pick` and `revert` take a single ref in `args` that may
// not start with `-`; the stash actions take a `stash@{N}` ref. Options that
// run programs or write files (`--upload-pack`, `--output`, …) are refused.
async function handleGit(req, res, parsed) {
  const body = await readJsonOr400(req, res);
  if (!body) return;
  const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
const action = body && typeof body.action === 'string' ? body.action : '';
const args = body && typeof body.args === 'string' ? body.args : '';
const message = body && typeof body.message === 'string' ? body.message : '';
// `files` is an array of paths to operate on (used by stage/unstage). It is
// an alternative to the string `args` form: when present, each path is passed
// to git as a single argv element, so file names containing spaces survive
// intact. No shell is involved either way — paths never go through a string
// split, so spaces, quotes, and leading dashes are safe.
const files = Array.isArray(body && body.files) ? body.files.filter((p) => typeof p === 'string' && p.length > 0) : [];
if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
if (!action) return sendJSON(res, 400, { error: 'action is required' });
// These are read-safe or explicit-save commands. `cherry-pick` and `revert`
// are explicit-save operations that create new commits (and can conflict);
// the frontend confirms before it calls them. `revert` passes `--no-edit` so
// it never blocks on the commit-message editor in the non-TTY child.
const SAFE_ACTIONS = new Set(['status', 'diff', 'log', 'add', 'unstage', 'commit', 'branch', 'checkout', 'stash', 'stash-apply', 'stash-pop', 'stash-drop', 'push', 'pull', 'cherry-pick', 'revert']);
  if (!SAFE_ACTIONS.has(action)) {
    return sendJSON(res, 400, { error: 'unsupported action: ' + action, supported: [...SAFE_ACTIONS] });
  }

  // Build an argv array (never a string + split) so values containing
  // spaces — commit messages in particular — reach git as single
  // arguments instead of being shattered into separate tokens.
  const splitArgs = (s) => (s ? s.trim().split(/\s+/).filter(Boolean) : []);
  // Free-form `args` must never smuggle in an option that runs a program or
  // writes a file (`pull --upload-pack=<cmd>`, `diff --output=<file>`).
  let tokens;
  try {
    tokens = checkArgs(action, splitArgs(args));
  } catch (err) {
    return sendJSON(res, 400, { error: err.message });
  }
  let argv;
  switch (action) {
    case 'status':
      argv = ['status', '--short', '--branch'];
      break;
    case 'diff':
      argv = ['diff'].concat(tokens.length ? tokens : ['--stat']);
      break;
    case 'log':
      argv = ['log', '--oneline', '-20'].concat(tokens);
      break;
    case 'add':
      if (files.length === 0) {
        if (!tokens.length) return sendJSON(res, 400, { error: 'files (array of paths) required for add' });
        argv = ['add'].concat(tokens);
      } else {
        argv = ['add', '--'].concat(files);
      }
      break;
    case 'unstage':
      if (files.length === 0) {
        if (!tokens.length) return sendJSON(res, 400, { error: 'files (array of paths) required for unstage' });
        argv = ['reset', '-q', 'HEAD', '--'].concat(tokens);
      } else {
        argv = ['reset', '-q', 'HEAD', '--'].concat(files);
      }
      break;
    case 'commit':
      if (!message) return sendJSON(res, 400, { error: 'message required for commit' });
      argv = ['commit', '-m', message];
      break;
    case 'branch':
      argv = ['branch'].concat(tokens);
      break;
    case 'checkout': {
      const ref = refArg(args);
      if (!ref) return sendJSON(res, 400, { error: 'args (branch name or commit) required for checkout' });
      // `track: true` checks out a remote branch (`origin/feature`) as a new
      // local tracking branch instead of a detached HEAD. The trailing `--`
      // pins the ref as a revision, never a path.
      argv = body.track === true ? ['checkout', '--track', ref, '--'] : ['checkout', ref, '--'];
      break;
    }
    case 'stash':
      argv = ['stash'].concat(tokens);
      break;
    case 'stash-apply':
    case 'stash-pop':
    case 'stash-drop': {
      const ref = args ? stashRef(args) : '';
      if (args && !ref) return sendJSON(res, 400, { error: 'args must be a stash ref like stash@{0}' });
      argv = ['stash', action.slice('stash-'.length)].concat(ref ? [ref] : []);
      break;
    }
    case 'push':
      argv = ['push'].concat(tokens);
      break;
    case 'pull':
      argv = ['pull'].concat(tokens);
      break;
    case 'cherry-pick':
    case 'revert': {
      const ref = refArg(args);
      if (!ref) return sendJSON(res, 400, { error: 'args (commit hash) required for ' + action });
      argv = action === 'revert' ? ['revert', '--no-edit', ref] : ['cherry-pick', ref];
      break;
    }
    default:
      return sendJSON(res, 400, { error: 'unsupported action' });
  }

  // push / pull wait on the network; everything else is local and quick.
  const timeout = action === 'push' || action === 'pull' ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS;
  const r = await runGitCommand(projectDir, argv, { timeout });
  if (r.error) {
    return sendJSON(res, 500, { ok: false, error: r.error, stdout: r.stdout.trim(), stderr: r.stderr.trim(), exitCode: -1 });
  }
  let stderr = r.stderr.trim();
  if (r.timedOut) stderr = (stderr ? stderr + '\n' : '') + 'git ' + action + ' timed out after ' + Math.round(timeout / 1000) + ' s';
  return sendJSON(res, 200, { ok: r.exitCode === 0, stdout: r.stdout.trim(), stderr, exitCode: r.exitCode });
}

const LOCAL_TIMEOUT_MS = 15000;
const NETWORK_TIMEOUT_MS = 120000;

// Spawn one git command in `projectDir` and collect its output. Never a
// shell: `argv` reaches git verbatim. Resolves (never rejects) with
// { ok, exitCode, stdout, stderr, timedOut, error? }.
function runGitCommand(projectDir, argv, opts) {
  const timeout = (opts && opts.timeout) || LOCAL_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', ['-C', projectDir].concat(argv), {
        cwd: projectDir,
        timeout,
        env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
        windowsHide: true
      });
    } catch (err) {
      resolve({ ok: false, exitCode: -1, stdout: '', stderr: '', timedOut: false, error: err.message });
      return;
    }
    let stdout = '', stderr = '';
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ ok: false, exitCode: -1, stdout, stderr, timedOut: false, error: err.message }));
    child.on('close', (code, signal) => finish({
      ok: code === 0,
      exitCode: code === null ? -1 : code,
      stdout,
      stderr,
      timedOut: code === null && signal === 'SIGTERM'
    }));
  });
}

// Options that make git run another program or write outside its normal
// output. Refused in every free-form `args` string.
const DANGEROUS_OPTION = /^--?(output|ext-diff|textconv|upload-pack|receive-pack|exec|config|git-dir|work-tree|namespace|open-files-in-pager|run|command)(=|$)/i;
// push / pull accept only these flags (plus bare remote / refspec tokens).
const NETWORK_FLAGS = new Set([
  '-u', '--set-upstream', '--tags', '--follow-tags', '--force-with-lease',
  '--rebase', '--no-rebase', '--ff-only', '--ff', '--no-ff', '--autostash', '--prune'
]);

function checkArgs(action, tokens) {
  for (const t of tokens) {
    if (DANGEROUS_OPTION.test(t)) throw new Error('option not allowed: ' + t);
    if ((action === 'push' || action === 'pull') && t.startsWith('-') && !NETWORK_FLAGS.has(t)) {
      throw new Error('option not allowed for ' + action + ': ' + t);
    }
  }
  return tokens;
}

// A single ref-like token (branch, remote branch, sha) that git cannot read
// as an option. Returns '' when the value is empty, has whitespace, or starts
// with '-'.
function refArg(value) {
  const ref = String(value || '').trim();
  if (!ref || /\s/.test(ref) || ref.startsWith('-')) return '';
  return ref;
}

function stashRef(value) {
  const ref = String(value || '').trim();
  return /^stash@\{\d+\}$/.test(ref) ? ref : '';
}

// Parse `git status --porcelain=v1 -z` into the two working-tree sections.
// Untracked entries use `??`; they belong in the unstaged section even though
// their worktree status character is `?` rather than a tracked-file status.
//
// A rename/copy record is `XY <new>\0<old>\0` — with `-z` git prints the
// *new* path first and the original second (the reverse of the human
// `old -> new` form). Each entry carries:
//   path   display text, `old -> new` for a rename
//   paths  the exact pathspecs a stage/unstage of this row must pass to git.
//          A staged rename needs both sides (`git reset -- old new` restores
//          the delete + untracked pair; resetting one side leaves half of it
//          staged). The unstaged half of `RM` is the edit to the new file, so
//          it only needs the new path.
function parsePorcelainStatus(stdout) {
  const records = String(stdout || '').split('\0').filter((s) => s.length > 0);
  const staged = [];
  const unstaged = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const xy = rec.slice(0, 2);
    const target = rec.slice(3);
    let orig = '';
    if (xy[0] === 'R' || xy[0] === 'C') {
      if (records[i + 1] !== undefined) {
        orig = records[i + 1];
        i++;
      }
    }
    // Each section describes its own half of XY: `AM` is "Added" in staged
    // and "Modified" in unstaged.
    if (xy[0] !== ' ' && xy[0] !== '?') {
    staged.push({
      path: orig ? orig + ' -> ' + target : target,
      paths: orig ? [orig, target] : [target],
      status: xy[0],
      statusText: xyToText(xy[0] + ' '),
      diff: ''
    });
    }
    if (xy[1] !== ' ') {
    unstaged.push({ path: target, paths: [target], status: xy[1], statusText: xyToText(' ' + xy[1]), diff: '' });
    }
  }
  return { staged, unstaged };
}

// `git stash list` format: reflog selector (`stash@{0}`), subject, date, each
// field NUL-terminated so records never run together. (`%S` is not a
// stash-list placeholder — git prints it literally.)
const STASH_FORMAT = '%gd%x00%s%x00%ad%x00';

function parseStashList(stdout) {
  const fields = String(stdout || '').split('\0').map((f) => f.trim());
  const stashes = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (!fields[i]) continue;
    stashes.push({ index: fields[i], subject: fields[i + 1], date: fields[i + 2] });
  }
  return stashes;
}

// Parse `git for-each-ref --format=%(refname)` output into the branches the
// Git modal can offer for checkout. Local branches come first. Remote
// branches are listed only when no local branch of the same name exists, and
// the symbolic `refs/remotes/<remote>/HEAD` pointer is skipped: checking it
// out (it shows up as a bare `origin` in `git branch -a`) lands on a detached
// HEAD instead of a branch.
function parseBranchRefs(stdout) {
  const local = [];
  const remote = [];
  for (const raw of String(stdout || '').split('\n')) {
    const ref = raw.trim();
    if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) remote.push(ref.slice('refs/remotes/'.length));
  }
  const localSet = new Set(local);
  const remotes = remote.filter((name) => !localSet.has(name.slice(name.indexOf('/') + 1)));
  return { branches: local, remoteBranches: remotes };
}
// ---- Git info API ---------------------------------------------------------
//
// GET /api/git/info?projectDir=<abs>
//   -> {
//        ok: true,
//        branch: 'master',                        // '' on a detached HEAD
//        detached: '',                            // short sha when detached
//        branches: [ 'master', 'dev', ... ],      // local branches
//        remoteBranches: [ 'origin/feature' ],    // remote-only, no */HEAD
//        stashes:  [ { index, subject, date } ],
//        staged:  [ { path, paths, status, statusText, diff, diffSkipped? } ],
//        unstaged: [ { path, paths, status, statusText, diff, diffSkipped? } ],
//        commits: [ { hash, short, subject, author, date } ] // metadata only
//      }
//
// One `git status` + one `git log -20` + per-file diffs (only for the
// staged/unstaged sections). Everything is parsed from machine-readable
// output (porcelain v1 with -z record separators, %x00 log formats,
// unified diff hunks) so the frontend never touches raw shell text.
// Per-commit file lists are NOT fetched here — the Git modal calls
// GET /api/git/commit-files the first time a commit is expanded.
async function handleGitInfo(req, res, parsed) {
  const projectDir = typeof parsed.query.projectDir === 'string' ? parsed.query.projectDir : '';
  if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });

  const run = (args) => runGitCommand(projectDir, args);

  const statusRes = await run(['status', '--porcelain=v1', '-z']);
  if (!statusRes.ok) {
    return sendJSON(res, 200, { ok: false, error: 'not a git repository', code: 'ENOGIT' });
  }

  const branchRes = await run(['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = (branchRes.ok ? branchRes.stdout : '').trim();
  // Detached HEAD: no branch name, so report the short commit instead and
  // let the modal show "detached at <sha>" rather than a random branch.
  let detached = '';
  if (!branch) {
    const headRes = await run(['rev-parse', '--short', 'HEAD']);
    if (headRes.ok) detached = headRes.stdout.trim();
  }

  // ---- Ahead / behind counts against upstream ---------------------------
  let ahead = 0, behind = 0;
  if (branch) {
    // `git rev-list --count --left-right HEAD...@{upstream}` gives
    // "<ahead>\t<behind>" on stdout (or "0\t0" and exits non-zero when
    // no upstream is configured).
    const abRes = await run(['rev-list', '--count', '--left-right', 'HEAD...@{upstream}']);
    if (abRes.ok) {
      const parts = abRes.stdout.trim().split('\t');
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    }
  }

  // ---- Branches (local + remote) --------------------------------------
  // Full refnames, so local and remote are told apart without guessing and
  // the "(HEAD detached at …)" pseudo-entry of `git branch -a` never appears.
  const branchesRes = await run(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  const { branches, remoteBranches } = parseBranchRefs(branchesRes.ok ? branchesRes.stdout : '');

  // ---- Stashes ---------------------------------------------------------
  const stashRes = await run(['stash', 'list', '--format=' + STASH_FORMAT]);
  const stashes = stashRes.ok ? parseStashList(stashRes.stdout) : [];

  // ---- Parse porcelain v1 -z status -------------------------------------
  // One record per change. A renamed file is `XY old\0new\0` (the path
  // is followed by the rename target inside the same record).
  const { staged, unstaged } = parsePorcelainStatus(statusRes.stdout);

  // ---- Recent commits ----------------------------------------------------
  const logRes = await run([
    'log', '-20', '--format=%H%x00%h%x00%s%x00%an%x00%aI%x00', '--'
  ]);
  const commits = [];
  if (logRes.ok) {
    const logFields = logRes.stdout.split('\0');
    for (let i = 0; i + 4 < logFields.length; i += 5) {
      commits.push({
        hash: logFields[i].trim(),
        short: logFields[i + 1].trim(),
        subject: logFields[i + 2].trim(),
        author: logFields[i + 3].trim(),
        date: logFields[i + 4].trim()
      });
    }
  }

  // ---- Diffs -----------------------------------------------------------
  // Untracked files have no committed baseline, so no diff exists.
  const capDiff = (text) => {
    const lines = text.split('\n');
    if (lines.length > 120) {
      return lines.slice(0, 120).join('\n') + '\n… diff truncated';
    }
    return text;
  };

  // Files past the cap are flagged `diffSkipped` so the modal can say so
  // instead of silently rendering them as if they had no diff. A rename
  // diffs both sides so git can pair them (`-M` is on by default).
  const MAX_FILE_DIFFS = 12;
  const markSkipped = (list) => { for (const f of list.slice(MAX_FILE_DIFFS)) f.diffSkipped = true; };
  markSkipped(staged);
  markSkipped(unstaged);
  await Promise.all(staged.slice(0, MAX_FILE_DIFFS).map(async (f) => {
    const r = await run(['diff', '--cached', '--'].concat(f.paths));
    if (r.ok) f.diff = capDiff(r.stdout);
  }));
  await Promise.all(unstaged.slice(0, MAX_FILE_DIFFS).map(async (f) => {
    const r = await run(['diff', '--'].concat(f.paths));
    if (r.ok) f.diff = capDiff(r.stdout);
  }));

  return sendJSON(res, 200, {
    ok: true,
    branch,
    detached,
    ahead,
    behind,
    branches,
    remoteBranches,
    stashes,
    staged,
    unstaged,
    commits,
    truncated: {
      stagedFiles: staged.length > MAX_FILE_DIFFS,
      unstagedFiles: unstaged.length > MAX_FILE_DIFFS
    }
  });
}

// ---- Paginated commits ----------------------------------------------------
//
// GET /api/git/commits?projectDir=<abs>&offset=0&count=20
//   -> { ok: true, commits: [ ... ], total: <count of all commits> }
//   Each commit: { hash, short, subject, author, date } — metadata only.
//   File lists are fetched on demand via GET /api/git/commit-files.
async function handleGitLog(req, res, parsed) {
  const projectDir = typeof parsed.query.projectDir === 'string' ? parsed.query.projectDir : '';
  if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });

  const queryOffset = parseInt(parsed.query.offset, 10);
  const offset = isFinite(queryOffset) && queryOffset >= 0 ? queryOffset : 0;
  const queryCount = parseInt(parsed.query.count, 10);
  const count = isFinite(queryCount) && queryCount >= 1 && queryCount <= 100 ? queryCount : 20;

  const run = (args) => runGitCommand(projectDir, args);

  // Get total commit count
  const totalRes = await run(['rev-list', '--count', 'HEAD']);
  const total = totalRes.ok ? parseInt(totalRes.stdout.trim(), 10) || 0 : 0;

  // Fetch the page of commits
  const logRes = await run([
    'log', '--format=%H%x00%h%x00%s%x00%an%x00%aI%x00',
    '--skip=' + offset,
    '-' + count,
    '--'
  ]);
  const commits = [];
  if (logRes.ok) {
    const logFields = logRes.stdout.split('\0');
    for (let i = 0; i + 4 < logFields.length; i += 5) {
      commits.push({
        hash: logFields[i].trim(),
        short: logFields[i + 1].trim(),
        subject: logFields[i + 2].trim(),
        author: logFields[i + 3].trim(),
        date: logFields[i + 4].trim()
      });
    }
  }

  return sendJSON(res, 200, { ok: true, commits, total, offset, count });
}

// ---- Per-commit file list ------------------------------------------------
//
// GET /api/git/commit-files?projectDir=<abs>&hash=<full-or-short>&nameStatus=1
//   -> { ok: true, files: [ { path, status, statusText, diff } ] }
//
// Full file list for one commit, fetched lazily when the user expands a
// commit in the Git modal. Uses `git show --name-status` so every changed
// file is listed (no diff-line truncation); `git show --format=` adds the
// actual diff hunks. No caps: the whole list is returned for the commit.
async function handleGitCommitFiles(req, res, parsed) {
  const projectDir = typeof parsed.query.projectDir === 'string' ? parsed.query.projectDir : '';
  const hash = typeof parsed.query.hash === 'string' ? parsed.query.hash.trim() : '';
  if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
  if (!hash) return sendJSON(res, 400, { error: 'hash is required' });

  const run = (args) => runGitCommand(projectDir, args);

  // Sanity-check the hash before passing it to git: allow only hex (at
  // least 4 chars) or a ref-like token such as a commit-ish. Everything
  // else (spaces, shell metacharacters, slashes) is rejected so the arg
  // never escapes into an unexpected git invocation.
  if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) {
    return sendJSON(res, 400, { error: 'invalid hash' });
  }

  // `--name-status` prints one `<XY>\t<path>` line per changed file (plus
  // `R100\t<old>\t<new>` for renames). Default output is non-verbose, so
  // each file appears exactly once with no copy/rename duplicates.
  const nameRes = await run(['show', '--name-status', '--format=', hash]);
  if (!nameRes.ok) {
    return sendJSON(res, 200, { ok: false, error: 'unknown commit', code: 'ENOCOMMIT' });
  }

  const files = [];
  const capDiff = (text) => {
    const lines = text.split('\n');
    if (lines.length > 120) {
      return lines.slice(0, 120).join('\n') + '\n… diff truncated';
    }
    return text;
  };

  // Diff hunks for each changed file, parsed into the same shape the
  // Git modal already renders (statusText derived from the porcelain
  // letter, diff capped at 120 lines per file).
  const diffRes = await run(['show', '--format=', hash]);
  let diffByPath = new Map();
  if (diffRes.ok) {
    let cur = null;
    const lines = diffRes.stdout.split('\n');
    for (const line of lines) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (m) {
        if (cur) diffByPath.set(cur.path, cur.diff);
        cur = { path: m[2], diff: line + '\n' };
        continue;
      }
      if (!cur) continue;
      if (line.startsWith('new file mode ')) cur.status = 'A';
      else if (line.startsWith('deleted file mode ')) cur.status = 'D';
      else if (line.startsWith('rename from ')) cur.status = 'R';
      cur.diff += line + '\n';
    }
    if (cur) diffByPath.set(cur.path, cur.diff);
  }

  const STATUS_TEXT = {
    A: 'Added', M: 'Modified', D: 'Deleted',
    R: 'Renamed', C: 'Copied', T: 'Type changed',
    U: 'Unmerged', X: 'Unknown', B: 'Broken'
  };

  const nameLines = nameRes.stdout.split('\n').filter((l) => l.length > 0);
  for (const line of nameLines) {
    const fields = line.split('\t');
    const status = (fields[0] || 'M').replace(/[0-9]/g, '').slice(0, 1);
    let path = fields[1] || '';
    if (status === 'R' || status === 'C') {
      path = (fields[1] || '') + ' -> ' + (fields[2] || '');
    }
    if (!path) continue;
    const full = diffByPath.get(path.split(' -> ')[0]) || diffByPath.get(path);
    files.push({
      path,
      status,
      statusText: STATUS_TEXT[status] || status,
      diff: full ? capDiff(full) : ''
    });
  }

  return sendJSON(res, 200, { ok: true, files });
}

module.exports = { handleGit, handleGitInfo, handleGitLog, handleGitCommitFiles, parsePorcelainStatus, parseBranchRefs, parseStashList, STASH_FORMAT };
