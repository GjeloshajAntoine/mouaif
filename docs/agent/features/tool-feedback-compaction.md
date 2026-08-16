# Tool feedback compaction — implementation notes

> Agent-facing reference for [`docs/features/tool-feedback-compaction.md`](../../features/tool-feedback-compaction.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

`src/toolFeedback.js` owns UTF-8-safe head/tail truncation, image payload removal, and subagent compaction. `src/ai.js` applies it at the live tool-to-model boundary, while `src/messages.js` applies the same rule to historical tool results.

The separation is intentional: `exec.result` is the rich representation for the user interface and persistence, while compacted content is only the `role: "tool"` message sent upstream.
