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

Any absolute URL Chrome can open is accepted — `http:`, `https:`, `file:`, `data:`, `about:`, and so on. Which URLs actually run is decided by the project's authorization mode and allowlist (see below).

To capture at a different size, add a `viewport` argument — a preset id (`"phone"`, `"phone+"`, `"tablet"`, `"laptop"`) or any `"WIDTHxHEIGHT"` string of positive integers (e.g. `"1280x800"`, `"3840x2160"`). Custom sizes have no range limit; very large ones may be slow, time out, or exceed the 32 MiB screenshot cap. It defaults to the 375 × 667 `"phone"` capture:

```json
{
  "name": "webpreview",
  "arguments": {
    "url": "https://example.com/landing",
    "viewport": "tablet"
  }
}
```

To show the page itself, interactive, instead of a screenshot, set `"mode": "live"`. No Chrome capture runs: the user's browser loads the URL in an iframe in the dock and the viewer, at the `viewport` size. The tool result reports `"mode": "live"`:

```json
{
  "name": "webpreview",
  "arguments": {
    "url": "http://localhost:5173/",
    "mode": "live",
    "viewport": "phone"
  }
}
```

`mode` is `"screenshot"` (default) or `"live"`. The same field is accepted by `POST /api/tools/webpreview`.

### In the chat UI
- **Right-aligned miniature** — the latest successful capture is shown above the composer, outside the scrolling transcript, as a small phone-proportioned image. The screenshot is the only content in chat; page title/host/time are shown only in the full-screen viewer. Its height is capped (`min(24dvh, 11rem)`) so a tall page capture stays a thumbnail instead of taking over the chat: the dock is in the flow above the composer, so every pixel of it comes out of the transcript. The image fills the card and is cropped to the **top** of the page — the part worth previewing — and the full capture is one tap away in the viewer.
- **Mobile proportion** — by default the capture uses the Inspector's 375 × 667 Phone viewport and the dock preserves that aspect ratio. The capture resolution is reported in the full-screen viewer's footer and can be changed.
- **Full image** — tap the card to open the screenshot in a full-screen viewer (title with a short host sub-line, a **Refresh** button, the Size dropdown, capture time and resolution in the footer, and Open-in-new-tab). The header is a **single row at every phone width**. The title/host block is the only flexible child, so it absorbs the slack and ellipsizes; **Refresh** collapses to its icon and keeps its glyph **centred** in the 44 × 44 px button (it is the only control here with no text to justify); the Size dropdown keeps its own width (enough for the longest option, so its label is never clipped); and the close ✕ sits at the end of the row. On a 360 px phone the whole header is 55 px tall and every control is still a 44 × 44 px tap target.
- **Change resolution** — the full-screen viewer has a native **Size** selector beside the close button (Phone / Phone+ / Tablet / Laptop / Custom). Picking a preset re-captures the same URL immediately, without a model round-trip. Picking **Custom** reveals touch-friendly width and height fields; any positive whole-number size can be applied (no upper limit). A custom size requested by the model pre-fills those fields.
- **Live (iframe) mode** — the viewer's footer has a **Screenshot / Live** toggle (two 44 px buttons). **Live** swaps the screenshot for the page itself in an `<iframe>` you can tap, scroll, and type into. It works for **any URL** (`http:`, `https:`, `file:`, `data:`, `about:`, …) and is **unrestricted**: no sandbox, no referrer stripping, and every browser permission (camera, microphone, geolocation, clipboard, fullscreen, …) is delegated to the page. The frame is rendered at the selected Size (Phone 375 × 667 by default) and scaled down to fit the sheet; the footer shows the frame size and scale. In Live mode **Refresh** reloads the frame and the Size control resizes it, with no capture and no authorization prompt. Your choice is remembered on the device (`localStorage` key `mouaif.webpreview.viewMode`).
- **Agent-opened Live preview** — the agent can open a Live preview itself by calling `webpreview` with `"mode": "live"` (see Usage). The dock then shows a scaled miniature of the running page with a **LIVE** badge instead of a screenshot. Tapping it opens the viewer already in Live mode, where the page is interactive; the miniature itself only opens the viewer. If the viewer is already open, a new live call switches it to Live at the requested size. Tapping **Screenshot** on a live-only preview captures one on demand.
- **Where Live loads from** — the frame is loaded by **your browser**, not the server's debug Chrome, so `localhost` means the device you are holding. Framing is not restricted on mouaif's side, but a site can still refuse to be embedded itself (`X-Frame-Options`, CSP `frame-ancestors`); use Screenshot or Open in new tab for those.
- **Dismiss** — a small circular close button on the card's top-right border removes the preview without changing the chat.
- **Open in browser** — the full viewer can open the original URL in a new browser tab.
- **Reload by the AI** — another `webpreview` call replaces the card's image with a fresh capture.
- **The dock always shows the newest capture.** A capture goes to the dock once, when its tool result arrives, not when you open its card in the transcript, so opening an old `webpreview` card no longer swaps the dock back to that stale screenshot. The dock compares `capturedAt`: an older capture never replaces a newer one, and a capture with no timestamp never replaces one that has a timestamp. Transcript backfill renders old rows after newer ones, so this ordering matters (`scripts/test-webpreview-dock-order.mjs`).

### Authorization
`webpreview` uses the project's tool authorization mode (`Ask`, `Allow`, or `Off`) and optional URL allowlist patterns. In `Ask` mode, changing the resolution closes the viewer and shows the standard authorization card in the chat; approving it retries the capture at the selected size.

## Related

- [Inspector](./inspector.md) — inspecting and interacting with live browser pages.
- [Tool authorization](./tool-authorization.md) — approving or gating tool execution.
