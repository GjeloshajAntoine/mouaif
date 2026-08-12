# Inspector — custom DevTools-style mobile UI

## Overview

The **Inspector** tab in the mobile shell ([frontend/src/main.jsx](../../frontend/src/main.jsx) → `InspectorView`) is a from-scratch DevTools-style UI built on top of the **Chrome DevTools Protocol (CDP)**. It is *not* the default Chrome panel embedded in an iframe — the browser speaks CDP directly over WebSocket, the mouaif server ([src/inspector.js](../../src/inspector.js) + [src/index.js](../../src/index.js)) is a thin relay. The UI is mobile-first and ships four sub-tabs: **Preview** (live screenshots of the page), **Console**, **Network**, and **Info** (page metrics). Its UI and CDP client are loaded as a separate JavaScript chunk only when the Inspector route is opened, keeping them out of the app's initial bundle.

The Inspector is the last piece of the spec from [decisions.md §6](../decisions.md) and §9 build-order item 14: a from-scratch mobile-friendly UI that consumes CDP events but never embeds the Chrome panel.

## Architecture

```
+--------------------+        +--------------------+        +--------------------+
|  mobile UI         |  WS    |  mouaif server     |  WS    |  Chrome (debug)   |
|  (Preact + Vite)   | <----> |  /api/inspector/   | <----> |  --remote-         |
|  InspectorView     |        |  proxy relay       |        |   debugging-port  |
+--------------------+        +--------------------+        +--------------------+
```

- **REST surface** — `GET /api/inspector/config`, `PUT /api/inspector/config`, `GET /api/inspector/version`, `GET /api/inspector/targets`, `POST /api/inspector/open`, `POST /api/inspector/close`, `POST /api/inspector/reload`, `POST /api/inspector/navigate`. The mobile UI calls these over plain `fetch()`.
- **WebSocket proxy** — `WS /api/inspector/proxy?host=<httpBase>&targetId=<id>`. The browser opens this URL; the server resolves the target id against the Chrome `/json/list` payload, opens a second WebSocket upstream to `webSocketDebuggerUrl`, and pipes frames in both directions until either side closes.
- **Per-connection, no shared state.** The proxy is a per-connection relay; the server does not parse, buffer, or transform CDP frames. That keeps the surface tiny and means future CDP domains are free.

The proxy is the only path for browser → Chrome traffic. There is no fall-back to an HTTP polling mode — the whole point of DevTools is the live stream.

## Configuration

The browser has to know where the debug Chrome instance is. That location is the **HTTP base** of the Chrome instance, e.g. `http://127.0.0.1:9222`. Chrome exposes `/json/version` and `/json/list` over plain HTTP on that base; the server reads them to discover targets and to resolve a `targetId` to its `webSocketDebuggerUrl`.

The configured URL is stored in the app SQLite store under the key `inspectorDebuggerUrl` ([src/inspector.js](../../src/inspector.js) → `APP_KEY_DEBUGGER_HOST`). The setup phase of the Inspector tab shows the current value plus the built-in default (`http://127.0.0.1:9222`). `Save & discover` persists the value and immediately fetches the target list. `Discover only` re-uses the current value.

The environment variable `MOUAIF_CHROME_URL` overrides the default for headless / test environments. An empty value in the app store falls back to the default.

### Phone tip

On a physical device, Chrome runs on the phone and `mouaif` runs on a laptop. Forward the port with `adb reverse tcp:9222 tcp:9222` and point the URL at `http://127.0.0.1:9222`. On the same network you can also use the phone's LAN IP.

## UI flow
The view is a 3-state machine. The phase, saved debugger URL, and
current target live in Preact `useState`; the high-frequency CDP
buffers (console / network entries, request map, virtual-list
handles) live in `useRef` so a CDP message burst does not thrash
the tree.

1. **Setup** — input the Chrome debugger URL, save, and discover.
   Shown only when the app has no saved URL yet.
