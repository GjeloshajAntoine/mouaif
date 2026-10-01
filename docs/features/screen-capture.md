# Chat screen capture

## Overview

Capture a screen as selected PNG images instead of uploading a video. A send-style capture button lives **outside the chat textbox** and opens a mobile-first capture and review sheet. Nothing is attached or sent until you confirm your selection.

## Usage

1. Enable **Screen capture button in chat** under **Settings → App defaults → Chat defaults** (hidden by default), then tap **Capture screen images** beside the chat textbox.
2. Choose **Share screen**, then pick a tab, window or screen in the browser's permission dialog. Alternatively, **Import screenshots** in chronological order or **Import video** from your saved screen recordings; both work without screen sharing.
3. Choose **Changed area only** (the default) or **Full image**, then tap **Capture now**. Optionally enable **Capture automatically** at a 2, 3, 5 or 10 second interval. No video or audio is recorded.
4. The first image is a full baseline. Later changed-area captures contain the smallest rectangular area covering meaningful changes from the previous captured image. Unchanged captures are skipped. A source-size change produces a new full image.
5. Under **Ignore zones**, use **Ignore top 5% (status bar)** or tap **Draw ignored zone** and drag a rectangle across the full-image preview. Remove zones individually if needed. Up to eight zones apply to the entire review tray, including captures already taken.
6. Review the image cards: check only the images you want and choose **Full image** or **Changed area only** individually. An unchanged image cannot be selected in changed-area mode; switch it to Full image if you want it included.
7. Tap **Attach images**. The sheet stops sharing and saves only your confirmed images to the chat draft. Add a caption, annotate an attachment using the existing image editor, and press **Send** in chat when ready.

**Stop sharing** ends capture without discarding the review tray. **Clear tray** removes its captures and resets the baseline, but preserves ignored zones. Closing the sheet discards its unconfirmed images and stops sharing. A tray holds eight images; the chat draft also has an eight-attachment limit, including existing attachments.

### Import a screen-recording video

1. Tap **Import video** and select a saved video, such as a phone screen recording. The browser decodes it locally; supported codecs depend on your browser (MP4/H.264 is a good starting point, with MOV/M4V/WebM supported where the browser can decode them).
2. Use the preview's video timeline to choose a moment, then tap **Capture this frame** for one still image.
3. Or choose an interval in **Capture images**, then tap **Extract every 3s** (the label follows your interval). It samples from the selected moment forward, up to the remaining review-tray slots. It does not scan the entire recording: for later content, scrub further and extract again after clearing or attaching the current tray.
4. Use the same full/changed-area mode, ignored zones, and image selection as other captures. Cards show the video's timestamp instead of the capture's wall-clock time. Small or unchanged differences are skipped in changed-area mode.
5. **Stop extracting** cancels extraction while preserving the frames already extracted. **Remove video** releases the source video but keeps its extracted images. Closing the sheet releases the video too.

Only confirmed PNG images are attached. The original video and its audio are **never uploaded or sent to the AI**. Sharing and video import are mutually exclusive sources: remove the imported video to enable Share screen again. If a video cannot be decoded, an error explains how to retry with another format.

### Disable the button

The button is hidden by default. Open **Settings → App defaults → Chat defaults** and turn on **Screen capture button in chat** to show it, or turn it off to hide it again. Explicit saved choices are preserved. This app-wide preference hides the button; it does not change ordinary image attachments or pasted screenshots. The capture button is disabled when the draft already contains eight images.

### Browser support and privacy

Live sharing uses the browser's `getDisplayMedia` permission dialog and needs a secure context (HTTPS or localhost). Many mobile browsers do not implement it: use imported screenshots or video there. An HTTP page on a phone connected over a LAN may also lack live-sharing support.

Raw frames stay in browser memory only while the sheet is open. Ignored zones both suppress change detection **and are blacked out in exported full and cropped images**. They are not merely comparison exclusions. Capture does not upload continuously, record video, or acquire audio. Only selected, masked images are saved to the existing chat draft attachment endpoint on confirmation; the provider receives them on the usual chat Send.

## Design

- **Composer:** a circular primary-colour screen glyph matches Send, with an independent 44 × 44 touch target outside the textbox. The textbox, Send and Stop behaviour remain unchanged.
- **Sheet:** a rounded bottom sheet at phone widths, a centred sheet with more room on desktop. A fixed header/close control and safe-area-aware attachment footer surround one scrolling column.
- **Flow:** four numbered cards: source, capture mode, ignored zones, review. Unsupported sharing, cancelled permission, empty gallery, no-change capture, full tray and save failures have explicit messages.
- **Review:** selected cards have an accent border, checkbox, timestamp, output selector and crop coordinates. Full-frame previews are used for zone drawing even when an output is cropped.
- **Accessibility:** named dialog, shared Escape/focus trap/restore, labelled inputs, tap-sized controls and live status/error messages. Automatic capture pauses during zone drawing. Navigation/close and the browser's Stop sharing release the stream.

## Image quality and comparison

Images are scaled to at most 1280 pixels on their longest edge. Small colour fluctuations are ignored to reduce noise. Changed areas use a bounding rectangle, not transparent pixel deltas: unchanged pixels inside that rectangle remain visible for context, except masked zones. Several distant changes can therefore produce a large crop.

The first frame can be deselected if you only want later difference images; sending a baseline is often useful for context. Cropped filenames include their origin and dimensions, for example `screen-2-changes-x20-y40-300x200.png`.
