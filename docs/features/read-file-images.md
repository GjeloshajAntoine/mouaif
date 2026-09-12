# Opening images with `read_file`

## Overview

`read_file` opens a picture instead of reading it as text. When the path ends in a picture extension, the tool attaches the file's pixels to the tool result as an image, so a vision model actually sees the screenshot, diagram, or photo — and the chat card paints the same picture back to the user. Text files keep their existing behavior; `.svg` stays on the text path because its markup is what a model can use.

## Usage

Ask the assistant to look at an image, or call the tool directly:

```text
read_file { "path": "docs/features/images/inspector-panel.png" }
```

Supported extensions: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.ico`. `.svg` is read as text (markup).

`startLine` / `endLine` do not apply to a picture and are ignored.

### Finding an image

`list_files` lists pictures alongside text files and marks them, so the model can find one without a shell round trip:

```text
# Listing: <all text and image files>
# Count: 2

# docs/features/images/
  inspector-panel.png (image)
  notes.md
```

### The model-facing result

An image read returns a three-line header — no base64 payload — plus the picture itself, which arrives as a separate vision message part right after the tool result:

```text
# File: docs/features/images/inspector-panel.png
# Kind: image (image/png, 184320 bytes)
# The picture is attached to this tool result as an image part.
```

### The chat card

The tool card shows the path, the MIME type, the size, and the picture. Tap the thumbnail to open it full screen; tap outside the picture, tap **✕**, or press `Escape` to close. A result that reached the UI as plain text (a replayed transcript row, a nested subagent result) has no bytes left, so the card says `Image bytes are not part of this result.` instead of painting an empty frame.

## Behavior

- **Caps.** An image larger than `fileReadMaxImageBytes` (default 4 MB) is refused with `ETOOL_CAP`. The model can downscale with the shell tool and read again. Set the knob at app level:

```json
{
  "fileReadMaxLines": 10000,
  "fileReadMaxImageBytes": 4194304
}
```

- **Vision or text model.** The picture is sent as an image part regardless of the model. A text-only model rejects image input, so the provider returns its own error; use a vision-capable model (the model picker's provider catalog notes which OpenRouter models accept image input).
- **Authorization is unchanged.** `read_file` is gated by the same **File tools** authorization mode (`off` / `ask` / `allowlist` / `allow`) as every other file tool. See [tool-authorization.md](./tool-authorization.md).
- **Path safety is unchanged.** Images are subject to the same project-root containment rules as text reads (`EOUTSIDE_PROJECT`).
- **Hidden content does not apply.** [hide-file-content](./hide-file-content.md) rules mark *lines*; a picture has none, so an image read is not redacted.
- **`search_files` is unchanged.** It still searches text only — a byte search over pictures would be noise.
- **Transcript size.** The pixels are persisted with the tool result (the same way an MCP image result is), so a 4 MB picture adds roughly 5.3 MB of base64 to that chat's transcript. Keep the cap low if a project holds large screenshots.

## Implementation notes

- `readImageFile` in [src/tools/files.js](../../src/tools/files.js) does the read. The extension list and the extension → MIME map come from `src/files.js` (`isImageExt`, `mimeForExt`), the same table the file editor previews with, so the two surfaces cannot disagree about what is a picture.
- The result carries `kind: 'image'`, `mimeType`, `bytes`, `note`, and a `content` array holding one `{ type: 'image', data, mimeType }` block. That block shape is the one MCP image results already use, so `toolResultImageParts` in [src/ai-stream.js](../../src/ai-stream.js) forwards it as a native vision part with no provider-specific code. `openAIContentToAnthropic` / `openAIContentToGeminiParts` in `src/ai-endpoints.js` convert the same block for Anthropic and Gemini.
- `compactToolFeedback` in [src/toolFeedback.js](../../src/toolFeedback.js) already replaces image payloads with `[image payload omitted; attached separately]` inside the reconstructed history, so the base64 is never paid for twice on the model side.
- The card lives in [frontend/src/components/chat/toolRender.js](../../frontend/src/components/chat/toolRender.js) (`renderReadFileToolResult` → `renderReadFileImage`, plus `openImageLightbox`). The lightbox is plain DOM so it works from the transcript's hot path; the thumbnail is wrapped in a button so the whole picture is a tap target (44 px minimum), and `.image-lightbox__close` sits inside the top safe area.
- Mobile-first: the thumbnail is capped at 220 px (`max-height` on `.tool-card__image`), the lightbox is `position: fixed; inset: 0` with `object-fit: contain` so a wide screenshot fits a 360 px viewport, and the card's caption is a `0.66rem` muted line rather than a second toolbar.
- Tests: `scripts/test-file-tools.js` covers the server side (block shape, byte fidelity, cap, `.svg` staying text, `list_files` flags, path safety) and `scripts/test-read-image-preview.js` covers the card (data URL, alt text, no base64 in text nodes, lightbox open/close paths, text-only fallback).

## Related

- Native file tools: [file-tools.md](./file-tools.md).
- Tool authorization: [tool-authorization.md](./tool-authorization.md).
- Hidden line ranges: [hide-file-content.md](./hide-file-content.md).
- MCP image results (the same content-block path): [mcp.md](./mcp.md).
- Image preview in the file editor: [files-modal-text-and-images.md](./files-modal-text-and-images.md).
