# Custom actions — implementation notes

> Agent-facing reference for [`docs/features/custom-actions.md`](../../features/custom-actions.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

Definitions are available through these local REST endpoints:

```text
GET    /api/actions?projectDir=<absolute-path>
POST   /api/actions
DELETE /api/actions/:id?projectDir=<absolute-path>
POST   /api/actions/:id/run
```

CLI execution delegates to the native Shell runner and its project authorization gate. MCP execution resolves the configured server and delegates to the selected MCP tool’s layered authorization gate. In **Ask** mode, the standard chat approval card appears before execution.
