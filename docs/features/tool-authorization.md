# Tool authorization — gating what tools the model may run

<!--
  Static-page-ready. No SSG shortcodes. Update docs/README.md in the
  same commit that adds this file.
-->

## Overview

Every tool call the model initiates — and every `/shell` slash command the user types in the composer — passes through an **authorization gate** before the runner executes. The user picks one of three primary modes per tool and project — **Off**, **Ask**, **Allow** — from a one-tap segmented control in project settings. An allowlist is an advanced refinement of Ask, not a fourth choice. The default is `ask`, so first use prompts for approval.

## Usage

### Modes

| Mode | Behavior |
|---|---|
| `off` | The tool is hidden from the model (its declaration is dropped from the request, so it costs no prompt tokens). Any call that still arrives — a stale chat filter, a hand-crafted REST call — returns `ETOOL_DISABLED`. |
| `ask` | Every call must be approved by the user in the UI. The chat shows a prompt with the command, working dir, and the proposed timeout; the user taps **Allow** or **Deny**. |
| `allowlist` | Calls whose `cmd` matches an allowlist regex run without prompting. Calls that do not match fall through to `ask`. This is the advanced form of `ask`; patterns are stored in the project file. The app-level MCP page keeps an **Auto-approve list** textarea; project-level patterns are edited from the raw `.mouaif.json` / `.mcp.json`. |
| `allow` | Every call is auto-approved. This project-level choice persists across chats and server restarts. |

The mode is set on the project record (per decision §2) and can be overridden per session by the user without writing the new value to disk:

```jsonc
// <projectDir>/.mouaif.json
{
  "tools": {
    "shell": {
      "mode":      "allowlist",     // 'off' | 'ask' | 'allowlist' | 'allow'
      "allowlist": [
        "^npm (test|run build|lint)$",
        "^git (status|diff|log|show)$"
      ],
      "defaultTimeoutMs": 30000,
      "maxTimeoutMs":     600000
    }
  }
}
```

A project with no authorization mode falls back to the app-level value, then to `ask`. The independent Shell enable switch remains off by default, so both conditions must pass before a command runs.

### MCP tools — layered, per-server and per-tool

MCP calls resolve through a four-level gate, most specific first:

1. `authorization.tools.<composedName>` — one tool on one server (`mcp__filesystem__write_file`). *(project `.mcp.json`)*
2. `authorization.servers.<serverSlug>` — every tool on that server. *(project `.mcp.json`)*
3. `authorization` (mode + allowlist) — the project's default for every MCP call. *(project `.mcp.json`)*
4. `mcp.authorization` (mode + allowlist) — the app-level default, the fallback for every project that has no project default. *(app SQLite store)*

The first entry with a `mode` wins; `ask` counts as a decision (so a per-server `ask` can tighten a project `allow`, and a project default can tighten the app default). A `null` value in a PUT patch deletes a project entry, restoring inheritance. `off` at any level hides exactly the specs it covers — one tool, one server, or every `mcp__*` spec — at zero prompt-token cost. The app layer carries only the single shared gate (mode + allowlist); per-server / per-tool maps are project-scoped, because the app store has no server registry.

```jsonc
// <projectDir>/.mcp.json
{
  "authorization": {
    "mode": "ask",
    "servers": {
      "filesystem": { "mode": "allow" },
      "playwright": { "mode": "allowlist", "allowlist": ["^mcp__playwright__navigate"] }
    },
    "tools": {
      "mcp__filesystem__write_file": { "mode": "off" }
    }
  }
}
```

MCP allowlists match against the summary `"<composedName> <firstStringArg>"` (e.g. `mcp__filesystem__read_file src/index.js`), so a pattern can pin either the tool itself (`^mcp__fs__read_file$`) or the resource it touches (`^mcp__fs__read_file src/.*`). Choosing **Always allow** on an MCP prompt pins only that one tool to `mode: "allow"` — it never flips the shared gate.

### Approval flow

When the gate is `ask` and the model initiates a call, the chat pauses the stream and renders an **Authorization required** card. The card shows:

- the tool name (`shell`)
- the proposed `cmd` and `timeoutMs`
- the project directory the command will run in
- the chat id and a "review trace" link (only when tracing is on)

