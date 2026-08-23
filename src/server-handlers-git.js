'use strict';

// Git REST handlers. Extracted from the original single-file
// http-server.js. Shared helpers live in src/server-shared.js.

const { spawn } = require('node:child_process');
const { sendJSON, readJsonOr400, xyToText } = require('./server-shared.js');

// ---- Git API ----------------------------------------------------------------
//
// Lightweight git operations run directly against the project directory.
// Routes:
//   POST /api/git  body: { projectDir, action, args? }
//     -> { ok, stdout, stderr, exitCode }
//
// Supported actions: status, diff, log, add, commit, branch, checkout, stash,
// stash-apply, stash-pop, stash-drop, push, pull
// These are read-safe or explicit-save commands. `commit` and `add` require
// an extra `message` field. `push` and `pull` talk to the configured remote.
async function handleGit(req, res, parsed) {
  const body = await readJsonOr400(req, res);
  if (!body) return;
  const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
  const action = body && typeof body.action === 'string' ? body.action : '';
  const args = body && typeof body.args === 'string' ? body.args : '';
  const message = body && typeof body.message === 'string' ? body.message : '';

  if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
  if (!action) return sendJSON(res, 400, { error: 'action is required' });

  const SAFE_ACTIONS = new Set(['status', 'diff', 'log', 'add', 'commit', 'branch', 'checkout', 'stash', 'stash-apply', 'stash-pop', 'stash-drop', 'push', 'pull']);
  if (!SAFE_ACTIONS.has(action)) {
    return sendJSON(res, 400, { error: 'unsupported action: ' + action, supported: [...SAFE_ACTIONS] });
  }

  // Build an argv array (never a string + split) so values containing
  // spaces — commit messages in particular — reach git as single
  // arguments instead of being shattered into separate tokens.
  const splitArgs = (s) => (s ? s.trim().split(/\s+/).filter(Boolean) : []);
  let argv;
  switch (action) {
    case 'status':
      argv = ['status', '--short', '--branch'];
      break;
    case 'diff':
      argv = ['diff'].concat(args ? splitArgs(args) : ['--stat']);
      break;
    case 'log':
      argv = ['log', '--oneline', '-20'].concat(splitArgs(args));
      break;
    case 'add':
      if (!args) return sendJSON(res, 400, { error: 'args (file paths) required for add' });
      argv = ['add'].concat(splitArgs(args));
      break;
    case 'commit':
      if (!message) return sendJSON(res, 400, { error: 'message required for commit' });
      argv = ['commit', '-m', message];
      break;
    case 'branch':
      argv = ['branch'].concat(splitArgs(args));
      break;
    case 'checkout':
      if (!args) return sendJSON(res, 400, { error: 'args (branch name) required for checkout' });
      argv = ['checkout', args];
      break;
    case 'stash':
      argv = ['stash'].concat(splitArgs(args));
      break;
    case 'stash-apply':
      argv = ['stash', 'apply'].concat(splitArgs(args));
      break;
    case 'stash-pop':
      argv = ['stash', 'pop'].concat(splitArgs(args));
      break;
    case 'stash-drop':
      argv = ['stash', 'drop'].concat(splitArgs(args));
      break;
    case 'push':
      argv = ['push'].concat(splitArgs(args));
      break;
    case 'pull':
      argv = ['pull'].concat(splitArgs(args));
      break;
    default:
      return sendJSON(res, 400, { error: 'unsupported action' });
  }

  const child = spawn('git', ['-C', projectDir].concat(argv), {
    cwd: projectDir,
    timeout: 15000,
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' })
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.on('close', resolve);
      child.on('error', reject);
    });
    return sendJSON(res, 200, { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
  } catch (err) {
    return sendJSON(res, 500, { ok: false, error: err.message, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: -1 });
  }
}

// Parse `git status --porcelain=v1 -z` into the two working-tree sections.
// Untracked entries use `??`; they belong in the unstaged section even though
// their worktree status character is `?` rather than a tracked-file status.
function parsePorcelainStatus(stdout) {
  const records = String(stdout || '').split('\0').filter((s) => s.length > 0);
  const staged = [];
  const unstaged = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const xy = rec.slice(0, 2);
    let path = rec.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') {
      const target = records[i + 1];
      if (target !== undefined) {
        path = path + ' -> ' + target;
        i++;
      }
    }
    const statusText = xyToText(xy);
    if (xy[0] !== ' ' && xy[0] !== '?') {
      staged.push({ path, status: xy[0], statusText, diff: '' });
    }
    if (xy[1] !== ' ') {
      unstaged.push({ path, status: xy[1], statusText, diff: '' });
    }
  }
  return { staged, unstaged };
}
// ---- Git info API ---------------------------------------------------------
//
// GET /api/git/info?projectDir=<abs>
//   -> {
//        ok: true,
//        branch: 'master',
//        branches: [ 'master', 'dev', ... ],      // local + remote branches
//        stashes:  [ { index, subject, date } ],
//        staged:  [ { path, status, statusText, diff } ],   // staged changes
//        unstaged: [ { path, status, statusText, diff } ],  // unstaged changes
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

  const run = (args) => new Promise((resolve) => {
    const child = spawn('git', ['-C', projectDir].concat(args), {
      cwd: projectDir,
      timeout: 15000,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
      windowsHide: true
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', () => resolve({ ok: false, stdout: '', exitCode: -1 }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, exitCode: code }));
  });

  const statusRes = await run(['status', '--porcelain=v1', '-z']);
  if (!statusRes.ok) {
    return sendJSON(res, 200, { ok: false, error: 'not a git repository', code: 'ENOGIT' });
  }

  const branchRes = await run(['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = (branchRes.ok ? branchRes.stdout : '').trim();

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
  const branchesRes = await run(['branch', '-a', '--format=%(refname:short)']);
  const branches = branchesRes.ok
    ? branchesRes.stdout.split('\n').map((b) => b.trim()).filter(Boolean)
    : [];

  // ---- Stashes ---------------------------------------------------------
  // `git stash list --format=...` gives one entry per stash:
  //   stash@{0} :: subject :: author-relative-date
  const stashRes = await run([
    'stash', 'list', '--format=%S%x00%s%x00%ad'
  ]);
  const stashes = [];
  if (stashRes.ok) {
    const fields = stashRes.stdout.split('\0');
    for (let i = 0; i + 2 < fields.length; i += 3) {
      stashes.push({
        index: fields[i].trim(),            // "stash@{0}"
        subject: fields[i + 1].trim(),
        date: fields[i + 2].trim()
      });
    }
  }

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

  const MAX_FILE_DIFFS = 12;
  await Promise.all(staged.slice(0, MAX_FILE_DIFFS).map(async (f) => {
    const r = await run(['diff', '--cached', '--', f.path.split(' -> ')[0]]);
    if (r.ok) f.diff = capDiff(r.stdout);
  }));
  await Promise.all(unstaged.slice(0, MAX_FILE_DIFFS).map(async (f) => {
    const r = await run(['diff', '--', f.path.split(' -> ')[0]]);
    if (r.ok) f.diff = capDiff(r.stdout);
  }));

  return sendJSON(res, 200, {
    ok: true,
    branch,
    ahead,
    behind,
    branches,
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

  const run = (args) => new Promise((resolve) => {
    const child = spawn('git', ['-C', projectDir].concat(args), {
      cwd: projectDir,
      timeout: 15000,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
      windowsHide: true
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', () => resolve({ ok: false, stdout: '', exitCode: -1 }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, exitCode: code }));
  });

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

  const run = (args) => new Promise((resolve) => {
    const child = spawn('git', ['-C', projectDir].concat(args), {
      cwd: projectDir,
      timeout: 15000,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
      windowsHide: true
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', () => resolve({ ok: false, stdout: '', exitCode: -1 }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, exitCode: code }));
  });

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

module.exports = { handleGit, handleGitInfo, handleGitLog, handleGitCommitFiles, parsePorcelainStatus };
