# Login notification

## Overview

mouaif can push a browser notification when a new browser signs in to a protected server. The alert names the user and a friendly label for the device or platform that signed in, and tapping it opens the projects list. The channel is **on by default** and can be turned off from Settings → Notifications.

## Usage

1. Enable access authentication for the server (`mouaif serve --auth`, or create the access user from a setup invitation).
2. Enable Web notifications in **Settings → Notifications** on the devices that should receive the alert.
3. **Sign-in alerts** under **Notification types** is on by default; turn it off to silence the alert.
4. Sign in from another browser or device. Every subscribed device receives one replaceable `mouaif sign-in` notification such as:

```text
mouaif sign-in
New sign-in as alice from iPhone or iPad.
```

The message stays generic on purpose: it names the platform (iPhone or iPad, Android device, Mac, Windows, Linux, or `this browser`) rather than a raw user-agent string.

### What triggers a push

| Event | When | Content |
|-------|------|---------|
| `login` | A password, setup, or passkey sign-in issues a new session | "New sign-in as `<user>` from `<platform>`" |
| `login` | App access is disabled or re-enabled from **Settings → Access & passkeys** | "App access is off…" / "Password and passkey protection is on again." |

The alert is sent to **every subscribed endpoint**, not only the session that just signed in. A login mints a brand-new push session whose own subscription list is empty until the page rebinds its endpoint, so a per-session send would reach nothing. Broadcasting is also the useful behavior: a sign-in notice matters most on the user's *other* already-signed-in devices.

The sign-in alert shares one replaceable tag (`mouaif-login`), so repeated sign-ins do not stack in the notification tray. An access on/off alert uses its own tag (`mouaif-access`) so it does not replace a pending sign-in notice.

## Implementation notes

- **Preference resolution** lives in `src/notifications.js` (`resolveNotificationPrefs`). This single server-side normalizer is shared by the chat streaming push and the access sign-in push, so both agree on the default set. It also keeps the legacy five-boolean fallbacks (`progress` / `completion` / `errors` and `askUser` / `toolAuthorization`). The frontend mirror is `normalizePreferences()` in `frontend/src/components/SettingsNotifications.jsx`.
- **The notifier** is `notifyLogin(username, req)` in `src/server-handlers-access.js`. It reads the app-level `notifications` setting, returns early unless `login === true`, derives the platform label from the request's `User-Agent`, and calls `push.sendPushToAll(...)`. It is wrapped in try/catch: a notification failure must never block sign-in.
- **The access on/off notifier** is `notifyAccessChange(enabled)` in the same file. It shares the `login` preference (a security event belongs on the same channel as a sign-in) and broadcasts with the `mouaif-access` tag, so it never overwrites a sign-in notice.
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

## Related

- [Push notifications](./push-notifications.md) — the notification service, its triggers, and iOS delivery behavior.
- [Access authentication](./access-authentication.md) — enabling and managing app access.
