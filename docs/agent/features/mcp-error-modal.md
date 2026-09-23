# MCP server error modal — implementation notes

> Agent-facing reference for [`docs/features/mcp-error-modal.md`](../../features/mcp-error-modal.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- `frontend/src/components/SettingsMcp.jsx` opens the modal for lifecycle failures and renders a tappable full-width error row.
- `frontend/src/components/chat/McpErrorModal.jsx` renders the lifecycle error details. It is shared by location only; chat does not import or mount it.
- `frontend/src/features.css` allows MCP server rows to wrap so lifecycle messages occupy their own row.
- `frontend/src/chat-composer.css` holds the mobile-first `.mcp-err__*` modal styles. The overlay, the sheet shell and the desktop card come from the shared modal sheet idiom in `frontend/src/sheets.css`; this file only overrides `--sheet-z` (62, above the other modals) and `--sheet-backdrop`, plus the desktop card width.
