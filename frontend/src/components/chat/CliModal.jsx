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
//   * a **suggestion row** above the prompt (the session's own echo lines, the
//     project's own top-level names from GET /api/files), which saves re-typing
//     a command on a keyboard that covers most of the screen — see
//     ./cliSuggest.js. A chip only rewrites the field; Enter still runs it.
//   * a **key row** under the prompt (Esc, Tab, ↑, ↓, ^C, ^D), each a single
//     raw write so ^C interrupts without also pressing Enter — see ./cliKeys.js.
//   * the modal's own **echo line** (`❯ ls -la`), written where the command is
//     sent. The server never echoes the child's stdin, so without it the screen
//     showed the answer with no record of the question, the history the
//     suggestion row reads had nothing to read, and `!!` had nothing to repeat.
//     It is also what makes the key row's two modes distinguishable: a
//     just-echoed line means the shell owns the prompt, and anything after it
//     means a program does.

import { h } from 'preact';
import { useState, useEffect, useMemo, useRef, useCallback } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { useModal } from '../../hooks/useModal.js';
import { CLI_KEYS, keepEditorFocus } from './cliKeys.js';
import { historyFromOutput, suggestionsFor } from './cliSuggest.js';
import { CliScreen } from './utils.js';

export function CliModal(props) {
  const { projectDir, onClose } = props;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shellLabel, setShellLabel] = useState('');
  const [dirLabel, setDirLabel] = useState(projectDir || '');
  const [busy, setBusy] = useState(false);
  // `entries` — the project's top-level names, the file half of the suggestion
  // row (`null` until the listing answers: a fetch that has not happened
  // invents no chips).
  const [entries, setEntries] = useState(null);

  const outRef = useRef(null);       // <pre> terminal output
  const inputRef = useRef(null);
  const sessionIdRef = useRef(null);
  const evtSourceRef = useRef(null);
  const [outBuffer, setOutBuffer] = useState('');   // accumulated output
  // Whether a program is showing a prompt and waiting. The key row's two
  // "answer the program" keys — Tab and ↑/↓ — are a shell's readline keys: on a
  // program's own reader they arrive as literal bytes, so the row marks which
  // mode it is in rather than letting the user find out after the fact. The flag
  // is set where the echo line is written (a command line means the shell), not
  // guessed from the bytes.
  const [promptOpen, setPromptOpen] = useState(false);