The user can tap **Allow once**, **Allow for session**, **Always allow**, or **Deny**. **Always allow** persists `mode: "allow"` for that tool family in `.mouaif.json`, so it also applies to new chats and after restart. **Allow for session** remains in memory and is cleared when the chat is reopened.

For `subagent` calls the card also shows a **model picker**: the user may select which model executes the delegated run, for that one call only. See [Per-run model choice on subagent approval](./auth-model-picker.md).

The composer `/shell` slash command uses the same gate. A `/shell` invocation in `ask` mode shows the same card; the only difference is the source line ("user-typed slash command" instead of "model-initiated call").

### REST

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| `GET`  | `/api/tools/authorization?projectDir=<abs>` | — | `{ tools: { shell: { mode, allowlist, defaultTimeoutMs, maxTimeoutMs, source: 'project' | 'app' | 'default' }, ... }, mcp: { mode, allowlist, servers: { <slug>: { mode, allowlist? } }, tools: { <composedName>: { mode, allowlist? } } } }` |
| `GET`  | `/api/tools/authorization?scope=app` | — | `{ mcp: { mode, allowlist, servers: {}, tools: {} } }` — the app-level MCP gate only (server/tool maps are always empty at the app layer) |
| `PUT`  | `/api/tools/authorization` | `{ projectDir, tools: { ... }, mcp: { mode?, servers?, tools? } }` | `{ tools: { ... }, mcp: { ... } }` (echo) |
| `PUT`  | `/api/tools/authorization` | `{ scope: 'app', mcp: { mode?, allowlist? } }` | `{ mcp: { ... } }` — writes the app-level MCP gate; no `projectDir`, and `servers` / `tools` are rejected |
| `GET`  | `/api/tools/authorization/pending?projectDir=<abs>&chatId=<id>` | — | `{ pending: [{ callId, tool, cmd?, path?, query?, summary?, timeoutMs?, projectDir }] }` |
| `POST` | `/api/tools/authorization/cancel` | `{ projectDir, chatId }` | `{ ok: true, cancelled: <number>, running: <boolean> }` |
| `POST` | `/api/tools/authorization/decision` | `{ chatId, callId, decision: 'allow-once' | 'allow-session' | 'deny' }` | `{ ok: true }` |

The `PUT` `mcp` key accepts any combination of `mode` (the shared fallback), `servers` (a map of slug → `{ mode, allowlist? }` or `null` to clear), and `tools` (a map of composed tool name → `{ mode, allowlist? }` or `null` to clear). Entries are merged; a `null` value deletes the override.

The `decision` endpoint is the only path the UI uses to answer a pending prompt. It validates the chat and project ownership before recording the decision. Direct REST calls retry with the same opaque `callId` after approval; model calls remain blocked on their SSE stream. Reopening a chat calls the pending endpoint so authorization and ask-user cards can be shown again after navigation. The cancel endpoint denies pending prompts and aborts the active chat run when possible, which gives the mobile UI a visible escape hatch for a wedged stream.

## Behavior

- **Default: `ask`.** New tools land with `ask` so the first call always requires a tap. A user who wants a friction-free experience flips to `allowlist` with a tight regex set.
- **Allowlist is regex-matched against the full command.** The match is anchored on the full string (`^...$`); partial matches do not pass. Each untrusted expression runs in an isolated worker that is terminated after 1 ms, so catastrophic backtracking cannot block the HTTP process.
- **Decisions are session-scoped, not persisted.** An `allow-once` decision resumes exactly one blocked call. An `allow-session` decision is kept in server memory and cleared by `POST /api/chats/:id/touch` when the chat is reopened.
- **Deny reasons are kept private.** A deny records only the call id in the in-memory session. The upstream receives `{ ok: false, code: 'EDENIED', reason: 'user denied' }`, without the command, project, or chat id.
- **`off` hides the tool from the model.** Tools in `off` mode are filtered out of the advertised tool list before each upstream request (saving prompt tokens on every round), and the execution gate still rejects late or forged calls with `ETOOL_DISABLED` as defense-in-depth. File tools resolve through their `file` family name, so one `off` hides all five operations. MCP tools resolve through the layered `.mcp.json` authorization block (per-tool → per-server → shared fallback), so an `off` at any level hides exactly the specs it covers — one tool, one server, or every `mcp__<slug>__<tool>` spec at once.
- **File operations share one gate.** The model-facing `read_file`, `list_files`, `search_files`, and `write_file` names all resolve through `tools.file`; enabling File tools therefore enables authorization for all four operations instead of returning `ETOOL_DISABLED` for their individual names.
- **Timeouts are bounded by the project.** A call's effective timeout is `clamp(requestedTimeoutMs || defaultTimeoutMs, 1 ms, maxTimeoutMs)`. Anything above the cap is clamped silently; the UI surfaces the clamped value in the prompt.
- **Mode changes are not retroactive.** Flipping a tool from `allow` to `ask` mid-session revokes the blanket grant and the next call is asked again. Flipping to `off` drops the tool from the next request's tool list and rejects any in-flight call with `ETOOL_DISABLED`; the model's prior `tool_result` history is left untouched.
- **Audit log.** Every decision is appended to the per-chat trace file (decision §5) as a `system event` line (`{ type: 'auth_decision', tool, callId, decision }`) when tracing is on. The audit line is not forwarded to the upstream.

