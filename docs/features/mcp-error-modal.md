# MCP server error modal

## Overview

MCP server lifecycle failures in Settings open a full-screen modal with the typed error code, complete message, and server identity. MCP tool failures in chat do not open a modal; they remain in the normal inline transcript tool card.

## Usage

No configuration is required.

- Open **Settings → MCP servers** and start or restart a server.
- If startup fails, the error modal opens immediately.
- The full-width error row remains below the server and can be tapped to reopen the modal.
- Dismiss the modal with its close button, the backdrop, or Escape. Escape, the Tab cycle and focus restore come from the shared sheet hook — see [Modal sheets](modal-sheets.md).
- Use the server row to edit its command or URL before retrying.

## Behavior

- The modal is limited to MCP server lifecycle actions in Settings.
- Chat MCP tool failures continue to use the existing auto-expanded transcript error card.
- Typed codes such as `EMCP_START`, `EMCP_TRANSPORT`, `EMCP_RPC`, and `EMCP_TIMEOUT` are preserved.
- The layout fills a phone viewport and becomes a centered sheet on wider screens.

## Related

- [MCP](./mcp.md) — MCP server configuration, lifecycle, tools, and typed errors.
- [Chat error surfacing](./chat-error-surfacing.md) — inline chat error behavior.
