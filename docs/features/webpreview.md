# Web preview tool (`webpreview`)

## Overview

`webpreview` is a built-in native tool that lets the model open a URL in the Chrome instance the Inspector tab talks to, capture a small JPEG screenshot of what is on the page, and surface the thumbnail inline in the chat transcript. The user sees a compact card next to the tool call — title, URL, dimensions — and tapping it opens a full-screen modal showing the screenshot at full size with the standard close button. The same `devtools/chrome` bridge the Inspector uses is reused: no separate browser is launched, and a single Chrome can run both the Inspector tab and every `webpreview` call.

## Usage

### From the model

```json
{
  "name": "webpreview",
  "arguments": {
    "url": "https://example.com/landing"
  }
}
```

The chat transcript renders a card with the captured thumbnail and the URL the model asked about. On failure the card renders the typed error in the same `tool-preview__pre` style every other failed tool uses, so the user always sees the typed code and message instead of a misleading "no preview" placeholder.

### In the chat UI

- **Card in the transcript.** Every successful `webpreview` call renders a `.tool-preview__webpreview` card. The card has a single short meta line above the thumbnail (`title · 640 × 480 · 120 KB · tap to open`) and the URL underneath the image in monospace.
- **Tap to open.** Tapping the card opens the modal. The same close affordances as every other chat modal:
  - Tap the **×** icon in the head strip.
  - Tap the dark backdrop outside the sheet.
  - Press **Escape**.

  All three dismiss without affecting the chat (no transcript edit, no model turn).
- **Open in new tab.** The footer of the modal has an "Open in new tab" button that opens the original URL in a fresh system browser tab (`target="_blank"`, `rel="noopener noreferrer"`). This is the escape hatch for pages that need cookies, scripts, or a wider window — the modal is just a screenshot, not a live browser.

### Authorization

`webpreview` is project-scoped to the standard `{ mode, allowlist, defaultTimeoutMs, maxTimeoutMs }` block at `tools.webpreview`:

```json
{
  "tools": {
    "webpreview": {
      "mode": "ask",
      "allowlist": [
        "^https?://(localhost|127\\.0\\.0\\.1):[0-9]+/",
        "^https?://[a-z0-9\\-]+\\.example\\.com/"
      ]
    }
  }
}
```

Modes (`off` / `ask` / `allowlist` / `allow`) follow the same rules as every other native tool ([docs/features/tool-authorization.md](./tool-authorization.md)). Allowlist patterns match against the URL itself (the `summary` surfaced on the authorization card and the regex matcher), so a pattern like `^https?://example\.com/` auto-approves every URL on that host, while `^https?://api\.example\.com/v1/` narrows it to a single path. The Authorization card surfaces the URL so the user can decide per-request.

## Behavior

- **Reuses the Inspector bridge.** The tool calls `openInspectorTarget(url)` from [src/inspector.js](../../src/inspector.js), which talks to Chrome over DevTools Protocol via the same `/api/inspector/proxy` WebSocket relay the Inspector tab uses. The default debugger URL is `MOUAIF_CHROME_URL` or `http://127.0.0.1:9222` — exactly the URL the Inspector tab targets. Users who run their own Chrome with `--remote-debugging-port` get the tool working for free.
- **One open tab per call.** Each call opens a fresh tab (modern Chrome's `Target.createTarget`), waits up to 10 s for `Page.loadEventFired`, gives layout a 250 ms grace window, captures a single viewport-sized JPEG, and closes the tab. A failed capture still closes the tab — server restarts do not leak preview tabs.
- **JPEG, viewport-only, capped.** The capture uses `Page.captureScreenshot` with `format: 'jpeg'`, `quality: 70`, and a clip rectangle clamped to 640 × 480 max (any larger cap is rounded down). The result is base64-decoded inside the runner and rejected with `ETOOLARGE` before being returned if it exceeds 2 MiB — the same cap as the chat feedback rail, so the model never receives more than one thumbnail's worth of bytes.
- **Result shape.** The chat UI pulls these fields:
  - `url` — the URL the model asked about.
  - `title` — the page title from the Chrome target record (refreshed on navigation in modern Chrome).
  - `thumbnail` — a `data:image/jpeg;base64,…` URL. The card uses it directly in an `<img>` (no fetch, no CSP issues with `data:`).
  - `width`, `height` — viewport dimensions used for the capture.
  - `sizeBytes`, `capturedAt` — meta for the modal footer.
- **Model feedback.** The same image is attached as an `image_url` part to the `tool` message through `toolResultImageParts` in [src/ai-stream.js](../../src/ai-stream.js), so multimodal providers (Anthropic, OpenAI-shaped, Gemini, Ollama) see the page they preview. Text-only providers get the JSON envelope `{ ok, url, title, sizeBytes, width, height, targetId }` and ignore the image part.
- **Failure is typed.** Each failure mode has its own code so the UI can show actionable messages:
  - `EBADINPUT` — empty URL, malformed URL, or non-http(s) scheme (`file:`, `data:`, `javascript:`, …).
  - `ECHROME_UNREACHABLE` — Chrome's `/json/version` is unreachable.
  - `EUPSTREAM` — Chrome opened the tab but `Page.captureScreenshot` failed (timeout, page crashed, etc.).
  - `ETOOLARGE` — the screenshot decoded past 2 MiB.
  - `EPARSE` — base64 payload did not decode.
  - `EMODULE` — the runner module failed to load.
  - `EWEBPREVIEW` — unhandled exception inside the runner (network drop, etc.).
- **Modal closes the chat native way.** `data-web-preview-id` on every card is the bridge between the imperative renderer (no Preact access) and the Preact modal (`<WebpreviewModal>` in `frontend/src/components/chat/WebpreviewModal.jsx`). A document-level click delegate emits a `requestOpen(id)` event, Chat.jsx subscribes, and the modal mounts over the chat. Tapping the backdrop or the close button calls the same `closeActive()` so the open state is consistent.

## Related

- [docs/features/inspector.md](./inspector.md) — the custom DevTools UI that pairs with this tool. They share the same Chrome endpoint; configuring `inspectorDebuggerUrl` (or just running Chrome with `--remote-debugging-port`) either side lights up the other.
- [docs/features/tool-authorization.md](./tool-authorization.md) — how the `off` / `ask` / `allowlist` / `allow` gate works for every native tool.
- [docs/features/chrome-debug-mcp.md](./chrome-debug-mcp.md) — the model-side Chrome automation surface for cases where `webpreview` is not enough (clicking, typing, scripted navigation).
- [src/inspector.js](../../src/inspector.js) — opens tabs and runs CDP commands over the same proxy the Inspector tab uses.
- [docs/decisions.md](../decisions.md) §6 — the locked-in decision that the mobile UI talks CDP raw instead of embedding the Chrome DevTools panel.
