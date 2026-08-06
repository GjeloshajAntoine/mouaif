# Task tool

Built-in `task` tool that lets the model create, track progress on, and complete structured tasks within a chat. Tasks are rendered as rich inline cards with progress bars, checkboxes, and descriptions — no MCP server required.

## Overview

The `task` tool gives the model a lightweight way to break complex work into manageable pieces and show real-time progress to the user. Tasks are stored in-memory per chat (they do not survive a server restart). Each task gets an auto-generated 8-hex-character ID the model references across turns.

Four actions are supported:

- **`create`** — define a new task with a title and optional description.
- **`update_progress`** — set the current count and total for an existing task, rendering a live progress bar.
- **`complete`** — mark a task as done.
- **`list`** — return every task in the current chat.

## Usage

The model calls `task` with these parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | yes | One of `"create"`, `"update_progress"`, `"list"`, `"complete"` |
| `title` | string | on create | Task title (max 60 chars — keep it short, a few words) |
| `description` | string | no | Optional description (max 2000 chars) |
| `taskId` | string | on update/complete | The task ID returned when the task was created |
| `current` | number | on update | Current progress value (0-based) |
| `total` | number | on update | Total progress value (must be ≥ 1) |

### Example: creating a task

```json
{
  "action": "create",
  "title": "Implement user authentication",
  "description": "Add login, logout, and session management"
}
```

The tool returns:

```json
{
  "task": {
    "id": "a1b2c3d4",
    "title": "Implement user authentication",
    "description": "Add login, logout, and session management",
    "status": "in_progress",
    "current": 0,
    "total": 100
  },
  "action": "created"
}
```

### Example: updating progress

```json
{
  "action": "update_progress",
  "taskId": "a1b2c3d4",
  "current": 2,
  "total": 5
}
```

### Example: completing a task

```json
{
  "action": "complete",
  "taskId": "a1b2c3d4"
}
```

### Example: listing all tasks

```json
{
  "action": "list"
}
```

## Authorization

The `task` tool uses the same authorization module as every other built-in tool. It is a native tool listed under `project.tools.task` with four modes:

| Mode | Behaviour |
|------|-----------|
| `off` | The tool spec is hidden from the model and calls are rejected with `ETOOL_DISABLED` |
| `ask` | The user is prompted on the first call per session |
| `allowlist` | Matches the call summary (first string argument) against a regex allowlist |
| `allow` | Runs without prompting |

## Implementation notes

- Tasks live in a module-level `Map<chatId, Map<taskId, task>>` and are garbage-collected on server restart.
- The tool is read/write on the in-memory store only — it never touches the filesystem or chat storage.
- When a chat is deleted via `DELETE /api/chats/:id`, the server calls `task.clearChat(id)` to release the task entries.
- The `validateArgs` function returns typed errors (`EBADINPUT`) so the model can self-correct on the next turn.
- Capped at 50 tasks per chat to prevent memory unbounded growth.

### Push notifications

`update_progress` and `complete` emit a `progress_update` stream event carrying the task title and counts (`kind: 'task'`, `title`, `current`, `total`, `status`, `message`). This flows through the same per-chat updatable push notification as the `report_progress` tool (tag `chat-<id>-progress`), so each update replaces the previous one instead of stacking. Task **creation** is intentionally not pushed: a fresh task always starts at 0%, which would be a noise notification. The notification is gated by the **Progress updates** toggle in Settings → Notifications (`notifications.progress`).

Task pushes use a UI-like plain-text layout (push notifications don't support real alignment, so each "row" is a line):

```text
🔔 Refactor auth · 12K tok · $0.0312
    ▓▓▓▓░░░░░░ 40%
    Fix push layout — 2 of 5
```

- **Title row** — chat name on the left, running turn usage on the right: total tokens (formatted via `usage.formatTokens`, e.g. `12K tok`) plus the accumulated price (`usage.formatCost`) when pricing is known. Token and cost totals accumulate across every upstream round of the turn (including tool rounds).
- **Bar row** — 10-cell ascii bar (`▓` filled / `░` empty) with the percentage.
- **Task row** — the task title with its `current of total` counts.

Generic `report_progress` notifications keep the simpler `"<pct>% — <message>"` body.