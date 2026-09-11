// mouaif web — Git modal (full-screen overlay like the file editor)
//
// Rendered on top of the chat view when the user taps the git button
// in the composer toolbar. Fetches parsed git data from
// GET /api/git/info and renders a header plus collapsible sections.
//
// Header: branch dropdown + Pull button (with behind count) + Push button
//         (with ahead count) + refresh + close.
// Body:   Stash (Stash up / Apply / Pop / Drop) · Staged changes (with
//         commit bar + per-file Unstage) · Unstaged changes (with per-file
//         Stage + Stage all) · Recent commits (paginated).

import { h, Fragment } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { useModal } from '../../hooks/useModal.js';
import { fetchJson } from '../../api.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';

// Run a git action via POST /api/git. Returns { ok, stdout, stderr }.
async function runGit(projectDir, action, args, message) {
const r = await fetchJson('/api/git', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ projectDir, action, args: args || '', message: message || '' })
});
if (r.status !== 200) {
return { ok: false, stderr: (r.body && r.body.error) || 'HTTP ' + r.status };
}
return r.body || { ok: false, stderr: 'no response' };
}
// Run a git action against an array of file paths (stage / unstage). The
// `files` array reaches git as separate argv elements, so a file name with
// spaces or special characters is never re-split on the server. Returns the
// same { ok, stdout, stderr } shape as runGit.
async function runGitFiles(projectDir, action, files) {
const r = await fetchJson('/api/git', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ projectDir, action, files })
});
if (r.status !== 200) {
return { ok: false, stderr: (r.body && r.body.error) || 'HTTP ' + r.status };
}
return r.body || { ok: false, stderr: 'no response' };
}
// A rename/copy path is reported by git as "old -> new". To stage or unstage
// the rename we must operate on the source path only: `git add -- old`
// records the rename, while adding the target name as well would confuse git
// into staging the target's (possibly new) content too. `git reset HEAD --
// old` likewise restores the rename to an unstaged delete+untracked pair.
function pathForGit(p) {
return String(p || '').split(' -> ')[0];
}

// Diff line rendering: colour +/-/@@ header lines.
function DiffView({ diff }) {
  if (!diff) return null;
  const lines = diff.split('\n');
  return h('div', { class: 'gm__diff' },
    h('pre', { class: 'gm__diff-pre', 'aria-label': 'Diff' },
      lines.map((line, i) => {
        let cls = '';
        if (line.startsWith('@@')) cls = ' gm__diff-hunk';
        else if (line.startsWith('+') && !line.startsWith('+++')) cls = ' gm__diff-add';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = ' gm__diff-del';
        else if (line.startsWith('diff --git')) cls = ' gm__diff-file';
        return h('span', { key: i, class: 'gm__diff-line' + cls }, line || '\u00A0');
      })
    )
  );
}

// A single changed-file row. In staged/unstaged sections the row shows a
// Stage / Unstage action button (wired through the parent's onFileAction),
// so the modal is a working-tree client, not just a viewer.
function FileRow({ file, defaultOpen, action, onAction, busy }) {
const [open, setOpen] = useState(!!defaultOpen);
const hasDiff = !!(file.diff && file.diff.trim());
const actionLabel = action === 'unstage' ? 'Unstage' : 'Stage';
return h('div', { class: 'gm__file' },
h('div', { class: 'gm__file-head' },
h('button', {
class: 'gm__file-toggle',
type: 'button',
onClick: () => setOpen(!open),
'aria-expanded': String(open),
'aria-label': (hasDiff ? 'Toggle diff for ' : '') + file.path
},
h('span', { class: 'gm__file-status gm__file-status--' + file.status }, file.statusText || file.status),
h('span', { class: 'gm__file-path', title: file.path }, file.path),
hasDiff ? h('span', { class: 'gm__file-caret', 'aria-hidden': 'true' }, open ? '\u25BE' : '\u25B8') : null
),
onAction ? h('button', {
class: 'gm__file-action' + (action === 'unstage' ? ' gm__file-action--unstage' : ''),
type: 'button',
disabled: busy,
onClick: () => onAction(file),
'aria-label': actionLabel + ' ' + file.path,
title: actionLabel + ' ' + file.path
}, actionLabel) : null
),
open && hasDiff ? h(DiffView, { diff: file.diff }) : null
);
}

