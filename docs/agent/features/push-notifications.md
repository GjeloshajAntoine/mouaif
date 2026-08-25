# Push notifications — implementation notes

> Agent-facing reference for [`docs/features/push-notifications.md`](../../features/push-notifications.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### Files

| File | Purpose |
|------|---------|
| `src/push.js` | Server-side VAPID key management, push subscription CRUD, push sending |
| `src/index.js` | Push routes (`/api/push/*`) and hooks in `handleChatStream` |
| `src/settings.js` | `push_subscriptions` and `push_vapid` SQLite tables |
| `frontend/build/sw-src.js` | Service worker push/notificationclick/notificationclose event handlers |
| `frontend/src/components/push.js` | Frontend push manager: permission request, subscription, visibility tracking |
| `frontend/src/components/SettingsNotifications.jsx` | Dedicated enable/disable, test, and event-preference screen |
| `frontend/src/main.jsx` | Starts push state sync and page-side PWA services |
| `frontend/src/sw-registration.js` | Registers the service worker and applies user-approved updates |
| `frontend/src/push-page-bridge.js` | Answers fresh visibility queries and handles open-window navigation messages |
| `frontend/src/notification-click.js` | Owns notification navigation and the iOS IndexedDB cold-launch handoff |

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

The manifest uses the same-origin `id`, `start_url`, and `scope` value `\/`, so the installed app identity follows whichever domain serves mouaif instead of embedding a build-time hostname.

### Dead subscription cleanup

When sending a push fails with HTTP 410 (Gone) or 404 (Not Found), the subscription is automatically removed from the database.

### Session binding

Subscriptions are tied to the browser session through a one-way hash of the session cookie token. The endpoint row is updated in place when a fresh session rebinds it, preserving its stable subscription ID and creation time. The saved origin comes from the server's canonical origin calculation; a client-provided origin is ignored.

### Service worker

The push event handlers are compiled into `dist/sw.js` via the Vite build plugin in `vite.config.js`. The service worker is registered in production builds only (dev mode skips it for HMR speed). Notification actions use same-origin `fetch()` with the HttpOnly session cookie; failures fall back to opening the chat.

Chat pushes have two per-chat slots: a replaceable ASCII status slot for progress/completion/errors, and an authorization slot shared by questions and tool approvals. The service worker explicitly prunes older notifications of the same slot, including legacy tags, before displaying the update. Service workers and PWA windows can be suspended independently, so cached reports and `WindowClient.focused` are not used to suppress a push. On every push, `queryClientView()` sends `GET_VISIBILITY_STATE` over a temporary `MessageChannel` to every listed window; `startPushPageBridge()` answers with the current hash and `document.visibilityState`. The page also sends a query-ID-correlated regular message for iOS WebKit versions that drop the transferred port. Only a fresh response from the queried client, matched by parsed chat ID, can suppress the alert. The one-second timeout deliberately falls through to showing it, covering clients that remain listed after the PWA is backgrounded or closed. Suppressing an incoming push closes queued notifications for that chat, while status pushes prune legacy progress/completion/error tags for the same chat ID.

### Permission prompt timeouts

The frontend push manager (`frontend/src/components/push.js`) wraps `Notification.requestPermission()` and `navigator.serviceWorker.ready` in deadlines so the Notifications settings screen can never stay locked on `busy`. A permission prompt that never resolves (headless browser, a browser that defers the prompt until a user gesture, or a failed service-worker install) unblocks after 30 s for the prompt and 10 s for the worker, and the **Enable** control re-enables with an explanatory status. The settings screen also releases its `busy` flag in a `finally` block so every toggle path — including disable — always returns the UI to a usable state.
