# Legacy `report_progress` tool

## Overview

The `report_progress` tool is retained only for compatibility with persisted or external tool calls. It is no longer advertised to models, and progress events no longer create global overlays or Web Push notifications. The frontend **does** render a real-time progress bar card in the transcript when the model calls it.

## Usage

A legacy caller can invoke `report_progress` with this schema:

```json
{
  "title": "Building project",
  "current": 5,
  "total": 100,
  "status": "running",
  "message": "Compiling source files..."
}
```

The dispatcher still processes the call so existing tool history fails gracefully. Chat questions, authorization requests, completion, and errors are the supported notification events described in [Push notifications](push-notifications.md).

## Frontend rendering

When the server emits a `progress_update` SSE event, the frontend renders a `.tool-card--progress` card in the transcript with:

- A header showing the `title` and a status pill (running / completed / failed)
- A progress bar (width animates from `current / total`)
- A percentage label (e.g. "42%")
- An optional status message

Completed/failed statuses auto-expand the card; running cards stay collapsed. The status pill also shows a short progress summary (e.g. "Building project 42%").

## Implementation notes

| File | Purpose |
|------|---------|
| `src/tools/progress.js` | `report_progress` tool specification, validator, and result builder |
| `src/ai.js` | Compatibility dispatch for legacy `report_progress` calls |
| `src/web/src/components/chat/transcript.js` | `updateProgressCard` — progress card DOM construction and update |
| `src/web/src/components/chat/stream.js` | SSE `progress_update` event handler |
| `src/web/src/features.css` | Progress card styles (`.tool-card--progress`, progress bar, percentage, message) |

The tool remains dispatchable but is excluded from new model requests. Its `progress_update` event does not produce a global toast or browser push alert.