// A single commit row. The changed-file list is fetched lazily from
// GET /api/git/commit-files the first time the row is expanded, so
// commits in the list only pay for `git show` when the user opens them.
function CommitRow({ projectDir, commit, busy, onAction }) {
const [open, setOpen] = useState(false);
const [files, setFiles] = useState(null);
const [error, setError] = useState('');
const [loading, setLoading] = useState(false);
const [loadedHash, setLoadedHash] = useState('');
const loadFiles = useCallback(async () => {
if (loading || loadedHash === commit.hash) return;
setLoading(true);
setError('');
try {
const params = new URLSearchParams();
params.set('projectDir', projectDir);
params.set('hash', commit.hash);
const r = await fetchJson('/api/git/commit-files?' + params.toString());
if (r.status === 200 && r.body && r.body.ok) {
setFiles(r.body.files || []);
setLoadedHash(commit.hash);
} else {
setError((r.body && r.body.error) || 'HTTP ' + r.status);
}
} catch (err) {
setError(String(err));
}
setLoading(false);
}, [projectDir, commit.hash, loading, loadedHash]);
function toggle() {
const next = !open;
setOpen(next);
if (next && loadedHash !== commit.hash) loadFiles();
}
return h('div', { class: 'gm__commit' },
h('div', { class: 'gm__commit-row' },
h('button', {
class: 'gm__commit-head' + (open ? ' is-open' : ''),
type: 'button',
onClick: toggle,
'aria-expanded': String(open),
'aria-label': 'Toggle commit ' + commit.short
},
h('span', { class: 'gm__commit-caret', 'aria-hidden': 'true' }, open ? '\u25BE' : '\u25B8'),
h('span', { class: 'gm__commit-hash' }, commit.short),
h('span', { class: 'gm__commit-subject', title: commit.subject }, commit.subject),
h('span', { class: 'gm__commit-meta' },
commit.author ? h('span', { class: 'gm__commit-author' }, commit.author) : null,
commit.date ? h('span', { class: 'gm__commit-date' }, formatDate(commit.date)) : null
)
),
h(CommitMenu, { commit, busy, onAction })
),
open && h('div', { class: 'gm__commit-body' },
loading
? h('div', { class: 'gm__empty' }, 'Loading files\u2026')
: error
? h('div', { class: 'gm__error' },
h('p', null, error),
h('button', { class: 'btn', type: 'button', onClick: loadFiles }, 'Retry')
)
: files === null
? h('div', { class: 'gm__empty' }, 'Loading files\u2026')
: files.length === 0
? h('div', { class: 'gm__empty' }, 'No file changes in this commit')
: files.map((f, i) => h(FileRow, { key: f.path + '-' + i, file: f }))
)
);
}
// Copy a value to the clipboard, falling back to execCommand for embedded
// web views that block navigator.clipboard. Returns true on success.
async function copyText(text) {
try {
await navigator.clipboard.writeText(text || '');
return true;
} catch (_) {
try {
const ta = document.createElement('textarea');
ta.value = text || '';
ta.style.position = 'fixed';
ta.style.opacity = '0';
document.body.appendChild(ta);
ta.select();
const ok = document.execCommand('copy');
document.body.removeChild(ta);
return ok;
} catch (_) {
return false;
}
}
}
// The per-commit options menu (⋯): copy the hash or subject, or run a git
// operation against the commit (checkout -> detached HEAD, cherry-pick,
// revert, which the parent confirms before dispatching).
function CommitMenu({ commit, busy, onAction }) {
const [open, setOpen] = useState(false);
const menuRef = useRef(null);
useClickOutside(menuRef, () => setOpen(false), open);
return h('div', { ref: menuRef, class: 'gm__commit-menu' },
h('button', {
class: 'gm__commit-menu-btn',
type: 'button',
'aria-haspopup': 'true',
'aria-expanded': String(open),
'aria-label': 'Commit options for ' + commit.short,
title: 'Commit options',
disabled: !!busy,
onClick: (e) => { e.stopPropagation(); setOpen(!open); }
}, '⋯'),
h('div', { class: 'gm__commit-menu-pop', hidden: !open, role: 'menu', onClick: (e) => e.stopPropagation() },
h('button', { type: 'button', onClick: () => { setOpen(false); onAction(commit, 'copy-hash'); } }, 'Copy hash'),
h('button', { type: 'button', onClick: () => { setOpen(false); onAction(commit, 'copy-message'); } }, 'Copy message'),
h('div', { class: 'gm__commit-menu-sep', role: 'separator' }),
h('button', { type: 'button', disabled: !!busy, onClick: () => { setOpen(false); onAction(commit, 'checkout'); } }, 'Checkout'),
h('button', { type: 'button', disabled: !!busy, onClick: () => { setOpen(false); onAction(commit, 'cherry-pick'); } }, 'Cherry-pick'),
h('button', { type: 'button', disabled: !!busy, onClick: () => { setOpen(false); onAction(commit, 'revert'); } }, 'Revert')
)
);
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const opts = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
  try { return d.toLocaleString(undefined, opts); } catch { return iso; }
}

