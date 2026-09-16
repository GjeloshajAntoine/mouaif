# Push notifications — implementation notes

> Agent-facing reference for [`docs/features/push-notifications.md`](../../features/push-notifications.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### Files

| File | Purpose |
|------|---------|
| `src/push.js` | Server-side VAPID key management, push subscription CRUD, push sending |
| `src/statusBar.js` | Status-bar rules: device report → bar cells, body layout, OS + version capacity table |
| `src/index.js` | Push routes (`/api/push/*`) and hooks in `handleChatStream` |
| `src/settings.js` | `push_subscriptions` and `push_vapid` SQLite tables |
| `frontend/build/sw-src.js` | Service worker push/notificationclick/notificationclose event handlers |
| `frontend/src/components/push.js` | Frontend push manager: permission request, subscription, visibility tracking |
| `frontend/src/components/SettingsNotifications.jsx` | Dedicated enable/disable, test, and event-preference screen |
| `frontend/src/settings.css` | Mobile layout, wrapped notification descriptions, and configuration-value styling |
| `frontend/src/main.jsx` | Starts push state sync and page-side PWA services |
| `frontend/src/sw-registration.js` | Registers the service worker and applies user-approved updates |
| `frontend/src/push-page-bridge.js` | Answers fresh visibility queries and handles open-window navigation messages |
| `frontend/src/notification-click.js` | Owns notification navigation and the iOS IndexedDB cold-launch handoff |

### API endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/push/config` | GET | Ensures the VAPID pair exists and returns safe status, served origin, public key, and VAPID contact |
| `/api/push/vapid-public-key` | GET | Returns the VAPID public key for subscription |
| `/api/push/subscribe` | POST | Save a push subscription (body: `{ subscription: { endpoint, keys: { p256dh, auth }, statusBarProfile?, statusBarMaxChars? } }`) — `statusBarProfile` is the device's `{ chars, viewportWidth, os, osVersion, style }` report, used to adapt the ASCII status bar |
| `/api/push/subscribe` | DELETE | Remove a push subscription (body: `{ endpoint }`) |
| `/api/push/subscriptions` | GET | List subscriptions for the current session |
| `/api/push/test` | POST | Send a test notification to the current browser session |
| `/api/tools/authorization/decision` | POST | Handle notification actions using the same decision path as chat cards |

### VAPID keys

VAPID keys are auto-generated on first server start and stored in the `push_vapid` SQLite table. They are NOT regenerated on restart or when the served domain changes — the same keys persist so existing push subscriptions remain valid. The private key never appears in settings responses.

For an HTTPS public origin, the canonical served origin is used as the VAPID subject/contact. Local HTTP deployments retain the valid `mailto:push@mouaif.local` fallback. Each delivery selects the subject associated with the subscription's server-derived origin, so subscriptions created before a domain change remain sendable.

### iOS and APNs

Safari on iOS and iPadOS exposes the standard Web Push API for installed Home Screen apps. Apple Push Notification service transports those pushes internally, but mouaif does **not** need an Apple Developer account, an APNs `.p8` key, a Team ID, a Key ID, or a bundle identifier. The VAPID pair generated in notification settings is sufficient. Networks with restricted egress must allow Apple's Web Push endpoints, including `*.push.apple.com`.

The manifest uses the same-origin `id`, `start_url`, and `scope` value `\/`, so the installed app identity follows whichever domain serves mouaif instead of embedding a build-time hostname.

### Dead subscription cleanup

When sending a push fails with HTTP 410 (Gone) or 404 (Not Found), the subscription is automatically removed from the database.

### Session binding

Subscriptions are tied to the browser session through a one-way hash of the session cookie token. The endpoint row is updated in place when a fresh session rebinds it, preserving its stable subscription ID and creation time. The saved origin comes from the server's canonical origin calculation; a client-provided origin is ignored.

### Service worker

The push event handlers are compiled into `dist/sw.js` via the Vite build plugin in `vite.config.js`. The service worker is registered in production builds only (dev mode skips it for HMR speed). Notification actions use same-origin `fetch()` with the HttpOnly session cookie; failures fall back to opening the chat.

Chat pushes have two per-chat slots: a replaceable ASCII status slot for progress/completion/errors, and an authorization slot shared by questions and tool approvals. The service worker explicitly prunes older notifications of the same slot, including legacy tags, before displaying the update. Service workers and PWA windows can be suspended independently, so cached reports and `WindowClient.focused` are not used to suppress a push. On every push, `queryClientView()` sends `GET_VISIBILITY_STATE` over a temporary `MessageChannel` to every listed window; `startPushPageBridge()` answers with the current hash and `document.visibilityState`. The page also sends a query-ID-correlated regular message for iOS WebKit versions that drop the transferred port. Only a fresh response from the queried client, matched by parsed chat ID, can suppress the alert. The one-second timeout deliberately falls through to showing it, covering clients that remain listed after the PWA is backgrounded or closed. Suppressing an incoming push closes queued notifications for that chat, while status pushes prune legacy progress/completion/error tags for the same chat ID.

### Device-adapted status bar

A status body is built for the device that receives it, from three inputs: screen size, the notification style the OS presents, and the OS version. The rules live in `src/statusBar.js`; `src/push.js` only stores each device's self-report and resolves the plan per target at send time.

- **Self-report.** `frontend/src/components/push.js` `deviceReport()` returns `{ chars, viewportWidth, os, osVersion, style }` and sends it as `subscription.statusBarProfile` (plus the older bare `statusBarMaxChars`) on `POST /api/push/subscribe`. `chars` is *measured* — a hidden monospace probe at the viewport width, so it tracks every phone size without UA sniffing for width. `os`/`osVersion` come from `navigator.userAgentData` where present and fall back to `osFromUserAgent()` (note `MacIntel` + `maxTouchPoints > 1` is reported as `ipados`).
- **Storage.** `push_subscriptions.status_bar_profile` holds the validated JSON report (`normalizeStatusBarProfile()` drops unknown fields and caps the blob); `status_bar` keeps the original bare count. A rebind without a report keeps the stored profile, so a stale page cannot reset a good one. Both columns are added by migration.
- **Plan.** `statusBarPlan(report)` returns `{ chars, lines, style, layout, cells }`. `cells` is continuous in `chars` (clamped to `MIN_CELLS`..`MAX_CELLS`, a stacked bar taking `STACKED_BAR_SHARE` of the line, an inline bar `INLINE_BAR_SHARE`); `lines` comes from `capacityFor(os, osVersion)`, which applies the ordered `versionRules` of the `OS_CAPACITY` table; `layout` is `inline` when `lines === 1`, else `stacked`. A measurement outside `MEASURE_LOWER_BOUND`..`MEASURE_UPPER_BOUND` of what the platform expects for the viewport is clamped and flagged.
- **Compose.** `composeStatusBody(plan, percent, infoLines)` renders `stacked` (bar row, then the message) or `inline` (bar + `INLINE_SEPARATOR` + a `clip()`ped message, or the bar alone when nothing useful fits). `planForSubscription(sub)` reads `status_bar_profile` and falls back to `status_bar`.
- **Send.** `sendChatPush()` passes `bodyFor(sub)`; `push.sendPush()` resolves it per subscription, which is why one chat's status can render differently on each device. `push.statusBar` re-exports the module so a sender needs one import.

`scripts/test-status-bar-sizing.js` drives the HTTP subscribe path and asserts the per-device bodies; `scripts/test-push-notifications.js` guards the wiring.

Notification-click navigation writes the click URL to the shared IndexedDB store (`mouaif-push-click`, 60 s TTL) in **both** the cold-launch path and the already-open-window path, then posts a `NAVIGATE` message / calls `clients.openWindow()`. This is the same store `consumePendingNotificationClick()` reads. A suspended iOS PWA can be woken by focus without its JS receiving the `NAVIGATE` postMessage, so the page-side consumer listens for `visibilitychange`, `pageshow`, **and** `focus` (debounced) to recover the pending target. Read-and-clear semantics make the consumer idempotent; the `NAVIGATE` handler clears the store too, so a successfully handled move never re-navigates.
A cold launch wakes the service worker from the click itself, so the store write can land after the freshly loaded page has already performed its startup read. `consumePendingNotificationClick()` therefore also polls the store every `COLD_LAUNCH_POLL_MS` (250 ms) for `COLD_LAUNCH_POLL_WINDOW_MS` (5 s), recording `window.location.hash` at launch and stopping the poll on the first applied target or as soon as the user navigates elsewhere — a late or stale target must never pull the user out of a view they chose. The `setTimeout(stopPolling, …)` guarantees the interval ends even when nothing was ever stored.

The `openWindow` branch only clears the stored target when the opened window actually landed on the clicked chat URL (its hash matches). iOS can resolve `clients.openWindow()` without navigating to the clicked URL (reopening `start_url` `/` instead), so clearing unconditionally on a resolve would discard the only navigation hint and drop the user on the chats list. Any non-matching open keeps the target; the freshly loaded page's `consumePendingNotificationClick()` then recovers it. See `frontend/src/notification-click.js` and `frontend/build/sw-src.js`.

### Preference resolution

The app-level `notifications` setting is stored as three booleans (`status`, `authorization`, `quickActions`). Two symmetrical helpers normalise the persisted value and both default missing keys to enabled: `resolveNotificationPrefs()` in `src/server-handlers-chats.js` (server, gates `sendChatPush`) and `normalizePreferences()` in `frontend/src/components/SettingsNotifications.jsx` (client, drives the toggles). Each prefers the current key when present and otherwise derives it from the older five-boolean shape (`progress`/`completion`/`errors` → `status`, `askUser`/`toolAuthorization` → `authorization`). Keep the two helpers in sync when the preference shape changes.

### Permission prompt timeouts

The frontend push manager (`frontend/src/components/push.js`) wraps `Notification.requestPermission()` and `navigator.serviceWorker.ready` in deadlines so the Notifications settings screen can never stay locked on `busy`. A permission prompt that never resolves (headless browser, a browser that defers the prompt until a user gesture, or a failed service-worker install) unblocks after 30 s for the prompt and 10 s for the worker, and the **Enable** control re-enables with an explanatory status. The settings screen also releases its `busy` flag in a `finally` block so every toggle path — including disable — always returns the UI to a usable state.
