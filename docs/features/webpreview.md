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

To capture at a different size, add a `viewport` argument — a preset id (`"phone"`, `"phone+"`, `"tablet"`, `"laptop"`) or a `"WIDTHxHEIGHT"` string (e.g. `"1280x800"`). It defaults to the 375 × 667 `"phone"` capture:

```json
{
  "name": "webpreview",
  "arguments": {
    "url": "https://example.com/landing",
    "viewport": "tablet"
  }
}
```

### In the chat UI
- **Right-aligned miniature** — the latest successful capture is shown above the composer, outside the scrolling transcript, as a small phone-proportioned image. The screenshot is the only content in chat; page title/host/time are shown only in the full-screen viewer. Its height is capped (`min(24dvh, 11rem)`) so a tall page capture stays a thumbnail instead of taking over the chat: the dock is in the flow above the composer, so every pixel of it comes out of the transcript. The image fills the card and is cropped to the **top** of the page — the part worth previewing — and the full capture is one tap away in the viewer.
- **Mobile proportion** — by default the capture uses the Inspector's 375 × 667 Phone viewport and the dock preserves that aspect ratio. The capture resolution is reported in the full-screen viewer's footer and can be changed.
- **Full image** — tap the card to open the screenshot in a full-screen viewer (title with a short host sub-line, a **Refresh** button, the Size dropdown, capture time and resolution in the footer, and Open-in-new-tab). The header is a **single row at every phone width**. The title/host block is the only flexible child, so it absorbs the slack and ellipsizes; **Refresh** collapses to its icon; the Size dropdown keeps its own width (enough for the longest option, so its label is never clipped); and the close ✕ sits at the end of the row. On a 360 px phone the whole header is 55 px tall and every control is still a 44 × 44 px tap target.
- **Change resolution** — the full-screen viewer has a native **Size** selector beside the close button (Phone / Phone+ / Tablet / Laptop / Custom). Picking a preset re-captures the same URL immediately, without a model round-trip. Picking **Custom** reveals touch-friendly width and height fields; values from 64 to 2048 px can be applied. A custom size requested by the model pre-fills those fields.
- **Dismiss** — a small circular close button on the card's top-right border removes the preview without changing the chat.
- **Open in browser** — the full viewer can open the original URL in a new browser tab.
- **Reload by the AI** — another `webpreview` call replaces the card's image with a fresh capture.

### Authorization
`webpreview` uses the project's tool authorization mode (`Ask`, `Allow`, or `Off`) and optional URL allowlist patterns. In `Ask` mode, changing the resolution closes the viewer and shows the standard authorization card in the chat; approving it retries the capture at the selected size.

## Implementation notes

- The native runner in `src/tools/webpreview.js` opens a temporary debug-Chrome tab, waits for the page, applies the requested viewport (default 375 × 667 phone), captures a JPEG, and closes the tab. It accepts a `viewport` arg via the model spec, and `resolveViewport()` maps preset ids or `WIDTHxHEIGHT` strings (clamped) to a capture rectangle.
- `frontend/src/components/chat/webpreviewState.js` bridges imperative tool results to `WebpreviewDock.jsx`.
- The dock is rendered directly between `.chat-view__transcript` and `.chat-view__composer-row` in `frontend/src/components/chat/Chat.jsx`.
- The full-screen viewer (`WebpreviewModal.jsx`) shows the capture resolution in its footer meta and exposes a **Refresh** button plus a native **Size** selector. Its **Custom** option validates width and height before sending a `WIDTHxHEIGHT` viewport. These controls call `POST /api/tools/webpreview` (implemented in `src/server-handlers-tools.js`) to re-capture at a chosen size. That endpoint goes through the same `webpreview` authorization gate as the model path; `Chat.jsx` handles `EAUTH_REQUIRED` by mounting the shared authorization card and retrying with the original call ID after approval.
- Screenshot bytes are emitted in the rich UI result only. `src/ai-stream.js` does not append them as model image input; the model receives compact URL, title, size, dimension, and viewport metadata.
- Repeating the tool call opens a fresh temporary tab, so each call functions as a reload.

## Related

- [Inspector](./inspector.md) — inspecting and interacting with live browser pages.
- [Tool authorization](./tool-authorization.md) — approving or gating tool execution.
