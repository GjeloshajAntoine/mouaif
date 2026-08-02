# Shell tool — let the model run commands in the project

<!--
  Static-page-ready. No SSG shortcodes. Update docs/README.md in the
  same commit that adds this file.
-->

## Overview

`mouaif` ships a built-in `shell` tool the model can invoke. The tool runs a command in the project's working directory, captures stdout / stderr / exit code / duration, and returns the result to the model. Calls and results ride the chat as `tool_call` and `tool_result` SSE events (see [docs/features/ai-client.md](./ai-client.md) for the reserved event names) and are persisted with the transcript and written to the trace file when tracing is on. The tool is **off by default per project**; the user opts in through project settings and gates every call with the authorization system ([docs/features/tool-authorization.md](./tool-authorization.md)).

## Usage

### Enabling the tool

In **Settings → Project settings → Tools** (reachable from a project card's ⋯ menu → **Settings…**), a **Shell tool** switch enables `shell` for that project. It persists `tools.shell.enabled: true` on the project's `.mouaif.json`. With it on, the AI client's outgoing request advertises the tool to the model using the OpenAI-compatible tool-call shape:

```json
{
  "type": "function",
  "function": {
    "name": "shell",
    "description": "Run a shell command in the project directory through mouaif, the local AI coding assistant that provides this chat. Commands execute on <os> via <shell> (e.g. \"Windows via Command Prompt (cmd.exe) — Windows command-line syntax (cmd.exe batch-style quoting and escaping; not POSIX sh/bash)\" or \"macOS via zsh (/bin/zsh) — POSIX sh syntax\"). Returns stdout, stderr, and exit code. Non-interactive only: the child has no stdin, so REPLs, prompts, and commands that read from stdin fail or exit immediately — run the one-shot/flagged form instead.",
    "parameters": {
      "type": "object",
      "properties": {
        "cmd":       { "type": "string", "description": "The command to run, as a single string. Must be non-interactive (no stdin input, no REPL, no prompts)." },
        "shell":     { "type": "string", "description": "Optional. The exact interpreter to run the command with, e.g. \"cmd.exe\" (default), \"pwsh\", or \"powershell.exe\" on Windows; a path to a sh-compatible binary on POSIX. Falls back to the platform default when omitted." },
        "timeoutMs": { "type": "integer", "description": "Optional per-call timeout, 1 ms - 10 min. Default 30 000." }
      },
      "required": ["cmd"],
      "additionalProperties": false
    }
  }
}
```

The tool spec makes the shell dialect explicit — `cmd.exe` on Windows is not POSIX sh, so the model is told up front which syntax to write (see [Model awareness](#model-awareness) below). An optional `shell` parameter lets the model (or a REST caller) pick a different interpreter for a single call; it is validated before use.

### In a chat

When the model decides to call the tool, the server intercepts the call (the model only sees the tool's description; the actual execution lives behind the mouaif server), runs the command in `projectDir`, and forwards the result back to the upstream as a `tool` message before continuing the stream. This is a real **multi-turn loop**: the model can call the tool, read the result, and call again until it considers the task complete or the user aborts the request. The chat UI shows every call and result inline in the conversation.

The wire shape on the SSE stream:

```
event: tool_call
data: { "id": "call_abc123", "name": "shell", "args": { "cmd": "npm test", "timeoutMs": 60000 } }

event: shell_output
data: { "id": "call_abc123", "stream": "stdout", "delta": "> project@1.0.0 test\n" }

event: shell_output
data: { "id": "call_abc123", "stream": "stderr", "delta": "npm warn ...\n" }

event: tool_result
data: { "id": "call_abc123", "name": "shell", "ok": true, "result": { "stdout": "...", "stderr": "", "exitCode": 0, "durationMs": 4213, "identity": "mouaif shell · macOS · zsh (/bin/zsh)" } }
```

`shell_output` frames are live, best-effort output deltas emitted while the command is still running. They are never persisted to the transcript; the final `tool_result` carries the complete (truncated) output. The `identity` field names the software (`mouaif shell`) plus the OS and the exact shell that ran the command; the same line is prepended to the first model-facing `tool` message so the model always knows which environment executed its command.

The chat composer also accepts a `/shell <cmd>` slash command that runs the tool directly without going through the model. The output is rendered in the chat as a `tool_result` block. This is the same code path as a model-initiated call — the only difference is that there is no prior `tool_call` from the model and the result is shown without a follow-up assistant message.

### REST

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| `POST` | `/api/tools/shell` | `{ projectDir, cmd, timeoutMs?, shell? }` | `{ ok, stdout, stderr, exitCode, durationMs, identity }` or `{ ok: false, error, code }` |

The REST endpoint is the same path the model-initiated call goes through. The chat composer uses it for `/shell`. A script can also use it to run a project command without going through the chat at all.

### Programmatic (Node)

```js
const { runShell } = require('mouaif/src/tools/shell.js');

const out = await runShell({
  projectDir: '/abs/path/to/project',
  cmd: 'npm test',
  timeoutMs: 60_000
});
// out: { ok: true, stdout: '...', stderr: '', exitCode: 0, durationMs: 4213,
//        identity: 'mouaif shell · macOS · zsh (/bin/zsh)' }
```

`runShell` also accepts an optional `shell` override (`runShell({ projectDir, cmd, shell: 'pwsh' })`), which must be one of `cmd.exe` / `pwsh` / `powershell` on Windows or a path to a sh-compatible binary on POSIX; anything else returns `EBADINPUT` without spawning.

## Behavior

- **Working directory.** Commands run in `projectDir`. The runner resolves the path and refuses anything outside the project root (`..` segments, absolute paths, symlinks that point outside) with `EOUTSIDE_PROJECT`. The runner is `path.join`-aware; it does not shell-`cd` for the user.
- **Shell.** The command is run with the user's login shell (`$SHELL` on POSIX, `cmd.exe /d /s /c` on Windows). It is a single string passed verbatim; there is no command parsing or argument splitting. Pipes, redirects, and `&&` chains are the user's responsibility and are not interpreted by mouaif. On Windows the runner passes the flags as separate argv elements and wraps the command in an extra pair of quotes with `windowsVerbatimArguments` so `cmd /s` quote-stripping does not mangle inner quotes (e.g. `node -e "console.log(1+1)"`). An optional per-call `shell` override reuses the same quoting rules when it resolves to `cmd.exe`/`cmd` and plain `-c` otherwise, so the override can never become an arbitrary-arguments injection.
- **Env.** The child inherits the parent process's environment, minus a small denylist (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`) to prevent trivial tool escape. `PATH` is preserved.
- **Sandboxing.** The runner does not provide OS-level sandboxing (containers, seccomp, `bwrap`). It is the user's responsibility to enable the tool only on projects they trust. The Settings UI shows a warning when the toggle is flipped on, and the authorization system (§17) requires explicit approval per call by default.
- **Timeouts.** A per-call `timeoutMs` is honored; the default is 30 s, the ceiling is 10 min. On timeout the child is killed (SIGTERM, then SIGKILL after 5 s) and the result is `{ ok: false, error: 'timed out', code: 'ETIMEDOUT', durationMs: <actual elapsed ms> }`. A child that ignores SIGTERM stays tracked for the exit-hook reap; its late `close` is ignored.
- **Output size cap.** stdout and stderr are truncated to a per-call cap (default 256K chars each, configurable via `app.shellOutputMaxBytes`). The cap counts characters (UTF-16 code units), not bytes, so multi-byte output is never split mid-codepoint and the marker matches what the model and the UI read. Truncation adds a final `\n...[truncated at 262144 chars]` line; the original exit code is preserved.
- **Multi-turn loop.** Tool results are fed back to the model as `tool` messages, so the model can chain calls (read a file, run a build, read the error, fix it). There is no fixed tool-turn limit; cancellation comes from the user aborting the active request.
- **Non-interactive only.** The child runs with no stdin (`stdio: ['ignore', 'pipe', 'pipe']`), so REPLs and commands that read stdin (bare `node`, `cmd` builtins, `npm init`, ...) fail or exit immediately — e.g. `Input redirection is not supported, exiting the process immediately.` on Windows. The tool spec declares this constraint; use one-shot forms (`node -e "..."`, `npm test`, flags) instead.
- **Identical-call circuit breaker.** The tool loop has no turn limit, so a model retrying the exact same failing call (same tool + same arguments) would spin forever. After 3 consecutive identical calls the server refuses the 4th+ with an `ELOOP` tool error telling the model to vary the command or answer in plain text. Any different call resets the streak.
- **Live output preview.** While the command runs, decoded stdout/stderr chunks ride the SSE stream as `shell_output` events so the chat card can stream a live preview (same for shell calls nested inside a subagent, which re-emit as `subagent_event` with `kind: "shell_output"`). These frames are UI-only — never persisted and never sent back to the model; the authoritative output is the single `tool_result` after the command exits.
- **Disabled by default.** A project with the tool off returns `ETOOL_DISABLED` for any call (model-initiated or `/shell`).
- **Persisted with the chat.** `tool_call` and `tool_result` events are written to `<projectDir>/.mouaif.traces.<chatId>.json` (when tracing is on) and to the per-chat NDJSON trace (decision §5) as `tool_call` and `tool_result` lines.
- **No new runtime dependencies.** The runner is built on `node:child_process.spawn` only. No third-party shell wrappers.

## Model awareness

The model learns which shell will run its commands from three redundant sources, so it cannot miss the dialect even after prompt compaction:

- **Tool spec.** The `shell` description embeds the OS + interpreter + dialect hint computed at module load, e.g. `Commands execute on Windows via Command Prompt (cmd.exe) — Windows command-line syntax (cmd.exe batch-style quoting and escaping; not POSIX sh/bash)`.
- **Feature summary.** `src/agentFeatures.js` injects an extra `[shell] <dialect hint>` line into the per-project system context whenever the shell tool is enabled, next to the existing `[shell](off|ask|allow) → allow` line. The `list_features` tool returns the same detail structurally (`state.tools.shell.dialect`, `state.tools.shell.exe`).
- **Result identity.** Every `tool_result` carries an `identity` field (`mouaif shell · Windows · Command Prompt (cmd.exe)`), and the same line is prepended to the first model-facing `tool` message. When a `shell` override runs, the identity names the interpreter that actually executed the command (e.g. `mouaif shell · Windows · Windows PowerShell (powershell)`).

## Implementation notes

- Source: `src/tools/shell.js` (new module) — `runShell({ projectDir, cmd, shell, timeoutMs, maxChars, onOutput })`, `resolveSandbox(projectDir)`, `truncate(buf, maxChars)` (char-based), `shellLabel()` / `shellLabelFor()` / `shellDialectHint()` (interpreter naming, exported for reuse by the feature summary), and the model-facing `SPEC`. The spec description names mouaif and the concrete OS/shell/dialect (computed once at module load); `runShell` also returns an `identity` string and the AI client prepends it to the first tool message line.
- The tool spec is added to the outgoing request inside `ai.streamChat()`: when `opts.shellEnabled` is set, `require('./tools/shell.js').SPEC` is pushed onto the `tools` array alongside any MCP-discovered specs. `streamChat` runs the multi-turn loop itself — an inner `runUpstreamTurn()` performs one request and returns the assembled tool calls; the outer loop dispatches them through `dispatchTool()` (native `shell` first, then MCP `mcp__<slug>__<tool>`), appends the assistant tool-call message + `tool` result messages to the working conversation, and re-requests. The single final `done` event carries the summed usage across all turns.
- `src/index.js` `handleChatStream` resolves `settings.getResolved(projectDir).tools.shell.enabled` and passes `{ projectDir, shellEnabled }` to `streamChat`. It also mounts `POST /api/tools/shell` (`handleTools`), which gates on the same flag (HTTP 403 `ETOOL_DISABLED` when off).\n- The `/shell <cmd>` composer command is parsed in `src/web/src/components/Chat.jsx` (`runShellCommand`); it POSTs to `/api/tools/shell` and renders the result inline as a `tool_result` card, no model round-trip.\n- The Settings \u2192 Project view (`src/web/src/components/SettingsProject.jsx`) has a **Shell tool** checkbox that PUTs `tools.shell.enabled` on the project file.
- Mobile-first layout: the `tool_call` and `tool_result` blocks render as monospaced cards with a 13 px monospace font and a minimum 44 px tap target for expansion. Long stdout is collapsed by default with an expand action.
- The `process.on('exit')` and `process.on('SIGINT')` handlers in the existing server do not need changes; child processes are tracked in a `Set` and reaped on parent exit so a server shutdown does not leak zombie children.

## Related

- [docs/features/ai-client.md](./ai-client.md) — `tool_call` and `tool_result` SSE event names.
- [docs/features/tool-authorization.md](./tool-authorization.md) — every shell call passes through the authorization gate.
- [docs/features/trace.md](#) (decision §5) — `tool_call` and `tool_result` lines on the NDJSON trace.
- Decision: [docs/decisions.md §16](../decisions.md) (this feature) and §10 (AI client wire format).
