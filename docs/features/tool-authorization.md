# Tool authorization — gating what tools the model may run

<!--
  Static-page-ready. No SSG shortcodes. Update docs/README.md in the
  same commit that adds this file.
-->

## Overview

Every tool call the model initiates — and every `/shell` slash command the user types in the composer — passes through an **authorization gate** before the runner executes. The gate is per-project, per-tool, and per-session; the user can choose between four modes (`off`, `ask`, `allowlist`, `allow`) and a default for each project. The default for new tools is `ask`, so the model can only run a command after the user has explicitly approved it (or a matching allowlist rule). Approvals are recorded so the user can re-prompt by switching back to `ask`.

## Usage

### Modes

| Mode | Behavior |
|---|---|
| `off` | The tool is disabled. Calls return `ETOOL_DISABLED` and the runner never runs. |
| `ask` | Every call must be approved by the user in the UI. The chat shows a prompt with the command, working dir, and the proposed timeout; the user taps **Allow** or **Deny**. |
| `allowlist` | Calls whose `cmd` matches an allowlist regex run without prompting. Calls that do not match fall through to `ask`. |
| `allow` | Every call in the session is auto-approved. Toggling back to `ask` revokes the blanket grant. |

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

### Approval flow

When the gate is `ask` and the model initiates a call, the chat pauses the stream and renders an **Authorization required** card. The card shows:

- the tool name (`shell`)
- the proposed `cmd` and `timeoutMs`
- the project directory the command will run in
- the chat id and a "review trace" link (only when tracing is on)

The user can tap **Allow once**, **Allow for this session** (equivalent to flipping to `allow` until the chat is reopened), or **Deny**. The chat resumes on **Allow once** with a single execution, on **Allow for this session** without further prompts for the same tool, and on **Deny** with a `tool_result` carrying `ok: false, code: 'EDENIED'`. The upstream sees a `tool` message with the same error, so the model can recover and try a different command.

The composer `/shell` slash command uses the same gate. A `/shell` invocation in `ask` mode shows the same card; the only difference is the source line ("user-typed slash command" instead of "model-initiated call").

### REST

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| `GET`  | `/api/tools/authorization?projectDir=<abs>` | — | `{ tools: { shell: { mode, allowlist, defaultTimeoutMs, maxTimeoutMs, source: 'project' | 'app' | 'default' } } }` |
| `PUT`  | `/api/tools/authorization` | `{ projectDir, tools: { ... } }` | `{ tools: { ... } }` (echo) |
| `POST` | `/api/tools/authorization/decision` | `{ chatId, callId, decision: 'allow-once' | 'allow-session' | 'deny' }` | `{ ok: true }` |

The `decision` endpoint is the only path the UI uses to answer a pending prompt. It validates the chat and project ownership before recording the decision. Direct REST calls retry with the same opaque `callId` after approval; model calls remain blocked on their SSE stream.

## Behavior

- **Default: `ask`.** New tools land with `ask` so the first call always requires a tap. A user who wants a friction-free experience flips to `allowlist` with a tight regex set.
- **Allowlist is regex-matched against the full command.** The match is anchored on the full string (`^...$`); partial matches do not pass. Each untrusted expression runs in an isolated worker that is terminated after 1 ms, so catastrophic backtracking cannot block the HTTP process.
- **Decisions are session-scoped, not persisted.** An `allow-once` decision resumes exactly one blocked call. An `allow-session` decision is kept in server memory and cleared by `POST /api/chats/:id/touch` when the chat is reopened.
- **Deny reasons are kept private.** A deny records only the call id in the in-memory session. The upstream receives `{ ok: false, code: 'EDENIED', reason: 'user denied' }`, without the command, project, or chat id.
- **Authorization is independent of the tool's enable switch.** A tool can be `off` (no calls) and `allow` (mode wouldn't matter). The order in the runner is: enabled? → mode? → allowlist? → execute.
- **Timeouts are bounded by the project.** A call's effective timeout is `clamp(requestedTimeoutMs || defaultTimeoutMs, 1 ms, maxTimeoutMs)`. Anything above the cap is clamped silently; the UI surfaces the clamped value in the prompt.
- **Mode changes are not retroactive.** Flipping a tool from `allow` to `ask` mid-session revokes the blanket grant and the next call is asked again. Flipping from `ask` to `off` rejects the next call with `ETOOL_DISABLED` and the model's prior `tool_result` history is left untouched.
- **Audit log.** Every decision is appended to the per-chat trace file (decision §5) as a `system event` line (`{ type: 'auth_decision', tool, callId, decision }`) when tracing is on. The audit line is not forwarded to the upstream.

## Implementation notes

- Source: `src/tools/authorization.js` (new module) — `effectiveMode(projectDir, tool)`, `authorize({ projectDir, chatId, call })`, `recordDecision(chatId, callId, decision)`.
- The runner calls `authorize(...)` as the first line of its hot path. A `null` decision means "no prompt needed, execute"; a `{ prompt: true }` decision means "the server has emitted a `tool_call` event to the UI and is waiting for a `decision` event on the same SSE stream." The runner blocks until the decision resolves; a UI-side abort cancels the pending prompt and returns `EABORTED` to the upstream.
- The chat touch route clears in-memory grants before updating `lastOpenedAt`; grants never enter `.mouaif.json`.
- The Settings UI lives in `src/web/src/components/SettingsProject.jsx` under a new **Tools** card. The card shows the effective mode per tool with the source (`project`, `app`, `default`) on a small caption line, and links to the per-tool allowlist editor.
- The Authorization card in the chat composer exposes Allow once, Allow for this session, and Deny as tap-accessible controls with no hover-only affordance.

## Related

- [docs/features/shell-tool.md](./shell-tool.md) — the first tool wired through this gate.
- [docs/features/ai-client.md](./ai-client.md) — `tool_call` and `tool_result` events.
- [docs/features/chat-ui.md](./chat-ui.md) — the chat composer renders the prompt and the `/shell` slash command.
- Decision: [docs/decisions.md §17](../decisions.md) (this feature) and §2 (project overrides app), §10 (AI client wire format).
