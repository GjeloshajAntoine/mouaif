# Full-screen images in the chat

## Overview

Every picture that appears in a chat opens full screen when tapped. A phone bubble is far too small to read a screenshot, diagram, chart, or photo, so an inline thumbnail is never the end of the story — the whole image is one tap away, in the same viewer regardless of where the picture came from.

## Usage

Tap a picture to open it. Tap outside it, tap the **✕** button, or press `Escape` to close. The viewer shows one image at a time: opening another replaces the first.

Images that are tappable in the chat view:

| Surface | Where it comes from |
| --- | --- |
| A user turn's attached images | The composer's image button, paste, or drag-in |
| A picture in an assistant reply | A markdown image (`![alt](url)`) the model wrote |
| A picture in the "Thinking" block | Markdown in that reasoning body |
| A tool-card thumbnail | `read_file` on a picture, or an MCP image result |
| The web preview dock | The `webpreview` tool's latest capture |

The viewer sits at the document root and is removed when the chat view unmounts, so a viewer left open cannot park a full-screen cover over the next screen.

## Related

- [Opening images with `read_file`](read-file-images.md).
- [Chat](chat-ui.md).
- [Web preview](webpreview.md).
