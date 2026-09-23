# Trace to file — implementation notes

> Agent-facing reference for [`docs/features/trace.md`](../../features/trace.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Implemented in `src/trace.js`; chat events are routed to the trace writer from the AI client / chat pipeline.
- `tool_call` and `tool_result` lines use the same wire names as the SSE events documented in [ai-client.md](./ai-client.md).
- See decision [docs/decisions.md §5](../../decisions.md) for the design rationale.