## Implementation notes

- Source: `src/tools/authorization.js` (new module) — `effectiveMode(projectDir, tool)`, `authorize({ projectDir, chatId, call })`, `recordDecision(chatId, callId, decision)`. `getAppMcpAuthorization()` / `setAppMcpAuthorization(patch)` read and write the app-level MCP gate (`mcp.authorization` in the app store), which `mcpLayeredConfig` already consumes as layer 4.
- The runner calls `authorize(...)` as the first line of its hot path. A `null` decision means "no prompt needed, execute"; a `{ prompt: true }` decision means "the server has emitted a `tool_call` event to the UI and is waiting for a `decision` event on the same SSE stream." The runner blocks until the decision resolves; a UI-side abort cancels the pending prompt and returns `EABORTED` to the upstream.
- The chat touch route clears in-memory grants before updating `lastOpenedAt`; grants never enter `.mouaif.json`.
- The Settings UI lives in `src/web/src/components/SettingsProject.jsx` under the **Tools** tree. Each tool row is one line: title, a one-line note (which reads "Hidden from the model — costs no tokens." in `off` mode), and a segmented **Off / Ask / Allow** control (`toolModeSegs`). Picking **Allow** clears any stored patterns. `ask_user` stays binary (`off` / `ask`). The Settings → Project tree no longer renders allowlist textareas — patterns in the project file are still honored, but are edited from the raw JSON in Technical details. MCP authorization renders through the same tree everywhere the tree appears: the chat tools card and the project settings tree both show an **MCP default** row (the project's shared gate) plus one **Off / Ask / Allow** segment per configured MCP server (the per-server override — the segment shows the effective mode and gains a ↺ reset when an override is set). The shared control lives in `McpAuthSeg` / `mcpEffective` in [src/web/src/components/settings/toolAuth.js](../../src/web/src/components/settings/toolAuth.js), wired into the chat card by [src/web/src/components/chat/cards.js](../../src/web/src/components/chat/cards.js) and into settings by `SettingsProject.jsx`. The server edit view (`SettingsMcpEditView`) adds the per-tool layer as an **Inherit / Off / Ask / Allow** select under "Discovered tools", and the app MCP page ([src/web/src/components/SettingsMcp.jsx](../../src/web/src/components/SettingsMcp.jsx)) carries the app-level **Default permission** row, which keeps its own **Auto-approve list** textarea. Project rows write `{ projectDir, mcp: { mode?, servers?, tools? } }`; the app row writes `{ scope: 'app', mcp: { mode?, allowlist? } }`.
- The Authorization card in the chat composer exposes Allow once, Allow for this session, and Deny as tap-accessible controls with no hover-only affordance.

## Related

- [docs/features/shell-tool.md](./shell-tool.md) — the first tool wired through this gate.
- [docs/features/ai-client.md](./ai-client.md) — `tool_call` and `tool_result` events.
- [docs/features/chat-ui.md](./chat-ui.md) — the chat composer renders the prompt and the `/shell` slash command.
- Decision: [docs/decisions.md §17](../decisions.md) (this feature) and §2 (project overrides app), §10 (AI client wire format).
