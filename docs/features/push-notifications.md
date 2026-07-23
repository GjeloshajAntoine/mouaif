# Push notifications

## Overview

Browser push notifications let mouaif send OS-level alerts for chat progress, completion, and errors even when the tab is backgrounded or the browser is closed. The system uses the standard Web Push API (service worker `push`/`notificationclick` events) with per-chat tagged notifications so progress bars are updatable without stacking multiple alerts.

**Stack:** `web-push` (server), service worker `push` event (client), VAPID keys (auto-generated, stored in SQLite).

## Usage

### Enabling push notifications

1. Open **Settings → App defaults**.
2. Tap **Enable** under "Push notifications".
3. Accept the browser's permission prompt.
4. The button changes to "Disable" when subscribed.

### What triggers a push

| Event | When | Content |
|-------|------|---------|
| `progress_update` | AI model calls `report_progress` with `status: "running"` | Chat title + progress message |
| `done` | A chat turn completes successfully | Chat title + "Response complete" |
| `error` | A chat turn fails (stream error, upstream error) | Chat title + error message |

Each notification uses `tag: chat-{chatId}` so multiple updates for the same chat replace the previous notification rather than stacking.

### Clicking a notification

- If the app is already open in a browser tab, the service worker posts a `NAVIGATE` message to the page, the tab focuses, and the hash router opens the specific chat.
- If the app is closed, a new tab opens at the absolute chat URL.

### Subscription sync

Startup sync compares the browser's current Push endpoint with the server's saved subscriptions for the current session. A stale local subscription is unsubscribed, and disabling push only removes an endpoint owned by that same session.

## Implementation notes

### Files

| File | Purpose |
|------|---------|
| `src/push.js` | Server-side VAPID key management, push subscription CRUD, push sending |
| `src/index.js` | Push routes (`/api/push/*`) and hooks in `handleChatStream` |
| `src/settings.js` | `push_subscriptions` and `push_vapid` SQLite tables |
| `src/web/build/sw-src.js` | Service worker push/notificationclick/notificationclose event handlers |
| `src/web/src/components/push.js` | Frontend push manager: permission request, subscription, visibility tracking |
| `src/web/src/components/SettingsDefaults.jsx` | Push enable/disable toggle in settings |
| `src/web/src/main.jsx` | Push state sync on startup |
| `src/web/src/sw-registration.js` | Registers the service worker and handles notification-click navigation messages |

### API endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/push/vapid-public-key` | GET | Returns the VAPID public key for subscription |
| `/api/push/subscribe` | POST | Save a push subscription (body: `{ subscription: { endpoint, keys: { p256dh, auth } } }`) |
| `/api/push/subscribe` | DELETE | Remove a push subscription (body: `{ endpoint }`) |
| `/api/push/subscriptions` | GET | List subscriptions for the current session |

### VAPID keys

VAPID keys are auto-generated on first server start and stored in the `push_vapid` SQLite table. They are NOT regenerated on restart — the same keys persist so existing push subscriptions remain valid.

### Dead subscription cleanup

When sending a push fails with HTTP 410 (Gone) or 404 (Not Found), the subscription is automatically removed from the database.

### Session binding

Subscriptions are tied to the browser session (via a one-way hash of the session cookie token). A different tab or device with the same session shares the subscription; clearing cookies removes the binding permanently.

### Service worker

The push event handlers are compiled into `dist/sw.js` via the Vite build plugin in `vite.config.js`. The service worker is registered in production builds only (dev mode skips it for HMR speed).