function stashNum(ref) {
  const m = /stash@\{(\d+)\}/.exec(ref || '');
  return m ? m[1] : ref;
}

export function GitModal(props) {
  const { projectDir, onClose } = props;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [commitOffset, setCommitOffset] = useState(0);
  const [allCommits, setAllCommits] = useState([]);
  const [commitTotal, setCommitTotal] = useState(0);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [commitSectionOpen, setCommitSectionOpen] = useState(false);
const [stashSectionOpen, setStashSectionOpen] = useState(false);
const [isLoading, setIsLoading] = useState(false);
const [commitMessage, setCommitMessage] = useState('');
const [pendingCommitAction, setPendingCommitAction] = useState(null);
const load = useCallback(async () => {
    if (!projectDir) { setLoading(false); setError('No project selected'); return; }
    if (isLoading) return;
    setIsLoading(true);
    setLoading(true);
    setError('');
    setNotice('');
    setAllCommits([]);
    setCommitOffset(0);
    setCommitTotal(0);
    try {
      const params = new URLSearchParams();
      params.set('projectDir', projectDir);
      const r = await fetchJson('/api/git/info?' + params.toString());
      if (r.status !== 200) {
        setError((r.body && r.body.error) || 'HTTP ' + r.status);
      } else if (r.body && r.body.ok === false) {
        setError((r.body && r.body.error) || 'Not a git repository');
      } else {
        setData(r.body);
        setAllCommits(r.body.commits || []);
        setCommitOffset((r.body.commits && r.body.commits.length) || 0);
      }
    } catch (err) {
      setError(String(err));
    }
    setLoading(false);
    setIsLoading(false);
  }, [projectDir]);

  useEffect(() => { load(); }, [load]);
// Escape, the Tab cycle and focus restore come from the shared sheet hook
// (frontend/src/hooks/useModal.js). A commit-action confirm sheet renders on
// top of this modal, so it takes Escape first: it pushes its own modal, and
// only the top-most sheet answers the key (see hooks/modalStack.js).
const handleEscape = useCallback(() => {
setPendingCommitAction((p) => {
if (p) return null;
if (onClose) onClose();
return p;
});
}, [onClose]);
const sheetRef = useModal({ onClose: handleEscape });
const confirmSheetRef = useModal({ onClose: handleEscape, active: !!pendingCommitAction });

  async function doGit(action, args, message) {
    if (busy) return;
    setBusy(action);
    setNotice('');
    const res = await runGit(projectDir, action, args, message);
    if (!res.ok) {
      setNotice((res.stderr || 'git ' + action + ' failed').trim() || 'git ' + action + ' failed');
    } else {
      setNotice('git ' + action + ' ok');
      await load();
    }
    setBusy('');
  }

  // Stage / unstage one file. Operates on the source path of a rename so the
// operation lands on the rename itself (see pathForGit), then reloads.
async function doGitFiles(action, file) {
if (busy) return;
setBusy(action);
setNotice('');
const res = await runGitFiles(projectDir, action, [pathForGit(file.path)]);
if (!res.ok) {
setNotice((res.stderr || 'git ' + action + ' failed').trim() || 'git ' + action + ' failed');
} else {
setNotice('');
await load();
}
setBusy('');
}
// Stage everything (all unstaged files) in one tap.
async function stageAll() {
if (busy) return;
setBusy('add');
setNotice('');
const paths = unstaged.map((f) => pathForGit(f.path));
if (!paths.length) { setBusy(''); return; }
const res = await runGitFiles(projectDir, 'add', paths);
if (!res.ok) {
setNotice((res.stderr || 'git add failed').trim() || 'git add failed');
} else {
setNotice('');
await load();
}
setBusy('');
}
// Commit the staged files with the message in the composer. Requires a
// message; clears it on success.
async function commit() {
if (busy) return;
const msg = commitMessage.trim();
if (!msg) { setNotice('Enter a commit message'); return; }
setBusy('commit');
setNotice('');
const res = await runGit(projectDir, 'commit', '', msg);
if (!res.ok) {
setNotice((res.stderr || 'git commit failed').trim() || 'git commit failed');
} else {
setCommitMessage('');
setNotice('Committed\u2026');
await load();
}
setBusy('');
}
function checkoutBranch(name) {
if (busy || name === (data && data.branch)) return;
doGit('checkout', name);
}
// Handle an action chosen from a commit's options menu.
//
// Copy actions are read-only and run immediately. The git-mutating actions
// (checkout -> detached HEAD, cherry-pick, revert) create a new commit or
// move the current HEAD, so they need explicit confirmation before dispatch;
// they set `pendingCommitAction` and the modal shows an in-app confirm sheet.
async function onCommitAction(commit, action) {
if (busy) return;
if (action === 'copy-hash') {
const ok = await copyText(commit.hash);
setNotice(ok ? 'Copied hash ' + commit.short : 'Copy failed');
return;
}
if (action === 'copy-message') {
const ok = await copyText(commit.subject);
setNotice(ok ? 'Copied message' : 'Copy failed');
return;
}
if (action === 'checkout') {
setPendingCommitAction({ commit, action: 'checkout' });
return;
}
if (action === 'cherry-pick') {
setPendingCommitAction({ commit, action: 'cherry-pick' });
return;
}
if (action === 'revert') {
setPendingCommitAction({ commit, action: 'revert' });
return;
}
}
function runPendingCommitAction() {
const pending = pendingCommitAction;
setPendingCommitAction(null);
if (!pending) return;
if (pending.action === 'checkout') {
doGit('checkout', pending.commit.hash);
} else if (pending.action === 'cherry-pick') {
doGit('cherry-pick', pending.commit.hash);
} else if (pending.action === 'revert') {
doGit('revert', pending.commit.hash);
}
}
async function loadMoreCommits() {
    if (loadingCommits) return;
    setLoadingCommits(true);
    try {
      const params = new URLSearchParams();
      params.set('projectDir', projectDir);
      params.set('offset', String(commitOffset));
      params.set('count', '20');
      const r = await fetchJson('/api/git/commits?' + params.toString());
      if (r.status === 200 && r.body && r.body.ok) {
        setAllCommits((prev) => prev.concat(r.body.commits || []));
        setCommitTotal(r.body.total || 0);
        setCommitOffset((prev) => prev + (r.body.commits ? r.body.commits.length : 0));
      }
    } catch (_) {}
    setLoadingCommits(false);
  }

  const staged = (data && data.staged) || [];
  const unstaged = (data && data.unstaged) || [];
  const stashes = (data && data.stashes) || [];
  const branch = (data && data.branch) || '';
  const branches = (data && data.branches) || [];
  const ahead = (data && data.ahead) || 0;
  const behind = (data && data.behind) || 0;
  const hasMoreCommits = commitTotal > 0 ? allCommits.length < commitTotal : allCommits.length >= 20;

  return h('div', { class: 'gm__overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Git' },
  h('div', { class: 'gm__sheet', ref: sheetRef },
      h('div', { class: 'gm__head' },
        h('label', { class: 'gm__branch-wrap' },
          h('span', { class: 'gm__branch-label' }, 'Branch'),
          h('select', {
            class: 'gm__branch-select',
            value: branch,
            disabled: busy === 'checkout',
            onChange: (e) => checkoutBranch(e.currentTarget.value),
            'aria-label': 'Branch'
          },
            branches.length === 0
              ? h('option', { value: branch }, branch || '(none)')
              : branches.map((b) => h('option', { key: b, value: b }, b))
          )
        ),
        h('button', {
        class: 'icon-btn gm__iconbtn' + (behind > 0 ? ' gm__iconbtn--has-count' : ''),
          type: 'button',
          onClick: () => doGit('pull'),
          disabled: !!busy,
          'aria-label': 'Pull from remote' + (behind > 0 ? ' (' + behind + ' behind)' : ''),
          title: 'Pull' + (behind > 0 ? ' (' + behind + ' behind)' : '')
        },
          behind > 0 ? h('span', { class: 'gm__iconbtn-badge' }, behind) : null,
          h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
            h('path', { d: 'M11 3v9.6L8.4 10 7 11.4l5 5 5-5L15.6 10 13 12.6V3h-2Zm-7 15h16v2H4v-2Z', fill: 'currentColor' })
          )
        ),
        h('button', {
        class: 'icon-btn gm__iconbtn' + (ahead > 0 ? ' gm__iconbtn--has-count' : ''),
          type: 'button',
          onClick: () => doGit('push'),
          disabled: !!busy,
          'aria-label': 'Push to remote' + (ahead > 0 ? ' (' + ahead + ' ahead)' : ''),
          title: 'Push' + (ahead > 0 ? ' (' + ahead + ' ahead)' : '')
        },
          ahead > 0 ? h('span', { class: 'gm__iconbtn-badge' }, ahead) : null,
          h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
            h('path', { d: 'M12 3a1 1 0 0 1 .7.3l5 5-1.4 1.4L13 7.4V20h-2V7.4L7.7 9.7 6.3 8.3l5-5A1 1 0 0 1 12 3Z', fill: 'currentColor' })
          )
        ),
        h('button', {
        class: 'icon-btn gm__iconbtn',
        type: 'button',
        onClick: load,
          disabled: loading || !!busy,
          'aria-label': 'Refresh git status',
          title: 'Refresh'
        },
          h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
            h('path', { d: 'M12 4V1L7 6l5 5V7c3.31 0 6 2.69 6 6 0 1-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 13c0-4.42-3.58-8-8-8Zm-5.3 7.7A7.93 7.93 0 0 0 4 13c0 4.42 3.58 8 8 8v3l5-5-5-5v3c-3.31 0-6-2.69-6-6 0-1 .25-1.97.7-2.8L5.24 10.24Z', fill: 'currentColor' })
          )
        ),
        h('button', {
        class: 'icon-btn icon-btn--close gm__iconbtn',
          type: 'button',
          onClick: onClose,
          'aria-label': 'Close',
          title: 'Close'
        },
          h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
            h('path', { d: 'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.88 18.3 9.17 12 2.88 5.71 4.3 4.3l6.29 6.29 6.3-6.29 1.41 1.41Z', fill: 'currentColor' })
          )
        )
      ),
      notice ? h('div', { class: 'gm__notice' }, notice) : null,
      h('div', { class: 'gm__body' },
        loading
          ? h('div', { class: 'gm__empty' }, 'Loading git status\u2026')
          : error
            ? h('div', { class: 'gm__error' },
                h('p', null, error),
                h('button', { class: 'btn', type: 'button', onClick: load }, 'Retry')
              )
            : h(Fragment, null,
                h('div', { class: 'gm__section' },
                  h('button', {
                    class: 'gm__section-head',
                    type: 'button',
                    onClick: () => setStashSectionOpen(!stashSectionOpen),
                    'aria-expanded': String(stashSectionOpen),
                    'aria-controls': 'gm-section-stash'
                  },
                    h('span', { class: 'gm__section-caret', 'aria-hidden': 'true' }, stashSectionOpen ? '\u25BE' : '\u25B8'),
                    h('span', { class: 'gm__section-title' }, 'Stash'),
                    h('span', { class: 'gm__section-count' }, stashes.length || '')
                  ),
                  stashSectionOpen && h('div', { id: 'gm-section-stash', class: 'gm__section-body' },
                    h('div', { class: 'gm__stash-toolbar' },
                      h('button', {
                        class: 'gm__stash-btn gm__stash-btn--stashup',
                        type: 'button',
                        disabled: !!busy,
                        onClick: () => doGit('stash'),
                        'aria-label': 'Stash working changes',
                        title: 'Stash up'
                      },
                        h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
                          h('path', { d: 'M12 4v9.6L9.4 11 8 12.4l5 5 5-5-1.4-1.4L14 13.6V4h-2ZM5 20h14v2H5v-2Z', fill: 'currentColor' })
                        ),
                        ' Stash up'
                      )
                    ),
                    stashes.length === 0
                      ? h('div', { class: 'gm__empty' }, 'No stashed changes')
                      : stashes.map((s, i) => h(StashRow, {
                          key: i, stash: s, busy,
                          onApply: (r) => doGit('stash-apply', r),
                          onPop: (r) => doGit('stash-pop', r),
                          onDrop: (r) => doGit('stash-drop', r)
                        }))
                  )
                ),
                h(Section, {
id: 'staged',
title: 'Staged changes',
files: staged,
defaultOpen: staged.length > 0,
emptyText: 'Nothing staged',
action: 'unstage',
onAction: (f) => doGitFiles('unstage', f),
busy: !!busy,
header: h('div', { class: 'gm__commit-bar' },
h('input', {
class: 'input gm__commit-input',
type: 'text',
value: commitMessage,
onInput: (e) => setCommitMessage(e.currentTarget.value),
placeholder: 'Commit message',
'aria-label': 'Commit message',
disabled: !!busy,
onKeyDown: (e) => {
if (e.key === 'Enter') { e.preventDefault(); commit(); }
}
}),
h('button', {
class: 'gm__commit-btn',
type: 'button',
disabled: !!busy || staged.length === 0,
onClick: commit,
'aria-label': 'Commit staged changes',
title: 'Commit staged changes'
}, busy === 'commit' ? 'Committing\u2026' : 'Commit')
)
}),
h(Section, {
id: 'unstaged',
title: 'Unstaged changes',
files: unstaged,
defaultOpen: unstaged.length > 0,
emptyText: 'Working tree clean',
action: 'add',
onAction: (f) => doGitFiles('add', f),
busy: !!busy
}),
staged.length > 0 && unstaged.length > 0 ? h('button', {
class: 'gm__stage-all',
type: 'button',
disabled: !!busy,
onClick: stageAll,
'aria-label': 'Stage all unstaged changes',
title: 'Stage all unstaged changes'
}, 'Stage all (' + unstaged.length + ')') : null,
                h('div', { class: 'gm__section' },
                  h('button', {
                    class: 'gm__section-head',
                    type: 'button',
                    onClick: () => setCommitSectionOpen(!commitSectionOpen),
                    'aria-expanded': String(commitSectionOpen),
                    'aria-controls': 'gm-section-commits'
                  },
                    h('span', { class: 'gm__section-caret', 'aria-hidden': 'true' }, commitSectionOpen ? '\u25BE' : '\u25B8'),
                    h('span', { class: 'gm__section-title' }, 'Recent commits'),
                    h('span', { class: 'gm__section-count' }, commitTotal || allCommits.length || '')
                  ),
                  commitSectionOpen && h('div', { id: 'gm-section-commits', class: 'gm__section-body' },
                    allCommits.length === 0
                      ? h('div', { class: 'gm__empty' }, 'No commits yet')
                      : h(Fragment, null,
                          allCommits.map((c, ci) => h(CommitRow, { key: c.hash || ci, projectDir, commit: c, busy: !!busy, onAction: onCommitAction })),
                          hasMoreCommits
                            ? h('button', {
                                class: 'gm__load-more',
                                type: 'button',
                                disabled: loadingCommits,
                                onClick: loadMoreCommits
                              }, loadingCommits ? 'Loading\u2026' : 'Load more')
                            : null
                        )
                  )
                )
              )
      )
    ),
    pendingCommitAction ? h(GitConfirm, {
    commit: pendingCommitAction.commit,
    action: pendingCommitAction.action,
    busy: !!busy,
    sheetRef: confirmSheetRef,
    onCancel: () => setPendingCommitAction(null),
    onConfirm: runPendingCommitAction
    }) : null
  );
}

