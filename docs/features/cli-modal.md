# CLI modal

## Overview

The CLI modal is a full-screen command prompt inside a chat, opened from the composer's File button → **Cli**. It runs a persistent shell for the project — the platform shell (`cmd.exe` on Windows, the user's `$SHELL` or `/bin/sh` on POSIX) — with the project directory as the working directory. Output streams into the modal; each line typed at the prompt is sent to the same running process.

The session runs on a **pseudo-terminal**, so programs that ask a question (`npm publish` under two-factor authentication, `git commit` for a missing identity, `sudo`, `read`) can show the prompt and read the answer you type.

## Usage

Open the composer's File button and choose **Cli**. The header shows the shell label, the project directory, and an **interactive** badge when the session has a real terminal.

- Type a command and press **Enter** to run it.
- Press **Enter** again to send an empty line — an interactive prompt that offers a default accepts it.
- Press **Ctrl+Enter** (**Cmd+Enter** on macOS) to send the line **without a line terminator**, for a program waiting on a single key (a `y/n` confirmation, a pager).
- Close the sheet with the close button or **Escape**. Closing kills the session.

Because the session is a real terminal, an interactive program can wait for you. Publishing from the modal is the motivating case:

```text
$ npm publish --otp=
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
npm error code EOTP
Open this URL in your browser to authenticate:
  https://www.npmjs.com/auth/cli/***
```

With the interactive session you can instead run the command, read the prompt, and answer it in the same sheet:

```text
$ npm publish --otp=
This operation requires a one-time password.
Enter OTP: 123456
+ mouaif@0.3.0
```

You can also run multiple commands in one session — the shell keeps its state (working directory, environment, variables) between lines.

## Implementation notes

### Session lifecycle

- `GET /api/tools/cli/session?projectDir=<abs>` starts or reuses the per-project session and returns `{ id, projectDir, shell, interactive, startedAt, defaultDir }`. `interactive` is `true` when the child runs on a pseudo-terminal.
- `POST /api/tools/cli/command` with `{ projectDir, cmd, raw? }` writes one line to the session's stdin. `raw: true` omits the line terminator.
- `POST /api/tools/cli/close` with `{ projectDir }` kills the session (idempotent).
- Output is broadcast over the `GET /events` SSE channel as `cli_output` frames `{ id, stream, data }`, filtered client-side by session id. A PTY merges stdout and stderr, so every chunk is labelled `stdout`; the piped fallback keeps a separate `stderr` channel.

The session helpers live in [src/server-handlers-tools.js](../../src/server-handlers-tools.js) (`ensureCliSession`, `writeCliCommand`, `attachCliStream`, `closeCliSession`). The modal is [frontend/src/components/chat/CliModal.jsx](../../frontend/src/components/chat/CliModal.jsx), and the stateful ANSI/VT screen decoder it renders through is `CliScreen` in [frontend/src/components/chat/utils.js](../../frontend/src/components/chat/utils.js).

### Pseudo-terminal and the piped fallback

The session is spawned with `node-pty`. Over pipes (`stdio: ['pipe', ...]`) the child is **not** a TTY, so a prompting program gets an immediate EOF — `read` returns an empty answer and `npm publish` refuses to prompt at all, answering `EOTP` with a **redacted** `…/auth/cli/***` URL (npm's `@npmcli/redact` masks the one-time token before printing it; the `*` characters are npm's placeholder, not the modal's).

`node-pty` is an optional native dependency. Where no prebuilt binary exists and no C++ toolchain is available, `require('node-pty')` fails, the module is treated as absent, and the session falls back to the original **piped** child. Everything non-interactive works identically; only prompting programs cannot ask a question. The session then reports `interactive: false`, and the modal omits the badge.

### Line terminator

`writeCliCommand` is the single place the terminator is chosen: CRLF for `cmd.exe` on Windows, LF for sh/bash on POSIX. Writing CRLF to a POSIX shell makes the trailing `\r` part of the command token (`ls\r` → `command not found`), which is why the rule lives in one shared helper rather than at each call site.

### Screen decoding

`CliScreen` buffers escape sequences that arrive split across SSE chunks, honours cursor positioning and erase, and enters/leaves the alternate screen. A full-screen TUI (htop, top, less) therefore redraws **in place** instead of stacking frames, and ordinary scrollback grows downward. It is a best-effort plain-text view, not a full terminal emulator: colour and cell-width attributes are dropped and column layout is not reconstructed.

### Limits

- A PTY has a fixed grid size (100×30). The modal does not yet report its own dimensions, so `resize` is not driven from the browser.
- Some single-key prompts (a `y/n` confirmation that reads raw mode) expect the key byte alone — use **Ctrl+Enter** so no trailing newline is sent.
- Desktop-only. On a phone the soft keyboard covers much of the sheet; the modal is usable but not the primary surface.

## Tests

```bash
npm run test:cli
```

- `scripts/test-cli-session-newline.js` — drives the real endpoints and asserts a plain `ls` lists the project files (the terminator rule).
- `scripts/test-cli-strip-ansi.js` — unit-tests `stripAnsi` / `CliScreen`.
- `scripts/test-cli-pty-interactive.js` — asserts the session is interactive, that a prompting program's question reaches the screen, and that the answer POSTed to the command endpoint is read back by the still-running child. It skips (exit 0) when `node-pty` is not installed, because that is the documented degraded mode.