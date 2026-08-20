# Task tool — implementation notes

> Agent-facing reference for [`docs/features/task-tool.md`](../../features/task-tool.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Tasks live in a module-level `Map<chatId, Map<taskId, task>>` and are garbage-collected on server restart.
- The tool is read/write on the in-memory store only — it never touches the filesystem or chat storage.
- When a chat is deleted via `DELETE /api/chats/:id`, the server calls `task.clearChat(id)` to release the task entries.
- The `validateArgs` function returns typed errors (`EBADINPUT`) so the model can self-correct on the next turn.
- Capped at 50 tasks per chat to prevent memory unbounded growth.

### Push notifications

`update_progress` and `complete` emit a `progress_update` stream event carrying the task title and counts (`kind: 'task'`, `title`, `current`, `total`, `status`, `message`). This flows through the same per-chat updatable status push notification as the `report_progress` tool (tag `chat-<id>-status`), so each update replaces the previous one and the final completion/error notification replaces the last task progress alert in place. Task **creation** is intentionally not pushed: a fresh task always starts at 0%, which would be a noise notification. The notification is gated by the **Progress updates** toggle in Settings → Notifications (`notifications.progress`).

Task pushes use a UI-like plain-text layout (push notifications don't support real alignment, so each "row" is a line):

```text
Refactor auth · 12K tok · $0.0312
[####------] 40%
Fix push layout — 2 of 5
```

- **Title row** — chat name on the left, running turn usage on the right: total tokens (formatted via `usage.formatTokens`, e.g. `12K tok`) plus the accumulated price (`usage.formatCost`) when pricing is known. Token and cost totals accumulate across every upstream round of the turn (including tool rounds).
- **Bar row** — 10-cell ASCII bar (`#` filled / `-` empty) with the percentage.
- **Task row** — the task title with its `current of total` counts.

Generic `report_progress` notifications keep the simpler `"<pct>% — <message>"` body.
