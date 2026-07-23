# Tool feedback compaction

## Overview

Tool results remain complete in the chat transcript while the copy sent back to the model is capped and compacted. This prevents large file reads, shell output, MCP diffs, browser snapshots, and nested subagent transcripts from causing runaway input-token growth on later tool rounds.

## Usage

Compaction is automatic for every native and MCP tool. No chat action is required.

The default model-facing limit is 64 KiB per tool result. A server operator can override it in the app settings data with `toolFeedbackMaxBytes`; values are clamped between 4 KiB and 1 MiB.

```json
{
  "toolFeedbackMaxBytes": 65536
}
```

## Behavior

- Results under the limit are passed to the model unchanged.
- Oversized text keeps approximately three quarters from the beginning and one quarter from the end, with a truncation marker between them.
- Truncation is based on UTF-8 bytes, not JavaScript character count.
- The complete structured result still reaches the SSE client, SQLite transcript, trace file, and tool card.
- Subagent feedback sent to the parent contains only `ok`, final `text`, and an error when present. Its complete nested chat and tool events remain available to the UI.
- Base64 image data is omitted from textual tool feedback because image blocks are attached separately as vision content.
- Existing stored chats are compacted when their tool history is reconstructed. No database migration or transcript rewrite is required.

## Implementation notes

`src/toolFeedback.js` owns UTF-8-safe head/tail truncation, image payload removal, and subagent compaction. `src/ai.js` applies it at the live tool-to-model boundary, while `src/messages.js` applies the same rule to historical tool results.

The separation is intentional: `exec.result` is the rich representation for the user interface and persistence, while compacted content is only the `role: "tool"` message sent upstream.

## Related

- [AI client](./ai-client.md)
- [Native file tools](./file-tools.md)
- [Shell tool](./shell-tool.md)
- [Agents](./agents.md)
