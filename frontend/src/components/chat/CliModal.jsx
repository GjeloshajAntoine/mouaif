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
//
// On a phone this modal is the app's one *terminal*, and a phone keyboard has
// no Escape, Tab, arrow or Ctrl key — so the sheet carries the rows a hardware
// keyboard would have provided:
//
//   * a **suggestion row** above the prompt (the commands this session sent to
//     the shell, the project's own top-level names from GET /api/files), which
//     saves re-typing a command on a keyboard that covers most of the screen —
//     see ./cliSuggest.js. A chip only rewrites the field; Enter still runs it.
//   * a **key row** under the prompt (Esc, Tab, ↑, ↓, ^C, ^D), each a single
//     raw write so ^C interrupts without also pressing Enter. Tab and ↑/↓ carry
//     the typed draft with them, because they edit the shell's own line — see
//     ./cliKeys.js.
//
// Who reads stdin is taken from the shell itself: on a pseudo-terminal bash and
// zsh switch bracketed paste on at their prompt and off when a command starts
// (lineEditorState in ./cliKeys.js). That decides whether the key row marks
// its readline keys, and whether a sent line is remembered — an answer typed to
// a program (a password, a one-time code) never becomes a suggestion.
//
// A pty echoes the shell's command line itself, so the modal writes its own
// `❯ cmd` echo line only for a piped session, which echoes nothing.

import { h } from 'preact';
import { useState, useEffect, useMemo, useRef, useCallback } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { useModal } from '../../hooks/useModal.js';
import { CLI_KEYS, keepEditorFocus, keyById, keyPayload, lineEditorState, splitTypedTab } from './cliKeys.js';
import { rememberCommand, suggestionsFor } from './cliSuggest.js';
import { CliScreen } from './utils.js';

