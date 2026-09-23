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

The alert is sent to **every subscribed endpoint**, not only the session that just signed in. A login mints a brand-new push session whose own subscription list is empty until the page rebinds its endpoint, so a per-session send would reach nothing. Broadcasting is also the useful behavior: a sign-in notice matters most on the user's *other* already-signed-in devices.

The sign-in alert shares one replaceable tag (`mouaif-login`), so repeated sign-ins do not stack in the notification tray.

## Related

- [Push notifications](./push-notifications.md) — the notification service, its triggers, and iOS delivery behavior.
- [Access authentication](./access-authentication.md) — enabling and managing app access.