// In-app confirmation for a commit's destructive/new-commit actions (checkout
// moves HEAD to a detached commit; cherry-pick and revert create new commits).
// A bottom sheet reusing the gm__overlay/sheet primitive so it layers above
// the Git modal, honors the safe-area inset, and keeps both buttons ≥44px.
// Rendered with its own classes rather than the Inspector's ConfirmSheet
// because inspector.css is lazy-loaded and may not be present in the chat view.
function GitConfirm({ commit, action, busy, onCancel, onConfirm, sheetRef }) {
let title = 'Confirm git action';
let message = '';
if (action === 'checkout') {
title = 'Checkout commit?';
message = 'Check out ' + commit.short + ' as a detached HEAD. Any current changes must be committed or stashed first.';
} else if (action === 'cherry-pick') {
title = 'Cherry-pick commit?';
message = 'Apply ' + commit.short + (' "' + commit.subject + '"') + ' onto the current branch as a new commit.';
} else if (action === 'revert') {
title = 'Revert commit?';
message = 'Create a new commit that undoes ' + commit.short + (' "' + commit.subject + '"') + '.';
}
const confirmLabel = action === 'checkout' ? 'Checkout' : (action === 'cherry-pick' ? 'Cherry-pick' : 'Revert');
return h('div', { class: 'gm__overlay gm__confirm', role: 'presentation', onClick: busy ? undefined : onCancel },
h('div', { class: 'gm__sheet gm__confirm-sheet', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title, ref: sheetRef, onClick: (e) => e.stopPropagation() },
h('div', { class: 'gm__confirm-body' },
h('strong', { class: 'gm__confirm-title' }, title),
h('p', { class: 'gm__confirm-msg' }, message),
h('div', { class: 'gm__confirm-actions' },
h('button', {
class: 'btn gm__confirm-cancel',
type: 'button',
disabled: busy,
onClick: onCancel
}, 'Cancel'),
h('button', {
class: 'btn gm__confirm-go',
type: 'button',
'data-danger': '1',
disabled: busy,
onClick: onConfirm
}, busy ? 'Working\u2026' : confirmLabel)
)
)
)
);
}

