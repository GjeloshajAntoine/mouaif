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
// The session starts on mount; closing the modal only detaches, leaving
// the shell running in the background. The screen shows a live terminal readout
// with the shell label + project dir in the header.
//
// The compact footer has only the command field and Run. Suggestions while
// typing offer this session's commands and the project's top-level names;
// a chip only rewrites the field, and Enter still runs it (see cliSuggest.js).
// Tab completion remains available from a hardware or phone keyboard.
//
// Who reads stdin is taken from the shell itself: on a pseudo-terminal bash and
// zsh switch bracketed paste on at their prompt and off when a command starts
// (lineEditorState in ./cliKeys.js). That decides whether a sent line is
// remembered — an answer typed to
// a program (a password, a one-time code) never becomes a suggestion.
//
// A pty echoes the shell's command line itself, so the modal writes its own
// `❯ cmd` echo line only for a piped session, which echoes nothing.

import { h } from 'preact';
import { useState, useEffect, useMemo, useRef, useCallback } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { useModal } from '../../hooks/useModal.js';
import { keepEditorFocus, lineEditorState, splitTypedTab } from './cliKeys.js';
import { rememberCommand, suggestionsFor, completeLocally } from './cliSuggest.js';
import { CliScreen } from './utils.js';
import { useVisualViewport } from '../../hooks/useVisualViewport.js';
import { subscribeCliOutput } from './cliOutput.js';

export function CliModal(props) {
  const { projectDir, onClose } = props;
  const overlayRef = useRef(null);
  const syncViewport = useCallback((viewport) => {
    const el = overlayRef.current;
    if (!el) return;
    // Fixed overlays otherwise extend behind the phone's soft keyboard.
    el.style.setProperty('--cli-viewport-top', viewport.offsetTop + 'px');
    el.style.setProperty('--cli-viewport-height', viewport.height + 'px');
  }, []);
  useVisualViewport(syncViewport);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shellLabel, setShellLabel] = useState('');
  const [dirLabel, setDirLabel] = useState(projectDir || '');
  // The session's own commands, newest first — used by suggestions and
  // Tab completion (see rememberCommand in cliSuggest.js).
  const [history, setHistory] = useState([]);
  // `entries` — the project's top-level names, the file half of the suggestion
  // row (`null` until the listing answers: a fetch that has not happened
  // invents no chips).
  const [entries, setEntries] = useState(null);
  // True once the shell reported an `exit` frame (or the session endpoint
  // refused). The prompt row cannot reach a dead session, so the sheet offers
  // Restart instead of an input that silently 410s on every send.
  const [exited, setExited] = useState(false);
  // Bumped by Restart to re-run the session effect against a fresh child.
  const [restartKey, setRestartKey] = useState(0);

  const outRef = useRef(null);       // <pre> terminal output
  const inputRef = useRef(null);
  const outputSubscriptionRef = useRef(null);
  const [outBuffer, setOutBuffer] = useState('');   // accumulated output
  // Who is reading the session's stdin: 'shell' (its line editor is waiting),
  // 'program' (a command is running and may be asking a question), 'piped' (no
  // pseudo-terminal — nothing can prompt), or null (unknown: not started yet,
  // exited, or a shell that never says). On a pty the shell says so itself by
  // switching bracketed paste on and off around every command line (see
  // lineEditorState in cliKeys.js). Suggestions only remember lines sent to 'shell' or
  // 'piped', so a program's answer — possibly a password — is never kept.
  const ownerRef = useRef(null);
  const editorTailRef = useRef('');
  const setOwnerBoth = useCallback((next) => {
    if (ownerRef.current === next) return;
    ownerRef.current = next;
  }, []);
  const interactiveRef = useRef(false);

