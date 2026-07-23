# Legacy `report_progress` tool

## Overview

The `report_progress` tool is retained only for compatibility with persisted or external tool calls. It is no longer advertised to models, and progress events no longer create global overlays or Web Push notifications.

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

## Implementation notes

| File | Purpose |
|------|---------|
| `src/tools/progress.js` | `report_progress` tool specification, validator, and result builder |
| `src/ai.js` | Compatibility dispatch for legacy `report_progress` calls |

The tool remains dispatchable but is excluded from new model requests. Its `progress_update` event does not produce a global toast or browser push alert.
