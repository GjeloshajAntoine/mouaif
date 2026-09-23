# Web preview page (project settings)
## Overview
Project Settings → More settings gains a **Web preview** link that opens a dedicated page for capturing a web URL and viewing the screenshot, without needing to open a chat first. It reuses the same `webpreview` capture endpoint and the full-screen viewer used by the chat's File toolbar "Preview" item, so the two surfaces behave identically.
## Usage
1. In Settings → project → **More settings**, tap **Web preview**.
2. Tap **Capture…** and enter an http(s) URL.
3. The page captures the page in the Inspector debug Chrome and opens the full-screen viewer (title with a short host sub-line, a **Refresh** button, the **Size** dropdown, capture time and resolution in the footer, and an Open-in-new-tab link).
4. The captured thumbnail stays on the page; tapping it re-opens the viewer. Changing the size in the viewer re-captures the same URL at the chosen resolution.
### Authorization
The capture goes through `POST /api/tools/webpreview`, which honors the project's `webpreview` authorization gate. In **Allow** mode the capture runs straight through. In **Ask** mode the endpoint returns `409 EAUTH_REQUIRED`; because there is no chat transcript here, the page shows a hint ("approve it in the chat to capture") rather than mounting the chat's authorization card.
## Related
- [Web preview tool](./webpreview.md) — the `webpreview` tool the AI uses to refresh a capture.
- [File toolbar](./file-toolbar.md) — the chat-side "Preview" item.
