# Web preview tool (`webpreview`) — implementation notes

> Agent-facing reference for [`docs/features/webpreview.md`](../../features/webpreview.md).

## Implementation notes

- Server runner: [`src/tools/webpreview.js`](../../../src/tools/webpreview.js) opens a fresh debug-Chrome target for every call, captures one JPEG, and closes the target. Repeating a call is the reload mechanism.
- AI wiring: [`src/ai-stream.js`](../../../src/ai-stream.js) advertises and dispatches the tool. It emits the rich screenshot result to the frontend but suppresses `webpreview` image parts from the follow-up model conversation.
- State bridge: [`frontend/src/components/chat/webpreviewState.js`](../../../frontend/src/components/chat/webpreviewState.js) keeps the latest capture and notifies the mounted chat view.
- Dock: [`frontend/src/components/chat/WebpreviewDock.jsx`](../../../frontend/src/components/chat/WebpreviewDock.jsx) renders the compact user-only image between the transcript and composer. The card is `width: min(26%, 6.5rem)` right-aligned, and because it is a flex item in the chat column its height comes out of the transcript — so the image is height-capped (`max-height: min(24dvh, 11rem)` with `object-fit: cover; object-position: top` in [`frontend/src/chat-composer.css`](../../../frontend/src/chat-composer.css)); a 375 × 812 capture is 94 × 176 on a 360 px-wide phone instead of ~200 px tall. Cap the **image**, not the card: a `max-height` on the card leaves the image overflowing it, because a percentage height cannot resolve against an auto-height parent. The dismiss button is the 22 px circle on the card's top-right border (visual size; it has no expanded hit area, and a 44 px one would cover the card's own tap-to-open region — see `docs/agent/features/modal-sheets.md` for the `.tap-target` helper and when it is unsafe).
- Viewer: [`frontend/src/components/chat/WebpreviewModal.jsx`](../../../frontend/src/components/chat/WebpreviewModal.jsx) opens only after a user taps the dock and shows the complete image.
- Transcript: [`frontend/src/components/chat/transcript.js`](../../../frontend/src/components/chat/transcript.js) publishes successful results immediately because result bodies are lazy. The normal tool card remains collapsed and does not contain the image.
- Styling: [`frontend/src/chat-composer.css`](../../../frontend/src/chat-composer.css) contains both dock and full-viewer styles.