2. **Targets** — list of discoverable pages / iframes / service
   workers / background pages, with a type chip, a title, a host
   subtitle, and a per-row overflow menu (Connect / Reload / Close).
3. **Inspect** — connected to a specific target, with **Preview**,
   **Console**, **Network**, and **Info** sub-tabs. The header shows
   the target's title, type, and URL. A status line above the
   active panel reports the current WebSocket state.

The view skips straight to **Targets** on mount when a saved URL is
present: `loadConfig` triggers `loadTargets` via `setTimeout(0)` so
the targets phase's status element is mounted before the request
fires. Returning users no longer have to retap **Discover** every
visit. The setup screen still shows when no URL is saved. Each phase
has a per-screen back button that walks the state machine backwards
and tears down any open WebSocket.

The **Targets** screen also has a **Page URL** field for one-step
inspect: type a page URL (e.g. `http://localhost:3000`, or bare
`localhost:3000` — the scheme is added for you), tap **Open &
inspect** (or press Enter), and the server tells Chrome to open that
page in a **new tab**, then attaches the inspector straight to it.
No need to open the tab yourself or pick from the target list. The
manual list below remains available for tabs that are already open.

While inspecting a target, the header shows the page's URL in a code
chip plus a **New tab** button (`POST /api/inspector/open`, the same
endpoint behind **Open & inspect**). Tapping the button opens that
same URL in a fresh Chrome tab; the outcome is reported on the status
line. The button is a 44 px+ touch target (the previous URL-as-link
affordance was ambiguous and hard to tap), and the current connection
keeps its target — no re-attachment.

## Tab management
The Inspector can **reload**, **navigate**, and **close** tabs of the
debug Chrome — both from the targets list and, for the page being
inspected, from the inspect header. The server talks CDP directly to
Chrome (`Page.reload` / `Page.navigate` on the target's WebSocket,
`Target.closeTarget` on the browser-level WebSocket), so these
actions work without an active inspector connection.

### Targets list rows
Each row is a tappable card with a **type chip** on the left, the
title above the host subtitle on the right, and a `…` overflow on
the far right. Tapping the body of the card is the primary action
(**Connect**). The overflow menu holds the per-row actions:

- **Connect** — same as tapping the body.
- **Reload** — visible only for targets of `type === "page"`
  (iframes, service workers and background pages do not have a
  reload action in CDP).
- **Close tab** — visible only for `type === "page"` targets; the
  server-side `Target.closeTarget` is called and the list is
  refreshed so the closed tab disappears.

The chip color follows the type: **TAB** / **FRAME** (accent blue)
for pages and iframes, **SW** / **WORKER** / **SHARED** (amber) for
workers, **BG** / **OTHER** (muted) for everything else. The chip
makes it easy to tell at a glance which row is a service worker vs
a normal tab.

The list itself is rendered declaratively as Preact children (the
previous version mutated a shared `<ul>` via `setTimeout` +
`createElement`, which raced Preact reconciliation and made refresh
actions flaky on a busy target list). The empty state shows a short
"how to" hint and a centred **Refresh targets** action instead of a
bare `<li>`.

### Inspect header

While inspecting, a toolbar under the header offers:

- **Reload** — reloads the attached page (`POST /api/inspector/reload`). The connection survives; the preview, console, and network panels keep streaming.
- **URL field + Go** — navigates the attached tab to a new URL (`POST /api/inspector/navigate`). Bare hosts like `localhost:3000` get `http://` added automatically, matching the "Open & inspect" flow. The field is pre-filled with the current page URL and submits on Enter.
- **Close** — closes the attached tab (`POST /api/inspector/close`), after a confirmation. The inspector disconnects, walks back to the targets list, and refreshes it.

These replace the old URL-as-link affordance: the URL now lives in an editable field, and destructive actions are explicit buttons instead of hidden gestures.

## Preview panel

