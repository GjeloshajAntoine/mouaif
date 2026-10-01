# Chat screen capture — implementation notes

## Overview

Agent-facing reference for [Chat screen capture](../../features/screen-capture.md). Capture processing runs locally; confirmed images reuse the existing draft-attachment write and chat send flow.

## Usage

Run the processing, composer preference and browser fixture tests:

```bash
node scripts/test-screen-capture.mjs
node scripts/test-video-capture.mjs
node scripts/test-screen-capture-ui.mjs
node scripts/test-composer-tools.mjs
npm run build:web
```

The browser regression requires Chrome. `node scripts/test-screen-capture-ui.mjs --serve` opens a ten-minute, isolated fixture for manual design inspection without touching real chats.

## Implementation notes

`frontend/src/components/chat/ScreenCapturePanel.jsx` is loaded on demand by `Chat.jsx`. `screenCapture.js` contains normalized-zone, difference-bounds, scaling, masking and PNG export helpers. `frontend/src/screen-capture.css` owns the responsive sheet. `FileToolbar.jsx` always renders the Screen capture menu item, closes its menu on selection and calls `Chat.jsx` through `onOpenScreenCapture`.

Frames are scaled to at most 1280 pixels on their longest edge before comparison and retained in a bounded eight-frame tray. RGB changes of 24/255 or less are ignored to reduce minor colour noise. Changed areas use a bounding rectangle, not transparent pixel deltas: unchanged pixels inside that rectangle remain visible for context, except masked zones. Resized captures establish a new full baseline. Retained raw canvases never become public attachments; masks are applied before cropping and encoding. The full preview and selected outputs regenerate when zones change.

Cropped filenames include their origin and dimensions, for example `screen-2-changes-x20-y40-300x200.png`. Existing bounded PNG export and public attachment allowlists are reused. No new REST endpoint or dependency is needed. There is no visibility preference: the retired `screenCaptureButton` key is removed from defaults, frontend readers and the client allowlist. Existing stored values are not deleted but no longer affect the always-enabled menu item. The sheet can open with zero remaining attachment slots; its confirmation button enforces the limit.

`videoCapture.js` adds local media loading, abortable seek waits, bounded interval sampling and source release. Imported files use object URLs rather than data URLs; browser decoding is the only codec dependency. Load/seek waits have a 15-second timeout and clean up their listeners on success, error or abort. Videos are muted, pause before capture, and sampling visits at most eight candidate times rather than scanning a long recording. Only PNG exports are passed to `onAttach`; no new backend route or video upload is involved. Remove, replace, decode failure and unmount revoke object URLs and unload the retained media element.

The 2.6KB `scripts/fixtures/screen-capture-video.mp4` is a generated 200×400 H.264 test recording: white baseline, red status bar after 2 seconds, blue 20×30 rectangle at (40,80) after 4 seconds, seven seconds total. Browser tests pin actual MP4 decoding, timeline extraction, interval diffs, ignored zones, codec failure/retry and resource cleanup at phone widths.

The shared modal hook supplies Escape, focus trapping and restoration. Stream tracks, source objects and interval timers are released on stop/unmount; late permission responses stop their tracks immediately. Automatic capture pauses during zone drawing. Only confirmed, masked PNGs are persisted, and a failed draft save leaves review open for retry. Navigation must not apply a late save to the new chat.
