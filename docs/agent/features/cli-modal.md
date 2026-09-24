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

### Echo line

The server never echoes what it wrote to the child's stdin — the shell prints its own prompt only when interactive line editing is on, which is exactly what a non-TTY child or a pty with `TERM=dumb` is not — so the modal writes `❯ <cmd>\n` into the screen when it sends the command (`runCommand` in [CliModal.jsx](../../../frontend/src/components/chat/CliModal.jsx)). That line is three features in one:

- it is the record of *what was asked*, beside the output that answers it;
- it is the `!!` anchor: `!!` is expanded by the shell's own history, so the client keeps no second history to drift. `runCommand` writes **no** echo line for `!!` itself — the expanded command never crosses the wire, so the modal cannot know what it was; the shell's own prompt is the echo.
- it is the source the suggestion row reads its history from, and the fact that makes the key row's two modes distinguishable (a just-echoed line means the shell owns the prompt; anything after it means a program does).

A command line is not echoed for a **raw** send (a single key), and a **Ctrl+Enter** line is not echoed either — a raw write is an answer to a program's prompt, not a shell command, and echoing it would claim the shell had run it.

### Suggestions

`frontend/src/components/chat/cliSuggest.js` is pure (no Preact, no DOM) and is unit-tested by `scripts/test-cli-suggest.js`. Two client-side sources, no new endpoint:

- **history** — `historyFromOutput(outBuffer)` scans the rendered screen for `❯ …` lines, newest first, de-duped, capped at 40 read entries. `outBuffer` is `CliScreen.render()`, so a TUI's redraws have already been folded into the screen the reader sees.
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

`shellOnly: true` marks Tab and the two arrows: they are a *shell's* readline keys, so the row dims exactly those three while a program owns the prompt (`promptOpen`) and leaves Esc, `^C` and `^D` lit — those three mean the same thing to a program as to a shell, and `^C` is the key a waiting program needs. The class it drives is `.cli__key--shell` under `.cli__keys.is-prompt` in [chat-composer.css](../../../frontend/src/chat-composer.css).

Every key goes through the *same* `POST /api/tools/cli/command` with **`raw: true`**, so `writeCliCommand` appends no terminator (`\n` on POSIX, `\r\n` on Windows). Appending one to `\x03` would send Ctrl+C *and* Enter, answering a prompt the user never saw; that is the invariant the test asserts byte for byte. The arrows are sent as the VT sequences a real terminal sends, so a pty's line editor turns them into history rather than printing `[A`.

Every control in both rows cancels `mousedown` (`keepEditorFocus`) so the browser cannot move focus to the button — on iOS and Android that would close the soft keyboard on every tap. After any send the modal restores focus to `.cli__prompt`, but only *after the render that re-enables it*: the prompt is `disabled` while a request is in flight, and a disabled input cannot take focus, so focusing it in the request's `finally` silently did nothing — which a phone feels as the keyboard closing after every tap (`wantFocusRef` + a `busy` effect).

The row's mode comes from `promptOpen`, set at each state transition (cleared on a session `exit` frame, cleared where a command line is echoed, set for `!!`, left alone by a raw key). It is never inferred from the output bytes, which would misread a program that happens to print `❯`.

### Screen decoding

`CliScreen` buffers escape sequences that arrive split across SSE chunks, honours cursor positioning and erase, and enters/leaves the alternate screen. A full-screen TUI (htop, top, less) therefore redraws **in place** instead of stacking frames, and ordinary scrollback grows downward. It is a best-effort plain-text view, not a full terminal emulator: colour and cell-width attributes are dropped and column layout is not reconstructed.

Output reaches the modal in arbitrary chunks, so a token can be cut anywhere. Both layers hold an incomplete token until the rest arrives, so nothing half-finished is ever rendered as text:

- **Bytes → text (server).** `attachCliStream` decodes each channel through its own `StringDecoder`, so a multi-byte UTF-8 character split across two chunks (`é`, `✓`, an emoji, a TUI's box-drawing border) is joined instead of becoming two `�`. A dangling partial character is flushed before the `exit` frame.
- **Text → screen (browser).** `CliScreen.write()` keeps any unterminated sequence in `pending` and completes it on the next chunk. That covers CSI (`ESC [ … final`, and the 8-bit `U+009B` form), OSC (window titles, `OSC 8` hyperlinks) terminated by BEL or `ESC \`, the DCS / SOS / PM / APC control strings, one-byte designators such as `ESC ( B`, and a lone `ESC` at the very end of a chunk. A malformed CSI is abandoned at the first byte that cannot belong to it, and an unterminated control string is dropped once it passes 8,192 code points, so neither can swallow the output that follows.

```text
chunk 1: "build \x1b"      chunk 2: "[32mok\x1b[0m"
before:  build [32mok      after:  build ok
```

### Limits

- A PTY has a fixed grid size (100×30). The modal does not yet report its own dimensions, so `resize` is not driven from the browser.
- Some single-key prompts (a `y/n` confirmation that reads raw mode) expect the key byte alone — use **Ctrl+Enter** so no trailing newline is sent.
- **Ctrl+Enter** (the raw single-key send) is a desktop chord: a soft keyboard cannot produce it, which is why the key row exists — `^C` and `^D` reach the two bytes that matter most, and the suggestion row removes the need to retype a command at all.
- The suggestion and key rows are fixed the sheet's height, so on a short viewport (a phone with the keyboard up) the terminal output is what shrinks; both rows keep their 44 px targets and never scroll out of reach.