const screenRef = useRef(null);
if (!screenRef.current) screenRef.current = new CliScreen();
// Whether the user is "pinned" to the bottom. True while output streams
// normally (the last frame fills the view, so new rows scroll into view).
// Once the user drags up to read history, stop auto-scrolling so the view
// isn't yanked down on every refresh (the "scroll but refreshes" symptom).
const pinnedRef = useRef(true);
  // writeOut(text) — the single sink for everything that reaches the screen:
  // session output, the piped session's echo line, and request errors.
  const writeOut = useCallback((text) => {
    if (!screenRef.current) screenRef.current = new CliScreen();
    screenRef.current.write(String(text == null ? '' : text));
    setOutBuffer(screenRef.current.render());
  }, []);
  const appendOut = useCallback((text, stream) => {
    if (!screenRef.current) screenRef.current = new CliScreen();
    if (stream === 'exit') {
    // Record the exit status as a trailing scrollback line below the current
    // frame (a TUI leaves its last frame in the grid, so it stays readable).
    // The shell is gone, so what is on screen is no longer a live prompt.
    screenRef.current.write('\r\n\u00A0\u2514\u2500 process exited with code ' + text + '\n');
    setOutBuffer(screenRef.current.render());
    setOwnerBoth(null);
    // The session is gone: the header swaps Stop for Restart and the prompt
    // row is replaced, so a send can never 410 into a dead shell.
    setExited(true);
    return;
    }
      // On a pty, follow the shell's bracketed-paste markers to know who owns
      // stdin. The scan is over this chunk plus a few carried bytes, never the
      // whole buffer, so a long build costs the same per chunk as a short one.
      if (interactiveRef.current && stream !== 'stderr') {
      const next = lineEditorState(editorTailRef.current, text);
      editorTailRef.current = next.tail;
      if (next.state) setOwnerBoth(next.state);
      }
    // The session is a piped (non-TTY) child, so full-screen programs (htop,
    // top, less) emit escape codes that arrive split across SSE frames. Feed
    // them to the stateful CliScreen, which buffers in-flight sequences and
    // rebuilds a text grid — so a TUI redraw replaces its frame in place
    // instead of appending raw `[39;49m` / `[8;1H` garbage each refresh.
    writeOut(text);
  }, [writeOut, setOwnerBoth]);

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
}, [outBuffer, loading, error]);
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
    let outputSubscription = null;
    // A restart re-runs this effect; the previous session's exit line stays on
    // screen, so the fresh session is announced with a marker of its own.
    setExited(false);
    async function start() {
      try {
        const r = await fetchJson('/api/tools/cli/session?projectDir=' + encodeURIComponent(projectDir || ''));
        if (cancelled) return;
        if (r.status !== 200) {
          setError((r.body && r.body.error) || ('HTTP ' + r.status));
          setLoading(false);
          return;
        }
        interactiveRef.current = !!r.body.interactive;
        // A piped child has no line editor and cannot prompt: every line is a
        // command. A pty starts unknown until the shell's first marker.
        setOwnerBoth(r.body.interactive ? null : 'piped');
        setShellLabel(r.body.shell || '');
        if (r.body.projectDir) setDirLabel(r.body.projectDir);
        outputSubscription = subscribeCliOutput({
        id: r.body.id,
        onOutput: appendOut,
        onDropped: () => writeOut('\u2026 earlier output dropped \u2026\r\n'),
        onEnded: () => { setOwnerBoth(null); setExited(true); }
        });
        outputSubscriptionRef.current = outputSubscription;
        await outputSubscription.ready;
        if (cancelled) return;
        setLoading(false);
        // Focus the prompt once the screen is up.
        if (inputRef.current) inputRef.current.focus();
        // The file half of the suggestion row, fetched after the session is up
        // so a slow listing cannot delay the terminal. A rejected fetch leaves
        // `entries` null and the row simply shows history only.
        fetchJson('/api/files?projectDir=' + encodeURIComponent(projectDir || ''))
        .then((fr) => {
        if (cancelled) return;
        if (fr.status === 200 && fr.body && Array.isArray(fr.body.entries)) {
        setEntries(fr.body.entries.map((e) => ({ name: e.name, type: e.type })));
        }
        })
        .catch(() => {});
      } catch (err) {
        if (!cancelled) { setError(String(err)); setLoading(false); }
      }
      }
    start();
    return () => {
      cancelled = true;
      // Detach only. The shell keeps running in the background and the next
      // open replays what it printed meanwhile; Stop is the explicit kill.
      if (outputSubscription) outputSubscription.close();
      if (outputSubscriptionRef.current === outputSubscription) outputSubscriptionRef.current = null;
    };
  }, [projectDir, restartKey]);

  // stop() — the header's Stop action: the only way the UI kills the shell.
  // Closing the sheet merely detaches (see the effect above).
  const stop = useCallback(() => {
    const ok = typeof window === 'undefined' || typeof window.confirm !== 'function'
      || window.confirm('Stop this shell? Anything still running in it is killed.');
    if (!ok) return;
    fetchJson('/api/tools/cli/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir })
    }).catch(() => {}).then(() => { if (onClose) onClose(); });
  }, [projectDir, onClose]);

  // restart — the header's Restart action, shown only once the shell has
  // exited. It starts a fresh session with a cleared screen: the old output is
  // a dead shell's, and keeping it above a live prompt would read as one
  // continuous session.
  const restart = useCallback(() => {
    screenRef.current = new CliScreen();
    editorTailRef.current = '';
    setOutBuffer('');
    setOwnerBoth(null);
    setCmdText('');
    setExited(false);
    setLoading(true);
    setError('');
    setRestartKey((k) => k + 1);
  }, [setOwnerBoth]);

  // Escape, the Tab cycle and focus restore come from the shared sheet hook
  // (frontend/src/hooks/useModal.js); the backdrop is this component's own.
  const sheetRef = useModal({ onClose: () => { if (onClose) onClose(); } });

  const [cmdText, setCmdText] = useState('');

  // Writes are serialised through one promise chain instead of disabling the
  // prompt while a request is in flight. Disabling the focused <input> blurs
  // it, which on a phone closes the soft keyboard on every Enter or key tap —
  // and a later `focus()` from a fetch callback runs outside the tap, so iOS
  // does not reopen it. With the chain the field stays enabled and focused,
  // two quick taps still reach the shell in the order they were made, and ^C
  // is never blocked behind the request it is meant to interrupt.
  const queueRef = useRef(Promise.resolve());

  // post(text, raw) — queue one write to the session. `raw: true` omits the
  // line terminator, for a single key or a single-key answer; a normal send
  // terminates the line so the shell runs it. An empty `text` sends a bare
  // newline, which accepts a prompt's default. The terminator rule is the
  // server's (`writeCliCommand`); this end only decides which of the two.
  const post = useCallback((text, raw) => {
    const run = () => fetchJson('/api/tools/cli/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, cmd: text, raw: !!raw })
    }).then((r) => {
    if (r.status !== 200) {
      writeOut('\n' + ((r.body && r.body.error) || ('HTTP ' + r.status)) + '\n');
      if (r.status === 404 || r.status === 410) {
      setOwnerBoth(null);
      setExited(true);
      }
    }
    // Writes must not wait for the read: ^C remains responsive. Output
    // catch-up continues even when an intermediary buffers the SSE stream.
    if (outputSubscriptionRef.current) outputSubscriptionRef.current.refresh();
    }).catch((err) => {
    writeOut('\nerror: ' + String(err) + '\n');
    });
    queueRef.current = queueRef.current.then(run, run);
    return queueRef.current;
  }, [projectDir, writeOut, setOwnerBoth]);

  // complete() — what hardware Tab and a Tab typed by a phone keyboard run. It rewrites the field with the
  // completion and leaves the caret at the end; nothing reaches the shell until
  // Enter. A completion that does not change the text (no match, or several
  // matches that agree on nothing more) leaves the field alone.
  function complete() {
    const el = inputRef.current;
    const current = el ? el.value : cmdText;
    const next = completeLocally(current, history, entries);
    if (next == null || next === current) return;
    setCmdText(next);
    if (el) { el.value = next; el.setSelectionRange(next.length, next.length); }
  }

  // onPromptInput — the field's `input` handler. A phone keyboard's Tab key
  // usually arrives here as a literal HT in the text rather than as a Tab
  // `keydown` (see splitTypedTab in cliKeys.js), so the text before the tab is
  // completed exactly like hardware Tab, and anything after it
  // stays in the field.
  function onPromptInput(e) {
    const el = e.currentTarget;
    const typed = splitTypedTab(el.value);
    if (!typed) { setCmdText(el.value); return; }
    el.value = typed.before;
    complete();
    const done = el.value;
    const rest = done + typed.rest;
    el.value = rest;
    setCmdText(rest);
  }

  function runCommand() {
    // An empty line is meaningful to a prompt (accept the default) and is a
    // harmless fresh prompt otherwise — always forward the Enter.
    const cmd = cmdText;
    setCmdText('');
    // Remember the line as history only when it is known to be a command for
    // the shell — never when a program might be reading it (a password, a
    // one-time code). `!!` is the shell's own history expansion and is not
    // remembered as a command of its own.
    setHistory((h) => rememberCommand(h, cmd, ownerRef.current));
    // A pty echoes the line itself (the shell's prompt shows it; a program
    // reading with echo off shows nothing, as it should). Only a piped child
    // needs the modal's echo line, or the screen would show the answer with no
    // record of the question.
    if (!interactiveRef.current) writeOut('\u276F ' + cmd + '\n');
    post(cmd, false);
  }

  // Ctrl+Enter: the field's text with no terminator, for a program waiting on
  // a single key. Never echoed and never remembered — it is an answer.
  function runRaw() {
    const raw = cmdText;
    setCmdText('');
    post(raw, true);
  }

  // applySuggestion(text) — a chip only rewrites the field. Enter still runs it,
  // so a suggestion is exactly as reversible as anything typed — the rule the
  // inspector's value suggestions follow for a property.
  const applySuggestion = useCallback((text) => {
    setCmdText(String(text == null ? '' : text));
    if (inputRef.current) inputRef.current.focus();
  }, []);

  // The suggestion row. Both sources are short capped lists (see
  // cliSuggest.js), so the row costs the same on a long build as on `ls`:
  // it does not depend on the output at all.
  const suggestions = useMemo(() => suggestionsFor({
    draft: cmdText,
    history,
    entries
  }), [cmdText, history, entries]);

  return h('div', { class: 'cli__overlay', ref: overlayRef, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command prompt' },
    h('div', { class: 'cli__sheet', ref: sheetRef },
      h('div', { class: 'cli__head' },
        h('div', { class: 'cli__title-stack' },
          h('span', { class: 'cli__title' }, shellLabel ? ('CLI — ' + shellLabel) : 'CLI'),
          h('span', { class: 'cli__dir', title: dirLabel }, dirLabel)
          ),
          // Stop kills the shell; once it has exited the same slot becomes
          // Restart, because a dead shell has nothing left to stop and the
          // only useful action is a new one. The close button only hides the
          // sheet and leaves a live session running in the background.
          exited && !loading && !error ? h('button', {
          class: 'btn btn--primary cli__stop',
          type: 'button',
          onClick: restart,
          'aria-label': 'Restart shell',
          title: 'Start a new shell in this project'
          }, 'Restart') : (!loading && !error ? h('button', {
          class: 'btn btn--danger cli__stop',
          type: 'button',
          onClick: stop,
          'aria-label': 'Stop shell',
          title: 'Stop shell (kills running commands)'
          }, 'Stop') : null),
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
                h('p', { role: 'alert' }, error),
                h('button', { class: 'btn btn--primary cli__restart', type: 'button', onClick: restart }, 'Retry'),
                h('button', { class: 'btn', type: 'button', onClick: onClose }, 'Close')
              )
            : h('div', { class: 'cli__terminal' },
                h('pre', { ref: attachOutRef, class: 'cli__out', 'aria-label': 'Command output', tabindex: '-1' }),
                // The suggestion row: the session's own commands and the
                // project's own top-level names. A chip only rewrites the
                // field (see applySuggestion) — Enter still runs it. An exited
                // shell has nothing to suggest, so the row goes with it.
                !exited && cmdText && suggestions.length
                  ? h('div', { class: 'cli__suggest', role: 'group', 'aria-label': 'Command suggestions' },
                      suggestions.map((s) => h('button', {
                        key: s.kind + ':' + s.text,
                        class: 'cli__suggest-chip',
                        type: 'button',
                        title: 'Use “' + s.text + '”',
                        onMouseDown: keepEditorFocus,
                        onClick: () => applySuggestion(s.text)
                      }, s.text))
                    )
                  : null,
                  // A live session gets the prompt row. An exited
                  // one gets a single footer instead: the shell is gone, and an
                  // input that 410s on every send is worse than no input at all.
                  // Restart is in the header, and repeated here where the thumb is.
                  exited
                  ? h('div', { class: 'cli__dead', role: 'group', 'aria-label': 'Shell ended' },
                  h('p', { class: 'cli__dead-text' }, 'The shell has ended.'),
                  h('button', {
                  class: 'btn btn--primary cli__restart',
                  type: 'button',
                  onClick: restart,
                  'aria-label': 'Restart shell'
                  }, 'Restart shell')
                  )
                  : [ h('div', { class: 'cli__prompt-row' },
                  h('span', { class: 'cli__prompt-mark', 'aria-hidden': 'true' }, '❯'),
                  h('input', {
                    ref: inputRef,
                    class: 'input cli__prompt',
                    type: 'text',
                    value: cmdText,
                    onInput: onPromptInput,
                    placeholder: 'Type a command — runs in the project folder',
                    'aria-label': 'Command line',
                    autocomplete: 'off',
                    autocapitalize: 'off',
                    // Labels the phone's own action key with what it does here.
                    enterkeyhint: 'send',
                    spellcheck: 'false',
                    // Plain Tab is the shell's completion key here, not focus
                    // navigation: the sheet's Tab cycle (useModal) skips a
                    // control marked `data-own-tab`. Shift+Tab still moves on.
                    'data-own-tab': '',
                    // Never disabled: disabling a focused input blurs it, which
                    // closes a phone's keyboard. Writes are queued instead.
                    onKeyDown: (e) => {
                    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    // Complete the line in the field itself.
                    e.preventDefault();
                    complete();
                    return;
                    }
                    if (e.key !== 'Enter') return;
                      e.preventDefault();
                      // Ctrl+Enter (or Cmd+Enter) sends the line with no
                      // terminator, for a program waiting on a single key.
                      if (e.ctrlKey || e.metaKey) runRaw();
                      else runCommand();
                    }
                    }),
                    // Run — the line in the prompt, made a visible action. On a
                    // phone the keyboard's own action key is the only "send", and
                    // it is labelled by `enterkeyhint` yet not by anything on the
                    // sheet; on a tablet or desktop it is simply the button the
                    // composer already has. A live shell needs it every time;
                    // once the shell has exited the row is gone entirely (the
                    // header offers Restart).
                    h('button', {
                    class: 'cli__run',
                    type: 'button',
                    onClick: runCommand,
                    'aria-label': 'Run command',
                    title: 'Run the command in the project folder',
                    onMouseDown: keepEditorFocus
                    },
                    h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
                    h('path', { d: 'M3.4 20.6 21 12 3.4 3.4 3 10l13 2-13 2 .4 6.6Z', fill: 'currentColor' })
                    )
                    )
                    )
                    ]
                    )
      )
    )
  );
}
