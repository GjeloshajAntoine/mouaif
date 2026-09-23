# Login notification — implementation notes

> Agent-facing reference for [`docs/features/login-notification.md`](../../features/login-notification.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- **Preference resolution** lives in `src/notifications.js` (`resolveNotificationPrefs`). This single server-side normalizer is shared by the chat streaming push and the access sign-in push, so both agree on the default set. It also keeps the legacy five-boolean fallbacks (`progress` / `completion` / `errors` and `askUser` / `toolAuthorization`). The frontend mirror is `normalizePreferences()` in `frontend/src/components/SettingsNotifications.jsx`.
- **The notifier** is `notifyLogin(username, req)` in `src/server-handlers-access.js`. It reads the app-level `notifications` setting, returns early unless `login === true`, derives the platform label from the request's `User-Agent`, and calls `push.sendPushToAll(...)`. It is wrapped in try/catch: a notification failure must never block sign-in.

- **The broadcast helper** is `push.sendPushToAll({ ... })` plus `push.listAllSubscriptions()` in `src/push.js`. The existing `sendPush` takes an explicit `subs` array or falls back to the per-session list.
- **The preference key** is `login` inside the app-level `notifications` object, defaulting to `true`. It is allowlisted through `CLIENT_SETTINGS_KEYS` in `src/server-shared.js` (`notifications`), so the web UI reads and writes it through the normal `/api/settings/app` endpoint.

```json
{
  "status": true,
  "authorization": true,
  "quickActions": true,
  "login": true
}
```