export function CliModal(props) {
  const { projectDir, onClose } = props;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shellLabel, setShellLabel] = useState('');
  const [dirLabel, setDirLabel] = useState(projectDir || '');
  // Whether the session runs on a pseudo-terminal (`interactive` from
  // GET /api/tools/cli/session). A pty echoes what is typed at the shell's
  // prompt and hides what a program reads with echo off, so the modal must not
  // echo anything itself there; a piped child echoes nothing, so it must.
  const [interactive, setInteractive] = useState(false);
  // The session's own commands, newest first — the history half of the
  // suggestion row (see rememberCommand in cliSuggest.js).
  const [history, setHistory] = useState([]);
  // `entries` — the project's top-level names, the file half of the suggestion
  // row (`null` until the listing answers: a fetch that has not happened
  // invents no chips).
  const [entries, setEntries] = useState(null);

  const outRef = useRef(null);       // <pre> terminal output
  const inputRef = useRef(null);
  const sessionIdRef = useRef(null);
  const evtSourceRef = useRef(null);
  const [outBuffer, setOutBuffer] = useState('');   // accumulated output
  // Who is reading the session's stdin: 'shell' (its line editor is waiting),
  // 'program' (a command is running and may be asking a question), 'piped' (no
  // pseudo-terminal — nothing can prompt), or null (unknown: not started yet,
  // exited, or a shell that never says). On a pty the shell says so itself by
  // switching bracketed paste on and off around every command line (see
  // lineEditorState in cliKeys.js). The key row dims Tab and ↑/↓ for
  // 'program', and the suggestion row only remembers lines sent to 'shell' or
  // 'piped', so a program's answer — possibly a password — is never kept.
  const [owner, setOwner] = useState(null);
  const ownerRef = useRef(null);
  const editorTailRef = useRef('');
  const setOwnerBoth = useCallback((next) => {
    if (ownerRef.current === next) return;
    ownerRef.current = next;
    setOwner(next);
  }, []);
  const interactiveRef = useRef(false);
  // True once a readline key has pushed a draft onto the shell's own line
  // (`npm ru` + Tab): what Enter then submits is that line, which the modal no
  // longer knows, so the field's remainder is not remembered as a command.
  const lineDirtyRef = useRef(false);

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
        interactiveRef.current = !!r.body.interactive;
        setInteractive(!!r.body.interactive);
        // A piped child has no line editor and cannot prompt: every line is a
        // command. A pty starts unknown until the shell's first marker.
        setOwnerBoth(r.body.interactive ? null : 'piped');
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
      }
    }).catch((err) => {
      writeOut('\nerror: ' + String(err) + '\n');
    });
    queueRef.current = queueRef.current.then(run, run);
    return queueRef.current;
  }, [projectDir, writeOut]);

  // sendKey(key) — one on-screen key from the row below the prompt (see
  // keyPayload in cliKeys.js). Every key is a raw write: a terminator after
  // Ctrl+C would also press Enter, answering a prompt the user has not seen.
  // Tab and ↑/↓ carry the draft with them, because they edit the *shell's*
  // line and the draft has not reached it yet.
  // `draftOverride` is the draft when the caller already split it off the
  // field (a Tab a phone keyboard typed into the text — see onPromptInput).
  const sendKey = useCallback((key, draftOverride) => {
    if (!key) return;
    const draft = typeof draftOverride === 'string'
      ? draftOverride
      : (inputRef.current ? inputRef.current.value : cmdText);
    const payload = keyPayload(key, draft);
    if (payload.clearDraft) setCmdText('');
    if (key.shellOnly) lineDirtyRef.current = true;
    if (key.id === 'int') lineDirtyRef.current = false;
    post(payload.seq, true);
  }, [cmdText, post]);

  // onPromptInput — the field's `input` handler. A phone keyboard's Tab key
  // usually arrives here as a literal HT in the text rather than as a Tab
  // `keydown` (see splitTypedTab in cliKeys.js), so the text before the tab is
  // sent exactly like a tap on the key row's Tab, and anything after it stays
  // in the field. The DOM value is set directly: when the state was already
  // empty, a controlled re-render would not overwrite the typed tab.
  function onPromptInput(e) {
    const el = e.currentTarget;
    const typed = splitTypedTab(el.value);
    if (!typed) { setCmdText(el.value); return; }
    sendKey(keyById('tab'), typed.draft);
    el.value = typed.rest;
    setCmdText(typed.rest);
  }

  function runCommand() {
    // An empty line is meaningful to a prompt (accept the default) and is a
    // harmless fresh prompt otherwise — always forward the Enter.
    const cmd = cmdText;
    setCmdText('');
    // Remember the line as history only when it is known to be a command for
    // the shell — never when a program might be reading it (a password, a
    // one-time code), and never the remainder of a line a readline key has
    // already pushed to the shell. `!!` is the shell's own history expansion
    // and is not remembered as a command of its own.
    const who = ownerRef.current;
    if (!lineDirtyRef.current) setHistory((h) => rememberCommand(h, cmd, who));
    lineDirtyRef.current = false;
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

  return h('div', { class: 'cli__overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command prompt' },
    h('div', { class: 'cli__sheet', ref: sheetRef },
      h('div', { class: 'cli__head' },
        h('div', { class: 'cli__title-stack' },
          h('span', { class: 'cli__title' }, shellLabel ? ('CLI — ' + shellLabel) : 'CLI'),
          h('span', { class: 'cli__dir', title: dirLabel }, dirLabel)
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
                // The suggestion row: the session's own commands and the
                // project's own top-level names. A chip only rewrites the
                // field (see applySuggestion) — Enter still runs it.
                suggestions.length
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
                h('div', { class: 'cli__prompt-row' },
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
                    // A hardware Tab does what the key row's Tab does:
                    // send the draft plus HT, so the shell completes it.
                    e.preventDefault();
                    sendKey(keyById('tab'));
                    return;
                    }
                    if (e.key !== 'Enter') return;
                      e.preventDefault();
                      // Ctrl+Enter (or Cmd+Enter) sends the line with no
                      // terminator, for a program waiting on a single key.
                      if (e.ctrlKey || e.metaKey) runRaw();
                      else runCommand();
                    }
                  })
                ),
                // The key row: the keys a phone keyboard does not have (see
                // cliKeys.js). While a program owns stdin, the three readline
                // keys (`shellOnly`) are marked; Esc, ^C and ^D stay lit.
                h('div', {
                  class: 'cli__keys' + (owner === 'program' ? ' is-prompt' : ''),
                  role: 'group',
                  'aria-label': 'Terminal keys'
                },
                  CLI_KEYS.map((k) => h('button', {
                    key: k.id,
                    class: 'cli__key' + (k.shellOnly ? ' cli__key--shell' : ''),
                    type: 'button',
                    title: k.title,
                    'aria-label': k.title,
                    tabindex: '-1',
                    onMouseDown: keepEditorFocus,
                    onClick: () => sendKey(k)
                  }, k.label))
                ),
                // One-line hint under the row. It names the mode only when the
                // shell has said which one it is in; a piped session has no
                // line editor, so Tab and the arrows do nothing there.
                h('p', { class: 'cli__hint' },
                  owner === 'program'
                    ? 'A program owns the prompt — ^C stops it; Esc leaves it.'
                    : interactive
                      ? 'Tab and ↑/↓ complete and recall. ^C stops the running command.'
                      : 'No terminal: Tab and ↑/↓ are not available. ^C stops the running command.'
                )
              )
      )
    )
  );
}
