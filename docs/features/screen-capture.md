# Chat screen capture

## Overview

Capture a screen as selected PNG images instead of uploading a video. A send-style capture button lives **outside the chat textbox** and opens a mobile-first capture and review sheet. Nothing is attached or sent until you confirm your selection.

## Usage

1. Tap **Capture screen images** beside the chat textbox.
2. Choose **Share screen**, then pick a tab, window or screen in the browser's permission dialog. Alternatively, **Import screenshots** in chronological order; this also works on phones whose browsers do not support screen sharing.
3. Choose **Changed area only** (the default) or **Full image**, then tap **Capture now**. Optionally enable **Capture automatically** at a 2, 3, 5 or 10 second interval. No video or audio is recorded.
4. The first image is a full baseline. Later changed-area captures contain the smallest rectangular area covering meaningful changes from the previous captured image. Unchanged captures are skipped. A source-size change produces a new full image.
5. Under **Ignore zones**, use **Ignore top 5% (status bar)** or tap **Draw ignored zone** and drag a rectangle across the full-image preview. Remove zones individually if needed. Up to eight zones apply to the entire review tray, including captures already taken.
6. Review the image cards: check only the images you want and choose **Full image** or **Changed area only** individually. An unchanged image cannot be selected in changed-area mode; switch it to Full image if you want it included.
7. Tap **Attach images**. The sheet stops sharing and saves only your confirmed images to the chat draft. Add a caption, annotate an attachment using the existing image editor, and press **Send** in chat when ready.

**Stop sharing** ends capture without discarding the review tray. **Clear tray** removes its captures and resets the baseline, but preserves ignored zones. Closing the sheet discards its unconfirmed images and stops sharing. A tray holds eight images; the chat draft also has an eight-attachment limit, including existing attachments.

### Disable the button

Open **Settings → App defaults → Chat defaults** and turn off **Screen capture button in chat**. This app-wide preference hides the button; it does not change ordinary image attachments or pasted screenshots. The capture button is disabled when the draft already contains eight images.

### Browser support and privacy

Live sharing uses the browser's `getDisplayMedia` permission dialog and needs a secure context (HTTPS or localhost). Many mobile browsers do not implement it: use imported screenshots there. An HTTP page on a phone connected over a LAN may also lack live-sharing support.

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
