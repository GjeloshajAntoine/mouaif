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
//
// All modal state lives in one reducer (./gitModalState.js). A refresh after
// an action keeps the current content on screen, so expanded diffs, open
// commits and section toggles survive a Stage / Commit / Pull.

import { h, Fragment } from 'preact';
import { useReducer, useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { useModal } from '../../hooks/useModal.js';
import { fetchJson } from '../../api.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import {
  COMMIT_PAGE,
  initialGitState,
  gitReducer,
  sectionOpen,
  hasMoreCommits,
  pathsFor,
  branchOptions,
  successText,
  failureText
} from './gitModalState.js';

// POST /api/git. `body` is { action, args?, files?, message?, track? }.
// Resolves to { ok, stdout, stderr }; never rejects.
async function postGit(projectDir, body) {
  try {
    const r = await fetchJson('/api/git', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir }, body))
    });
    if (r.status !== 200) {
      return { ok: false, stderr: (r.body && r.body.error) || 'HTTP ' + r.status };
    }
    return r.body || { ok: false, stderr: 'no response' };
  } catch (err) {
    return { ok: false, stderr: String(err) };
  }
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
// Stage / Unstage action button, so the modal is a working-tree client, not
// just a viewer. Files past the server's diff cap say so instead of looking
// diff-less.
function FileRow({ file, action, onAction, busy }) {
  const [open, setOpen] = useState(false);
  const hasDiff = !!(file.diff && file.diff.trim());
  const actionLabel = action === 'unstage' ? 'Unstage' : 'Stage';
  return h('div', { class: 'gm__file' },
    h('div', { class: 'gm__file-head' },
      h('button', {
        class: 'gm__file-toggle',
        type: 'button',
        onClick: () => { if (hasDiff) setOpen((v) => !v); },
        'aria-expanded': hasDiff ? String(open) : undefined,
        'aria-label': (hasDiff ? 'Toggle diff for ' : '') + file.path
      },
        h('span', { class: 'gm__file-status gm__file-status--' + file.status }, file.statusText || file.status),
        h('span', { class: 'gm__file-path', title: file.path }, file.path),
        hasDiff
          ? h('span', { class: 'gm__file-caret', 'aria-hidden': 'true' }, open ? '\u25BE' : '\u25B8')
          : file.diffSkipped
            ? h('span', { class: 'gm__file-note', title: 'Diffs are loaded for the first 12 files only' }, 'no diff loaded')
            : null
      ),
      onAction ? h('button', {
        class: 'gm__file-action' + (action === 'unstage' ? ' gm__file-action--unstage' : ''),
        type: 'button',
        disabled: busy,
        onClick: () => onAction(action, file),
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
// The row is keyed by hash, so its loaded files never belong to another
// commit.
function CommitRow({ projectDir, commit, busy, onAction }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState({ status: 'idle', list: [], error: '' });
  const inFlight = useRef(false);

  const loadFiles = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFiles({ status: 'loading', list: [], error: '' });
    try {
      const params = new URLSearchParams({ projectDir, hash: commit.hash });
      const r = await fetchJson('/api/git/commit-files?' + params.toString());
      if (r.status === 200 && r.body && r.body.ok) {
        setFiles({ status: 'ready', list: r.body.files || [], error: '' });
      } else {
        setFiles({ status: 'error', list: [], error: (r.body && r.body.error) || 'HTTP ' + r.status });
      }
    } catch (err) {
      setFiles({ status: 'error', list: [], error: String(err) });
    }
    inFlight.current = false;
  }, [projectDir, commit.hash]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && files.status === 'idle') loadFiles();
  }

  let body = null;
  if (open) {
    if (files.status === 'error') {
      body = h('div', { class: 'gm__error' },
        h('p', null, files.error),
        h('button', { class: 'btn', type: 'button', onClick: loadFiles }, 'Retry')
      );
    } else if (files.status !== 'ready') {
      body = h('div', { class: 'gm__empty' }, 'Loading files\u2026');
    } else if (files.list.length === 0) {
      body = h('div', { class: 'gm__empty' }, 'No file changes in this commit');
    } else {
      body = files.list.map((f) => h(FileRow, { key: f.path, file: f }));
    }
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
    open ? h('div', { class: 'gm__commit-body' }, body) : null
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
  const pick = (action) => { setOpen(false); onAction(commit, action); };
  return h('div', { ref: menuRef, class: 'gm__commit-menu' },
    h('button', {
      class: 'gm__commit-menu-btn',
      type: 'button',
      'aria-haspopup': 'true',
      'aria-expanded': String(open),
      'aria-label': 'Commit options for ' + commit.short,
      title: 'Commit options',
      disabled: !!busy,
      onClick: (e) => { e.stopPropagation(); setOpen((v) => !v); }
    }, '⋯'),
    h('div', { class: 'gm__commit-menu-pop', hidden: !open, role: 'menu', onClick: (e) => e.stopPropagation() },
      h('button', { type: 'button', role: 'menuitem', onClick: () => pick('copy-hash') }, 'Copy hash'),
      h('button', { type: 'button', role: 'menuitem', onClick: () => pick('copy-message') }, 'Copy message'),
      h('div', { class: 'gm__commit-menu-sep', role: 'separator' }),
      h('button', { type: 'button', role: 'menuitem', disabled: !!busy, onClick: () => pick('checkout') }, 'Checkout'),
      h('button', { type: 'button', role: 'menuitem', disabled: !!busy, onClick: () => pick('cherry-pick') }, 'Cherry-pick'),
      h('button', { type: 'button', role: 'menuitem', disabled: !!busy, onClick: () => pick('revert') }, 'Revert')
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

// What each confirm sheet says. `confirm` is { kind, ...payload }.
function confirmCopy(confirm) {
  if (confirm.kind === 'stash-drop') {
    return {
      title: 'Drop stash?',
      message: 'Delete ' + confirm.stash.index + (confirm.stash.subject ? ' "' + confirm.stash.subject + '"' : '') + '. This cannot be undone.',
      label: 'Drop'
    };
  }
  const c = confirm.commit;
  if (confirm.kind === 'checkout') {
    return { title: 'Checkout commit?', message: 'Check out ' + c.short + ' as a detached HEAD. Any current changes must be committed or stashed first.', label: 'Checkout' };
  }
  if (confirm.kind === 'cherry-pick') {
    return { title: 'Cherry-pick commit?', message: 'Apply ' + c.short + ' "' + c.subject + '" onto the current branch as a new commit.', label: 'Cherry-pick' };
  }
  return { title: 'Revert commit?', message: 'Create a new commit that undoes ' + c.short + ' "' + c.subject + '".', label: 'Revert' };
}

export function GitModal(props) {
  const { projectDir, onClose } = props;
  const [state, dispatch] = useReducer(gitReducer, initialGitState);
  // Async handlers read the latest state through this ref, so a handler
  // created in an earlier render never acts on stale `busy` / `generation`.
  const stateRef = useRef(state);
  stateRef.current = state;
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  const loadSeq = useRef(0);

  // Fetch /api/git/info. Only the newest request may update state, so two
  // quick refreshes cannot land out of order. Resolves to '' or the error.
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const send = (a) => { if (aliveRef.current && seq === loadSeq.current) dispatch(a); };
    if (!projectDir) {
      send({ type: 'load-error', error: 'No project selected' });
      return 'No project selected';
    }
    send({ type: 'load-start' });
    let error = '';
    try {
      const params = new URLSearchParams({ projectDir });
      const r = await fetchJson('/api/git/info?' + params.toString());
      if (r.status !== 200) error = (r.body && r.body.error) || 'HTTP ' + r.status;
      else if (!r.body || r.body.ok === false) error = (r.body && r.body.error) || 'Not a git repository';
      else send({ type: 'load-ok', data: r.body });
    } catch (err) {
      error = String(err);
    }
    if (error) send({ type: 'load-error', error });
    return error;
  }, [projectDir]);

  useEffect(() => { load(); }, [load]);

  // Run one git action, then refresh. `busy` stays set through the refresh,
  // and the success / failure notice is set after it, so it is never wiped.
  const runAction = useCallback(async (body, noticeArg) => {
    if (stateRef.current.busy) return;
    dispatch({ type: 'busy', action: body.action });
    const res = await postGit(projectDir, body);
    if (!aliveRef.current) return;
    if (!res.ok) {
      dispatch({ type: 'done', notice: { text: failureText(body.action, res), tone: 'error' } });
      // A failed pull / checkout / cherry-pick can still change the tree
      // (conflicts, partial merges), so refresh anyway.
      if (body.action !== 'add' && body.action !== 'unstage' && body.action !== 'commit') load();
      return;
    }
    const refreshError = await load();
    if (!aliveRef.current) return;
    const text = successText(body.action, noticeArg);
    dispatch({
      type: 'done',
      clearMessage: body.action === 'commit',
      notice: refreshError
        ? { text: refreshError, tone: 'error' }
        : text ? { text, tone: 'ok' } : null
    });
  }, [projectDir, load]);

  const onFileAction = useCallback((action, file) => {
    runAction({ action, files: pathsFor(file) });
  }, [runAction]);

  const stageAll = useCallback(() => {
    const unstaged = (stateRef.current.data && stateRef.current.data.unstaged) || [];
    const files = [].concat(...unstaged.map(pathsFor));
    if (files.length) runAction({ action: 'add', files });
  }, [runAction]);

  const commit = useCallback(() => {
    const s = stateRef.current;
    const staged = (s.data && s.data.staged) || [];
    if (s.busy || staged.length === 0) return;
    const message = s.commitMessage.trim();
    if (!message) {
      dispatch({ type: 'notice', notice: { text: 'Enter a commit message', tone: 'error' } });
      return;
    }
    runAction({ action: 'commit', message });
  }, [runAction]);

  const checkoutBranch = useCallback((value) => {
    const s = stateRef.current;
    if (s.busy || !value || value === (s.data && s.data.branch)) return;
    const option = branchOptions(s.data).find((o) => o.name === value);
    if (!option) return;
    runAction(option.remote ? { action: 'checkout', args: value, track: true } : { action: 'checkout', args: value }, value);
  }, [runAction]);

  // Copy actions run immediately; checkout / cherry-pick / revert move HEAD
  // or create a commit, so they open the confirm sheet first.
  const onCommitAction = useCallback(async (c, action) => {
    if (stateRef.current.busy) return;
    if (action === 'copy-hash' || action === 'copy-message') {
      const ok = await copyText(action === 'copy-hash' ? c.hash : c.subject);
      if (!aliveRef.current) return;
      const text = ok ? (action === 'copy-hash' ? 'Copied hash ' + c.short : 'Copied message') : 'Copy failed';
      dispatch({ type: 'notice', notice: { text, tone: ok ? 'ok' : 'error' } });
      return;
    }
    if (action === 'checkout' || action === 'cherry-pick' || action === 'revert') {
      dispatch({ type: 'confirm', confirm: { kind: action, commit: c } });
    }
  }, []);

  const runConfirm = useCallback(() => {
    const confirm = stateRef.current.confirm;
    if (!confirm) return;
    if (confirm.kind === 'stash-drop') {
      runAction({ action: 'stash-drop', args: confirm.stash.index }, confirm.stash.index);
    } else {
      runAction({ action: confirm.kind, args: confirm.commit.hash }, confirm.commit.short);
    }
  }, [runAction]);

  const cancelConfirm = useCallback(() => dispatch({ type: 'cancel-confirm' }), []);

  const loadMoreCommits = useCallback(async () => {
    const s = stateRef.current;
    if (s.loadingMore) return;
    const generation = s.generation;
    dispatch({ type: 'more-start' });
    try {
      const params = new URLSearchParams({ projectDir, offset: String(s.commits.length), count: String(COMMIT_PAGE) });
      const r = await fetchJson('/api/git/commits?' + params.toString());
      if (!aliveRef.current) return;
      if (r.status === 200 && r.body && r.body.ok) {
        dispatch({ type: 'more-ok', generation, commits: r.body.commits || [], total: r.body.total || 0 });
      } else {
        dispatch({ type: 'more-error', generation, error: (r.body && r.body.error) || 'HTTP ' + r.status });
      }
    } catch (err) {
      if (aliveRef.current) dispatch({ type: 'more-error', generation, error: String(err) });
    }
  }, [projectDir]);

  // Escape, the Tab cycle and focus restore come from the shared sheet hook
  // (frontend/src/hooks/useModal.js). The confirm sheet pushes its own modal
  // on top, and only the top-most sheet answers Escape (hooks/modalStack.js),
  // so each sheet only needs its own close action.
  const sheetRef = useModal({ onClose });
  const confirmSheetRef = useModal({ onClose: cancelConfirm, active: !!state.confirm });

  const { data, busy, notice, confirm } = state;
  const staged = (data && data.staged) || [];
  const unstaged = (data && data.unstaged) || [];
  const stashes = (data && data.stashes) || [];
  const branch = (data && data.branch) || '';
  const detached = (data && data.detached) || '';
  const options = branchOptions(data);
  const ahead = (data && data.ahead) || 0;
  const behind = (data && data.behind) || 0;
  const ready = state.status === 'ready';
  const toggle = (id) => dispatch({ type: 'toggle-section', id });

  let body;
  if (state.status === 'loading') {
    body = h('div', { class: 'gm__empty' }, 'Loading git status\u2026');
  } else if (state.status === 'error') {
    body = h('div', { class: 'gm__error' },
      h('p', null, state.error),
      h('button', { class: 'btn', type: 'button', onClick: load }, 'Retry')
    );
  } else {
    body = h(Fragment, null,
      h(Section, {
        id: 'stash',
        title: 'Stash',
        count: stashes.length,
        open: sectionOpen(state, 'stash'),
        onToggle: toggle
      },
        h('div', { class: 'gm__stash-toolbar' },
          h('button', {
            class: 'gm__stash-btn gm__stash-btn--stashup',
            type: 'button',
            disabled: !!busy,
            onClick: () => runAction({ action: 'stash' }),
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
          : stashes.map((s) => h(StashRow, {
            key: s.index,
            stash: s,
            busy: !!busy,
            onApply: (ref) => runAction({ action: 'stash-apply', args: ref }, ref),
            onPop: (ref) => runAction({ action: 'stash-pop', args: ref }, ref),
            onDrop: () => dispatch({ type: 'confirm', confirm: { kind: 'stash-drop', stash: s } })
          }))
      ),
      h(Section, {
        id: 'staged',
        title: 'Staged changes',
        count: staged.length,
        open: sectionOpen(state, 'staged'),
        onToggle: toggle
      },
        h('div', { class: 'gm__commit-bar' },
          h('input', {
            class: 'input gm__commit-input',
            type: 'text',
            value: state.commitMessage,
            onInput: (e) => dispatch({ type: 'message', value: e.currentTarget.value }),
            placeholder: 'Commit message',
            'aria-label': 'Commit message',
            enterkeyhint: 'done',
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
        ),
        staged.length === 0
          ? h('div', { class: 'gm__empty' }, 'Nothing staged')
          : staged.map((f) => h(FileRow, { key: f.path, file: f, action: 'unstage', onAction: onFileAction, busy: !!busy }))
      ),
      h(Section, {
        id: 'unstaged',
        title: 'Unstaged changes',
        count: unstaged.length,
        open: sectionOpen(state, 'unstaged'),
        onToggle: toggle
      },
        unstaged.length === 0
          ? h('div', { class: 'gm__empty' }, 'Working tree clean')
          : h(Fragment, null,
            unstaged.map((f) => h(FileRow, { key: f.path, file: f, action: 'add', onAction: onFileAction, busy: !!busy })),
            h('button', {
              class: 'gm__stage-all',
              type: 'button',
              disabled: !!busy,
              onClick: stageAll,
              'aria-label': 'Stage all unstaged changes',
              title: 'Stage all unstaged changes'
            }, 'Stage all (' + unstaged.length + ')')
          )
      ),
      h(Section, {
        id: 'commits',
        title: 'Recent commits',
        count: state.commitTotal || state.commits.length,
        open: sectionOpen(state, 'commits'),
        onToggle: toggle
      },
        state.commits.length === 0
          ? h('div', { class: 'gm__empty' }, 'No commits yet')
          : h(Fragment, null,
            state.commits.map((c) => h(CommitRow, { key: c.hash, projectDir, commit: c, busy: !!busy, onAction: onCommitAction })),
            state.moreError ? h('div', { class: 'gm__empty gm__empty--error', role: 'alert' }, state.moreError) : null,
            hasMoreCommits(state)
              ? h('button', {
                class: 'gm__load-more',
                type: 'button',
                disabled: state.loadingMore,
                onClick: loadMoreCommits
              }, state.loadingMore ? 'Loading\u2026' : state.moreError ? 'Retry' : 'Load more')
              : null
          )
      )
    );
  }

  return h('div', { class: 'gm__overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Git' },
    h('div', { class: 'gm__sheet', ref: sheetRef, 'aria-busy': state.refreshing || !!busy ? 'true' : undefined },
      h('div', { class: 'gm__head' },
        h('label', { class: 'gm__branch-wrap' },
          h('span', { class: 'gm__branch-label' }, 'Branch'),
          h('select', {
            class: 'gm__branch-select',
            value: branch,
            disabled: !ready || !!busy,
            onChange: (e) => checkoutBranch(e.currentTarget.value),
            'aria-label': 'Branch'
          },
            !branch
            ? h('option', { value: '', disabled: true }, detached ? 'detached at ' + detached : '(none)')
            : !options.some((o) => o.name === branch)
            // An unborn branch (no commits yet) has no ref to list.
            ? h('option', { value: branch }, branch)
            : null,
            options.filter((o) => !o.remote).map((o) => h('option', { key: o.name, value: o.name }, o.name)),
            options.some((o) => o.remote)
              ? h('optgroup', { label: 'Remote' },
                options.filter((o) => o.remote).map((o) => h('option', { key: o.name, value: o.name }, o.name)))
              : null
          )
        ),
        h(HeadButton, {
          label: 'Pull from remote', title: 'Pull', count: behind, countText: 'behind',
          disabled: !ready || !!busy, onClick: () => runAction({ action: 'pull' }),
          path: 'M11 3v9.6L8.4 10 7 11.4l5 5 5-5L15.6 10 13 12.6V3h-2Zm-7 15h16v2H4v-2Z'
        }),
        h(HeadButton, {
          label: 'Push to remote', title: 'Push', count: ahead, countText: 'ahead',
          disabled: !ready || !!busy, onClick: () => runAction({ action: 'push' }),
          path: 'M12 3a1 1 0 0 1 .7.3l5 5-1.4 1.4L13 7.4V20h-2V7.4L7.7 9.7 6.3 8.3l5-5A1 1 0 0 1 12 3Z'
        }),
        h(HeadButton, {
          label: 'Refresh git status', title: 'Refresh', size: 16,
          extraClass: state.refreshing ? ' gm__iconbtn--spinning' : '',
          disabled: state.status === 'loading' || state.refreshing || !!busy, onClick: load,
          path: 'M12 4V1L7 6l5 5V7c3.31 0 6 2.69 6 6 0 1-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 13c0-4.42-3.58-8-8-8Zm-5.3 7.7A7.93 7.93 0 0 0 4 13c0 4.42 3.58 8 8 8v3l5-5-5-5v3c-3.31 0-6-2.69-6-6 0-1 .25-1.97.7-2.8L5.24 10.24Z'
        }),
        h(HeadButton, {
          label: 'Close', title: 'Close', size: 16, extraClass: ' icon-btn--close',
          onClick: onClose,
          path: 'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.88 18.3 9.17 12 2.88 5.71 4.3 4.3l6.29 6.29 6.3-6.29 1.41 1.41Z'
        })
      ),
      notice
        ? h('div', {
          class: 'gm__notice' + (notice.tone === 'ok' ? ' gm__notice--ok' : ''),
          role: notice.tone === 'ok' ? 'status' : 'alert'
        }, notice.text)
        : null,
      h('div', { class: 'gm__body' }, body)
    ),
    confirm ? h(GitConfirm, {
      confirm,
      busy: !!busy,
      sheetRef: confirmSheetRef,
      onCancel: cancelConfirm,
      onConfirm: runConfirm
    }) : null
  );
}

// A header icon button with an optional ahead / behind count badge.
function HeadButton({ label, title, count, countText, disabled, onClick, path, size, extraClass }) {
  const suffix = count > 0 ? ' (' + count + ' ' + countText + ')' : '';
  return h('button', {
    class: 'icon-btn gm__iconbtn' + (count > 0 ? ' gm__iconbtn--has-count' : '') + (extraClass || ''),
    type: 'button',
    onClick,
    disabled: !!disabled,
    'aria-label': label + suffix,
    title: title + suffix
  },
    count > 0 ? h('span', { class: 'gm__iconbtn-badge' }, count) : null,
    h('svg', { viewBox: '0 0 24 24', width: size || 18, height: size || 18, 'aria-hidden': 'true' },
      h('path', { d: path, fill: 'currentColor' })
    )
  );
}

// In-app confirmation for the modal's destructive actions: a commit's
// checkout (moves HEAD to a detached commit), cherry-pick and revert (create
// new commits), and a stash drop (deletes it). Stays open while the action
// runs, so the confirm button can show "Working…". Layers over the Git
// modal, honors the safe-area inset, and keeps both buttons ≥44px. Rendered
// with its own classes rather than the Inspector's ConfirmSheet because
// inspector.css is lazy-loaded and may not be present in the chat view.
function GitConfirm({ confirm, busy, onCancel, onConfirm, sheetRef }) {
  const { title, message, label } = confirmCopy(confirm);
  return h('div', { class: 'gm__overlay gm__confirm', role: 'presentation', onClick: busy ? undefined : onCancel },
    h('div', { class: 'gm__sheet gm__confirm-sheet', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title, ref: sheetRef, onClick: (e) => e.stopPropagation() },
      h('div', { class: 'gm__confirm-body' },
        h('strong', { class: 'gm__confirm-title' }, title),
        h('p', { class: 'gm__confirm-msg' }, message),
        h('div', { class: 'gm__confirm-actions' },
          h('button', { class: 'btn gm__confirm-cancel', type: 'button', disabled: busy, onClick: onCancel }, 'Cancel'),
          h('button', {
            class: 'btn gm__confirm-go',
            type: 'button',
            'data-danger': '1',
            disabled: busy,
            onClick: onConfirm
          }, busy ? 'Working\u2026' : label)
        )
      )
    )
  );
}

// One collapsible section. Open state is owned by the modal's reducer, so
// it survives a refresh.
function Section({ id, title, count, open, onToggle, children }) {
  return h('div', { class: 'gm__section' },
    h('button', {
      class: 'gm__section-head' + (open ? ' is-open' : ''),
      type: 'button',
      onClick: () => onToggle(id),
      'aria-expanded': String(open),
      'aria-controls': 'gm-section-' + id
    },
      h('span', { class: 'gm__section-caret', 'aria-hidden': 'true' }, open ? '\u25BE' : '\u25B8'),
      h('span', { class: 'gm__section-title' }, title),
      h('span', { class: 'gm__section-count' }, count || '')
    ),
    open ? h('div', { id: 'gm-section-' + id, class: 'gm__section-body' }, children) : null
  );
}

// Stash row: one stash with Apply / Pop / Drop actions. Drop asks first.
function StashRow({ stash, busy, onApply, onPop, onDrop }) {
  return h('div', { class: 'gm__stash-row' },
    h('span', { class: 'gm__stash-index' }, stashNum(stash.index)),
    h('span', { class: 'gm__stash-main' },
      h('span', { class: 'gm__stash-subject', title: stash.subject }, stash.subject),
      stash.date ? h('span', { class: 'gm__stash-date' }, stash.date) : null
    ),
    h('div', { class: 'gm__stash-actions' },
      h('button', { class: 'gm__stash-btn', type: 'button', disabled: busy, onClick: () => onApply(stash.index), title: 'Apply stash without removing it' }, 'Apply'),
      h('button', { class: 'gm__stash-btn', type: 'button', disabled: busy, onClick: () => onPop(stash.index), title: 'Apply stash and remove it' }, 'Pop'),
      h('button', { class: 'gm__stash-btn gm__stash-btn--danger', type: 'button', disabled: busy, onClick: onDrop, title: 'Delete stash' }, 'Drop')
    )
  );
}
