# Chat view mockup

## Overview

A reproducible review page renders every native tool with the actual chat renderers and stylesheet, with result cards expanded initially. Its source is tracked under `scripts/chat-view-mockup/`, so the review no longer depends on a disposable, gitignored fixture that can disappear or drift.

## Usage

From the repository root, run:

```bash
npm run mockup:chat
```

Open the loopback URL printed by the command. The preview uses its own available port, not the application's port 5732. To choose a port or build a standalone file:

```bash
npm run mockup:chat -- --port=5743
npm run mockup:chat -- --build
```

Build output is `.mouaif/chat-view-mockup/index.html`. The built page can be opened from disk, including its local question and authorization examples. On a phone, use the app's local preview proxy URL for the printed loopback address rather than opening loopback directly.

The renderer bundle is transported as a base64 data-script URL so the proxy's root-path rewriter cannot corrupt JavaScript regex literals. Without this, the introduction rendered but the tool cards never loaded. Regression checks now open the page through the production preview proxy, not just directly.

- Search by tool name or family, or select a family.
- Choose **Show → Approvals for every tool** to review each tool's pending approval state. Add `?view=approvals#tool-shell` to the preview URL to open directly at the first approval card.
- Approval examples use the actual four-button **Allow once / Allow session / Always allow / Deny** card, including the subagent's per-run model picker. Demo decisions display a local outcome; **Reset approval examples** restores all cards. Search and family filters work in both views.
- `ask_user` shows its actual question-and-answer card instead. `report_progress` and `list_features` explicitly say **No approval prompt**: the app does not ask for these tools when enabled. The preview does not invent approval requirements or change real authorization settings.
- Switch between **Live: call → result**, **Result first with recovered arguments**, and **Persisted transcript replay**. Switching paths intentionally remounts examples in their initial expanded state.
- Use **Expand all**, **Collapse all**, and **Replay unchanged** to check that replay preserves the same cards and the chosen state.
- Scroll to **Live, failure, and interaction states** to finish a running shell, review long arguments, failures, dismissed questions, empty results, images, progress, pending questions, and authorization.
- Check narrow widths first: 360, 390, and 430 CSS pixels.

The page covers all 43 current native tools, two representative MCP text/image results, and an unknown-tool fallback. It is not an exhaustive catalogue of external MCP tools or every argument combination. Embedded MCP Apps and provider/network behavior are covered by their own tests, not simulated here.

Nothing runs a shell command, deletes a chat, changes settings, restarts the app, or registers an MCP server. The preview serves synthetic data. Question and authorization decisions are handled locally inside the preview, including when opened through mouaif's local preview proxy; they never reach the app's real authorization API. Other API requests return 404.

## Review findings

### Fixed: an explicitly opened running card collapsed on success

The successful-result handler treated both an untouched card and an explicitly opened card as “not user-collapsed.” It therefore removed `is-expanded` even after the user opened the card. This looked like a choice reverting when the result arrived.

The handler now distinguishes an explicit open (`_userCollapsed === false`) from the untouched default. Explicitly opened cards stay open; deliberately closed cards stay closed; untouched successful cards still default to collapsed. This is an in-session state fix, not new persistence across a full browser reload.

### Implemented: compact approval and result usability

The production cards and mockup stay compact on narrow screens:

- Ordinary headers stay single-line rows with full-width tap areas, keyboard focus, Enter/Space support, and expanded-state announcements.
- Generic results format structured objects as compact `key: value` lines while keeping nested data and offering **View full details (bounded)** when payloads are large or capped.
- Long requests start folded behind **show full request**, leaving output accessible while preserving one card-body scroller and production height caps.
- Mixed batches show a warning-colored **Partial success** state, with success/failure counts retained.
- Approval cards show compact action titles, essential arguments or diffs, and a single-row **Once / Session / Always / Deny** bar with Sending, Retry, and Approved/Denied feedback in place. Catalogue mounts opt out of autofocus and auto-scroll, and the mockup uses a compact sticky control bar without per-card wrapper headings.

See [Readable tool approvals and results](./tool-card-usability.md) for usage, limits, and permission semantics. Existing modes and grants are unchanged. Rich bespoke summaries for every external MCP tool are outside this generic review harness.

## Review coverage

- `scripts/chat-view-mockup/fixtures.js` contains a deliberate synthetic case for each tool. The test compares the list with `frontend/src/toolGroups.js`; adding a native tool without an example fails coverage.
- `main.js` calls `appendToolCallCard`, `appendToolResultCard`, `reconcileTranscriptRows`, `handleShellOutputEvent`, `askUserCard`, and `authorizationCard` from production. It does not implement substitute cards. `approvals.js` supplies synthetic requests matching the stream's summary shapes. The catalogue opts out of authorization autofocus and question auto-scroll so many pending examples cannot pull the reader away; live chat callers retain both defaults.
- `style.css` imports the production stylesheet. Only document scrolling, entry animation, off-screen row skipping, and the surrounding review shell are adjusted. Card-body and subagent height caps are unchanged.
- `scripts/chat-view-mockup.mjs` bundles with the existing esbuild dependency and serves from loopback with `Cache-Control: no-store`. No installation or application-server restart is needed.
- `npm run test:chat-mockup` tests direct loading and delivery through the production preview proxy, tool inventory, expanded bodies, three rendering paths, stable open/closed replay, result transitions, filters, image zoom, every approval example, all four demo decisions, reset and view switching, runtime errors, and narrow-width overflow. Approval buttons are checked for 44px targets at 360/390/430px. It also checks that demo decisions cannot reach an app-origin API and is included in `test:browser-build`.

```bash
npm run test:chat-mockup
node scripts/test-tool-card-expanded-consistency.js
node scripts/test-chat-element-stability.mjs
```

## Related

- [Tool card expanded view](./tool-card-expanded-view.md)
- [Chat transcript rendering](./chat-transcript-rendering.md)
- [Chat UI](./chat-ui.md)
