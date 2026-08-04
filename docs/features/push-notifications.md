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

Attention alerts use `chat-{chatId}-attention`; completion and error alerts use `chat-{chatId}-status`. A completion alert therefore cannot replace a question before the user has answered it. The service worker suppresses an alert only when the exact chat is visible on screen (focused **and** `visibilityState === 'visible'`); a page that is focused but hidden — screen locked, another app on top, or an iOS PWA sitting in the background — still delivers the notification. Engines that don't report `visibilityState` on their window clients always show the alert rather than risk silently dropping it.

On iOS Safari, the OS keeps a replaced notification visible until the user acts on it, so the service worker prunes the old alert from the queue by tag (`getNotifications({ tag })` → `close()`) before calling `showNotification` with the same tag. This makes progress, completion, and attention alerts replace their predecessors in place on iPhone and iPad instead of stacking.

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

The model's `report_progress` calls and task updates (`update_progress` / `complete`) emit `progress_update` stream events. Each one sends a push tagged `chat-{chatId}-progress`, so the OS replaces the previous notification for that chat instead of stacking a new one — the notification shows the live percentage / task title / token count as the run progresses. Progress pushes are gated by the **Progress updates** toggle (`notifications.progress`), which defaults to on.

## Implementation notes

### Files

| File | Purpose |
|------|---------|
| `src/push.js` | Server-side VAPID key management, push subscription CRUD, push sending |
| `src/index.js` | Push routes (`/api/push/*`) and hooks in `handleChatStream` |
| `src/settings.js` | `push_subscriptions` and `push_vapid` SQLite tables |
| `src/web/build/sw-src.js` | Service worker push/notificationclick/notificationclose event handlers |
| `src/web/src/components/push.js` | Frontend push manager: permission request, subscription, visibility tracking |
| `src/web/src/components/SettingsNotifications.jsx` | Dedicated enable/disable, test, and event-preference screen |
| `src/web/src/main.jsx` | Push state sync on startup |
| `src/web/src/sw-registration.js` | Registers the service worker and handles notification-click navigation messages |

### API endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/push/config` | GET | Ensures the VAPID pair exists and returns safe status, served origin, public key, and VAPID contact |
| `/api/push/vapid-public-key` | GET | Returns the VAPID public key for subscription |
| `/api/push/subscribe` | POST | Save a push subscription (body: `{ subscription: { endpoint, keys: { p256dh, auth } } }`) |
| `/api/push/subscribe` | DELETE | Remove a push subscription (body: `{ endpoint }`) |
| `/api/push/subscriptions` | GET | List subscriptions for the current session |
| `/api/push/test` | POST | Send a test notification to the current browser session |
| `/api/tools/authorization/decision` | POST | Handle notification actions using the same decision path as chat cards |

### VAPID keys

VAPID keys are auto-generated on first server start and stored in the `push_vapid` SQLite table. They are NOT regenerated on restart or when the served domain changes — the same keys persist so existing push subscriptions remain valid. The private key never appears in settings responses.

For an HTTPS public origin, the canonical served origin is used as the VAPID subject/contact. Local HTTP deployments retain the valid `mailto:push@mouaif.local` fallback. Each delivery selects the subject associated with the subscription's server-derived origin, so subscriptions created before a domain change remain sendable.

### iOS and APNs

Safari on iOS and iPadOS exposes the standard Web Push API for installed Home Screen apps. Apple Push Notification service transports those pushes internally, but mouaif does **not** need an Apple Developer account, an APNs `.p8` key, a Team ID, a Key ID, or a bundle identifier. The VAPID pair generated in notification settings is sufficient. Networks with restricted egress must allow Apple's Web Push endpoints, including `*.push.apple.com`.

The manifest uses the same-origin `id`, `start_url`, and `scope` value `/web/`, so the installed app identity follows whichever domain serves mouaif instead of embedding a build-time hostname.

### Dead subscription cleanup

When sending a push fails with HTTP 410 (Gone) or 404 (Not Found), the subscription is automatically removed from the database.

### Session binding

Subscriptions are tied to the browser session through a one-way hash of the session cookie token. The endpoint row is updated in place when a fresh session rebinds it, preserving its stable subscription ID and creation time. The saved origin comes from the server's canonical origin calculation; a client-provided origin is ignored.

### Service worker

The push event handlers are compiled into `dist/sw.js` via the Vite build plugin in `vite.config.js`. The service worker is registered in production builds only (dev mode skips it for HMR speed). Notification actions use same-origin `fetch()` with the HttpOnly session cookie; failures fall back to opening the chat.

### Permission prompt timeouts

The frontend push manager (`src/web/src/components/push.js`) wraps `Notification.requestPermission()` and `navigator.serviceWorker.ready` in deadlines so the Notifications settings screen can never stay locked on `busy`. A permission prompt that never resolves (headless browser, a browser that defers the prompt until a user gesture, or a failed service-worker install) unblocks after 30 s for the prompt and 10 s for the worker, and the **Enable** control re-enables with an explanatory status. The settings screen also releases its `busy` flag in a `finally` block so every toggle path — including disable — always returns the UI to a usable state.