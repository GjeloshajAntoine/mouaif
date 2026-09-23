# Shell tool — let the model run commands in the project — implementation notes

> Agent-facing reference for [`docs/features/shell-tool.md`](../../features/shell-tool.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

### REST

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| `POST` | `/api/tools/shell` | `{ projectDir, cmd, timeoutMs?, shell? }` | NDJSON stream (see below) |

A successful run streams `application/x-ndjson` lines — one `output` frame per live chunk while the command runs, then a final `result` frame with the complete tool result:

```
{"type":"output","stream":"stdout","delta":"> project@1.0.0 test\n"}
{"type":"output","stream":"stderr","delta":"npm warn ...\n"}
{"type":"result","result":{"ok":true,"stdout":"...","stderr":"","exitCode":0,"durationMs":4213,"identity":"mouaif shell · macOS · zsh (/bin/zsh)"}}
```

`result` carries the same shape the endpoint returned before streaming: `{ ok, stdout, stderr, exitCode, durationMs, identity }` or `{ ok: false, error, code }`. Error responses that happen *before* the run (authorization `409 EAUTH_REQUIRED`, `403` disabled/denied, bad input) are plain JSON, not NDJSON; clients should fall back to reading a non-NDJSON body as JSON.

The REST endpoint is the same path the model-initiated call goes through. The chat composer uses it for `/shell`. It also runs through the authorization gate: in `ask` mode a call without a prior grant returns HTTP `409` with `{ code: 'EAUTH_REQUIRED', chatId, callId, ... }`; the caller records a decision via `POST /api/tools/authorization/decision` and retries the call with the same `callId` (see [docs/features/tool-authorization.md](./tool-authorization.md)). The call requires `chatId` and `callId` to resolve the session.

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

## Model awareness

The model learns which shell will run its commands from three redundant sources, so it cannot miss the dialect even after prompt compaction:

- **Tool spec.** The `shell` description embeds the OS + interpreter + dialect hint computed at module load, e.g. `Commands execute on Windows via Command Prompt (cmd.exe) — Windows command-line syntax (cmd.exe batch-style quoting and escaping; not POSIX sh/bash)`.
- **Feature summary.** `src/agentFeatures.js` injects an extra `[shell] <dialect hint>` line into the per-project system context whenever the shell tool is enabled, next to the existing `[shell](off|ask|allow) → allow` line. The `list_features` tool returns the same detail structurally (`state.tools.shell.dialect`, `state.tools.shell.exe`).
- **Result identity.** Every `tool_result` carries an `identity` field (`mouaif shell · Windows · Command Prompt (cmd.exe)`), and the same line is prepended to the first model-facing `tool` message. When a `shell` override runs, the identity names the interpreter that actually executed the command (e.g. `mouaif shell · Windows · Windows PowerShell (powershell)`).
- **Live output respects explicit collapse.** `shell_output` chunks auto-open the call card so the preview is visible while running, but never re-open a card the user collapsed by tapping its header — a deliberate collapse wins over the live-output auto-open, so a late chunk can't pop a closed card back open.

## Implementation notes

- Source: [`src/tools/shell.js`](../../../src/tools/shell.js) — `runShell({ projectDir, cmd, shell, timeoutMs, maxChars, onOutput })`, `resolveSandbox(projectDir)`, `truncate(buf, maxChars)` (char-based), `shellLabel()` / `shellDialectHint()` (interpreter naming, exported for reuse by the feature summary), and the model-facing `SPEC`. The spec description names mouaif and the concrete OS/shell/dialect (computed once at module load); `runShell` also returns an `identity` string and the AI client prepends it to the first tool message line.
- The tool spec is added to the outgoing request inside `ai.streamChat()`: the native `shell` spec is always pushed onto the `tools` array (its Off/Ask/Allow mode decides whether a call prompts, runs, or is rejected — see [docs/features/tool-authorization.md](./tool-authorization.md)). `streamChat` runs the multi-turn loop itself — an inner `runUpstreamTurn()` performs one request and returns the assembled tool calls; the outer loop dispatches them through `dispatchTool()` (native `shell` first, then MCP `mcp__<slug>__<tool>`), appends the assistant tool-call message + `tool` result messages to the working conversation, and re-requests. The single final `done` event carries the summed usage across all turns.
- `handleChatStream` in [src/server-handlers-chats.js](../../../src/server-handlers-chats.js) resolves the tool authorization state and passes it to `streamChat`. It also mounts `POST /api/tools/shell` (via `handleTools` in [src/server-handlers-tools.js](../../../src/server-handlers-tools.js)), which runs every call through the authorization gate (`ask` → HTTP 409 `EAUTH_REQUIRED`, `off` → HTTP 403 `ETOOL_DISABLED`).
- The `/shell <cmd>` composer command is parsed in `frontend/src/components/chat/stream.js` (`runShellCommand`); it POSTs to `/api/tools/shell` and renders the result inline as a `tool_result` card, no model round-trip.
- The Settings → Project view (`frontend/src/components/SettingsProject.jsx`) shows the Off/Ask/Allow segments and PUTs `tools.shell: { mode, allowlist }` on the project file.
- Mobile-first layout: the `tool_call` and `tool_result` blocks render as monospaced cards with a 13 px monospace font and a minimum 44 px tap target for expansion. Long stdout is collapsed by default with an expand action.
- The `process.on('exit')` and `process.on('SIGINT')` handlers in the existing server do not need changes; child processes are tracked in a `Set` and reaped on parent exit so a server shutdown does not leak zombie children.

## Decisions

- [docs/decisions.md](../../decisions.md): §16 (shell tool), §10 (AI client wire format), §17 (tool authorization).
