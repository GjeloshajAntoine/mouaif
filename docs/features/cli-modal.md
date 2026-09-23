# CLI modal

## Overview

The CLI modal is a full-screen command prompt inside a chat, opened from the composer's File button → **Cli**. It runs a persistent shell for the project — the platform shell (`cmd.exe` on Windows, the user's `$SHELL` or `/bin/sh` on POSIX) — with the project directory as the working directory. Output streams into the modal; each line typed at the prompt is sent to the same running process.

The session runs on a **pseudo-terminal** on macOS, Linux, BSD, and supported Windows x64/ARM64 installations, so programs that ask a question (`npm publish` under two-factor authentication, `git commit` for a missing identity, `sudo`, `read`) can show the prompt and read the answer you type, and programs that only print full output to a terminal — npm's 2FA link — print it complete.

## Usage

Open the composer's File button and choose **Cli**. The header shows the shell label and the project directory.

- Type a command and press **Enter** to run it.
- Press **Enter** on an empty line to send it — a prompt that offers a default accepts it.
- Press **Ctrl+Enter** (**Cmd+Enter** on macOS) to send the line **without a line terminator**, for a program waiting on a single key (a `y/n` confirmation, a pager).
- Close the sheet with the close button or **Escape**. Closing kills the session.

Because the session is a real terminal, an interactive program can wait for you. Publishing from the modal is the motivating case. Without a terminal, npm fails and masks its one-time link (its log redactor replaces the UUID in the URL with `***`):

```text
$ npm publish
npm error code EOTP
npm error Open this URL in your browser to authenticate:
npm error   https://www.npmjs.com/auth/cli/***
```

In the modal, npm sees a terminal, prints the link complete, and waits for the web login to finish:

```text
$ npm publish
Authenticate your account at:
https://www.npmjs.com/auth/cli/0f8fad5b-d9cb-469f-a165-70867728950e
Press ENTER to open in the browser...
+ mouaif@0.3.0
```

Copy the link into your phone's browser and sign in; npm polls for the approval and continues on its own. (The **Press ENTER** line is npm offering to open a browser on the machine running mouaif, which is not the device you are holding — skip it.) An account on authenticator-app 2FA gets `Enter OTP:` instead — type the code and press **Enter**.

You can also run multiple commands in one session — the shell keeps its state (working directory, environment, variables) between lines.

## Implementation notes

### Session lifecycle

- `GET /api/tools/cli/session?projectDir=<abs>` starts or reuses the per-project session and returns `{ id, projectDir, shell, interactive, startedAt, defaultDir }`. `interactive` is `true` when a pseudo-terminal backend loaded. It is diagnostic only; the modal shows no badge for it.
- `POST /api/tools/cli/command` with `{ projectDir, cmd, raw? }` writes one line to the session's stdin. `raw: true` omits the line terminator.
- `POST /api/tools/cli/close` with `{ projectDir }` kills the session (idempotent).
- **Access:** these routes sit behind the app's access protection (session login and same-origin/CSRF checks), like every `/api/*` route. They do **not** consult the project's **Shell** tool Off/Ask/Allow mode. That mode governs what the *model* may run; the CLI modal is typed by the signed-in user, so it is treated like a terminal on the host.
- The session is keyed by the project's **real** path: `session` resolves symlinks with `realpath`, and `command` / `close` resolve the `projectDir` they receive the same way, so a project opened through a symlink reaches (and closes) the same shell.
- Output is broadcast over the `GET /events` SSE channel as `cli_output` frames `{ id, stream, data }`, filtered client-side by session id. A PTY merges stdout and stderr, so every chunk is labelled `stdout`; the piped fallback keeps a separate `stderr` channel.

The session helpers live in [src/server-handlers-tools.js](../../src/server-handlers-tools.js) (`ensureCliSession`, `writeCliCommand`, `attachCliStream`, `closeCliSession`), the pseudo-terminal shim in [src/pty.js](../../src/pty.js). The modal is [frontend/src/components/chat/CliModal.jsx](../../frontend/src/components/chat/CliModal.jsx), and the stateful ANSI/VT screen decoder it renders through is `CliScreen` in [frontend/src/components/chat/utils.js](../../frontend/src/components/chat/utils.js).

### Pseudo-terminal

The session is spawned on a pseudo-terminal by [src/pty.js](../../src/pty.js). Over pipes (`stdio: ['pipe', ...]`) the child is **not** a TTY, so a prompting program gets an immediate EOF — `read` returns an empty answer and `npm publish` refuses to prompt at all, answering `EOTP` with a **redacted** `…/auth/cli/***` URL (npm's `@npmcli/redact` masks the one-time token before printing it; the `*` characters are npm's placeholder, not the modal's).

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
- Desktop-only. On a phone the soft keyboard covers much of the sheet; the modal is usable but not the primary surface.

## Tests

```bash
npm run test:cli
```

- `scripts/test-cli-session-newline.js` — drives the real endpoints and asserts a plain `ls` lists the project files (the terminator rule).
- `scripts/test-cli-strip-ansi.js` — unit-tests `stripAnsi` / `CliScreen`, including every escape-sequence family split at every pair of positions and fed one code point at a time.
- `scripts/test-cli-utf8-split.js` — feeds `attachCliStream` UTF-8 split at every byte boundary, on the PTY and piped paths, and asserts no `�` reaches the broadcast.
- `scripts/test-cli-pty-interactive.js` — asserts the session is interactive, that a prompting program's question reaches the screen, and that the answer POSTed to the command endpoint is read back by the still-running child. It skips (exit 0) when no pseudo-terminal can be allocated, because that is the documented degraded mode.
- `scripts/test-cli-symlink-project.js` — opens a session through a symlinked project path and asserts that a command reaches it and that close really ends it.
- `scripts/test-cli-npm-otp-url.js` — runs a real `npm publish` in a CLI session against a local registry that demands web 2FA, once per backend present on the host, and asserts the link reaches the modal complete (never `***`) and the publish finishes.
- `scripts/test-cli-pty-shim.js` — unit-tests `src/pty.js` on every POSIX backend present on the host (stdout is a terminal too, the grid is 100×30, not 0×0): `isAvailable()` is true on POSIX, quoting survives a path with spaces and quotes, `onData` replays what was buffered before the stream attached, `write` reaches the shell, and `kill` takes down the shell, its foreground job and any backgrounded job (`cmd &`). Windows uses node-pty's own platform-tested ConPTY adapter.