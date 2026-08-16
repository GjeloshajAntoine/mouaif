# Legacy `report_progress` tool — implementation notes

> Agent-facing reference for [`docs/features/legacy-progress-tool.md`](../../features/legacy-progress-tool.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

| File | Purpose |
|------|---------|
| `src/tools/progress.js` | `report_progress` tool specification, validator, and result builder |
| `src/ai.js` | Compatibility dispatch for legacy `report_progress` calls |
| `frontend/src/components/chat/transcript.js` | `updateProgressCard` — progress card DOM construction and update |
| `frontend/src/components/chat/stream.js` | SSE `progress_update` event handler |
| `frontend/src/features.css` | Progress card styles (`.tool-card--progress`, progress bar, percentage, message) |

The tool remains dispatchable for compatibility. Its `progress_update` event does not produce a global toast or browser push alert.
