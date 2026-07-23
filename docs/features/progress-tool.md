# `report_progress` tool

## Overview

The `report_progress` tool lets the model report real-time progress on a long-running operation. The server validates the call, emits a `progress_update` SSE event, and the frontend renders a live progress bar card in the transcript. The tool is advertised to all models that support tool calling.

## Usage

The model calls `report_progress` with this schema:

```json
{
  "title": "Building project",
  "current": 5,
  "total": 100,
  "status": "running",
  "message": "Compiling source files..."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Short description of the operation (max 120 chars) |
| `current` | number | yes | Current progress value (0-based) |
| `total` | number | yes | Maximum progress value (must be positive) |
| `status` | string | no | `"running"`, `"completed"`, or `"failed"` (default: `"running"`) |
| `message` | string | no | Optional status message shown below the progress bar (max 500 chars) |

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
| `src/ai.js` | Tool advertised to models in `toolSpecs`; dispatch for `report_progress` calls |
| `src/index.js` | Tool listed in `/api/tools/list` catalog |
| `src/web/src/components/chat/transcript.js` | `updateProgressCard` — progress card DOM construction and update |
| `src/web/src/components/chat/stream.js` | SSE `progress_update` event handler |
| `src/web/src/features.css` | Progress card styles (`.tool-card--progress`, progress bar, percentage, message) |

The tool is advertised to models that support tool calling (OpenAI-compatible shape). Its `progress_update` event does not produce a global toast or browser push alert.