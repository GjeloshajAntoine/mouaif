# Task tool — implementation notes

> Agent-facing reference for [`docs/features/task-tool.md`](../../features/task-tool.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Tasks live in a module-level `Map<chatId, Map<taskId, task>>` and are garbage-collected on server restart.
- The tool is read/write on the in-memory store only — it never touches the filesystem or chat storage.
- When a chat is deleted via `DELETE /api/chats/:id`, the server calls `task.clearChat(id)` to release the task entries.
- The `validateArgs` function returns typed errors (`EBADINPUT`) so the model can self-correct on the next turn.
- Capped at 50 tasks per chat to prevent memory unbounded growth.

### Push notifications

`update_progress` and `complete` emit a `progress_update` stream event carrying the task title and counts (`kind: 'task'`, `title`, `current`, `total`, `status`, `message`). This flows through the same per-chat updatable status push notification as the `report_progress` tool (tag `chat-<id>-status`), so each update replaces the previous one and the final completion/error notification replaces the last task progress alert in place. Task **creation** is intentionally not pushed: a fresh task always starts at 0%, which would be a noise notification. The notification is gated by the **ASCII chat status** toggle in Settings → Notifications (`notifications.status`).

Task pushes use one plain-text block under the bar (push notifications don't support alignment, so each row is a line). The whole status lives in the BODY — the title is just the chat name:

```text
[####------] 40%
Refactoring the composer
2 of 5
12.4K tok · $0.0312
```

- **Title row** — the chat name only. The OS renders the title in a fixed, narrow slot and truncates it before the body, so nothing that matters is parked there.
- **Bar row** — an ASCII bar (`#` filled / `-` empty) with the percentage. The bar is adapted to the receiving device: its cell count follows the measured body line (continuous with screen size, not bucketed), the layout follows the notification style (a one-line platform shares the row with the top fact; a two-line platform gives the bar its own row), and the line count + fallback width come from the OS and version table in `src/statusBar.js`. A non-zero percentage always lights at least one cell.
- **Fact rows** — `detailLines()` emits the running message, then the `current of total` counts, then the turn usage (`usageSummary()`), then the elapsed time, tool, and model, in that order, dropping a tier that would not fit the surface's width or height. A task therefore has one row of facts, not a title row plus a separate task row, and the first update (0 of N) omits the counts that the bar already conveys.

Generic `report_progress` notifications use the same per-device ASCII bar and fact set; completion uses a full bar and suppresses the counts tier, and an error keeps an empty, unlabelled bar plus its message and whatever context the turn had (see [push-notifications.md](./push-notifications.md)).
