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

### Suggestions

Above the prompt, a row of chips offers what you are most likely to type next: the commands this session has already sent to the shell, newest first, and the project's own top-level files and folders. Tap a chip to put it in the prompt — **Enter still runs it**, so a suggestion is exactly as reversible as something you typed yourself.

- The row filters as you type: `npm r` offers `npm run …`, `src` offers `src/`, and a chip equal to what you have already typed is dropped rather than offered as a no-op.
- Folder chips carry a trailing slash (`src/`), file chips do not (`package.json`).
- Hidden dot-entries (`.gitignore`, `.env`) are not offered as chips.
- A command not in the row costs nothing: the prompt is still there, and the row goes quiet while nothing matches.
- Only commands sent to the **shell** are remembered. What you type in answer to a program's question — a `sudo` password, `read -s`, an npm one-time code — is never offered as a chip.

On a terminal session the shell shows each command itself, on its own prompt line, and a program that reads with echo off (a password prompt) shows nothing — so what you type stays off the screen. On a session without a terminal (a host where no pseudo-terminal can be allocated) nothing echoes, so the modal writes each command itself, marked with the same `❯` the prompt uses:

```text
❯ npm run test:cli
…test output…
```

Type **`!!`** and press **Enter** to repeat the previous command — the shell's own history expansion, handy when a keyboard has no Up arrow. It needs a terminal session; `!!` is not added to the suggestion row, the command it repeats already is.

### Keys

A phone keyboard has letters, digits and Enter, and nothing a terminal actually needs. Under the prompt, one row carries the six keys it lacks:

| Key | Sends | Does |
| --- | --- | --- |
| **Esc** | `ESC` | leave a full-screen program (`less`, `vim`, a TUI) |
| **Tab** | `HT` | complete a path or command |
| **↑** / **↓** | `ESC [ A` / `ESC [ B` | previous / next command in this shell's history |
| **^C** | `ETX` | interrupt the running command |
| **^D** | `EOT` | end input (EOF) |

Each key is one raw write with **no line terminator**, so `^C` interrupts without also pressing Enter — which would answer a second prompt you never saw. Tab, ↑ and ↓ take what you have typed with them: `npm ru` then **Tab** completes `npm ru` on the shell's own line, and the field empties because that line — shown on the screen — is now the one being edited. Keep typing to continue it and press **Enter** to run it. `^C` also clears what you had typed. Tapping a key or pressing Enter never dismisses the soft keyboard, and keys tapped in quick succession reach the shell in order.

A phone keyboard that has its own Tab key (Samsung Keyboard, Hacker's Keyboard, some Gboard layouts) works too. Those keyboards usually do not report a Tab key press at all — they type a literal tab character into the field — so the prompt watches its text: everything before the tab is sent exactly like a tap on the row's **Tab**, and anything typed after it stays in the field. Further tab characters are dropped; a command line has no use for them.

With a hardware keyboard, pressing **Tab** in the prompt does exactly what the on-screen **Tab** key does — it is not focus navigation there. The prompt is marked `data-own-tab`, which tells the sheet's shared focus trap (`frontend/src/hooks/useModal.js`) to leave plain Tab alone; **Shift+Tab** still moves focus out of the prompt, so the keyboard is never trapped.

Tab and the arrows are a **shell's** readline keys. When a program is running they are delivered to that program as literal bytes, which is usually not what you want — so the row dims just those three and the line under it says so (`A program owns the prompt — ^C stops it; Esc leaves it.`). The modal knows which is which because bash and zsh announce it: they switch the terminal's bracketed-paste mode on at their prompt and off when a command starts. **Esc**, **^C** and **^D** mean the same thing to a program as to a shell and stay lit; `^C` is the key a waiting program needs. Without a terminal there is no line editor, so Tab and the arrows do nothing and the hint says so.

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

- `scripts/test-cli-suggest.js` — unit-tests the suggestion and key rows' pure modules (the key table's sequences, what each key writes with a draft in the field, how a tab a phone keyboard typed into the field is split off and sent as Tab, who owns stdin from bracketed-paste markers split across chunks, which lines the history keeps, the ranking and the cap). Every key is asserted byte for byte, including that none of them carries a line terminator.
- `scripts/test-cli-session-newline.js` — drives the real endpoints and asserts a plain `ls` lists the project files (the terminator rule).
- `scripts/test-cli-strip-ansi.js` — unit-tests `stripAnsi` / `CliScreen`, including every escape-sequence family split at every pair of positions and fed one code point at a time.
- `scripts/test-cli-utf8-split.js` — feeds `attachCliStream` UTF-8 split at every byte boundary, on the PTY and piped paths, and asserts no `�` reaches the broadcast.
- `scripts/test-cli-pty-interactive.js` — asserts the session is interactive, that a prompting program's question reaches the screen, and that the answer POSTed to the command endpoint is read back by the still-running child. It skips (exit 0) when no pseudo-terminal can be allocated, because that is the documented degraded mode.
- `scripts/test-cli-symlink-project.js` — opens a session through a symlinked project path and asserts that a command reaches it and that close really ends it.
- `scripts/test-cli-npm-otp-url.js` — runs a real `npm publish` in a CLI session against a local registry that demands web 2FA, once per backend present on the host, and asserts the link reaches the modal complete (never `***`) and the publish finishes.
- `scripts/test-cli-pty-shim.js` — unit-tests `src/pty.js` on every POSIX backend present on the host (stdout is a terminal too, the grid is 100×30, not 0×0): `isAvailable()` is true on POSIX, quoting survives a path with spaces and quotes, `onData` replays what was buffered before the stream attached, `write` reaches the shell, and `kill` takes down the shell, its foreground job and any backgrounded job (`cmd &`). Windows uses node-pty's own platform-tested ConPTY adapter.
