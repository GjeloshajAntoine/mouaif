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
