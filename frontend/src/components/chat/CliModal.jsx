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
//   * two **key rows** under the prompt (Esc Tab ^C ^D ^Z ^L / ← ↑ ↓ → PgUp
//     PgDn). While the shell owns the line, Tab, the arrows, the Page keys and
//     Esc edit the *field itself* (complete, recall, move the caret, scroll the
//     output, clear), so nothing reaches the child until Enter; while a program
//     owns stdin, every key is a raw write of its VT sequence, so `less`, `top`
//     or `vim` can be driven from a phone — see keyPayload in ./cliKeys.js.
//
// Who reads stdin is taken from the shell itself: on a pseudo-terminal bash and
// zsh switch bracketed paste on at their prompt and off when a command starts
// (lineEditorState in ./cliKeys.js), and a full-screen program enters the
// alternate screen. That decides which mode the keys are in, and whether a
// sent line is remembered — an answer typed to a program (a password, a
// one-time code) never becomes a suggestion.
//
// A pty echoes the shell's command line itself, so the modal writes its own
// `❯ cmd` echo line only for a piped session, which echoes nothing.

import { h } from 'preact';
import { useState, useEffect, useMemo, useRef, useCallback } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { useModal } from '../../hooks/useModal.js';
import { CLI_KEYS, cursorKeyMode, keepEditorFocus, keyForEvent, keyPayload, lineEditorState, splitTypedTab } from './cliKeys.js';
import { rememberCommand, suggestionsFor, completeLocally, listDirFor, stepHistory } from './cliSuggest.js';
import { CliScreen } from './utils.js';

