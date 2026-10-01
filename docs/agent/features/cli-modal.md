# CLI modal — implementation notes

> Agent-facing reference for [`docs/features/cli-modal.md`](../../features/cli-modal.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### Session lifecycle

- `GET /api/tools/cli/session?projectDir=<abs>` starts or reuses the per-project session and returns `{ id, projectDir, shell, interactive, startedAt, defaultDir }`. `interactive` is `true` when a pseudo-terminal backend loaded. It is diagnostic only; the modal shows no badge for it.
- `POST /api/tools/cli/command` with `{ projectDir, cmd, raw? }` writes one line to the session's stdin. `raw: true` omits the line terminator.
- `POST /api/tools/cli/close` with `{ projectDir }` kills the session (idempotent).
- **Access:** these routes sit behind the app's access protection (session login and same-origin/CSRF checks), like every `/api/*` route. They do **not** consult the project's **Shell** tool Off/Ask/Allow mode. That mode governs what the *model* may run; the CLI modal is typed by the signed-in user, so it is treated like a terminal on the host.
- The session is keyed by the project's **real** path: `session` resolves symlinks with `realpath`, and `command` / `close` resolve the `projectDir` they receive the same way, so a project opened through a symlink reaches (and closes) the same shell.
- Output is broadcast over the `GET /events` SSE channel as `cli_output` frames `{ id, stream, data }`, filtered client-side by session id. A PTY merges stdout and stderr, so every chunk is labelled `stdout`; the piped fallback keeps a separate `stderr` channel.

The session helpers live in [src/server-handlers-tools.js](../../../src/server-handlers-tools.js) (`ensureCliSession`, `writeCliCommand`, `attachCliStream`, `closeCliSession`), the pseudo-terminal shim in [src/pty.js](../../../src/pty.js). The modal is [frontend/src/components/chat/CliModal.jsx](../../../frontend/src/components/chat/CliModal.jsx), and the stateful ANSI/VT screen decoder it renders through is `CliScreen` in [frontend/src/components/chat/utils.js](../../../frontend/src/components/chat/utils.js).

### Pseudo-terminal

The session is spawned on a pseudo-terminal by [src/pty.js](../../../src/pty.js). Over pipes (`stdio: ['pipe', ...]`) the child is **not** a TTY, so a prompting program gets an immediate EOF — `read` returns an empty answer and `npm publish` refuses to prompt at all, answering `EOTP` with a **redacted** `…/auth/cli/***` URL (npm's `@npmcli/redact` masks the one-time token before printing it; the `*` characters are npm's placeholder, not the modal's).

`src/pty.js` selects a platform backend. On POSIX it uses a tool the host already has, avoiding a native-addon build. On Windows it uses the optional `node-pty` package and its published x64/ARM64 ConPTY prebuilds, so a normal `npx mouaif` installation does not need Python or Visual Studio Build Tools. A missing or unsupported optional binary does not fail installation; that host uses the existing piped fallback.

The POSIX backends are tried in order, and the first that passes a one-time probe is kept (the probe command must see a terminal on **both** stdin and stdout and hand back its exit code):

| Backend | Where | What runs |
| --- | --- | --- |
| `node-pty` / ConPTY | Windows x64 and ARM64 | the platform prebuild shipped by `node-pty` |
| util-linux `script` | every Linux distro and base image | `script -qefc "<cmd>" /dev/null` |
| BSD `script` | macOS, FreeBSD, OpenBSD, NetBSD | `script -q /dev/null /bin/sh -c "<cmd>"` |
| `python3` `pty` | any POSIX host with Python (a stripped container without util-linux) | a small `pty.fork()` relay passed with `python3 -c` |

```bash
# the util-linux case, roughly:
script -qefc "stty rows 30 cols 100; exec '/bin/bash' '-i'" /dev/null
```

`-c` runs the shell on a pty slave, `-e` propagates the child's exit code, `-f` flushes each write so output is not delayed, and `-q` drops the "Script started" banner. `script` sizes the pty from its own stdin, which is a pipe here, so the grid would read `0 0`; the `stty` step sets it to 100×30 first, and `exec` keeps the shell's exit code. The python3 relay sets the same grid with `TIOCSWINSZ`, forwards SIGTERM/SIGHUP to the shell as SIGHUP, and exits with the shell's status. `TERM` is inherited, or set to `xterm-256color` when it is empty or `dumb`. Closing the session signals every process in the terminal session `script` created (found through `/proc`, before anything is signalled): SIGHUP and SIGTERM first, then SIGKILL after a one-second grace period. An interactive shell gives each job its own process group, so signalling `script`'s group alone would miss a backgrounded job (`npm run dev &`); the session id is what they all share. A program that called `setsid()` itself (a daemon) has left the session on purpose and keeps running.

Backend resolution runs once, at the first session. Windows loads `node-pty`; POSIX probes the command-based backends. If none is available, the session falls back to a **piped** child (`interactive: false`). Everything non-interactive works identically in that degraded mode, but prompting programs cannot ask a question and npm prints its link masked.

### Line terminator

`writeCliCommand` is the single place the terminator is chosen: CRLF for `cmd.exe` on Windows, LF for sh/bash on POSIX. Writing CRLF to a POSIX shell makes the trailing `\r` part of the command token (`ls\r` → `command not found`), which is why the rule lives in one shared helper rather than at each call site.

### Stdin owner and echo line

On a pty the shell's line editor echoes what is typed at its prompt, and a program that turns echo off (`read -s`, `sudo`, npm's OTP prompt) shows nothing. The modal therefore writes **no** echo line of its own on a pty — an earlier version did, which showed every command twice and printed hidden answers as `❯ secret123`. Only a **piped** session (`interactive: false`) gets the modal's `❯ <cmd>\n` line, because nothing else echoes there.

Who reads stdin is tracked as `owner` in [CliModal.jsx](../../../frontend/src/components/chat/CliModal.jsx):

| `owner` | Source | Meaning |
| --- | --- | --- |
| `'shell'` | `ESC [?2004h` in the output | bash (readline ≥ 8.1) / zsh (≥ 5.1) enabled bracketed paste: its prompt is waiting |
| `'program'` | `ESC [?2004l` in the output | the shell accepted a line and a command is running |
| `'piped'` | `interactive: false` from the session endpoint | no TTY, nothing can prompt |
| `null` | session start on a pty, `exit` frame, or a shell that never sends the markers (dash) | unknown |

`lineEditorState(tail, chunk)` in [cliKeys.js](../../../frontend/src/components/chat/cliKeys.js) finds the last marker in one chunk plus a carry of `marker.length - 1` bytes, so a marker cut across two SSE frames is still seen, only once, and the per-chunk cost does not grow with the session's output. `owner` is a real statement from the child, not a guess from what the output looks like.

`!!` is left to the shell's own history expansion (pty only; a piped `sh -c`-style child and `cmd.exe` have none).

### Suggestions

`frontend/src/components/chat/cliSuggest.js` is pure (no Preact, no DOM) and is unit-tested by `scripts/test-cli-suggest.js`. Two client-side sources, no new endpoint:

- **history** — a short list in the modal's state, updated by `rememberCommand(history, cmd, owner)` when Enter sends a line: newest first, de-duped, capped at `MAX_HISTORY` (40). A line is kept only when `owner` is `'shell'` or `'piped'`, so an answer typed to a program — possibly a password — never becomes a chip; blank lines and history expansions (`!!`, `!git`) are skipped, and so is the rest of a line a readline key already pushed to the shell (`lineDirtyRef`), whose full text the modal no longer knows. The history is never read back from the screen: that would re-split the whole output on every chunk and pick up anything a program echoed.
- **names** — the top level of the project, from `GET /api/files?projectDir=…` (the endpoint [FileEditor.jsx](../../../frontend/src/components/FileEditor.jsx) already browses with), fetched once after the session starts so a slow listing cannot delay the terminal. Hidden dot-entries are skipped; a directory is offered as `name/`.

`suggestionsFor({ draft, history, entries })` filters by the draft (substring, prefix matches first, source order inside a rank), drops a candidate equal to the draft, de-dupes and caps at `MAX_SUGGESTIONS` (7). It never refuses to run anything: a chip only calls `applySuggestion`, which rewrites `.cli__prompt` — **Enter is still the decision**.

### Key row

`frontend/src/components/chat/cliKeys.js` holds the six keys as one table (`CLI_KEYS`), so each byte sequence lives in exactly one place:

| id | label | sequence |
| --- | --- | --- |
| `esc` | `Esc` | `\x1b` |
| `tab` | `Tab` | `\t` |
| `up` | `↑` | `\x1b[A` |
| `down` | `↓` | `\x1b[B` |
| `int` | `^C` | `\x03` |
| `eof` | `^D` | `\x04` |

`shellOnly: true` marks Tab and the two arrows: they edit the prompt's **own** buffer (completeLocally / stepHistory), so the row dims exactly those three while a program owns the prompt (`owner === 'program'`) and leaves Esc, `^C` and `^D` lit — those three mean the same thing to a program as to a shell, and `^C` is the key a waiting program needs. The class it drives is `.cli__key--shell` under `.cli__keys.is-prompt` in [chat-composer.css](../../../frontend/src/chat-composer.css).

Esc, `^C` and `^D` go through `POST /api/tools/cli/command` with **`raw: true`**, so `writeCliCommand` appends no terminator (`\n` on POSIX, `\r\n` on Windows). Appending one to `\x03` would send Ctrl+C *and* Enter, answering a prompt the user never saw; that is the invariant the test asserts byte for byte. Tab and ↑/↓ write **nothing** to the child — `keyPayload` returns `{ seq: '' }` for a `shellOnly` key — and are handled entirely in the prompt buffer.

`keyPayload(key)` decides what a tap writes: `shellOnly` keys write nothing, `int` (`^C`) writes ETX and returns `clearDraft: true`, Esc and `^D` carry their byte and leave the field alone. An earlier version had the readline keys flush `draft + seq` onto the shell's line and clear the field (`clearDraft: true`); on a phone the shell's echoed line is easy to miss, so a Tap looked like "Tab ate my text", and on a piped session it lost the text outright. Tab now calls `completeLocally(text, history, entries)` from [cliSuggest.js](../../../frontend/src/components/chat/cliSuggest.js) and ↑/↓ call `stepHistory(history, index, dir)`, both of which rewrite `cmdText` (and the DOM value, caret at the end) in place; nothing is sent until Enter.

`completeLocally` has two phases. **The line**: a `history` command that starts with the whole field completes it (`npm ru` → the history's `npm run test:cli`, or their longest common prefix when several match). **The word**: when no command matches, the field's trailing word (`\S*$`) completes from the project's top-level names, prefix preserved (`ls pac` → `ls package.json`, `cd scr` → `cd scripts/`). It returns the new text, or `null` when nothing matches (the field is left untouched). `stepHistory(history, index, dir)` walks the same newest-first list — ↑ goes older (`index + 1`, clamped at the oldest), ↓ back toward the newest (`index - 1`), landing on `index: -1` with an empty line past the newest. The walk index lives in `recallIndexRef`, reset on each keystroke and on send/raw.

Every control in both rows cancels `mousedown` (`keepEditorFocus`) so the browser cannot move focus to the button — on iOS and Android that would close the soft keyboard on every tap. The prompt is **never disabled**: disabling a focused input blurs it, and a `focus()` issued later from a fetch callback runs outside the user gesture, which iOS will not honour with a keyboard. Instead every write goes through one promise chain (`queueRef` / `post`), so taps reach the shell in the order they were made and `^C` is never blocked behind the request it is meant to interrupt.

The row dims its readline keys (`.cli__keys.is-prompt`) exactly when `owner === 'program'`. The hint names the mode (`Tab completes and ↑/↓ recall in the prompt. ^C stops the running command.`); completing a command line while a program waits for an answer is the wrong thing to do, so Tab/↑/↓ go quiet there. Tab and ↑/↓ work the same on a piped session: the completion sources are all client-side, so no terminal is needed.

### Output catch-up

`subscribeCliOutput` in [cliOutput.js](../../../frontend/src/components/chat/cliOutput.js) owns the EventSource and retained-output replay. It catches up with `GET /api/tools/cli/output?id=…&since=…` on initialization, SSE open/error, after command writes, and every 1.5 seconds while mounted. This also covers a proxy buffering an apparently connected SSE response. Only one replay request runs at a time; live frames received during replay are queued, ordered and deduplicated against the replay's sequence watermark. Session end stops polling, and cleanup closes the EventSource and clears the timer without killing the shell. No REST surface changes are needed.

`scripts/test-cli-output.mjs` exercises catch-up independently. `scripts/cli-modal-live-fixture.mjs` mounts the real component against an isolated `createServer` and a disposable project; `?buffered=1` simulates a stream with no delivered frames while preserving real shell execution and replay requests.

### Screen decoding

`CliScreen` buffers escape sequences that arrive split across SSE chunks, honours cursor positioning and erase, and enters/leaves the alternate screen. A full-screen TUI (htop, top, less) therefore redraws **in place** instead of stacking frames, and ordinary scrollback grows downward. It is a best-effort plain-text view, not a full terminal emulator: colour and cell-width attributes are dropped and column layout is not reconstructed.

Output reaches the modal in arbitrary chunks, so a token can be cut anywhere. Both layers hold an incomplete token until the rest arrives, so nothing half-finished is ever rendered as text:

- **Bytes → text (server).** `attachCliStream` decodes each channel through its own `StringDecoder`, so a multi-byte UTF-8 character split across two chunks (`é`, `✓`, an emoji, a TUI's box-drawing border) is joined instead of becoming two `�`. A dangling partial character is flushed before the `exit` frame.
- **Text → screen (browser).** `CliScreen.write()` keeps any unterminated sequence in `pending` and completes it on the next chunk. That covers CSI (`ESC [ … final`, and the 8-bit `U+009B` form), OSC (window titles, `OSC 8` hyperlinks) terminated by BEL or `ESC \`, the DCS / SOS / PM / APC control strings, one-byte designators such as `ESC ( B`, and a lone `ESC` at the very end of a chunk. A malformed CSI is abandoned at the first byte that cannot belong to it, and an unterminated control string is dropped once it passes 8,192 code points, so neither can swallow the output that follows.

```text
chunk 1: "build \x1b"      chunk 2: "[32mok\x1b[0m"
before:  build [32mok      after:  build ok
```

### Mobile controls

Every affordance the sheet needs is on the sheet, at the `--tap` (44 px) floor. The header carries **Stop** (`.cli__stop`) and the close button (`.icon-btn .icon-btn--close .cli__iconbtn`); `.cli__iconbtn` is re-declared in [chat-composer.css](../../../frontend/src/chat-composer.css) because the shared `.icon-btn` is `--tap-sm` (32 px) and a header glyph must clear the same 44 px minimum as everything else. The prompt row ends with **Run** (`.cli__run`), which calls the same `runCommand` as Enter and cancels `mousedown` (`keepEditorFocus`) so a tap cannot close the soft keyboard. `enterkeyhint: 'send'` only labels the keyboard's own action key; Run is the one that is *visible*.

Run is an icon-only action with an accessible label. Its visible background is inset inside a 44 px touch target, as are the keyboard toggle and optional key faces. `keysOpen` defaults to false; only a tap on the keyboard icon mounts `.cli__keys` and `.cli__hint`. Suggestions mount only for a non-empty draft, and use a horizontally scrollable row without bulky filled chips. The prompt is 2 rem tall (overriding the shared input minimum) with a 1 rem font to avoid iOS focus zoom. `useVisualViewport` updates `--cli-viewport-top` and `--cli-viewport-height` on the overlay so the layout fits above the soft keyboard even when the visual viewport pans. The output painting effect depends on `loading` and `error` as well as `outBuffer`: output received before the `<pre>` mounts must be painted when startup completes, even without another output chunk.

An `exit` frame (`appendOut(…, 'exit')`), a replay reporting `running: false` / HTTP 404, or a command returning HTTP 404 / 410 sets `exited`, which:

- removes the suggestion row (`!exited && cmdText && suggestions.length`) and the prompt/key rows, replacing them with `.cli__dead` — a one-line notice and a `.cli__restart` button;
- swaps the header's Stop for Restart (`exited && !loading && !error`).

`restart()` clears the screen (`screenRef.current = new CliScreen()`, `setOutBuffer('')`), resets the prompt and history walk, and bumps `restartKey`, which is the session effect's second dependency — so the effect re-runs against a *fresh* child (the server's `GET /cli/session` starts a new session because the old one was reaped on exit). A cleared screen is deliberate: the old output belongs to a dead shell, and keeping it above a live prompt would read as one continuous session.

Startup failures offer **Retry**, which clears the error and re-runs session initialization through the same restart path. `scripts/test-cli-modal.mjs` covers the component's startup, command writes, viewport properties and recovery paths; it runs with `npm run test:cli`.

### Limits

- A PTY has a fixed grid size (100×30). The modal does not yet report its own dimensions, so `resize` is not driven from the browser.
- Some single-key prompts (a `y/n` confirmation that reads raw mode) expect the key byte alone — use **Ctrl+Enter** so no trailing newline is sent.
- **Ctrl+Enter** (the raw single-key send) is a desktop chord: a soft keyboard cannot produce it, which is why the key row exists — `^C` and `^D` reach the two bytes that matter most, and the suggestion row removes the need to retype a command at all.
- The default footer is one prompt row. Suggestions appear only while typing, and extra keys are opt-in. On a short viewport the output shrinks before the active controls, whose touch targets remain 44 px.
