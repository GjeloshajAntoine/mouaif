# Web preview tool (`webpreview`)

## Overview

`webpreview` is a built-in tool that allows the model to open a URL, capture a screenshot, and present a thumbnail directly in the chat transcript. Tapping the thumbnail opens a full-screen image viewer.

## Usage

When the model analyzes web pages, it can invoke `webpreview`:

```json
{
  "name": "webpreview",
  "arguments": {
    "url": "https://example.com/landing"
  }
}
```

### In the chat UI

- **Transcript thumbnail** — successful web previews render an image thumbnail card with page title and dimensions.
- **Full-screen modal** — tap the card to inspect the full-resolution screenshot.
- **Open in browser** — tap "Open in new tab" inside the modal to navigate directly to the page in your default browser.

### Authorization

`webpreview` uses your project's tool authorization permissions (`Ask`, `Allow`, or `Off`), with optional URL regex pattern matching in project settings.

## Behavior

- **Inspector integration** — uses the same Chrome debug endpoint configured for the Inspector tab (`http://127.0.0.1:9222`).
- **One tab per capture** — opens a temporary headless tab, captures the screenshot, and immediately cleans up the tab.
- **Multimodal AI feedback** — the resulting image is passed to vision-capable models (e.g. Claude, GPT-4o, Gemini) so the AI can reason about visual page layout.
- **Interactive popup** — tapping any preview thumbnail opens a full-screen image modal.

## Related

- [Inspector](./inspector.md) — inspecting live pages.
- [Chrome Debug MCP](./chrome-debug-mcp.md) — full browser automation.
- [Tool authorization](./tool-authorization.md) — approving or gating tool execution.
