# `report_progress` tool — implementation notes

> Agent-facing reference for [`docs/features/progress-tool.md`](../../features/progress-tool.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Model guidance

The `average` and `extensive` prompt profiles instruct the model to call `report_progress` at the start and on completion of every task — not only long or multi-step ones — and to send a final `status: "completed"` report (with `current` equal to `total`) so the card turns green and the completion notification fires at the end of every turn.

## Implementation notes

| File | Purpose |
|------|---------|
| `src/tools/progress.js` | `report_progress` tool specification, validator, and result builder |
| `src/ai.js` | Tool advertised to models in `toolSpecs`; dispatch for `report_progress` calls |
| `src/index.js` | Tool listed in `/api/tools/list` catalog and prompt-profile previews |
| `src/tools/authorization.js` | Native authorization/visibility state for the Settings UI |
| `frontend/src/components/chat/transcript.js` | `updateProgressCard` — progress card DOM construction and update |
| `frontend/src/components/chat/stream.js` | SSE `progress_update` event handler |
| `src/server-handlers-chats.js` | Per-chat progress push notification (title carries the usage label) |
| `src/promptProfiles.js` | `average` / `extensive` guidance to report progress and completion |
| `frontend/src/features.css` | Progress card styles (`.tool-card--progress`, progress bar, percentage, message) |

The `progress_update` event does not produce a global toast; it drives the per-chat updatable progress push described above.
