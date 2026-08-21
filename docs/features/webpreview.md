# Web preview tool (`webpreview`)

## Overview

`webpreview` refreshes a user-facing, mobile-proportioned screenshot of a web URL. The latest image appears as a reduced image between the chat scroll and the message textbox; the AI can trigger a refresh, but the screenshot is not returned to the AI for visual analysis.

## Usage

The AI can show or reload a preview by invoking the tool with the current URL:

```json
{
  "name": "webpreview",
  "arguments": {
    "url": "https://example.com/landing"
  }
}
```

### In the chat UI
- **Right-aligned miniature** — the latest successful capture is shown above the composer, outside the scrolling transcript, as a small phone-proportioned image. The screenshot is the only content in chat; page title/host/time are shown only in the full-screen viewer.
- **Mobile proportion** — the capture uses the Inspector's 375 × 667 Phone viewport and the dock preserves that aspect ratio.
- **Full image** — tap the card to open the screenshot in a full-screen viewer (title, URL, host, capture time, Refresh and Open-in-new-tab are all there).
- **Dismiss** — a small circular close button on the card's top-right border removes the preview without changing the chat.
- **Open in browser** — the full viewer can open the original URL in a new browser tab.
- **Reload by the AI** — another `webpreview` call replaces the card's image with a fresh capture.

### Authorization

`webpreview` uses the project's tool authorization mode (`Ask`, `Allow`, or `Off`) and optional URL allowlist patterns.

## Implementation notes

- The native runner in `src/tools/webpreview.js` opens a temporary debug-Chrome tab, waits for the page, applies the Inspector Phone viewport, captures a 375 × 667 JPEG, and closes the tab.
- `frontend/src/components/chat/webpreviewState.js` bridges imperative tool results to `WebpreviewDock.jsx`.
- The dock is rendered directly between `.chat-view__transcript` and `.chat-view__composer-row` in `frontend/src/components/chat/Chat.jsx`.
- Screenshot bytes are emitted in the rich UI result only. `src/ai-stream.js` does not append them as model image input; the model receives compact URL, title, size, and dimension metadata.
- Repeating the tool call opens a fresh temporary tab, so each call functions as a reload.

## Related

- [Inspector](./inspector.md) — inspecting and interacting with live browser pages.
- [Tool authorization](./tool-authorization.md) — approving or gating tool execution.
