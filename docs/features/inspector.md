# Inspector — custom DevTools-style mobile UI

## Overview

The **Inspector** tab provides a mobile-first DevTools experience for inspecting and debugging web pages directly from your phone or desktop browser. It connects to any Chrome or Chromium browser instance running with remote debugging enabled.

![Inspector on a 360 px phone with all four optional panels visible](./images/inspector/mobile-360-all-on.png)

## Getting started

1. Start your browser with remote debugging enabled (default port: `9222`).
2. Open the **Inspector** tab in mouaif.
3. Verify or enter the debugger URL (`http://127.0.0.1:9222`) and tap **Discover targets**.
4. Select a tab from the list to inspect it.

> **Tip for mobile devices:** To inspect a page on your physical device, forward the port with `adb reverse tcp:9222 tcp:9222` and point the debugger URL to `http://127.0.0.1:9222`.

## Panels

You can toggle each of the four panels on and off to customize your workspace:

### 1. Preview panel
- **Live page preview** — captures full-height snapshots of the active page. For Chrome's built-in PDF viewer, the Inspector automatically switches to a viewport capture so Chrome includes the separately composited PDF pages instead of showing only the empty viewer UI shell.
- **Interactive tapping** — tap anywhere on the screenshot to click elements or interact with the page remotely.
- **Scroll & navigation** — scroll through tall pages and follow links in real-time.
- **Viewport size presets** — a dropdown in the Preview panel header applies a CDP device-metrics override to the inspected page: **Auto** (native size), **Phone** (375×667), **Phone+** (414×896), **Tablet** (768×1024), and **Laptop** (1280×800). The page reflows live so media queries and responsive breakpoints respond as if the browser were that size.
- **Refresh preview** — a refresh button in the Preview panel header forces a fresh screenshot on tap, independent of the automatic capture triggers (`Page.frameNavigated`, `Page.frameStoppedLoading`, and the 3 s fallback poll). Handy when an in-page change didn't fire a navigation event.
- **Draft Craft annotation** — draw on the latest preview and add it to a chat draft. The full-screen annotation surface renders above the app dock, including on narrow mobile viewports.

### 2. Console panel
- **Live logs** — see `console.log`, `info`, `warn`, and `error` messages with timestamps and severity indicators.
- **Interactive JavaScript Console** — execute JS expressions directly on the page with autocomplete for globals, properties, and element IDs.
- **Stack traces** — tap any log row to inspect formatted stack traces and object details.

### 3. Network panel
- **Request inspector** — view live HTTP requests and responses, status codes, transferred sizes, and timing metrics.
- **Request headers & payloads** — tap any request to inspect headers and response bodies.
- **Color-coded status** — quick visual indicators for successful, redirected, pending, or failed network calls.

### 4. Info panel
- **Page vitals** — monitor live DOM node counts, JavaScript heap usage, event listeners, frame rates, and layout recalculations.

## Tab management

Use the top navigation bar to:
- Enter a new URL to navigate the tab.
- **Reload** the page.
- **Open new tab** in the attached browser.
- **Close tab** when done — opens an in-app confirmation sheet (see below).

### Closing a tab

Close tab is destructive, so the Inspector prompts for confirmation before sending the request to Chrome. Both entry points (the per-row `…` menu in the targets list and the header overflow menu of an attached tab) open the same in-app sheet:

- The sheet shows the tab's title in quotes (or the URL host when the title is empty) so the user can confirm the right target.
- **Cancel** dismisses the sheet with no network call.
- **Close tab** sends `POST /api/inspector/close` with `{ targetId }`. On success the Inspector disconnects the live CDP session, returns to the targets list, and refreshes the target list so the closed tab disappears. Failures surface on the status pill instead of re-opening the sheet.

The previous design used `window.confirm`, which some embedded web views auto-dismiss and return `false` without rendering a dialog; the close handler then early-returned and the user saw the button as inert (no status pill, no network call). The in-app sheet renders inline so it always renders, always accepts input, and obeys the mobile-first UI rules (≥ 44 × 44 px tap targets, safe-area padding).

## Related

- [Chrome Debug MCP](./chrome-debug-mcp.md) — letting the AI assistant automate the browser.
- [Web preview tool](./webpreview.md) — in-chat page preview thumbnails.
