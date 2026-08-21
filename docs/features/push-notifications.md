# Push notifications

## Overview

Browser notifications let mouaif follow a running chat when the tab is in the background or closed. The important alerts are interactive: a user can answer a simple two-choice `ask_user` question, allow a tool once, or deny a tool directly from the notification when the browser supports actions.

**Stack:** `web-push` (server), service worker `push` event (client), VAPID keys (auto-generated, stored in SQLite).

## Usage

### Enabling push notifications

1. Open **Settings → Notifications**.
2. Tap **Enable** under "Web notifications".
3. Accept the browser's permission prompt.
4. Optionally tap **Send test notification**.

The same screen configures which chat events produce alerts and whether quick actions are shown. iPhone and iPad require the app to be installed on the Home Screen before Web Push can be enabled.

The **Server configuration** group shows the origin used by the notification service, the generated-key status, and the VAPID contact. Opening this screen repairs a missing VAPID pair automatically; there are no keys to copy into the browser.

### Serving from a public domain

Web Push on iPhone and iPad requires an installed Home Screen app served over HTTPS. When a TLS reverse proxy exposes mouaif on a public domain, start the HTTP server with its canonical external origin:

```bash
mouaif serve --host 127.0.0.1 --public-origin https://mouaif.example.com
```

`MOUAIF_PUBLIC_ORIGIN=https://mouaif.example.com` is the equivalent environment setting. The origin must contain only the scheme, host, and optional port. This explicit value is used for same-origin checks, the Secure browser-session cookie, subscription records, and the VAPID contact; untrusted forwarding headers are not accepted as configuration.

### What triggers a push

| Event | When | Content |
|-------|------|---------|
| `ask_user_required` | The model pauses for a structured answer | Question; exactly two single-choice answers can be tapped directly |
| `authorization_required` | A tool is waiting for approval | Tool name with **Allow once** and **Deny** actions |
| `done` | A chat turn completes successfully | Chat title + "Response complete" |
| `error` | A chat turn fails (stream error, upstream error) | Chat title + error message |

Attention alerts use `chat-{chatId}-attention`; progress, completion, and error alerts share `chat-{chatId}-status`. A completion or error alert therefore replaces the last progress alert, but cannot replace a question before the user has answered it. The service worker suppresses an alert when the same chat ID is visible on screen, regardless of query-parameter order or whether the open route includes `projectDir`; a page that is focused but hidden — screen locked, another app on top, or an iOS PWA sitting in the background — still delivers the notification. Suppression also clears queued alerts for that chat because their content is already visible.

Because `WindowClient.focused` / `visibilityState` are unreliable on some engines (Safari, iOS PWA), the page is the authority on its own visibility. Each open app window reports `{ hash, visible, focused }` on load and route/visibility changes, and the service worker also queries every live window when each push arrives. The push-time query is necessary because browsers suspend service workers and erase their in-memory visibility reports between events. Fresh page responses are matched by parsed chat ID; an older page that cannot answer still uses the client-property fallback. Background and suspended windows report hidden and do not suppress alerts.

On iOS Safari, the OS can keep replaced notifications visible until the user acts on them. Before showing a push, the service worker closes the matching tag. Status pushes also close legacy progress/completion/error tags carrying the same chat ID, preventing older notification formats from stacking beside the current status slot.

### Clicking a notification

- Tapping the notification body opens the exact chat and restores its pending question or authorization card. If the app is already open, the service worker posts the target URL to the existing window (a `NAVIGATE` message) and focuses it; only when no app window exists does it call `clients.openWindow()`. iOS Safari has no `WindowClient.navigate()`, so the page itself swaps its hash — the click lands in the running window, not in a second tab.
- **Closed-app (iOS PWA) handoff:** iOS Safari relaunches an installed PWA at its `start_url` when the app is closed, and does not support `clients.openWindow()` from the service worker. The worker therefore writes the click URL to an IndexedDB store (`mouaif-push-click` / `clicks`, shared with the page, 60 s TTL) before attempting to open a window. The freshly launched page reads and clears that store on startup and whenever it becomes visible again, then navigates to the chat. A later manual launch is never redirected because the target is consumed (and cleared) on the first read.
- **Allow once** and **Deny** post to the existing authorization-decision API without opening the app.
- A simple two-choice question submits the selected value through the same API.
- Multi-select questions, long option lists, and free-form answers open the full chat UI.

### Subscription sync

Startup sync compares the browser's current Push endpoint with the server's saved subscriptions for the current session. After a server restart, an existing local subscription is rebound to the fresh session instead of being destroyed. Disabling notifications removes only an endpoint owned by that session.

### Configuration

The app-level `notifications` setting stores:

```json
{
	"askUser": true,
	"toolAuthorization": true,
	"completion": true,
	"errors": true,
	"progress": true,
	"quickActions": true
}
```

Browser permission and subscription are installation-specific. Event preferences are app-wide and are exposed through the normal `/api/settings/app` endpoint.

### Progress notifications

The model's `report_progress` calls and task updates (`update_progress` / `complete`) emit `progress_update` stream events. Each one sends a push tagged `chat-{chatId}-status`, so the OS replaces the previous status notification for that chat instead of stacking a separate progress and completion notification. Task status uses a true ASCII bar such as `[####------] 40%`; the final completion or error replaces it in place. Progress pushes are gated by the **Progress updates** toggle (`notifications.progress`), which defaults to on.

Progress from a nested `subagent` run flows to the same `progress_update` channel as top-level calls, so a delegated agent that reports progress still sends the updatable push and the transcript progress card on the parent chat.
