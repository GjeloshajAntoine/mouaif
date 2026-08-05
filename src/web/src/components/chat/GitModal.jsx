// mouaif web — Git modal (full-screen overlay like the file editor)
//
// Rendered on top of the chat view when the user taps the git button
// in the composer toolbar. Fetches parsed git data from
// GET /api/git/info and renders a header plus a tabbed body.
//
// Header: a branch dropdown + Push / Pull buttons + refresh / close.
// Tabs:   Staged changes · Unstaged changes · Recent commits · Stash.
// Sections and rows keep their own open/closed state so the user can
// drill into exactly what they need without leaving the composer.

import { h, Fragment } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { fetchJson } from '../../api.js';

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

// Diff line rendering: colour +/-/@@ header lines. Rendered as a
// <pre> with per-line classes for simple, dependency-free syntax.
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

// A single changed-file row: path + status chip on the left, a
// chevron on the right; tapping toggles the inline diff.
function FileRow({ file, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const hasDiff = !!(file.diff && file.diff.trim());
  return h('div', { class: 'gm__file' },
    h('button', {
      class: 'gm__file-head' + (open ? ' is-open' : ''),
      type: 'button',
      onClick: () => setOpen(!open),
      'aria-expanded': String(open),
      'aria-label': (hasDiff ? 'Toggle diff for ' : '') + file.path
    },
      h('span', { class: 'gm__file-status gm__file-status--' + file.status }, file.statusText || file.status),
      h('span', { class: 'gm__file-path', title: file.path }, file.path),
      hasDiff ? h('span', { class: 'gm__file-caret', 'aria-hidden': 'true' }, open ? '\u25BE' : '\u25B8') : null
    ),
    open && hasDiff ? h(DiffView, { diff: file.diff }) : null
  );
}

// A single commit: short hash + subject + author/date on the head;
// expands into its changed files, each of which expands into a diff.
function CommitRow({ commit }) {
  const [open, setOpen] = useState(false);
  const files = commit.files || [];
  return h('div', { class: 'gm__commit' },
    h('button', {
      class: 'gm__commit-head' + (open ? ' is-open' : ''),
      type: 'button',
      onClick: () => setOpen(!open),
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
    open && h('div', { class: 'gm__commit-body' },
      files.length === 0
        ? h('div', { class: 'gm__empty' }, 'No file changes in this commit')
        : files.map((f, i) => h(FileRow, { key: f.path + '-' + i, file: f }))
    )
  );
}

// 2026-07-31T16:51:38+02:00 -> "31 Jul 2026, 16:51" (local time).
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const opts = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
  try { return d.toLocaleString(undefined, opts); } catch { return iso; }
}

// Short status from a stash ref label like "stash@{0}" -> "0".
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
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (!projectDir) { setLoading(false); setError('No project selected'); return; }
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError('');
    setNotice('');
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
      }
    } catch (err) {
      setError(String(err));
    }
    setLoading(false);
    loadingRef.current = false;
  }, [projectDir]);

  useEffect(() => { load(); }, [load]);

  // Close on Escape; stop the chat view's own Escape handler from
  // fighting us. (useChatState also closes the file editor on Escape,
  // but this modal is not tracked there.)
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (onClose) onClose();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Run a git action, then refresh the info payload.
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

  function checkoutBranch(name) {
    if (busy || name === (data && data.branch)) return;
    doGit('checkout', name);
  }

  const staged = (data && data.staged) || [];
  const unstaged = (data && data.unstaged) || [];
  const commits = (data && data.commits) || [];
  const stashes = (data && data.stashes) || [];
  const branch = (data && data.branch) || '';
  const branches = (data && data.branches) || [];

  return h('div', { class: 'gm__overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Git' },
    h('div', { class: 'gm__sheet' },
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
          class: 'gm__iconbtn',
          type: 'button',
          onClick: () => doGit('pull'),
          disabled: !!busy,
          'aria-label': 'Pull from remote',
          title: 'Pull'
        },
          h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
            h('path', { d: 'M11 3v9.6L8.4 10 7 11.4l5 5 5-5L15.6 10 13 12.6V3h-2Zm-7 15h16v2H4v-2Z', fill: 'currentColor' })
          )
        ),
        h('button', {
          class: 'gm__iconbtn',
          type: 'button',
          onClick: () => doGit('push'),
          disabled: !!busy,
          'aria-label': 'Push to remote',
          title: 'Push'
        },
          h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
            h('path', { d: 'M12 3a1 1 0 0 1 .7.3l5 5-1.4 1.4L13 7.4V20h-2V7.4L7.7 9.7 6.3 8.3l5-5A1 1 0 0 1 12 3Z', fill: 'currentColor' })
          )
        ),
        h('button', {
          class: 'gm__iconbtn',
          type: 'button',
          onClick: () => doGit('stash'),
          disabled: !!busy,
          'aria-label': 'Stash working changes',
          title: 'Stash up'
        },
          h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
            h('path', { d: 'M12 4v9.6L9.4 11 8 12.4l5 5 5-5-1.4-1.4L14 13.6V4h-2ZM5 20h14v2H5v-2Z', fill: 'currentColor' })
          )
        ),
        h('button', {
          class: 'gm__iconbtn',
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
          class: 'gm__iconbtn gm__iconbtn--close',
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
                h(Section, {
                  id: 'staged',
                  title: 'Staged changes',
                  files: staged,
                  defaultOpen: staged.length > 0,
                  emptyText: 'Nothing staged'
                }),
                h(Section, {
                  id: 'unstaged',
                  title: 'Unstaged changes',
                  files: unstaged,
                  defaultOpen: unstaged.length > 0,
                  emptyText: 'Working tree clean'
                }),
                h(Section, {
                  id: 'commits',
                  title: 'Recent commits',
                  files: commits,
                  defaultOpen: false,
                  emptyText: 'No commits yet',
                  renderFile: (c, i) => h(CommitRow, { key: c.hash || i, commit: c })
                }),
                h(Section, {
                  id: 'stash',
                  title: 'Stash',
                  files: stashes,
                  defaultOpen: false,
                  emptyText: 'No stashed changes',
                  renderFile: (s, i) => h(StashRow, { key: i, stash: s, busy, onApply: (r) => doGit('stash-apply', r), onPop: (r) => doGit('stash-pop', r), onDrop: (r) => doGit('stash-drop', r) })
                })
              )
      )
    )
  );
}

// One collapsible section (e.g. "Staged changes"): header row with a
// count + chevron, then the file rows.
function Section({ id, title, files, defaultOpen, emptyText, renderFile }) {
  const [open, setOpen] = useState(defaultOpen);
  const count = files ? files.length : 0;
  const renderRow = renderFile || ((f, i) => h(FileRow, { key: f.path + '-' + i, file: f }));
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
