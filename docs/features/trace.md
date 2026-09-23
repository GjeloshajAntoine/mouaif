# Trace to file

## Overview

A per-chat toggle (off by default) appends every new event for that chat to a project-relative NDJSON file. A one-shot "Export trace" action writes the same shape to a path the user picks without leaving the toggle on. The file is the user's source file — no rotation, no TTL, no auto-cleanup — and deleting either the trace or the chat leaves the other untouched.

## Usage

- **Toggle**: per-chat, off by default. There is no app-wide or project-wide default; every chat starts untraced.
- **Path**: `<projectDir>/.mouaif/traces/<chatId>.ndjson`, append-only. The filename identifies the chat, so `chatId` is not repeated on every line. If the chat has no project, the user is prompted to pick one before tracing starts (no surprise writes outside the project).
- **One-shot export**: the chat UI exposes an "Export trace" action that writes the same NDJSON shape to a user-picked path without enabling the toggle.
- **Where the controls live**: the trace toggle, "Export trace", and the chat's delete action sit on the project's **Technical details** page (`#/settings/project/technical?chatId=…`). Reach it from a chat via the settings button, then the **Technical details** link at the bottom of project settings; the link carries the current `chatId` so the trace controls show.

### NDJSON shape

One event per line, each with `{ ts, type, ...payload }`:

| `type` | Payload |
|---|---|
| `user message` | The message the user sent |
| `assistant message` | The model's reply text |
| `tool call` | `tool_call` — name and arguments |
| `tool result` | `tool_result` — the tool's output |
| `system event` | Non-message system events (e.g. authorization decisions) |
| `error` | Failed turns surfaced as errors |

## Behavior

- While the toggle is on, every new event for the chat is appended.
- Toggling off closes the file handle; the file is kept. Toggling on again opens it in append mode and continues.
- Independent of chat storage: the trace is a *view* of the transcript, written out as a plain file. Deleting the trace file does not delete the chat; deleting the chat does not delete the trace file.
- Append-only, no rotation, no auto-cleanup.

## Related

- [docs/features/ai-client.md](./ai-client.md) — `tool_call` and `tool_result` SSE event names.
- [docs/features/mcp.md](./mcp.md) — MCP tool calls are traced as `tool call` / `tool result` lines too.
