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

The same screen exposes the notification types: **ASCII chat status**, **Authorization**, **Authorization actions**, and **Sign-in alerts**. Authorization quick actions can be toggled separately. Each preference uses a short summary so the rows remain compact on a phone. iPhone and iPad require the app to be installed on the Home Screen before Web Push can be enabled.

The **Server configuration** group shows the origin used by the notification service, the generated-key status, and the VAPID contact. Opening this screen repairs a missing VAPID pair automatically; there are no keys to copy into the browser. Configuration values and notification-type descriptions wrap on narrow screens so their full contents remain readable.

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
| `login` | A password, setup, or passkey sign-in issues a new session | "New sign-in as `<user>` from `<platform>`" |

Only two per-chat notification slots are used. Authorization alerts (`ask_user_required` and `authorization_required`) share `chat-{chatId}-attention`; all other chat status (`progress_update`, `done`, and `error`) shares `chat-{chatId}-status` and the same ASCII format. New notifications replace the older notification in their slot, so statuses cannot stack and a question cannot be replaced by ordinary status. The service worker suppresses an alert only when the same chat ID is confirmed visible on screen by a fresh page response, regardless of query-parameter order or whether the open route includes `projectDir`. A page that is focused but hidden — screen locked, another app on top, or an iOS PWA sitting in the background — still delivers the notification. Suppression also clears queued alerts for that chat because their content is already visible.

Because `WindowClient.focused` / `visibilityState` are unreliable on some engines (Safari, iOS PWA), the page is the authority on its own visibility. The service worker queries every live window when each push arrives, and only a current `{ hash, visible, focused }` response can suppress it; no cached visibility table is maintained. Responses normally use a transferred `MessagePort`; the page also mirrors each response as a query-ID-correlated service-worker message because some iOS WebKit releases deliver `Client.postMessage` but silently drop the transferred port. A suspended or recently closed PWA may remain temporarily listed as a focused client but cannot answer; in that case the alert is shown rather than discarded. Fresh responses are matched by parsed chat ID.

On iOS Safari, the OS can keep replaced notifications visible until the user acts on them. Before showing a push, the service worker closes the matching tag. Status pushes also close legacy progress/completion/error tags carrying the same chat ID, preventing older notification formats from stacking beside the current status slot.

### Clicking a notification

- Tapping the notification body opens the exact chat and restores its pending question or authorization card. If the app is already open, the service worker posts the target URL to the existing window (a `NAVIGATE` message) and focuses it; only when no app window exists does it call `clients.openWindow()`. iOS Safari has no `WindowClient.navigate()`, so the page itself swaps its hash — the click lands in the running window, not in a second tab.
- **Already-open / suspended-app recovery (iOS PWA):** a suspended PWA reported to the worker as an existing window can be woken by focus without its JavaScript running to receive the `NAVIGATE` postMessage (WebKit drops it). The worker therefore writes the click URL to the shared IndexedDB store **before** posting `NAVIGATE`, exactly as it does for a cold launch. The page consumes that store on startup, on becoming visible, on `pageshow`, and on `focus` — so tapping a notification still lands in the right chat even when the move is attempted on a window that never handled the message. The store is read-and-clear, and a `NAVIGATE` that *is* handled clears it too, so a successful move never re-navigates.
- **Closed-app (iOS PWA) handoff:** iOS Safari relaunches an installed PWA at its `start_url` when the app is closed, and does not support `clients.openWindow()` from the service worker. The worker therefore writes the click URL to an IndexedDB store (`mouaif-push-click` / `clicks`, shared with the page, 60 s TTL) before attempting to open a window. The freshly launched page reads and clears that store on startup and whenever it becomes visible again, then navigates to the chat. A later manual launch is never redirected because the target is consumed (and cleared) on the first read.
- **Late worker write (cold launch):** a click can wake the service worker *itself*, so its IndexedDB write sometimes lands after the freshly loaded page has already run its one-shot startup read. The page therefore keeps re-reading the store every `COLD_LAUNCH_POLL_MS` for up to `COLD_LAUNCH_POLL_WINDOW_MS` after launch (stopping on the first applied target), so the tap still lands in the chat instead of the chats list. The poll also stops as soon as the user navigates somewhere themselves, so a late or stale target can never pull them out of a view they chose.
- **Guarded open-window clear:** when `clients.openWindow()` *does* resolve, the worker only clears the stored target if the opened window actually landed on the clicked chat URL (its hash matches). iOS can resolve `clients.openWindow()` without navigating to the clicked URL — reopening `start_url` `/` instead — so clearing unconditionally would discard the only navigation hint and land the user on the chats list. A non-matching open keeps the target, which the freshly loaded page recovers via the cold-launch path.
- **Allow once** and **Deny** post to the existing authorization-decision API without opening the app.
- A simple two-choice question submits the selected value through the same API.
- Multi-select questions, long option lists, and free-form answers open the full chat UI.

