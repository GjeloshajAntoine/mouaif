---
name: mouaif-config
description: Configure a mouaif project the way the Settings UI would — read or change app and project settings, connect providers, add project models, write agents and custom prompts, set tool authorization, and register MCP servers. Use when the user asks to set up, change, or explain a project's configuration.
---

# Configuring mouaif

Settings resolve in three layers: **built-in defaults → app settings → project settings**. The project wins on conflict. App settings live in the app store (`~/.mouaif/store.sqlite`, one JSON row); project settings live in `<projectDir>/.mouaif.json`, or in the app store when the project opted into **Store settings in app DB**.

Never write either store by hand. Use `get_settings` and `update_settings` — they are the same business logic and the same redaction the Settings UI uses. `update_settings` defaults to `project` scope, so pass `scope: "app"` deliberately.

## Find out the current state first

```text
get_settings({ scope: "project" })                     # the raw project file
get_settings({ scope: "app", keys: ["promptSize"] })   # one or a few app keys
list_projects()                                        # registered projects: id, path, name, cost
get_app_info()                                         # feature state and this chat's effective tool permissions
```

`get_settings` returns credentials redacted: an `apiKey` on a provider or model entry comes back as `hasApiKey`. That shape round-trips, so you may read a provider, change one field, and write it back.

## What you can change, and where it lives

| Goal | Where | Key |
| --- | --- | --- |
| Prompt-size profile for new chats | app, or project to override | `promptSize`: `very-small` \| `average` \| `extensive` \| `chat` |
| Composer Enter behavior | app | `enterForNewline` (true = Enter inserts a newline) |
| Auto-retry a failed send once | app | `autoRetry` |
| Tool output shape fed back to the model | app | `toolOutput`: `{ size: "very-small" \| "average" \| "full" \| "extensive", structure: "tree" \| "json" }` |
| One tool result's context cap | app | `toolFeedbackMaxBytes` (bytes, default 65536) |
| Notifications | app | `notifications`: `{ status, authorization, quickActions, login }` |
| Custom prompts | app (shared) or project | `prompts`: array of `{ id, name, content }` |
| Custom composer actions | project | `customActions` |
| Project display name | project | `name` |
| Agents (subagent personas) | project | `agents`; default persona in `defaultAgent` |
| Skills on/off, and per-skill opt-outs | project | `skills`, `disabledSkills` (also on the chat record) |
| Agent instruction files | project | `agentFiles`, `agentFileNames` (defaults `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`) |
| Hide-file-content rules | project | `hideFileContent` |
| File tags | project | `tags` |
| Tool authorization | project | `tools`: see below |
| MCP servers | project file `.mcp.json` (or app store) | edited through the app, not a settings key |

Store the **chosen** prompt-size profile per chat with `update_chat({ promptSize })`; the settings key above is the default for new chats.

## Providers and models

Providers are app-scoped connections: `{ id, baseUrl, apiKey, auth, oauthAccount }`. Model ids are project-scoped and reference a provider: `{ id, provider, label, contextWindow }`. A provider carries no model list of its own.

The provider ids a project model may reference:

`openai-compatible`, `anthropic`, `gemini`, `codex`, `ollama`, `openrouter`, `github-copilot`, `azure`, `mistral`, `groq`, `deepseek`

Two rules decide which provider to use:

- Pick the endpoint that matches the service. For Azure OpenAI set the resource and deployment in `baseUrl` (or `apiVersion` on the project model). For a local llama.cpp `llama-server` or LM Studio use `openai-compatible` with no key.
- `codex` and `github-copilot` are plan-based sign-ins, not key servers. For Codex the API-key route is `openai-compatible`.

Credentials are the one thing you cannot do. `update_settings` refuses any write containing an `apiKey`, and a project model carries no key at all. To connect or re-authenticate a provider, or to sign in for the OAuth-based ones (`anthropic`, `openrouter`, and the two plan sign-ins), tell the user to open **Settings → Providers**. When a required provider is missing, say so instead of inventing a connection.

Add a project model:

```text
update_settings({
  scope: "project",
  patch: { models: [ { id: "<model-id>", provider: "<provider-id>", label: "<label>", contextWindow: 200000 } ] }
})
```

`models` is an array and is **replaced**, not merged — read the current list, append, and write the whole array back. The same applies to `prompts`, `tags`, `customActions` and `agents`.

## Agents

An agent is a named persona (`{ name, content, tools?, modelId?, providerId?, thinkingLevel? }`) used only as a delegation target for the `subagent` tool. It is not a chat persona — a chat persona is a custom prompt. It becomes the nested call's system message, optionally restricted to a tool allowlist.

## Tool authorization

`tools` maps a gate to `{ mode, allowlist, defaultTimeoutMs, maxTimeoutMs }`, where `mode` is `off` \| `ask` \| `allow`. Families carry one gate each, and a single tool may override its family:

| Gate | Leaves |
| --- | --- |
| `shell` | the `shell` tool |
| `file` | `read_file`, `list_files`, `search_files`, `write_file`, `edit_file`, `group_read`, `group_edit` |
| `chats` | `list_chats`, `get_chat`, `create_chat`, `update_chat`, `change_working_folder`, `search_models`, `start_chat`, `delete_chat`, `search_chats`, `attach_chat_image`, `list_chat_attachments`, `ask_user`, `task`, `report_progress`, `webpreview` |
| `mouaif` | `get_settings`, `update_settings`, `list_projects`, `get_app_info`, `restart_app`, `list_features` |
| `subagent` | the `subagent` tool |

`ask_user` is binary: only `off` or `ask`.

A write to `tools`, `mcp`, `authAccounts` or `authPending` always asks the user for approval before it lands, even when `update_settings` is on `allow`. That is deliberate — this tool must not be able to widen its own reach. Say what you are about to change and why, so the approval card reads clearly.

Prefer `allow` for a tool the user just asked you to use in this project, `ask` for anything with a cost or a side effect, and `off` for what they want out of reach.

## MCP servers

MCP servers are configurable through the app, not through `update_settings`. Tell the user to add or edit them in **Settings → MCP**, or add a remote server there and complete its sign-in. Once a server is connected, its tools appear as `mcp__<server>__<tool>` and are gated by `tools.mcp` with per-server and per-tool overrides.

## Two rules that hold everywhere

- **Credentials never pass through you.** Read them redacted; send the user to Settings → Providers to write them.
- **Arrays are replaced, not merged.** Read, modify, write back. A patch that carries only the new entry deletes the rest.
