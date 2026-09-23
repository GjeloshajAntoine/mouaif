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

## Related

- Native file tools: [file-tools.md](./file-tools.md).
- Tool authorization: [tool-authorization.md](./tool-authorization.md).
- Hidden line ranges: [hide-file-content.md](./hide-file-content.md).
- MCP image results (the same content-block path): [mcp.md](./mcp.md).
- Image preview in the file editor: [files-modal-text-and-images.md](./files-modal-text-and-images.md).
