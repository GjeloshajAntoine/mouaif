# Readable tool approvals and results

## Overview

Chat tool cards explain the proposed operation, its target, and the scope of an approval before you decide. The same production cards appear in the chat-view mockup, with synthetic data and no real permission changes.

## Usage

### Review an approval

- Read the plain-language action title, target chat, working folder, and proposed request. Available details include search ranges, URLs, batch commands, changed settings, worker/group identifiers, and messages.
- File writes identify new versus existing files when the target can be inspected safely. Single-file changes include a bounded before snapshot and the proposed replacement/content; hidden file lines remain redacted. These are review snapshots, not a guarantee that the file will be unchanged when execution starts.
- Chat updates and settings changes include a before snapshot when available. Secret-shaped fields are redacted. Older or direct API requests without detailed context still show their original summary.
- Subagent approvals retain their per-run model picker and shared-image list. MCP tool cards identify the server/tool and do not assume the operation is read-only.
- **Allow once** and **Deny** are always visible. Broader grants live under **More permission options** and require acknowledging their scope. A delete-chat approval also requires confirming deletion of the named chat and transcript.

The broader choices retain the existing server semantics: **Allow session** grants the called tool in this chat's in-memory session; **Always allow** writes a project-wide native-family permission or a per-MCP-tool permission. The card lists the actual affected tools. Arguments and targets are not restricted to the current example. More-specific overrides and mandatory prompts can still apply. Merely opening the card or this mockup changes no permissions.

### Decision feedback

A submitted decision shows **Sending…** and blocks duplicate taps. Failed requests keep the card and offer **Retry decision**. A successful request shows **Approved** or **Denied** until the matching tool call/result replaces the approval; approval is not the same as successful execution. These transient receipts are not a new persisted approval history.

If the network response is lost, a retry can report that the request no longer exists. Check the chat's current tool state before running anything again; the UI does not automatically re-execute a tool.

### Read a result

- Ordinary tool headers have a 44px minimum touch target, a keyboard tab stop, Enter/Space support, and an expanded-state announcement.
- Shell and generic results distinguish **Request** from **Result**. A long request starts folded behind **show full request**, leaving output reachable without reading the whole command first. Opening it uses the same card-body scroller, not another nested scroll box.
- Structured fallback results retain nested objects and arrays instead of silently dropping them. **View full details (bounded)** opens the larger preview. Depth, item, character, and node limits protect the chat from huge payloads; limit markers are explicit.
- Batches containing both successes and failures use a warning-colored **Partial success** status and retain failure counts, even if the envelope says success or failure.
- Explicit open/closed choices continue to survive result arrival and unchanged transcript reconciliation.

`ask_user` remains a question, and enabled `report_progress` / `list_features` still do not request approval.

## Review and verification

Open the [chat view mockup](./chat-view-mockup.md) and choose **Approvals for every tool**. The demo covers all native tools, representative MCP calls, scope confirmation, delete confirmation, retry, pending locks, reset, and switching between approval and result views at 360/390/430px.

```bash
npm run test:chat-mockup
node scripts/test-tool-approval-details.js
npm run test:ask-user
node scripts/test-auth-shortcut-scope.js
```

The production approval events and pending-approval responses carry an additive `details` field. Existing tool APIs, permission modes, grant meanings, port, and tool execution behavior are unchanged.
