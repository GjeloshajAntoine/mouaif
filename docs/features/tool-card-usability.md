# Readable tool approvals and results

## Overview

Chat tool cards explain the proposed operation, its target, and its result in a compact single-column layout that takes as little vertical space as possible on phones. The same production cards appear in the chat-view mockup, with synthetic data and no real permission changes.

## Usage

### Review an approval

- The single-line header names the action (for example **Run command** or **Edit files (2)**) alongside the tool identifier.
- The compact monospace body shows the essential target and change (command, file path and replacement lines, named chat, or key=value arguments) without repeating default fields. Secret-shaped fields remain redacted.
- Subagent approvals retain their per-run model picker and shared-image list.
- **Once**, **Session**, **Always**, and **Deny** sit on a single compact row (`--tap-sm` height, keyboard shortcuts `1`–`4` and `Escape`), with the full permission scope exposed on hover/title and assistive labels.

The broader choices retain the existing server semantics: **Session** grants the called tool in this chat's in-memory session; **Always** writes a project-wide native-family permission or a per-MCP-tool permission. Merely opening the card or this mockup changes no permissions.

### Decision feedback

The status line stays hidden until a decision is submitted. A submitted decision shows **Sending…** and blocks duplicate taps. Failed requests keep the card and offer **Retry decision**. A successful request shows **Approved** or **Denied** until the matching tool call/result replaces the approval.

### Read a result

- Ordinary tool headers stay compact single-line rows that span the full card width and support tap, keyboard focus, Enter/Space, and expanded-state announcements.
- Long requests start folded behind **Command · show full request** or **Arguments · show full request**, leaving output reachable without reading the whole command first. Opening it uses the same card-body scroller, not another nested scroll box.
- Structured fallback results format top-level fields as compact `key: value` lines while preserving nested objects and arrays. Larger payloads (>600 characters or capped) offer **View full details (bounded)**.
- Batches containing both successes and failures use a warning-colored **Partial success** status and retain failure counts.
- Explicit open/closed choices continue to survive result arrival and unchanged transcript reconciliation.

`ask_user` remains a question, and enabled `report_progress` / `list_features` still do not request approval.

## Review and verification

Open the [chat view mockup](./chat-view-mockup.md) and choose **Approvals**. The compact sticky bar switches between results and approvals, filters by family or search term, and tests decisions, retry, and reset at 360/390/430px.

```bash
npm run test:chat-mockup
node scripts/test-tool-approval-details.js
npm run test:ask-user
node scripts/test-auth-shortcut-scope.js
```

The production approval events and pending-approval responses carry an additive `details` field. Existing tool APIs, permission modes, grant meanings, port, and tool execution behavior are unchanged.
