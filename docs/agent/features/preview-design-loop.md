# Preview design loop — implementation notes

> Agent-facing reference for [`docs/features/preview-design-loop.md`](../../features/preview-design-loop.md).

## Implementation notes

- `frontend/src/components/chat/webpreviewState.js` keeps the last 6 screenshot captures in memory (`getHistory(url)`), cleared with the active preview when the chat changes. It also has a reload signal (`requestReload` / `subscribeReload`) that the dock and the viewer use to re-key their Live iframes.
- `Chat.jsx` watches `runningVisible`. When it goes from true to false and Auto is on, a Live payload calls `requestReload()`, and a screenshot is captured again through `POST /api/tools/webpreview` (`silentRecapture`). The automatic capture never shows an authorization card: in Ask mode, or on any error, the current capture stays. It is only published if the dock still shows the same URL.
- `PreviewPromptBar.jsx` puts the text into the composer and calls the composer's normal send, so `/commands`, drafts and the transcript behave the same as typing in the chat. Any text already in the composer is replaced.
- `PreviewCompare.jsx` stacks the two images and clips the "before" image with `clip-path: inset()`. The divider is a native range input, so touch, mouse and keyboard all work.
- No new endpoints.