export function CliModal(props) {
  const { projectDir, onClose } = props;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shellLabel, setShellLabel] = useState('');
  const [dirLabel, setDirLabel] = useState(projectDir || '');
  // The session's own commands, newest first — the history half of the
  // suggestion row and what ↑/↓ recall from (see rememberCommand in
  // cliSuggest.js).
  const [history, setHistory] = useState([]);
  // `entries` — the project's top-level names, the file half of the suggestion
  // row (`null` until the listing answers: a fetch that has not happened
  // invents no chips).
  const [entries, setEntries] = useState(null);
  // `dirEntries` — the names of the directory the user has completed *into*
  // (`{ relDir, names }`), so Tab can keep going past the project's top level:
  // `ls src/` fixes src as that directory and `ls src/comp` then completes from
  // its children. One directory is enough state — completion walks forward, one
  // step per Tab — and keeping just one bounds the fetching. `null` until a
  // path segment has been completed into that directory.
  const [dirEntries, setDirEntries] = useState(null);
  // The directories already asked for, so a Tab that finds no deeper listing
  // does not re-request the same one on every tap.
  const fetchedDirsRef = useRef(null);
  if (!fetchedDirsRef.current) fetchedDirsRef.current = new Set();

  // Where the field sits in the ↑/↓ walk over the session's own history: -1
  // means "not walking" (the field holds a fresh line). Reset whenever the user
  // types or sends, so the next ↑ starts from the newest command.
  const recallIndexRef = useRef(-1);

  const outRef = useRef(null);       // <pre> terminal output
  const inputRef = useRef(null);
  const sessionIdRef = useRef(null);
  const evtSourceRef = useRef(null);
  // Highest output seq already written to the screen (replay + live).
  const lastSeqRef = useRef(0);
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
  const appCursorRef = useRef(false);
  const cursorTailRef = useRef('');

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
      // The shell says its line editor is waiting again. A killed full-screen
      // program never wrote its restore sequence, so the screen is dropped out
      // of full-screen here too — otherwise every key would keep writing raw
      // bytes at a shell that is back at its prompt (Tab would never complete).
      if (next.state === 'shell' && screenRef.current) screenRef.current.leaveFullScreen();
      if (next.state) setOwnerBoth(next.state);
      // Application cursor mode (DECCKM): a full-screen program may expect
      // `ESC O A` for the arrows instead of `ESC [ A` (see cursorKeyMode).
      const ck = cursorKeyMode(cursorTailRef.current, text);
      cursorTailRef.current = ck.tail;
      if (ck.app !== null) appCursorRef.current = ck.app;
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
        // A piped child has no line editor and cannot prompt: every line is a
        // command. A pty starts unknown until the shell's first marker.
        setOwnerBoth(r.body.interactive ? null : 'piped');
        setShellLabel(r.body.shell || '');
        if (r.body.projectDir) setDirLabel(r.body.projectDir);
        // The session id is ready — open the SSE channel and listen
        // for this session's cli_output frames. The session may be a
        // background terminal that kept running while the modal was closed
        // (docs/features/background-terminal.md), so live frames that arrive
        // before the backlog replay finishes are held, then everything at or
        // below the replayed seq is dropped: no gap, no duplicate.
        const pending = [];
        let replayed = false;
        const deliver = (data) => {
        if (typeof data.seq === 'number') {
        if (data.seq <= lastSeqRef.current) return;
        lastSeqRef.current = data.seq;
        }
        appendOut(data.data, data.stream);
        };
        evtSource = new EventSource('/events');
        evtSourceRef.current = evtSource;
        evtSource.addEventListener('cli_output', (e) => {
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        if (!data || data.id !== sessionIdRef.current) return;
        if (!replayed) { pending.push(data); return; }
        deliver(data);
        });
        // Replay the retained backlog (empty for a fresh session).
        try {
        const rr = await fetchJson('/api/tools/cli/output?id=' + encodeURIComponent(r.body.id) + '&since=0');
        if (cancelled) return;
        if (rr.status === 200 && rr.body && Array.isArray(rr.body.chunks)) {
        if (rr.body.dropped) writeOut('\u2026 earlier output dropped \u2026\r\n');
        for (const c of rr.body.chunks) deliver({ data: c.data, stream: c.stream, seq: c.seq });
        }
        } catch { /* replay is best-effort; live frames still flow */ }
        replayed = true;
        for (const d of pending.splice(0)) deliver(d);
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
      if (evtSource) evtSource.close();
    };
  }, [projectDir]);

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
  // Tab and ↑/↓ are the exception: they edit the *local* field and write
  // nothing to the child (see completeLocally / stepHistory in ./cliSuggest.js),
  // so completion and recall never cost a round-trip and never move the text
  // out of the box the user is looking at.
  // programMode() — whether a key should go to the child as bytes rather than
  // edit the field: a command is running (the shell switched bracketed paste
  // off) or a full-screen program holds the alternate screen.
  function programMode() {
    return ownerRef.current === 'program' || !!(screenRef.current && screenRef.current.isFullScreen);
  }

  // moveCaret(delta) / scrollOut(dir) / clearField() — the local actions of
  // ←/→, PgUp/PgDn and Esc (see `local` in cliKeys.js).
  function moveCaret(delta) {
    const el = inputRef.current;
    if (!el) return;
    const at = Math.max(0, Math.min(el.value.length, (el.selectionStart == null ? el.value.length : el.selectionStart) + delta));
    el.setSelectionRange(at, at);
  }
  function scrollOut(dir) {
    const el = outRef.current;
    if (!el) return;
    el.scrollTop += dir * Math.max(40, el.clientHeight - 40);
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }
  function clearField() {
    recallIndexRef.current = -1;
    setCmdText('');
    if (inputRef.current) inputRef.current.value = '';
  }

  // sendKey(key) — one key, from the row or a hardware key press: a local
  // edit while the shell owns the line, raw bytes while a program does.
  function sendKey(key) {
    if (!key) return;
    const payload = keyPayload(key, { program: programMode(), appCursor: appCursorRef.current });
    switch (payload.local) {
      case 'complete': complete(); return;
      case 'history-up': recall('up'); return;
      case 'history-down': recall('down'); return;
      case 'caret-left': moveCaret(-1); return;
      case 'caret-right': moveCaret(1); return;
      case 'page-up': scrollOut(-1); return;
      case 'page-down': scrollOut(1); return;
      case 'clear': clearField(); return;
      default: break;
    }
    if (payload.clearDraft) clearField();
    // The answer to "the key did nothing": a full-screen program reads the
    // key, then redraws — follow it to the bottom.
    pinnedRef.current = true;
    post(payload.seq, true);
  }

  // fetchDir(relDir) — list one directory and make it the completion source.
  //
  // Called when a completion reveals a directory (`src/`), and when the user
  // types into one that was never listed. Each directory is fetched once per
  // sheet; a failure simply leaves the source where it was, because a Tab with
  // no candidates changes nothing — the same promise the suggestion row makes.
  const fetchDir = useCallback((relDir) => {
    const target = String(relDir == null ? '' : relDir).replace(/\/+$/, '');
    if (!target || fetchedDirsRef.current.has(target)) return;
    fetchedDirsRef.current.add(target);
    fetchJson('/api/files?projectDir=' + encodeURIComponent(projectDir || '') + '&dir=' + encodeURIComponent(target))
      .then((r) => {
        if (r.status !== 200 || !r.body || !Array.isArray(r.body.entries)) return;
        setDirEntries({ relDir: target, names: r.body.entries.map((e) => (e.type === 'dir' ? e.name + '/' : e.name)) });
      })
      .catch(() => {});
  }, [projectDir]);

  // complete() — what the key row's Tab, a hardware Tab, and a Tab a phone
  // keyboard typed into the field all run. It rewrites the field with the
  // completion and leaves the caret at the end; nothing reaches the shell until
  // Enter. A completion that does not change the text (no match, or several
  // matches that agree on nothing more) leaves the field alone.
  //
  // The line is the cue to list a directory. `cd scr` → `cd src/` starts the
  // listing of `src`, so the *next* Tab can complete inside it; `git add`
  // `src/com` → `src/components/` does the same one level deeper. The listing is
  // deliberately not used by the tap that triggers it — that one is the deep
  // directory it just named — and is there for the next one, which is exactly
  // the case no client-side source can ever answer.
  function complete() {
    const el = inputRef.current;
    const current = el ? el.value : cmdText;
    const next = completeLocally(current, history, entries, dirEntries);
    // A completion that landed on a directory *is* the directory to list, so the
    // next Tab is about its children. Otherwise the line in the field is what to
    // look at — it names the directory the next Tab will complete inside.
    const landedOnDir = next != null && next !== current && next.endsWith('/') ? next : null;
    const dir = listDirFor(landedOnDir != null ? landedOnDir : current, dirEntries);
    if (dir) fetchDir(dir);
    if (next == null || next === current) return;
    setCmdText(next);
    if (el) { el.value = next; el.setSelectionRange(next.length, next.length); }
  }

  // recall(dir) — the key row's ↑/↓, walking the session's own history (newest
  // first) into the field.
  function recall(dir) {
    const el = inputRef.current;
    const stepped = stepHistory(history, recallIndexRef.current, dir);
    if (stepped.text == null) { recallIndexRef.current = -1; return; }
    recallIndexRef.current = stepped.index;
    setCmdText(stepped.text);
    if (el) { el.value = stepped.text; el.setSelectionRange(stepped.text.length, stepped.text.length); }
  }

  // onPromptInput — the field's `input` handler. A phone keyboard's Tab key
  // usually arrives here as a literal HT in the text rather than as a Tab
  // `keydown` (see splitTypedTab in cliKeys.js), so the text before the tab is
  // completed exactly like a tap on the key row's Tab, and anything after it
  // stays in the field.
  function onPromptInput(e) {
    const el = e.currentTarget;
    const typed = splitTypedTab(el.value);
    if (!typed) { setCmdText(el.value); recallIndexRef.current = -1; return; }
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
    recallIndexRef.current = -1;
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
    recallIndexRef.current = -1;
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

  // Read at render: every output frame re-renders (outBuffer), so this follows
  // a program entering or leaving the alternate screen.
  const isProgram = owner === 'program' || !!(screenRef.current && screenRef.current.isFullScreen);

  return h('div', { class: 'cli__overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command prompt' },
    h('div', { class: 'cli__sheet', ref: sheetRef },
      h('div', { class: 'cli__head' },
        h('div', { class: 'cli__title-stack' },
          h('span', { class: 'cli__title' }, shellLabel ? ('CLI — ' + shellLabel) : 'CLI'),
          h('span', { class: 'cli__dir', title: dirLabel }, dirLabel)
          ),
          // Stop kills the shell; the close button only hides the sheet and
          // leaves the session running in the background.
          !loading && !error ? h('button', {
          class: 'btn btn--danger cli__stop',
          type: 'button',
          onClick: stop,
          'aria-label': 'Stop shell',
          title: 'Stop shell (kills running commands)'
          }, 'Stop') : null,
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
                    // A hardware Tab, arrow or Page key does what the same
                    // key on the row does (local edit at the shell, bytes to
                    // a program). ←/→ at the shell keep the browser's own
                    // caret movement.
                    const hk = keyForEvent(e);
                    if (hk) {
                    if (!programMode() && (hk.id === 'left' || hk.id === 'right')) return;
                    e.preventDefault();
                    sendKey(hk);
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
                // The key rows: the keys a phone keyboard does not have, in
                // two rows of six (see cliKeys.js). Every key is live in both
                // modes — `is-prompt` only recolours the row so it is clear
                // the keys now go to the program.
                [1, 2].map((row) => h('div', {
                key: 'keys' + row,
                class: 'cli__keys' + (isProgram ? ' is-prompt' : ''),
                role: 'group',
                'aria-label': row === 1 ? 'Terminal control keys' : 'Terminal movement keys'
                },
                CLI_KEYS.filter((k) => k.row === row).map((k) => h('button', {
                key: k.id,
                class: 'cli__key',
                type: 'button',
                title: k.title,
                'aria-label': k.title,
                tabindex: '-1',
                onMouseDown: keepEditorFocus,
                onClick: () => sendKey(k)
                }, k.label))
                )),
                // One-line hint under the rows, naming the current mode.
                h('p', { class: 'cli__hint' },
                isProgram
                ? 'Keys go to the running program — ^C stops it, Esc leaves it.'
                : 'Tab completes, ↑/↓ recall, ←/→ move in the prompt. ^C stops a command.'
                )
              )
      )
    )
  );
}