// One collapsible section. For the staged section, `header` renders a commit
// bar (commit-message input + Commit button) below the section head; for the
// staged/unstaged sections, `action`/`onAction` add a per-file Stage/Unstage
// button to each row.
function Section({ id, title, files, defaultOpen, emptyText, renderFile, action, onAction, busy, header }) {
const [open, setOpen] = useState(defaultOpen);
const count = files ? files.length : 0;
const renderRow = renderFile || ((f, i) => h(FileRow, {
key: f.path + '-' + i, file: f, action, onAction, busy
}));
return h('div', { class: 'gm__section' },
h('button', {
class: 'gm__section-head' + (open ? ' is-open' : ''),
type: 'button',
onClick: () => setOpen(!open),
'aria-expanded': String(open),
'aria-controls': 'gm-section-' + id
},
h('span', { class: 'gm__section-caret', 'aria-hidden': 'true' }, open ? '\u25BE' : '\u25B8'),
h('span', { class: 'gm__section-title' }, title),
h('span', { class: 'gm__section-count' }, count || '')
),
open && h('div', { id: 'gm-section-' + id, class: 'gm__section-body' },
header || null,
count === 0
? h('div', { class: 'gm__empty' }, emptyText || 'Nothing here')
: files.map((f, i) => renderRow(f, i))
)
);
}

// Stash row: one stash with Apply / Pop / Drop actions.
function StashRow({ stash, busy, onApply, onPop, onDrop }) {
  return h('div', { class: 'gm__stash-row' },
    h('span', { class: 'gm__stash-index' }, stashNum(stash.index)),
    h('span', { class: 'gm__stash-main' },
      h('span', { class: 'gm__stash-subject', title: stash.subject }, stash.subject),
      stash.date ? h('span', { class: 'gm__stash-date' }, stash.date) : null
    ),
    h('div', { class: 'gm__stash-actions' },
      h('button', { class: 'gm__stash-btn', type: 'button', disabled: !!busy, onClick: () => onApply(stash.index), title: 'Apply stash without removing it' }, 'Apply'),
      h('button', { class: 'gm__stash-btn', type: 'button', disabled: !!busy, onClick: () => onPop(stash.index), title: 'Apply stash and remove it' }, 'Pop'),
      h('button', { class: 'gm__stash-btn gm__stash-btn--danger', type: 'button', disabled: !!busy, onClick: () => onDrop(stash.index), title: 'Delete stash' }, 'Drop')
    )
  );
}