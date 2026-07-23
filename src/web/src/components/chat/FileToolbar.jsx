// mouaif web — File/git toolbar button (inline inside composer pill)
//
// Sits as the first element inside .chat-view__composer: a round button
// with a stacked ▲▼ arrow icon. Opens a dropdown menu with file editor
// and git actions. The menu is positioned above the composer.

import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { fetchJson } from '../../api.js';

// Git action result card (shown inline after execution)
function ResultCard({ action, result }) {
  if (!result) return null;
  const ok = result.ok;
  return h('div', { class: 'file-toolbar__result' },
    h('div', { class: 'file-toolbar__result-head' },
      h('span', { class: 'file-toolbar__result-action' }, action),
      h('span', { class: 'file-toolbar__result-status' + (ok ? ' is-ok' : ' is-err') }, ok ? 'OK' : 'exit ' + result.exitCode)
    ),
    result.stdout ? h('pre', { class: 'file-toolbar__result-out' }, result.stdout) : null,
    result.stderr ? h('pre', { class: 'file-toolbar__result-err' }, result.stderr) : null,
    result.error ? h('pre', { class: 'file-toolbar__result-err' }, result.error) : null
  );
}

export function FileToolbar(props) {
  const { projectDir, onOpenFileEditor } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [gitAction, setGitAction] = useState(null);
  const [gitArgs, setGitArgs] = useState('');
  const [gitMessage, setGitMessage] = useState('');
  const [running, setRunning] = useState(null);
  const [result, setResult] = useState(null);
  const menuRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
        setGitAction(null);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  useEffect(() => {
    if (gitAction && (gitAction === 'add' || gitAction === 'commit') && inputRef.current) {
      inputRef.current.focus();
    }
  }, [gitAction]);

  async function runGit(action, args, message) {
    if (!projectDir) return;
    setRunning(action);
    setResult(null);
    try {
      const r = await fetchJson('/api/git', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, action, args: args || '', message: message || '' })
      });
      if (r.status === 200) {
        setResult({ action, ...r.body });
      } else {
        setResult({ action, ok: false, error: r.body.error || 'HTTP ' + r.status, stdout: '', stderr: '', exitCode: -1 });
      }
    } catch (err) {
      setResult({ action, ok: false, error: String(err), stdout: '', stderr: '', exitCode: -1 });
    }
    setRunning(null);
  }

  function handleGitClick(action) {
    if (action === 'add') { setGitAction('add'); setGitArgs(''); setResult(null); return; }
    if (action === 'commit') { setGitAction('commit'); setGitMessage(''); setResult(null); return; }
    setGitAction(null);
    runGit(action, '', '');
  }

  function handleAddSubmit(e) { e.preventDefault(); if (!gitArgs.trim()) return; const args = gitArgs.trim(); setGitAction(null); runGit('add', args, ''); }
  function handleCommitSubmit(e) { e.preventDefault(); if (!gitMessage.trim()) return; const msg = gitMessage.trim(); setGitAction(null); runGit('commit', '', msg); }
  function handleFileEditor() { setMenuOpen(false); if (onOpenFileEditor) onOpenFileEditor(); }

  return h('div', { class: 'file-toolbar' },
    h('button', {
      class: 'file-toolbar__trigger',
      type: 'button',
      onClick: () => {
        setMenuOpen(!menuOpen);
        setGitAction(null);
        setResult(null);
      },
      'aria-label': 'File tools',
      'aria-haspopup': 'true',
      'aria-expanded': String(menuOpen),
      title: 'File and git tools'
    },
      h('svg', { viewBox: '0 0 20 20', width: 20, height: 20, 'aria-hidden': 'true', class: 'file-toolbar__icon' },
        h('path', { d: 'M2 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5Z', fill: 'currentColor', opacity: '0.85' }),
        h('path', { d: 'M10 13l-3-4h6l-3 4Z', fill: 'currentColor' })
      )
    ),
    menuOpen && h('div', { ref: menuRef, class: 'file-toolbar__menu', role: 'menu' },
      h('button', { class: 'file-toolbar__menu-item', role: 'menuitem', type: 'button', onClick: handleFileEditor },
        h('span', { class: 'file-toolbar__menu-icon' }, '📝'),
        h('span', null, 'File editor')
      ),
      h('div', { class: 'file-toolbar__menu-divider' }),
      h('div', { class: 'file-toolbar__menu-header' }, 'Git'),
      h('button', { class: 'file-toolbar__menu-item', role: 'menuitem', type: 'button', onClick: () => handleGitClick('status'), disabled: !!running },
        h('span', { class: 'file-toolbar__menu-icon' }, '🔍'),
        h('span', null, 'Status'),
        running === 'status' ? h('span', { class: 'file-toolbar__spinner' }, '…') : null
      ),
      h('button', { class: 'file-toolbar__menu-item', role: 'menuitem', type: 'button', onClick: () => handleGitClick('diff'), disabled: !!running },
        h('span', { class: 'file-toolbar__menu-icon' }, '📊'),
        h('span', null, 'Diff'),
        running === 'diff' ? h('span', { class: 'file-toolbar__spinner' }, '…') : null
      ),
      h('button', { class: 'file-toolbar__menu-item', role: 'menuitem', type: 'button', onClick: () => handleGitClick('log'), disabled: !!running },
        h('span', { class: 'file-toolbar__menu-icon' }, '📋'),
        h('span', null, 'Log'),
        running === 'log' ? h('span', { class: 'file-toolbar__spinner' }, '…') : null
      ),
      gitAction === 'add'
        ? h('form', { class: 'file-toolbar__inline-form', onSubmit: handleAddSubmit },
            h('input', { ref: inputRef, class: 'file-toolbar__inline-input', type: 'text', placeholder: 'file paths (e.g. src/)', value: gitArgs, onInput: (e) => setGitArgs(e.target.value), 'aria-label': 'Files to add' }),
            h('button', { class: 'file-toolbar__inline-submit', type: 'submit', disabled: !gitArgs.trim() || !!running }, 'Add')
          )
        : h('button', { class: 'file-toolbar__menu-item', role: 'menuitem', type: 'button', onClick: () => handleGitClick('add'), disabled: !!running },
            h('span', { class: 'file-toolbar__menu-icon' }, '➕'),
            h('span', null, 'Add'),
            running === 'add' ? h('span', { class: 'file-toolbar__spinner' }, '…') : null
          ),
      gitAction === 'commit'
        ? h('form', { class: 'file-toolbar__inline-form', onSubmit: handleCommitSubmit },
            h('input', { ref: inputRef, class: 'file-toolbar__inline-input', type: 'text', placeholder: 'commit message', value: gitMessage, onInput: (e) => setGitMessage(e.target.value), 'aria-label': 'Commit message' }),
            h('button', { class: 'file-toolbar__inline-submit', type: 'submit', disabled: !gitMessage.trim() || !!running }, 'Commit')
          )
        : h('button', { class: 'file-toolbar__menu-item', role: 'menuitem', type: 'button', onClick: () => handleGitClick('commit'), disabled: !!running },
            h('span', { class: 'file-toolbar__menu-icon' }, '💾'),
            h('span', null, 'Commit'),
            running === 'commit' ? h('span', { class: 'file-toolbar__spinner' }, '…') : null
          )
    ),
    result ? h(ResultCard, { action: result.action, result }) : null
  );
}