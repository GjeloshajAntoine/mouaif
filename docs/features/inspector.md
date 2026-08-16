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
- **Live page preview** — captures full-height snapshots of the active page.
- **Interactive tapping** — tap anywhere on the screenshot to click elements or interact with the page remotely.
- **Scroll & navigation** — scroll through tall pages and follow links in real-time.

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
- **Close tab** when done.

## Related

- [Chrome Debug MCP](./chrome-debug-mcp.md) — letting the AI assistant automate the browser.
- [Web preview tool](./webpreview.md) — in-chat page preview thumbnails.
