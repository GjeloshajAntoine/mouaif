'use strict';

// Git REST handlers. Extracted from the original single-file
// http-server.js. Shared helpers live in src/server-shared.js.

const { spawn } = require('node:child_process');
const { sendJSON, readJsonBody, xyToText } = require('./server-shared.js');

// ---- Git API ----------------------------------------------------------------
//
// Lightweight git operations run directly against the project directory.
// Routes:
//   POST /api/git  body: { projectDir, action, args? }
//     -> { ok, stdout, stderr, exitCode }
//
// Supported actions: status, diff, log, add, commit, branch, checkout, stash
// These are read-safe or explicit-save commands. `commit` and `add` require
// an extra `message` field. No remote push/pull for safety.
async function handleGit(req, res, parsed) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
  const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
  const action = body && typeof body.action === 'string' ? body.action : '';
  const args = body && typeof body.args === 'string' ? body.args : '';
  const message = body && typeof body.message === 'string' ? body.message : '';

  if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
  if (!action) return sendJSON(res, 400, { error: 'action is required' });

  const SAFE_ACTIONS = new Set(['status', 'diff', 'log', 'add', 'commit', 'branch', 'checkout', 'stash']);
  if (!SAFE_ACTIONS.has(action)) {
    return sendJSON(res, 400, { error: 'unsupported action: ' + action, supported: [...SAFE_ACTIONS] });
  }

  let cmd;
  switch (action) {
    case 'status':
      cmd = 'git status --short --branch';
      break;
    case 'diff':
      cmd = 'git diff' + (args ? ' ' + args : ' --stat');
      break;
    case 'log':
      cmd = 'git log --oneline -20' + (args ? ' ' + args : '');
      break;
    case 'add':
      if (!args) return sendJSON(res, 400, { error: 'args (file paths) required for add' });
      cmd = 'git add ' + args;
      break;
    case 'commit':
      if (!message) return sendJSON(res, 400, { error: 'message required for commit' });
      cmd = 'git commit -m ' + JSON.stringify(message);
      break;
    case 'branch':
      cmd = 'git branch' + (args ? ' ' + args : '');
      break;
    case 'checkout':
      if (!args) return sendJSON(res, 400, { error: 'args (branch name) required for checkout' });
      cmd = 'git checkout ' + args;
      break;
    case 'stash':
      cmd = 'git stash' + (args ? ' ' + args : '');
      break;
    default:
      return sendJSON(res, 400, { error: 'unsupported action' });
  }

  const child = spawn('git', ['-C', projectDir].concat(cmd.split(' ').slice(1)), {
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

// ---- Git info API ---------------------------------------------------------
//
// GET /api/git/info?projectDir=<abs>
//   -> {
//        ok: true,
//        branch: 'master',
//        staged:  [ { path, status, statusText, diff } ],   // staged changes
//        unstaged: [ { path, status, statusText, diff } ],  // unstaged changes
//        commits: [ { hash, short, subject, author, date, files: [ { path, status, diff } ] } ]
//      }
//
// One `git status` + one `git log -20` + per-file diffs. Diffs are
// capped at 120 lines each; everything is parsed from machine-readable
// output (porcelain v1 with -z record separators, %x00 log formats,
// unified diff hunks) so the frontend never touches raw shell text.
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

  // ---- Parse porcelain v1 -z status -------------------------------------
  // One record per change. A renamed file is `XY old\0new\0` (the path
  // is followed by the rename target inside the same record).
  const records = statusRes.stdout.split('\0').filter((s) => s.length > 0);
  const staged = [];
  const unstaged = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const xy = rec.slice(0, 2);
    let path = rec.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') {
      // Consume the rename/copy target that git appended as its own
      // NUL-terminated record.
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
    if (xy[1] !== ' ' && xy[1] !== '?') {
      unstaged.push({ path, status: xy[1], statusText, diff: '' });
    }
  }

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
  const MAX_COMMIT_DIFFS = 3;

  await Promise.all(staged.slice(0, MAX_FILE_DIFFS).map(async (f) => {
    const r = await run(['diff', '--cached', '--', f.path.split(' -> ')[0]]);
    if (r.ok) f.diff = capDiff(r.stdout);
  }));
  await Promise.all(unstaged.slice(0, MAX_FILE_DIFFS).map(async (f) => {
    const r = await run(['diff', '--', f.path.split(' -> ')[0]]);
    if (r.ok) f.diff = capDiff(r.stdout);
  }));

  // Per-commit changed files: `git show --format=` drops the commit
  // header so stdout is purely the diff for that commit. Parse file
  // hunks so each changed file is a separate expandable entry.
  const parseFileDiffs = (text) => {
    const files = [];
    let cur = null;
    const lines = text.split('\n');
    for (const line of lines) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (m) {
        if (cur) files.push(cur);
        cur = { path: m[2], status: 'M', statusText: 'Modified', diff: line + '\n' };
        continue;
      }
      if (!cur) continue;
      if (line.startsWith('new file mode ')) { cur.status = 'A'; cur.statusText = 'Added'; }
      else if (line.startsWith('deleted file mode ')) { cur.status = 'D'; cur.statusText = 'Deleted'; }
      else if (line.startsWith('rename from ')) { cur.status = 'R'; cur.statusText = 'Renamed'; }
      else if (line.startsWith('similarity index ')) { cur.statusText = 'Renamed'; }
      cur.diff += line + '\n';
    }
    if (cur) files.push(cur);
    return files;
  };

  await Promise.all(commits.slice(0, MAX_COMMIT_DIFFS).map(async (c) => {
    const r = await run(['show', '--format=', c.hash]);
    if (r.ok) {
      c.files = parseFileDiffs(capDiff(r.stdout));
      c.filesTruncated = r.stdout.split('\n').length > 120;
    }
  }));
  for (const c of commits) {
    if (!c.files) c.files = [];
    if (!c.filesTruncated) c.filesTruncated = false;
  }

  return sendJSON(res, 200, {
    ok: true,
    branch,
    staged,
    unstaged,
    commits,
    truncated: {
      stagedFiles: staged.length > MAX_FILE_DIFFS,
      unstagedFiles: unstaged.length > MAX_FILE_DIFFS
    }
  });
}

module.exports = { handleGit, handleGitInfo };