### Subscription sync

Startup sync compares the browser's current Push endpoint with the server's saved subscriptions for the current session. After a server restart, an existing local subscription is rebound to the fresh session instead of being destroyed. Disabling notifications removes only an endpoint owned by that session.

### Configuration

The app-level `notifications` setting stores:

```json
{
"status": true,
"authorization": true,
"quickActions": true,
"login": true
}
```

Browser permission and subscription are installation-specific. Event preferences are app-wide and are exposed through the normal `/api/settings/app` endpoint.

### Progress notifications

The model's `report_progress` calls and task updates (`update_progress` / `complete`) emit `progress_update` stream events. Each one sends a push tagged `chat-{chatId}-status`, so the OS replaces the previous status notification for that chat instead of stacking notifications. Every status uses a true ASCII bar and is gated by the **ASCII chat status** toggle (`notifications.status`), which defaults to on.

The bar is adapted to the device that receives it: **every phone size**, the **notification style** the OS presents, and the **OS version**. When a browser subscribes it reports its own facts — the measured width of one notification body line, its viewport, its platform and version — and the server stores them per device and builds each body for that device.

**Width follows the screen, continuously.** The number of cells is derived from the measured body line, not from size buckets, so a 320 px phone and a 430 px phone get a different bar, and a desktop window a longer one.

**Style decides the layout.** A collapsed Android notification shows one body line; an iOS banner (15+) shows two; a desktop toast about two. When the platform previews a single line, the bar and the most important fact share that row — `[###---] 40% · Refactoring...` — because a second row would never be seen. When it previews two or more, the bar takes its own row and the facts follow. An empty fact set leaves the bar alone in both layouts.

**OS version sets the fallback.** A device that cannot measure itself (older WebKit, a headless browser) falls back to its platform's known width, and the number of preview lines comes from a version table:

| Platform | One body line holds | Collapsed lines | Notes |
|----------|--------------------|-----------------|-------|
| Android | ~34 chars on a 360 px phone | 1 | Android 8+ (Oreo) adds the tall expanded card |
| iOS / iPadOS | ~40 chars | 2 on iOS 15+, else 1 | Version sets the banner preview |
| macOS | ~52 chars | 2 | |
| Windows / Linux / ChromeOS | ~46–48 chars | 2 | |

The same table bounds a measured value that is implausibly far from what the platform expects at the reported viewport, so a broken measurement cannot produce a bar that overflows the notification card. A device that reports nothing at all is treated as a phone on an unknown platform: one body line, conservative width.

**Everything else rides the body, under the bar.** The notification title is always just the chat name — the slot the OS clips first — so the status facts live in the body, where a wider/taller device simply shows more of them. Each fact is a tier, added top-down while it fits the surface's width **and** height:

| Order | Fact | Example |
|-------|------|---------|
| 1 | Running message | `Refactoring the composer` |
| 2 | Position in the work | `2 of 5` |
| 3 | Turn usage | `12.4K tok · $0.0312` |
| 4 | Elapsed time | `12s` |
| 5 | Tool | `shell` |
| 6 | Model | `gpt-5-mini` |

A one-line surface keeps the bar and its single most important fact; a preview-sized one shows the top three; an expanded notification shows all six. Missing facts simply do not appear, so a plain model round shows only the model and no tool. A slot that would wrap is dropped rather than wrapped, and a path or model id that has to be clipped keeps its tail (`...transcript.js`) rather than its prefix. A completion replaces the counts row (the position is no longer the news), and an error keeps its message plus whatever context the turn had reached.

The notification title carries the chat name and does not change with the device.

Every status shares one shape. A two-line surface:

```text
[####------] 40%
Refactoring the composer
2 of 5
12.4K tok · $0.0312
```

A one-line surface, where the bar shares its row:

```text
[###---] 40% · Refactoring...
```

Progress from a nested `subagent` run flows to the same `progress_update` channel as top-level calls, so a delegated agent that reports progress still sends the updatable push and the transcript progress card on the parent chat.