The Preview panel shows what the attached page actually looks like, live. It captures the page via `Page.captureScreenshot` (JPEG, quality 55) and paints the result into an `<img>` via an object URL. The capture loop is **event-driven** rather than a fixed timer: the panel subscribes to `Page.frameNavigated` and `Page.frameStoppedLoading` over the same CDP connection, and each of those events triggers an immediate capture. A slow 3 s fallback poll covers in-page state changes that no CDP event fires for (scroll, hover, JS-driven DOM mutations, SPA route changes that don't navigate the frame). The poll resets its 3 s clock every time an event-driven capture lands, so the panel does **not** busy-poll during a navigation burst — an idle page costs at most one capture per 3 s, and a page that just finished loading captures immediately and goes quiet. The loop is strictly sequential (no overlapping captures) and stops as soon as the user switches sub-tab or disconnects. `Page.enable` is sent on connection; if the domain is unavailable the panel shows a status line and the other tabs keep working.

The screenshot is a **full-page capture** (`captureBeyondViewport: true`), so the shot is as tall as the page's scrollable content rather than just the visible viewport. The frame that hosts the image is a scroll container (`overflow: auto`, `56dvh` tall). The image is scaled to the frame's width (`width: 100%`, height from aspect ratio) and the frame scrolls vertically through the full-page height — a mobile-first "scroll through the page" view. Scaling to the frame width (rather than showing natural device pixels) is required because high-DPR captures come back 2–3× wider than the CSS viewport; at natural size the user would only see a zoomed-in corner of the page. If the user is scrolled inside the frame when a fresh screenshot arrives, their position is restored on image load instead of snapping to the top.

Because the preview is a raw compositor screenshot, the captured page is rendered with the **emulated color-scheme preference**, not the devtools UI's. On connection the inspector sends `Emulation.setEmulatedMedia` with `prefers-color-scheme: light` (the CDP default; older Chrome requires an explicit override — the empty `Emulation.setEmulatedMedia` that used to be sent left the emulated preference as `no-preference`, which dark-mode pages could resolve to their dark stylesheet). Without this, a page that requested light mode but got captured by the dark UI came out as a dark JPEG that no CSS filter could repair. If the target doesn't support the Emulation domain the override is a no-op and the other tabs keep working.

Tapping or clicking anywhere on the preview **forwards a click to the page**. The tap coordinates go through a three-step mapping so the click lands exactly where the user tapped:

1. **Frame → image** — the preview frame is a scroll container, so the tap's client coordinates are first shifted by the frame's `scrollLeft`/`scrollTop` (this matters for pages wider than the frame, where the user panned horizontally before tapping).
2. **Image CSS → natural pixels** — the image is scaled to the frame width, so the frame-relative CSS coordinates are scaled by `naturalWidth`/`naturalHeight` to produce device-pixel coordinates within the full-page screenshot (`captureBeyondViewport` returns device pixels).
3. **Full-page device pixels → viewport CSS pixels** — `Input.dispatchMouseEvent` wants coordinates relative to the live viewport, so `clickAt` (in `inspector/events.js`) first divides by the page's `devicePixelRatio` (queried via `Runtime.evaluate`) to get page CSS coordinates, then subtracts the page's `scrollX`/`scrollY`. If the tapped point is outside the live viewport (e.g. below the fold), the page is first scrolled to bring it roughly centered into view (`window.scrollTo`), then the click is dispatched at the corrected viewport coordinates.

The click is sent as `Input.dispatchMouseEvent` (`mousePressed` + `mouseReleased`, left button) over the same CDP connection. The preview behaves like a remote tap surface, not just a picture — a tap below the fold scrolls the real page and clicks the element the user aimed at.

### Preview refresh + click reliability

The capture loop swaps the screenshot into a single, persistent `<img>` node by reassigning its `src` to a fresh object URL on every capture. The previous version called `setImgSrc(next)` to push a new URL into state, which caused Preact to **unmount the old `<img>` and mount a brand-new one** every 1.2 s. Two side effects followed:

- The user saw a brief blank / "loading" flash on every refresh — the visible "load message" that re-appeared constantly.
- A click landing during the decode window found `imgRef.current.naturalWidth === 0` and silently returned, so the tap on the preview was a no-op until the next refresh.

Reusing the same node removes both. The capture loop also:

- **Is event-driven, not timer-driven.** Subscribes to `Page.frameNavigated` and `Page.frameStoppedLoading` over the same CDP connection; each event triggers an immediate capture. A 3 s fallback poll covers in-page state changes that no CDP event fires for (scroll, hover, JS-driven DOM mutations, SPA route changes that don't navigate the frame). The poll resets its 3 s clock every time an event-driven capture lands, so an idle page costs at most one capture per 3 s.
- Defers `URL.revokeObjectURL` of the previous object URL until the new image's `onload` fires. Revoking too early used to abort the in-flight decode and show a blank frame.
- Caches the last successfully decoded `naturalWidth`/`naturalHeight` in a ref (`lastDims`). `onPreviewClick` uses these as a fallback when the live image is still mid-decode — the page's intrinsic size is essentially constant between captures, so the previous frame is a safe approximation and a click during a refresh still maps to a sensible point on the page.
- Updates the status note from `capturing…` to `live` only on the first successful capture, and only changes it again on error. The per-tick timestamp that used to re-fire through the `aria-live` region on every refresh was just noise.

The `<img>` is mounted with `src=""` (and `draggable="false"`) so the element is in the tree and has a measurable bounding rect even before the first capture lands. Clicks arriving before any capture at all fall back to the rendered rect's own dimensions, so the page still receives a click near the tapped area.

## Console panel

The Console panel subscribes to `Runtime.consoleAPICalled` and `Runtime.exceptionThrown`. Each event is rendered as a row with a timestamp, a level chip (LOG / DEBUG / INFO / WARNING / ERROR — colored to match Chrome's own severity), the formatted message text, and a source link (`file:line`) when a stack trace is attached. Object arguments render as compact inline previews (`{a: 1, b: 2, …}`) built from the CDP `preview` payload rather than a bare `Object` description.

Tapping a row opens a **detail sheet**: the full message, the source location, and the complete stack trace for exceptions and traced logs.

The panel keeps the last **2,000** entries in memory and renders them through a [Virtual list](virtual-list.md) with a fixed 52 px row height and an overscan of 6. The new bottom is auto-scrolled into view when an event arrives.

`Runtime.enable` is sent on connection. If the call rejects, the failure shows in the status line and the rest of the view keeps working (we don't tear down on a single failed command).

## Network panel

The Network panel subscribes to `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`, and `Network.loadingFailed`. Entries are keyed by `requestId` so the four events per request collapse into a single row. The row carries the method, the HTTP status (or `···` for pending, `FAIL` for `loadingFailed`), the URL, and a metadata line with resource type, MIME type, transferred size, duration, and remote IP. Status chips are colored by class: 2xx green, 3xx amber, 4xx/5xx red, pending muted, failed red.

Chrome does not replay requests that finished before the Network domain was enabled — `Network.enable` on an already-loaded page emits nothing, and there is no request-history API. So on attach the panel **backfills the page's existing resources** via `Page.getResourceTree` (the main document, subframe documents, and their resource URLs), tagged with a `PRE` status chip and a `pre-attach` meta tag. This keeps an attach to an already-open tab (the common case) from showing an empty log. Backfilled rows are reconstructed entries, not full request records: Chrome retains no size or body for them, so the detail sheet explains that and hides the "Fetch body" button (the sheet's body area shows `(pre-attach — body not captured by Chrome)`). New traffic after attach streams in normally with full detail; the backfill is inserted before any live entries so the timeline stays chronological. The status line reports how many resources were backfilled. If the Page domain is unavailable the backfill is skipped and the panel starts empty.

Tapping a row opens a **detail sheet** with the full URL, timing, remote address, protocol, cache flag, request and response headers, and the response body. The body is fetched lazily via `Network.getResponseBody` on demand (capped at 200 kB in the UI) so the panel doesn't pay for payloads the user never looks at.

The panel renders the last **2,000** requests through the same Virtual list primitive with a 52 px row height. There is no auto-scroll on the Network panel — the user keeps their place while events arrive, matching the Chrome panel.

## Info panel

The Info panel shows live page vitals from `Performance.getMetrics`: open documents, frames, DOM node count, JS event listeners, JS heap usage, layout count, and style-recalc count, plus the number of network requests seen in the session. It polls every 2.5 s while the tab is active and renders the counters as a responsive metric grid (2 columns on a phone, 4 on wider screens).

`Network.enable` is sent on connection.

## REST surface

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET    | `/api/inspector/config` | — | `{ url, defaultUrl }` |
| PUT    | `/api/inspector/config` | `{ url }` | `{ url }` (rejected with 400 if `url` is not http(s)) |
| GET    | `/api/inspector/version` | — | Chrome `/json/version` payload |
| GET    | `/api/inspector/targets` | — | `{ targets: ChromeListItem[] }` |
| POST   | `/api/inspector/open` | `{ url }` | `{ target: ChromeListItem }` — opens the URL in a new Chrome tab and returns the fresh target. Primary path is the CDP `Target.createTarget` command over the browser-level WebSocket (from `/json/version`); falls back to the classic `PUT /json/new` for Chrome builds that still expose it (modern Chrome 137+ removed the HTTP endpoint and returns 404). If the CDP browser WS id went stale (Chrome restarted between the `/json/version` fetch and the WS open — Chrome answers "not found"), the call retries once with a freshly re-fetched id. If `/json/version` has no browser WS **and** `/json/new` 404s, a clear actionable error is returned instead of Chrome's raw "not found" |
| POST   | `/api/inspector/close` | `{ targetId }` | `{ ok: true }` — closes a tab (`Target.closeTarget` on the browser-level WebSocket) |
| POST   | `/api/inspector/reload` | `{ targetId }` | `{ ok: true }` — reloads a tab (`Page.reload` on the target's WebSocket) |
| POST   | `/api/inspector/navigate` | `{ targetId, url }` | `{ frameId, loaderId }` — navigates a tab to a new URL (`Page.navigate` on the target's WebSocket). `url` must be http(s) |

Errors from the upstream Chrome are mapped to typed status codes:

| Code | HTTP | When |
|------|------|------|
| `ECHROME_UNREACHABLE` | 502 | The configured host didn't accept the TCP connection |
| `ETARGET_NOT_FOUND`   | 404 | `targetId` was not in `/json/list` |
| `EUPSTREAM`           | 502 | Chrome returned a non-2xx from `/json/list` or `/json/version` |
| `EPARSE`              | 502 | Chrome returned 2xx with a non-JSON body or a non-array for `/json/list` |
| `EBADURL` / `EBADINPUT` | 400 | Mis-shaped input |

The WebSocket proxy returns 400 for missing `targetId` / `ws`, 404 for unknown targets, 502 for `ECHROME_UNREACHABLE`, and a 500 with a typed body for upstream open failures. On success, the response is the standard `HTTP/1.1 101 Switching Protocols` and the connection is upgraded.

## Implementation notes

The mobile detail sheet applies top and bottom safe-area padding at the fixed overlay level, keeping its content clear of the device status bar and home indicator.

- **WS library** — runtime dependency `ws@^8`. Used both server-side (the `noServer` `WebSocketServer` for the upgrade handshake) and in the test mock. The mobile UI uses the browser's native `WebSocket` to talk to the server.
- **Proxy error surfacing** — a rejected upgrade (e.g. `ETARGET_NOT_FOUND`) is written as a short HTTP response with a JSON body before the socket closes. The browser's WebSocket `error` event carries no message, so `cdp.js` captures the server's close reason and the UI shows it on the status line instead of a generic "WebSocket error".
- **No new CSS framework.** The Inspector styles live at the bottom of [frontend/src/style.css](../../frontend/src/style.css) under `/* ---- Inspector ---- */`. They re-use the same tokens (surfaces, accent, semantic colors, 4 px spacing) and follow the mobile-first rules from [.github/copilot-instructions.md](../../.github/copilot-instructions.md) §2.
- **Tab bar layout** — the bottom tab bar is a 3-column grid (`Projects / Inspector / Settings`). Inspector is a peer of the existing tabs, not a child of Settings; provider authentication lives within Settings.
- **Virtualization** — both list panels use [frontend/src/virtual-list.js](../../frontend/src/virtual-list.js). Each row is a fixed-height absolutely-positioned node, the pool is reused, and the spacer height drives the native scrollbar. The Inspector passes an optional `key` function so rows keep DOM-node identity across updates: when a network entry flips from pending to 200, or a response body loads, the same `<div>` is re-rendered in place instead of being recycled.
- **Mutable row updates** — network and console entries carry a `rev` counter that is bumped on every mutation. The virtual-list render functions diff a signature (`id|rev|status|size|duration`) against the node's previous signature and skip DOM writes entirely when nothing changed, so a busy page doesn't force-reflow the list on every CDP event.
- **State and refs.** The phase, saved debugger URL, current target, panel and detail item live in Preact `useState` so the Inspector re-renders when the user moves between phases. The high-frequency CDP buffers (websocket, command id, pending responses, event listeners, console / network entry arrays, request map, virtual-list handles) live in `useRef` so a CDP message burst updates a ref and pushes rows into the virtual list directly. Preact is only re-rendered on phase / panel / status changes.
- **Reconnect safety.** Disconnecting rejects pending CDP commands and clears
	listeners plus the request map. Close/error events from an older socket are
	identity-checked so they cannot wipe the state of a replacement connection.
- **Backwards compatibility.** Adding the 4th tab does not change the existing REST or SSE surface. The bundle grew by ~14 KB JS and ~3.5 KB CSS to ship the new view.
- **Auto-discovery on mount.** When a debugger URL is already saved, `loadConfig` calls `loadTargets` via `setTimeout(0)` so the targets phase's status `<div>` is mounted before the request fires. Without the `setTimeout`, the call would write its status message to the setup phase's `<span>` (the only mounted status element at the time `loadConfig` resolves), and the targets phase would mount with a stale "fetching targets…" message. Returning users no longer have to retap **Discover** on every visit.
- **Strict-mode `.current` cleanup.** A previous refactor from `useRef` to `useState` left a few `debuggerUrl.current = …` and `defaultUrl.current = …` lines in `loadConfig` / `connect`. In strict mode, setting a property on a string primitive throws (`Cannot create property 'current' on string ''`), and the resulting unhandled rejection aborted the auto-discovery chain. The fix is to drop the leftover `.current` assignments and read the state value directly.
- **Server log line.** The `mouaif serve` startup banner now mentions `Web: / — mobile UI` and `CDP: /api/inspector/ + WS /api/inspector/proxy` so users can see at a glance what shipped.

## Test fixture

`mock-cdp-ws.js` (a one-shot dev helper, not part of the shipped product) is a small Node script that serves `/json/version` + `/json/list` over plain HTTP and a real WebSocket that speaks CDP. It pushes a log / warn / error to the console every 700 ms and a `GET 200` / `POST 500` pair to the network panel. Run it on port 9224, set the Inspector URL to `http://127.0.0.1:9224`, and connect to a target to see both panels light up end-to-end without a real browser.
