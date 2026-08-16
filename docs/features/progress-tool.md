# `report_progress` tool

## Overview

The `report_progress` tool lets the model report real-time progress on a long-running operation. The server validates the call, emits a `progress_update` SSE event, and the frontend renders a live progress bar card in the transcript. The tool is advertised to all models that support tool calling when its project authorization mode is not `off`.

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

## Authorization

`report_progress` appears in Settings → Project with the same `off` / `ask` / `allow` modes as other native tools. `off` hides it from model requests, while `ask` and `allow` keep it visible. Execution bypasses the interactive authorization prompt because progress updates do not read or modify project resources; the mode is used as the visibility gate. Legacy or external calls can still be dispatched directly for compatibility.

## Frontend rendering

When the server emits a `progress_update` SSE event, the frontend renders a `.tool-card--progress` card in the transcript with:

- A header showing the `title` and a status pill (running / completed / failed)
- A progress bar (width animates from `current / total`)
- A percentage label (e.g. "42%")
- An optional status message

Completed/failed statuses auto-expand the card; running cards stay collapsed. The status pill also shows a short progress summary (e.g. "Building project 42%").

## Notifications

Each `progress_update` also drives a per-chat updatable browser push notification (tag `chat-<id>-status`), so a background chat keeps the user in the loop without leaving a second progress notification beside the final completion/error notification. The notification title carries the chat title plus the cumulative token/cost label for this turn (e.g. "my-project · 12.4K tok · $0.03") — progress and usage together; the body shows the live percentage and message. When a `status: "completed"` update arrives, the card turns green and the final completion notification replaces that status slot so the end of a long task is visible if the chat is not open.
