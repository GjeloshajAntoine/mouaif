# Trace to file

Per-chat NDJSON export of a chat's events into `<projectDir>/.mouaif/traces/<chatId>.ndjson`, so a transcript can be committed next to the project source like any other file. It is a user export, not a background stream: nothing is written unless the user opts the chat in, and it is fully independent of chat storage.

## Overview

A per-chat toggle (off by default) appends every new event for that chat to a project-relative NDJSON file. A one-shot "Export trace" action writes the same shape to a path the user picks without leaving the toggle on. The file is the user's source file — no rotation, no TTL, no auto-cleanup — and deleting either the trace or the chat leaves the other untouched.

## Usage

- **Toggle**: per-chat, off by default. There is no app-wide or project-wide default; every chat starts untraced.
- **Path**: `<projectDir>/.mouaif/traces/<chatId>.ndjson`, append-only. The filename identifies the chat, so `chatId` is not repeated on every line. If the chat has no project, the user is prompted to pick one before tracing starts (no surprise writes outside the project).
- **One-shot export**: the chat UI exposes an "Export trace" action that writes the same NDJSON shape to a user-picked path without enabling the toggle.
- **Where the controls live**: the trace toggle, "Export trace", and the chat's delete action sit on the project's **Technical details** page (`#/settings/project/technical?chatId=…`), which the chat header's settings button opens with the current `chatId`. The chat import action shares that page.

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

## Implementation notes

- Implemented in `src/trace.js`; chat events are routed to the trace writer from the AI client / chat pipeline.
- `tool_call` and `tool_result` lines use the same wire names as the SSE events documented in [ai-client.md](./ai-client.md).
- See decision [docs/decisions.md §5](../decisions.md) for the design rationale.

## Related

- [docs/features/ai-client.md](./ai-client.md) — `tool_call` and `tool_result` SSE event names.
- [docs/features/mcp.md](./mcp.md) — MCP tool calls are traced as `tool call` / `tool result` lines too.
- Decision: [docs/decisions.md §5](../decisions.md) (trace-to-file) and §10 (AI client wire format).
