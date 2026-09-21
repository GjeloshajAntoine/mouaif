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
import { useModal } from '../../hooks/useModal.js';
import { CliScreen } from './utils.js';

export function CliModal(props) {
  const { projectDir, onClose } = props;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shellLabel, setShellLabel] = useState('');
  const [dirLabel, setDirLabel] = useState(projectDir || '');
  const [busy, setBusy] = useState(false);
  // True when the server session runs on a pseudo-terminal, so a program
  // that asks a question can read the answer typed into the prompt line.
  const [interactive, setInteractive] = useState(false);

  const outRef = useRef(null);       // <pre> terminal output
  const inputRef = useRef(null);
  const sessionIdRef = useRef(null);
  const evtSourceRef = useRef(null);
  const [outBuffer, setOutBuffer] = useState('');   // accumulated output

const screenRef = useRef(null);
if (!screenRef.current) screenRef.current = new CliScreen();
// Whether the user is "pinned" to the bottom. True while output streams
// normally (the last frame fills the view, so new rows scroll into view).
// Once the user drags up to read history, stop auto-scrolling so the view
// isn't yanked down on every refresh (the "scroll but refreshes" symptom).
const pinnedRef = useRef(true);
  const appendOut = useCallback((text, stream) => {
    if (!screenRef.current) screenRef.current = new CliScreen();
    if (stream === 'exit') {
      // Record the exit status as a trailing scrollback line below the current
      // frame (a TUI leaves its last frame in the grid, so it stays readable).
      screenRef.current.write('\r\n\u00A0\u2514\u2500 process exited with code ' + text + '\n');
      setOutBuffer(screenRef.current.render());
      return;
    }
    // The session is a piped (non-TTY) child, so full-screen programs (htop,
    // top, less) emit escape codes that arrive split across SSE frames. Feed
    // them to the stateful CliScreen, which buffers in-flight sequences and
    // rebuilds a text grid — so a TUI redraw replaces its frame in place
    // instead of appending raw `[39;49m` / `[8;1H` garbage each refresh.
    screenRef.current.write(String(text || ''));
    setOutBuffer(screenRef.current.render());
  }, []);

  // Render `outBuffer` into the <pre> and decide whether to auto-scroll.
//
// Two distinct cases:
//   * Full-screen TUI (htop / top / less) — the frame redraws *in place* at a
//     fixed height, so force-pinning to `scrollHeight` on every refresh would
//     yank the view down to the help row (the "scrolls down each time it
//     refreshes" symptom). Preserve the current scroll position instead.
//   * Normal scrollback — output grows downward. Pin to the bottom only while
//     the user is near the bottom; once they drag up to read history, stop
//     following so new rows don't yank the view around.
useEffect(() => {
const el = outRef.current;
if (!el) return;
const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
const full = screenRef.current ? screenRef.current.isFullScreen : false;
if (full) {
// In-place TUI redraw: keep whatever position the user is at. Setting
// textContent resets scrollTop, so capture and restore it.
const prevTop = el.scrollTop;
const prevHeight = el.scrollHeight;
el.textContent = outBuffer;
// If the user is pinned to the bottom, keep them pinned to the new
// bottom (the frame may have grown/shrunk a line); otherwise stay put.
if (pinnedRef.current || wasNearBottom) {
el.scrollTop = el.scrollHeight;
} else {
el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
}
} else if (pinnedRef.current || wasNearBottom) {
el.textContent = outBuffer;
el.scrollTop = el.scrollHeight;
} else {
const prevTop = el.scrollTop;
el.textContent = outBuffer;
el.scrollTop = prevTop;
}
}, [outBuffer]);
// Track whether the user has scrolled away from the bottom. Wire this via a
// callback ref so it attaches as soon as the <pre> mounts (the modal renders
// the terminal only after the session loads, so a mount-time effect sees a
// null node). While pinned, new output keeps the view glued to the latest
// row; when the user drags up we stop following so they can read history.
const attachOutRef = useCallback((node) => {
if (outRef.current && outRef.current._onScroll) {
outRef.current.removeEventListener('scroll', outRef.current._onScroll);
}
outRef.current = node;
if (node) {
const onScroll = () => {
pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
};
node._onScroll = onScroll;
node.addEventListener('scroll', onScroll, { passive: true });
}
}, []);
useEffect(() => {
return () => {
if (outRef.current && outRef.current._onScroll) {
outRef.current.removeEventListener('scroll', outRef.current._onScroll);
}
};
}, []);

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
        setInteractive(!!r.body.interactive);
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

  // Escape, the Tab cycle and focus restore come from the shared sheet hook
  // (frontend/src/hooks/useModal.js); the backdrop is this component's own.
  const sheetRef = useModal({ onClose: () => { if (onClose) onClose(); } });

  const [cmdText, setCmdText] = useState('');

  // send(text, raw) — POST one line to the session. `raw: true` omits the
  // line terminator, for a single-key answer to a prompt the program is
  // showing; a normal send terminates the line so the shell runs it. An
  // empty `text` sends a bare newline, which accepts an interactive
  // prompt's default. On a non-interactive session the server writes to
  // the piped child instead, which is unchanged.
  const send = useCallback(async (text, raw) => {
    setBusy(true);
    try {
      const r = await fetchJson('/api/tools/cli/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, cmd: text, raw: !!raw })
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
  }, [projectDir, appendOut]);

  async function runCommand() {
    // An empty line is meaningful to an interactive prompt (accept the
    // default) — forward it instead of ignoring the Enter.
    const cmd = cmdText;
    if (!cmd.trim() && !interactive) return;
    setCmdText('');
    await send(cmd, false);
  }

  return h('div', { class: 'cli__overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command prompt' },
    h('div', { class: 'cli__sheet', ref: sheetRef },
      h('div', { class: 'cli__head' },
        h('div', { class: 'cli__title-stack' },
          h('span', { class: 'cli__title' }, shellLabel ? ('CLI — ' + shellLabel) : 'CLI'),
          h('span', { class: 'cli__dir', title: dirLabel }, dirLabel),
          interactive
            ? h('span', { class: 'cli__badge', title: 'Interactive terminal — prompting programs can read your answer' }, 'interactive')
            : null
        ),
        h('button', {
          class: 'icon-btn icon-btn--close cli__iconbtn',
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
                h('pre', { ref: attachOutRef, class: 'cli__out', 'aria-label': 'Command output', tabindex: '-1' }),
                h('div', { class: 'cli__prompt-row' },
                  h('span', { class: 'cli__prompt-mark', 'aria-hidden': 'true' }, '❯'),
                  h('input', {
                    ref: inputRef,
                    class: 'input cli__prompt',
                    type: 'text',
                    value: cmdText,
                    onInput: (e) => setCmdText(e.currentTarget.value),
                    placeholder: 'Type a command — runs in the project folder',
                    'aria-label': 'Command line',
                    autocomplete: 'off',
                    autocapitalize: 'off',
                    spellcheck: 'false',
                    disabled: busy,
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        // Ctrl+Enter (or Cmd+Enter) sends the line with no
                        // terminator, for a program waiting on a single key.
                        if (e.ctrlKey || e.metaKey) {
                          const raw = cmdText;
                          setCmdText('');
                          send(raw, true);
                        } else {
                          runCommand();
                        }
                      }
                    }
                  })
                )
              )
      )
    )
  );
}