# Inspector — custom DevTools-style mobile UI

## Overview

The **Inspector** tab in the mobile shell ([src/web/src/main.jsx](../../src/web/src/main.jsx) → `InspectorView`) is a from-scratch DevTools-style UI built on top of the **Chrome DevTools Protocol (CDP)**. It is *not* the default Chrome panel embedded in an iframe — the browser speaks CDP directly over WebSocket, the mouaif server ([src/inspector.js](../../src/inspector.js) + [src/index.js](../../src/index.js)) is a thin relay. The UI is mobile-first and only ships the two panels that fit on a phone: **Console** and **Network**.

The Inspector is the last piece of the spec from [decisions.md §6](../decisions.md) and §9 build-order item 14: a from-scratch mobile-friendly UI that consumes CDP events but never embeds the Chrome panel.

## Architecture

```
+--------------------+        +--------------------+        +--------------------+
|  mobile UI         |  WS    |  mouaif server     |  WS    |  Chrome (debug)   |
|  (Preact + Vite)   | <----> |  /api/inspector/   | <----> |  --remote-         |
|  InspectorView     |        |  proxy relay       |        |   debugging-port  |
+--------------------+        +--------------------+        +--------------------+
```

- **REST surface** — `GET /api/inspector/config`, `PUT /api/inspector/config`, `GET /api/inspector/version`, `GET /api/inspector/targets`. The mobile UI calls these over plain `fetch()`.
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

The view is a 3-state machine. State is held in refs (not Preact state) so a CDP message burst does not thrash the tree.

1. **Setup** — input the Chrome debugger URL, save, and discover.
2. **Targets** — list of discoverable pages / service workers / etc. with title, type chip, URL, and a Connect button per row.
3. **Inspect** — connected to a specific target, with a **Console** and a **Network** sub-tab. The header shows the target's title, type, and URL. A status line above the active panel reports the current WebSocket state.

The view starts in `setup`. Each phase has a per-screen back button that walks the state machine backwards and tears down any open WebSocket.

## Console panel

The Console panel subscribes to `Runtime.consoleAPICalled` and `Runtime.exceptionThrown`. Each event is rendered as a row with a timestamp, a level chip (LOG / DEBUG / INFO / WARNING / ERROR — colored to match Chrome's own severity), and the formatted message text. Arguments are coerced to strings via `argToString` (preferring `value`, then `description`, then the `type`).

The panel keeps the last **2,000** entries in memory and renders them through a [Virtual list](virtual-list.md) with a fixed 44 px row height and an overscan of 6. The new bottom is auto-scrolled into view when an event arrives.

`Runtime.enable` is sent on connection. If the call rejects, the failure shows in the status line and the rest of the view keeps working (we don't tear down on a single failed command).

## Network panel

The Network panel subscribes to `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`, and `Network.loadingFailed`. Entries are keyed by `requestId` so the four events per request collapse into a single row. The row carries the method, the HTTP status (or `···` for pending, `FAIL` for `loadingFailed`), and the URL. Status chips are colored by class: 2xx green, 3xx amber, 4xx/5xx red, pending muted, failed red.

The panel renders the last **2,000** requests through the same Virtual list primitive with a 48 px row height. There is no auto-scroll on the Network panel — the user keeps their place while events arrive, matching the Chrome panel.

`Network.enable` is sent on connection.

## REST surface

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET    | `/api/inspector/config` | — | `{ url, defaultUrl }` |
| PUT    | `/api/inspector/config` | `{ url }` | `{ url }` (rejected with 400 if `url` is not http(s)) |
| GET    | `/api/inspector/version` | — | Chrome `/json/version` payload |
| GET    | `/api/inspector/targets` | — | `{ targets: ChromeListItem[] }` |

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

- **WS library** — runtime dependency `ws@^8`. Used both server-side (the `noServer` `WebSocketServer` for the upgrade handshake) and in the test mock. The mobile UI uses the browser's native `WebSocket` to talk to the server.
- **No new CSS framework.** The Inspector styles live at the bottom of [src/web/src/style.css](../../src/web/src/style.css) under `/* ---- Inspector ---- */`. They re-use the same tokens (surfaces, accent, semantic colors, 4 px spacing) and follow the mobile-first rules from [.github/copilot-instructions.md](../../.github/copilot-instructions.md) §2.
- **Tab bar layout** — the bottom tab bar becomes a 4-column grid (`Projects / Inspector / Settings / Auth`). Inspector is a peer of the existing tabs, not a child of Settings; the from-scratch UI earns its own entry point. The bar still respects `env(safe-area-inset-bottom)`.
- **Virtualization** — both panels use [src/web/src/virtual-list.js](../../src/web/src/virtual-list.js). Each row is a fixed-height absolutely-positioned node, the pool is reused, and the spacer height drives the native scrollbar.
- **Ref-only state.** The CDP client (websocket, command id, pending responses, event listeners, console / network buffers) lives on refs, not Preact state. A CDP message burst updates a ref and pushes rows into the virtual list directly; Preact is only re-rendered on phase / panel / status changes.
- **Backwards compatibility.** Adding the 4th tab does not change the existing REST or SSE surface. The bundle grew by ~14 KB JS and ~3.5 KB CSS to ship the new view.
- **Server log line.** The `mouaif serve` startup banner now mentions `Web: /web/ — mobile UI` and `CDP: /api/inspector/ + WS /api/inspector/proxy` so users can see at a glance what shipped.

## Test fixture

`mock-cdp-ws.js` (a one-shot dev helper, not part of the shipped product) is a small Node script that serves `/json/version` + `/json/list` over plain HTTP and a real WebSocket that speaks CDP. It pushes a log / warn / error to the console every 700 ms and a `GET 200` / `POST 500` pair to the network panel. Run it on port 9224, set the Inspector URL to `http://127.0.0.1:9224`, and connect to a target to see both panels light up end-to-end without a real browser.
