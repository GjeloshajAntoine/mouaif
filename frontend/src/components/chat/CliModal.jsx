// mouaif web — CLI modal (Command Prompt-style interactive terminal)
//
// Full-screen overlay like the Git modal. Opens a persistent shell
// session on the server for THIS project — the default working
// directory is the project root, so every command runs there. Output
// streams in over the /api/events SSE channel; each prompt line you
// type is POSTed to /api/tools/cli/command and executed by the same
// persistent child process (cmd.exe on Windows, the user's $SHELL on
// POSIX).
//
// The session starts on mount, closes when the modal unmounts or the
// user taps the close button. The screen shows a live terminal readout
// with the shell label + project dir in the header.

import { h } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { fetchJson } from '../../api.js';

export function CliModal(props) {
  const { projectDir, onClose } = props;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shellLabel, setShellLabel] = useState('');
  const [dirLabel, setDirLabel] = useState(projectDir || '');
  const [busy, setBusy] = useState(false);

  const outRef = useRef(null);       // <pre> terminal output
  const inputRef = useRef(null);
  const sessionIdRef = useRef(null);
  const evtSourceRef = useRef(null);
  const outBufferRef = useRef('');   // accumulated output (rendered on tick)

  const appendOut = useCallback((text, stream) => {
    if (stream === 'exit') {
      outBufferRef.current += '\n\u00A0\u2514\u2500 process exited with code ' + text + '\n';
      flush();
      return;
    }
    const t = String(text || '');
    if (!t) return;
    // Carriage returns show up as line advances in a pipe; keep them
    // literally so progress bars and \b output render naturally.
    outBufferRef.current += t;
    flush();
  }, []);

  // Flush the buffer into the DOM (throttled for large streams).
  function flush() {
    if (!outRef.current) return;
    outRef.current.textContent = outBufferRef.current;
    const el = outRef.current;
    el.scrollTop = el.scrollHeight;
  }

  // ---- session start ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let evtSource = null;
    async function start() {
      try {
        const r = await fetchJson('/api/tools/cli/session?projectDir=' + encodeURIComponent(projectDir || ''));
        if (cancelled) return;
        if (r.status !== 200) {
          setError((r.body && r.body.error) || ('HTTP ' + r.status));
          setLoading(false);
          return;
        }
        sessionIdRef.current = r.body.id;
        setShellLabel(r.body.shell || '');
        if (r.body.projectDir) setDirLabel(r.body.projectDir);
        // The session id is ready — open the SSE channel and listen
        // for this session's cli_output frames.
        evtSource = new EventSource('/events');
        evtSourceRef.current = evtSource;
        evtSource.addEventListener('cli_output', (e) => {
          let data;
          try { data = JSON.parse(e.data); } catch { return; }
          if (!data || data.id !== sessionIdRef.current) return;
          appendOut(data.data, data.stream);
        });
        setLoading(false);
        // Focus the prompt once the screen is up.
        if (inputRef.current) inputRef.current.focus();
      } catch (err) {
        if (!cancelled) { setError(String(err)); setLoading(false); }
      }
    }
    start();
    return () => {
      cancelled = true;
      if (evtSource) evtSource.close();
      // Close the server session when the modal unmounts.
      if (sessionIdRef.current) {
        fetchJson('/api/tools/cli/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectDir })
        }).catch(() => {});
      }
    };
  }, [projectDir]);

  // Close on Escape (same pattern as the Git modal).
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

  async function runCommand() {
    const el = inputRef.current;
    if (!el) return;
    const cmd = el.value;
    el.value = '';
    if (!cmd.trim()) return;
    setBusy(true);
    try {
      const r = await fetchJson('/api/tools/cli/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, cmd })
      });
      if (r.status !== 200) {
        appendOut('\n' + ((r.body && r.body.error) || ('HTTP ' + r.status)) + '\n', 'stderr');
      }
    } catch (err) {
      appendOut('\nerror: ' + String(err) + '\n', 'stderr');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.focus();
    }
  }

  return h('div', { class: 'cli__overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command prompt' },
    h('div', { class: 'cli__sheet' },
      h('div', { class: 'cli__head' },
        h('div', { class: 'cli__title-stack' },
          h('span', { class: 'cli__title' }, shellLabel ? ('CLI — ' + shellLabel) : 'CLI'),
          h('span', { class: 'cli__dir', title: dirLabel }, dirLabel)
        ),
        h('button', {
          class: 'cli__iconbtn cli__iconbtn--close',
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
      h('div', { class: 'cli__body' },
        loading
          ? h('div', { class: 'cli__empty' }, 'Starting command prompt\u2026')
          : error
            ? h('div', { class: 'cli__error' },
                h('p', null, error),
                h('button', { class: 'btn', type: 'button', onClick: onClose }, 'Close')
              )
            : h('div', { class: 'cli__terminal' },
                h('pre', { ref: outRef, class: 'cli__out', 'aria-label': 'Command output', tabindex: '-1' }),
                h('div', { class: 'cli__prompt-row' },
                  h('span', { class: 'cli__prompt-mark', 'aria-hidden': 'true' }, '❯'),
                  h('input', {
                    ref: inputRef,
                    class: 'input cli__prompt',
                    type: 'text',
                    placeholder: 'Type a command — runs in the project folder',
                    'aria-label': 'Command line',
                    autocomplete: 'off',
                    autocapitalize: 'off',
                    spellcheck: 'false',
                    disabled: busy,
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') { e.preventDefault(); runCommand(); }
                    }
                  })
                )
              )
      )
    )
  );
}