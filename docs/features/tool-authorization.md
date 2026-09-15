# Tool authorization — gating what tools the model may run

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

The mode is picked with one segmented control, rendered by a single shared component (`ToolAuthSeg` in `frontend/src/components/settings/toolAuth.js`) on every surface: the tool row in the chat **Tools** card, the composer **Tools** popup, and project settings. `subagent` is not special-cased — it is the same row, same control, and same save path as `shell`, `task`, and the file-family gate, so a change to the control lands everywhere at once. `ask_user` narrows the component to the binary `Off / Ask` choices.

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

#### Where the `off` gate is applied

The "at zero prompt-token cost" property is not automatic: `off` hides tools when the advertised tool list is built, in two places that must stay in step — `src/ai-stream.js` (the streaming request) and `src/server-handlers-chats.js` (the tools-list endpoint behind the chat UI). Both run the same three passes:

1. the native-family loop, which drops every member of a family whose resolved family mode is `off` (`file` drops all five operations, `shell` drops `shell`, …);
2. a **per-leaf file loop**, which resolves each `read_file` / `list_files` / `search_files` / `write_file` / `edit_file` spec through `authorization.effectiveConfig(projectDir, name)` so a single operation's `off` override (e.g. `tools.read_file.mode = "off"` while `tools.file.mode = "allow"`) hides exactly that operation;
3. the MCP loop, which resolves each `mcp__*` spec through the same `effectiveConfig`.

`effectiveConfig` is a module export of `src/tools/authorization.js`, and every call site sits inside a `catch {}` whose documented fallback is "authorization state unreadable; keep every tool advertised". If that export is ever dropped, the calls throw `TypeError`, the fallback swallows it, and an `off` override silently stops hiding anything — the project keeps paying prompt tokens for tools it disabled, with no error anywhere. `scripts/test-mcp-authorization-gate.js` locks down the export, the layered resolution (per-tool over per-server), and the no-override case that must *not* resolve to `off`.

### Approval flow

When the gate is `ask` and the model initiates a call, the chat pauses the stream and renders an **Authorization required** card. The card shows:

- the tool name (`shell`)
- the proposed `cmd` and `timeoutMs`
- the project directory the command will run in
- the chat id and a "review trace" link (only when tracing is on)

The user can tap **Allow once**, **Allow for session**, **Always allow**, or **Deny**. **Always allow** persists `mode: "allow"` for that tool family in `.mouaif.json`, so it also applies to new chats and after restart. **Allow for session** remains in memory and is cleared when the chat is reopened.

On a keyboard, `1`–`4` select the four decisions and `Escape` denies. Those shortcuts are scoped to non-text targets: the card hosts the per-run model picker, whose **Search models** field mounts inside it, and a keystroke aimed at that field must never resolve the prompt (previously typing `4` in the search box denied the call). Regression test: [scripts/test-auth-shortcut-scope.js](../../scripts/test-auth-shortcut-scope.js).

For `subagent` calls the card also shows a **model picker**: the user may select which model executes the delegated run, for that one call only. See [Per-run model choice on subagent approval](./auth-model-picker.md).

The composer `/shell` slash command uses the same gate. A `/shell` invocation in `ask` mode shows the same card; the only difference is the source line ("user-typed slash command" instead of "model-initiated call").

## Behavior

