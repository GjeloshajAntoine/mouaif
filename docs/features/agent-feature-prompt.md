# Agent feature prompt and tool

## Overview

The agent feature prompt is a dynamic system message injected into every chat stream that tells the model which mouaif features are enabled, disabled, or authorized for the current project and chat session. It is accompanied by a `list_features` tool the model can call at any time to get the complete structured feature state — especially useful under the `very-small` prompt profile, where tool descriptions are trimmed.

Together they solve the problem of "the model doesn't know what it can do": without them, the model only learns about a tool when it receives its full schema in the `tools` field. The feature prompt gives a one-line summary of every available capability up front, and the tool delivers the full detail on demand.

## Usage

### Feature injection

The feature summary is assembled server-side and injected as its own `system` message in the upstream message array, after agent files and before tagged files. It lists:

- **Built-in tools** — shell, subagent, ask_user, file tools — showing their authorization mode (`off` / `ask` / `allowlist` / `allow`).
- **MCP servers** — how many are configured. (Deliberately NOT the live running/stopped status: the summary rides inside the cached Anthropic system block, and a status flip mid-conversation would invalidate the whole prompt cache. Live status is available via `list_features`.)
- **Agent files** — whether AGENTS.md / CLAUDE.md etc. are injected.
- **Agents** — how many named subagent personas are defined in the project.
- **File tagging** — whether tags are configured in the project.
- **Trace** — whether trace-to-file is on for this chat.
- **Prompt profile** — the active profile id (`very-small`, `average`, `extensive`, or `chat`).

The message ends by mentioning the `list_features` tool for full detail.

### `list_features` tool

The model has a `list_features` tool available in every chat. It takes no arguments and returns a JSON object with these keys:

| Key | Type | Description |
|---|---|---|
| `tools` | `object` | Each built-in tool family (`shell`, `subagent`, `file`, `ask_user`) with `mode`, `allowlist`, `defaultTimeoutMs`, `maxTimeoutMs`. |
| `mcp` | `array` | Each MCP server with `name`, `slug`, `status`, `tools`, `authorization`. |
| `agentFiles` | `object` | `enabled` (boolean), `fileNames` (the names looked for), `discovered` (files actually found with size). |
| `agents` | `object` | `discovered` (named subagent personas found, by name). |
| `fileTagging` | `object` | `active` (boolean), `count` (number of tags). |
| `trace` | `boolean` | Whether trace-to-file is on for this chat. |
| `promptProfile` | `object` | `id` and `label` of the active prompt profile. |

The tool bypasses the authorization gate — it is read-only metadata and never requires user approval.

### Chat controls

When discovered agent files are shown in the chat card, every file row has a checkbox next to the file name. Because agent-file injection is currently a chat-level on/off state, toggling any row controls whether all discovered files are injected on the next turn. The card lists discovered files even when the current chat has agent files disabled, so the chat card and Settings → Project remain consistent. The checkboxes are disabled and marked as locked when agent files are disabled in project settings.

## Behavior

- **Always injected** — the feature summary is always added as a system message (unless no feature is enabled, in which case it is omitted to save tokens). Even if every tool is `off`, the prompt profile and trace state are still reported.
- **No tokens wasted** — the summary is short (typically 5–10 lines). The detailed state is on-demand via the tool.
- **Authorization bypass** — `list_features` is exempt from the authorization gate; it never prompts the user. It is a metadata tool, not an execution tool.
- **Live state** — the feature summary is recalculated on every stream turn, so it always reflects the current project and chat settings. The tool call also reads live state.

## Related

- [Prompt-size profiles](./prompt-profiles.md) — selecting between very-small, average, and extensive prompt profiles.
- [Tool authorization](./tool-authorization.md) — tool authorization rules and options.
- [Agents](./agents.md) — subagent delegation personas.
- [File tagging](./file-tagging.md) — tagging context files in projects.
- [Native file tools](./file-tools.md) — reading and managing files.
