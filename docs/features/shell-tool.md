# Shell tool — let the model run commands in the project

<!--
  Static-page-ready. No SSG shortcodes. Update docs/README.md in the
  same commit that adds this file.
-->

## Overview

`mouaif` ships a built-in `shell` tool the model can invoke. The tool runs a command in the project's working directory, captures stdout / stderr / exit code / duration, and returns the result to the model. Calls and results ride the chat as `tool_call` and `tool_result` SSE events (see [docs/features/ai-client.md](./ai-client.md) for the reserved event names) and are persisted with the transcript and written to the trace file when tracing is on. The tool is **off by default per project**; the user opts in through project settings and gates every call with the authorization system ([docs/features/tool-authorization.md](./tool-authorization.md)).

## Usage

### Enabling the tool

In **Settings → Project → Tools**, a switch enables `shell` for that project. With it on, the AI client's outgoing request advertises the tool to the model using the OpenAI-compatible tool-call shape:

```json
{
  "type": "function",
  "function": {
    "name": "shell",
    "description": "Run a shell command in the project directory. Returns stdout, stderr, and exit code.",
    "parameters": {
      "type": "object",
      "properties": {
        "cmd":       { "type": "string", "description": "The command to run, as a single string." },
        "timeoutMs": { "type": "integer", "description": "Optional per-call timeout, 1 ms - 10 min. Default 30 000." }
      },
      "required": ["cmd"],
      "additionalProperties": false
    }
  }
}
```

### In a chat

When the model decides to call the tool, the server intercepts the call (the model only sees the tool's description; the actual execution lives behind the mouaif server), runs the command in `projectDir`, and forwards the result back to the upstream as a `tool` message before continuing the stream. The chat UI shows the call and the result inline in the conversation.

The wire shape on the SSE stream:

```
event: tool_call
data: { "id": "call_abc123", "name": "shell", "args": { "cmd": "npm test", "timeoutMs": 60000 } }

event: tool_result
data: { "id": "call_abc123", "name": "shell", "ok": true, "result": { "stdout": "...", "stderr": "", "exitCode": 0, "durationMs": 4213 } }
```

The chat composer also accepts a `/shell <cmd>` slash command that runs the tool directly without going through the model. The output is rendered in the chat as a `tool_result` block. This is the same code path as a model-initiated call — the only difference is that there is no prior `tool_call` from the model and the result is shown without a follow-up assistant message.

### REST

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| `POST` | `/api/tools/shell` | `{ projectDir, cmd, timeoutMs? }` | `{ ok, stdout, stderr, exitCode, durationMs }` or `{ ok: false, error, code }` |

The REST endpoint is the same path the model-initiated call goes through. The chat composer uses it for `/shell`. A script can also use it to run a project command without going through the chat at all.

### Programmatic (Node)

```js
const { runShell } = require('mouaif/src/tools/shell.js');

const out = await runShell({
  projectDir: '/abs/path/to/project',
  cmd: 'npm test',
  timeoutMs: 60_000
});
// out: { ok: true, stdout: '...', stderr: '', exitCode: 0, durationMs: 4213 }
```

## Behavior

- **Working directory.** Commands run in `projectDir`. The runner resolves the path and refuses anything outside the project root (`..` segments, absolute paths, symlinks that point outside) with `EOUTSIDE_PROJECT`. The runner is `path.join`-aware; it does not shell-`cd` for the user.
- **Shell.** The command is run with the user's login shell (`$SHELL` on POSIX, `cmd.exe` on Windows). It is a single string passed verbatim; there is no command parsing or argument splitting. Pipes, redirects, and `&&` chains are the user's responsibility and are not interpreted by mouaif.
- **Env.** The child inherits the parent process's environment, minus a small denylist (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`) to prevent trivial tool escape. `PATH` is preserved.
- **Sandboxing.** The runner does not provide OS-level sandboxing (containers, seccomp, `bwrap`). It is the user's responsibility to enable the tool only on projects they trust. The Settings UI shows a warning when the toggle is flipped on, and the authorization system (§17) requires explicit approval per call by default.
- **Timeouts.** A per-call `timeoutMs` is honored; the default is 30 s, the ceiling is 10 min. On timeout the child is killed (SIGTERM, then SIGKILL after 5 s) and the result is `{ ok: false, error: 'timed out', code: 'ETIMEDOUT', durationMs: timeoutMs + 5000 }`.
- **Output size cap.** stdout and stderr are truncated to a per-call cap (default 256 KB each, configurable via `app.shellOutputMaxBytes`). Truncation adds a final `\n...[truncated at 256000 bytes]` line; the original exit code is preserved.
- **No streaming on the wire.** The tool returns a single `tool_result` after the command exits. A future revision may stream stdout/stderr line-by-line; for this commit, a single result is enough to keep the upstream contract simple.
- **Disabled by default.** A project with the tool off returns `ETOOL_DISABLED` for any call (model-initiated or `/shell`).
- **Persisted with the chat.** `tool_call` and `tool_result` events are written to `<projectDir>/.mouaif.traces.<chatId>.json` (when tracing is on) and to the per-chat NDJSON trace (decision §5) as `tool_call` and `tool_result` lines.
- **No new runtime dependencies.** The runner is built on `node:child_process.spawn` and `node:child_process.exec`. No third-party shell wrappers.

## Implementation notes

- Source: `src/tools/shell.js` (new module) — `runShell({ projectDir, cmd, timeoutMs })`, `resolveSandbox()`, `truncate(buf)`.
- The model-facing tool spec is registered in `src/ai.js` next to the existing `ENDPOINTS` table, so the same per-provider builder/parser path emits the call. The runner is invoked from a new `toolRunner` registry, also in `src/ai.js`; the chat handler in `src/index.js` calls the registry after the upstream returns a `tool_call` event and feeds the result back in as a `tool` message.
- The `/shell` composer command is parsed in `src/web/src/components/Chat.jsx`; the `client.shell(cmd)` helper POSTs to `/api/tools/shell` and renders the result inline.
- Mobile-first layout: the `tool_call` and `tool_result` blocks render as monospaced cards with a 13 px monospace font and a 32 px tap target for the expand/collapse chevron. Long stdout is collapsed to the last 12 lines by default with a "Show full output" action.
- The `process.on('exit')` and `process.on('SIGINT')` handlers in the existing server do not need changes; child processes are tracked in a `Set` and reaped on parent exit so a server shutdown does not leak zombie children.

## Related

- [docs/features/ai-client.md](./ai-client.md) — `tool_call` and `tool_result` SSE event names.
- [docs/features/tool-authorization.md](./tool-authorization.md) — every shell call passes through the authorization gate.
- [docs/features/trace.md](#) (decision §5) — `tool_call` and `tool_result` lines on the NDJSON trace.
- Decision: [docs/decisions.md §16](../decisions.md) (this feature) and §10 (AI client wire format).