const screenRef = useRef(null);
if (!screenRef.current) screenRef.current = new CliScreen();
// Whether the user is "pinned" to the bottom. True while output streams
// normally (the last frame fills the view, so new rows scroll into view).
// Once the user drags up to read history, stop auto-scrolling so the view
// isn't yanked down on every refresh (the "scroll but refreshes" symptom).
const pinnedRef = useRef(true);
  // writeOut(text) — the single sink for everything that reaches the screen:
  // session output, the modal's own echo line, and the raw keys the key row
  // sends. The rendered text is also kept in `outBuffer` because it is what the
  // suggestion row reads its history from (see cliSuggest.js), and a rendered
  // frame is the honest source: the ANSI-aware CliScreen has already folded a
  // TUI's redraws into the screen the user is looking at.
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
      setPromptOpen(false);
      return;
    }
    // The session is a piped (non-TTY) child, so full-screen programs (htop,
    // top, less) emit escape codes that arrive split across SSE frames. Feed
    // them to the stateful CliScreen, which buffers in-flight sequences and
    // rebuilds a text grid — so a TUI redraw replaces its frame in place
    // instead of appending raw `[39;49m` / `[8;1H` garbage each refresh.
    writeOut(text);
  }, [writeOut]);

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

  // Focus is restored *after the render that re-enables the prompt*, not in the
  // request's `finally`. The prompt is `disabled` while a send is in flight (so
  // two taps cannot race), and a disabled input cannot take focus: focusing it in
  // `finally` — before Preact has committed `busy: false` — silently did nothing,
  // and on a phone an unfocused prompt is a *closed* keyboard. A request therefore
  // only asks; the effect does it once the field is usable again.
  const wantFocusRef = useRef(false);
  const focusPrompt = useCallback(() => { wantFocusRef.current = true; }, []);
  useEffect(() => {
    if (busy || !wantFocusRef.current) return;
    wantFocusRef.current = false;
    if (inputRef.current) inputRef.current.focus();
  }, [busy]);

  // send(text, raw) — POST one line to the session. `raw: true` omits the
  // line terminator, for a single-key answer to a prompt the program is
  // showing; a normal send terminates the line so the shell runs it. An
  // empty `text` sends a bare newline, which accepts a prompt's default.
  //
  // The terminator rule is the server's (`writeCliCommand`); this end only
  // decides which of the two it wants. It deliberately does not touch the key
  // row's mode: that is the caller's decision, because `!!` and a plain command
  // line mean different things about what owns the prompt.
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
      focusPrompt();
    }
  }, [projectDir, appendOut, focusPrompt]);

  // sendKey(key) — one on-screen key from the row below the prompt (see
  // cliKeys.js). `raw` is the whole point for every key in the table: a
  // terminator appended to Ctrl+C would also press Enter, answering a second
  // prompt the user has not seen.
  const sendKey = useCallback((key) => {
    if (!key) return;
    setBusy(true);
    fetchJson('/api/tools/cli/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, cmd: key.seq, raw: true })
    }).then((r) => {
      if (r.status !== 200) {
        appendOut('\n' + ((r.body && r.body.error) || ('HTTP ' + r.status)) + '\n', 'stderr');
      }
    }).catch((err) => {
      appendOut('\nerror: ' + String(err) + '\n', 'stderr');
    }).finally(() => {
      setBusy(false);
      focusPrompt();
    });
  }, [projectDir, appendOut, focusPrompt]);

  async function runCommand() {
    // An empty line is meaningful to a prompt (accept the default) and is a
    // harmless fresh prompt otherwise — always forward the Enter.
    const cmd = cmdText;
    setCmdText('');
    // The macOS line-editor convention: `!!` is the previous command, repeated
    // here because a phone keyboard cannot press Up. The shell's own history
    // expansion handles it exactly as it does from a terminal — no client-side
    // substitution, no separate history to keep in sync. Its echo line is what
    // `!!` reads, so nothing is written for it, and the mode is *unknown*: the
    // repeated command is the previous one, which may well be a program that
    // wants ^C rather than Tab.
    if (cmd.trim() === '!!') {
    setPromptOpen(true);
    await send(cmd, false);
    return;
    }
    // The modal's own echo line. The server never echoes what it wrote to the
    // child's stdin, so nothing else on the screen shows which command is being
    // answered — and that line is what makes the screen reader label, the
    // key-row mode and the suggestion row's history agree about what the shell
    // was just asked. `promptOpen` is the same fact: this line *is* the shell's
    // prompt, so a program asking a question is the only thing that clears it.
    setPromptOpen(false);
    writeOut('\u276F ' + cmd + '\n');
    await send(cmd, false);
  }

  // applySuggestion(text) — a chip only rewrites the field. Enter still runs it,
  // so a suggestion is exactly as reversible as anything typed — the rule the
  // inspector's value suggestions follow for a property.
  const applySuggestion = useCallback((text) => {
    setCmdText(String(text == null ? '' : text));
    // The chip's own command is the re-run path: `!!` would be echoed as `!!`,
    // not as what the user meant.
    setPromptOpen(false);
    focusPrompt();
  }, [focusPrompt]);

  // The suggestion row. `outBuffer` is a render behind the last byte of output,
  // which is exactly the resolution a suggestion needs; `cmdText` is read on
  // every keystroke, which is what filters the row. Both source lists are
  // capped (see cliSuggest.js), so the memo is not load-bearing for cost.
  const suggestions = useMemo(() => suggestionsFor({
    draft: cmdText,
    history: historyFromOutput(outBuffer),
    entries
  }), [cmdText, outBuffer, entries]);

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
            // The suggestion row. A phone keyboard cannot retype the last
            // command as cheaply as it can tap it, so the session's own
            // history and the project's own top-level names are offered
            // above the field. A chip only rewrites the field (see
            // applySuggestion) — Enter still runs it.
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
            onInput: (e) => setCmdText(e.currentTarget.value),
            placeholder: 'Type a command — runs in the project folder',
            'aria-label': 'Command line',
            autocomplete: 'off',
            autocapitalize: 'off',
            // `enterkeyhint` is what makes the phone's own action key
            // read "send" (rather than "return"), so the one key every
            // mobile keyboard has is labelled with what it does here.
            enterkeyhint: 'send',
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
            ),
            // The key row: the keys a phone keyboard does not have and a
            // terminal cannot be used without (see cliKeys.js). Each one is
            // a single raw write, so `^C` interrupts without also pressing
            // Enter, and the row stays visible while a program waits —
            // answering a program is the case it exists for. While a program
            // owns the prompt, its three readline keys (`shellOnly`) are
            // marked; Esc, `^C` and `^D` stay lit, because those are useful
            // in both modes.
            h('div', {
            class: 'cli__keys' + (promptOpen ? ' is-prompt' : ''),
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
            disabled: busy,
            onMouseDown: keepEditorFocus,
            onClick: () => sendKey(k)
            }, k.label))
            ),
            // One-line hint under the row: the sheet already covers most of
            // a phone screen, so a control that duplicates a hardware key
            // says what it does in place rather than in a legend. The row's
            // two modes are named, because which keys it is sending *for*
            // changes when the shell hands stdin to a program.
            h('p', { class: 'cli__hint' },
            promptOpen
            ? 'A program owns the prompt — ^C stops it; Esc leaves it.'
            : 'Tab and ↑/↓ complete and recall. ^C stops the running command.'
            )
            )
      )
    )
  );
}