- **Default: `ask`.** New tools land with `ask` so the first call always requires a tap. A user who wants a friction-free experience flips to `allowlist` with a tight regex set.
- **Allowlist is regex-matched against the full command.** The match is anchored on the full string (`^...$`); partial matches do not pass. Each untrusted expression runs in an isolated worker that is terminated after 1 ms, so catastrophic backtracking cannot block the HTTP process.
- **Decisions are session-scoped, not persisted.** An `allow-once` decision resumes exactly one blocked call. An `allow-session` decision is kept in server memory and cleared by `POST /api/chats/:id/touch` when the chat is reopened.
- **Revoking a session never orphans a parked prompt.** A pending request owns the promise the tool loop is awaiting, so both revokes settle it before discarding state: `POST /api/chats/:id/touch` (`clearGrants`) and `POST /api/tools/authorization/cancel` (`cancelSession`) reject every parked wait with a typed `EDENIED` and return how many they rejected. Otherwise the loop would stay parked — the upstream-abort signal does not fire while it waits on a decision rather than a fetch — holding the chat's running marker so every later send bounced off `409 EALREADY_RUNNING`.
- **Deny reasons are kept private.** A deny records only the call id in the in-memory session. The upstream receives `{ ok: false, code: 'EDENIED', reason: 'user denied' }`, without the command, project, or chat id.
- **`off` hides the tool from the model.** Tools in `off` mode are filtered out of the advertised tool list before each upstream request (saving prompt tokens on every round), and the execution gate still rejects late or forged calls with `ETOOL_DISABLED` as defense-in-depth. File tools resolve through their `file` family name, so one `off` hides all five operations. MCP tools resolve through the layered `.mcp.json` authorization block (per-tool → per-server → shared fallback), so an `off` at any level hides exactly the specs it covers — one tool, one server, or every `mcp__<slug>__<tool>` spec at once.
- **File operations share one gate.** The model-facing `read_file`, `list_files`, `search_files`, `write_file`, and `edit_file` names resolve through `tools.file`; enabling File tools therefore enables authorization for all five operations instead of returning `ETOOL_DISABLED` for their individual names. Per-operation `off` overrides still disable one leaf, but stale per-operation `ask` entries do not mask a family-level `allow`. A per-leaf `off` hides **only that operation** from the model — the family loop never fires while the family is enabled, so the advertisement gate resolves each file spec through `effectiveConfig` a second time. Regression test: [scripts/test-file-tool-off-advertisement.js](../../scripts/test-file-tool-off-advertisement.js).
- **Timeouts are bounded by the project.** A call's effective timeout is `clamp(requestedTimeoutMs || defaultTimeoutMs, 1 ms, maxTimeoutMs)`. Anything above the cap is clamped silently; the UI surfaces the clamped value in the prompt.
- **Mode changes are not retroactive.** Flipping a tool from `allow` to `ask` mid-session revokes the blanket grant and the next call is asked again. Flipping to `off` drops the tool from the next request's tool list and rejects any in-flight call with `ETOOL_DISABLED`; the model's prior `tool_result` history is left untouched.
- **Audit log.** Every decision is appended to the per-chat trace file (decision §5) as a `system event` line (`{ type: 'auth_decision', tool, callId, decision }`) when tracing is on. The audit line is not forwarded to the upstream.
- **A parked prompt survives reload, tab switch, back navigation, and refocus.** A run waiting on an authorization / `ask_user` prompt never emits new transcript rows (the `tool_call` row is withheld until the user approves), so the client's reconcile poll (`reconcileRunningChat`) treats the pending queue itself as the "genuinely waiting" signal. Reopening a server-running chat loads `GET /api/tools/authorization/pending` before subscribing to live replay and clears any stale local settle latch. The poll also checks pending requests before honoring that latch, covering a retained/background page whose URL never remounted. Responses are scoped to the chat that requested them, so a late response from the page just left cannot mount an approval on the page returned to. Cards remain deduped by `callId`; as long as a prompt is pending, the status reads **waiting for you…** and the run is not locally marked done.

## Related

- [docs/features/shell-tool.md](./shell-tool.md) — the first tool wired through this gate.
- [docs/features/ai-client.md](./ai-client.md) — `tool_call` and `tool_result` events.
- [docs/features/chat-ui.md](./chat-ui.md) — the chat composer renders the prompt and the `/shell` slash command.
- Decision: [docs/decisions.md §17](../decisions.md) (this feature) and §2 (project overrides app), §10 (AI client wire format).
