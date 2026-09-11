# Draft Craft

## Overview

Draft Craft adds material to any existing chat draft without sending it immediately. It supports annotated Inspector images, images attached to the chat composer, and code selected in the project file editor.

## Usage

### Annotated Inspector image
1. Open **Inspector** and connect to a browser tab.
2. In the **Preview** toolbar, tap the blue image-and-sparkle **Draft Craft** icon. It sits beside the other preview actions and never covers the screenshot.
3. Pinch with two fingers to zoom, or use the **−** and **+** controls. Switch between **Pan** and **Draw** to make freehand marks.
4. In **Marker dots**, choose sequential numbers or letters, then drag the next dot from the marker bar onto the image. Each dot appears as a short chip; tapping a chip selects it and a single text row edits that annotation in place. Existing dots can be dragged to a new image position — a dot that is dropped near (or off) the image edge snaps back onto the picture instead of being lost — or removed with the × button in the selected chip's edit row.
5. Optionally add a general image note, then tap **Add to chat draft** and choose a project and chat.

The image opens **fit-to-view**: the whole full-page screenshot is scaled to fit the canvas instead of showing only its top-left corner, so a tall page is fully visible from the start. A **Fit** button (and a **−** control) never zooms out past that fit level, so the whole image always stays in frame. When the image is smaller than the canvas it is centered in both axes; as you zoom in past the frame it pins to the top-left and becomes scrollable, so every part stays reachable by panning.

The pinch midpoint stays under your fingers while zooming. In **Pan** mode, drag the image to move around the zoomed screenshot. Marker labels increase automatically up to 26 dots. The exported image contains each dot, while the text draft includes the corresponding numbered or lettered annotation list along with the page title, URL, and general note.

The **Tools** strip is collapsible: tap **Tools** to fold the zoom / color / marker controls down to a slim bar so the screenshot gets the full canvas height. Collapsing or resizing the window re-fits the image to the newly available space when you have not zoomed in past the fit level. The **Marker dots** area uses a compact chip strip: each dot is a short chip that wraps across a couple of lines, and a single text row edits whichever chip is selected, so the tools panel stays short and the preview stays large no matter how many dots are placed. The chip strip caps at a small height and scrolls only when it overflows. The **Add to chat draft** button is pinned in a footer below the scrollable tools panel, so it stays visible even with many marker chips.

### Annotated composer image

1. Attach one or more images to the chat composer (via the **add image** button, paste, or drag).
2. Tap an attached image chip to open the same Draft Craft annotator over that image.
3. Draw freehand marks, add numbered/lettered marker dots with text, and optionally add a note, exactly as in the Inspector flow.
4. Tap **Use annotated image** to replace that attachment in-place and append the annotation note to the composer without replacing existing instructions. The text and annotated image are saved together immediately, and the annotated version is the one that gets sent.

The annotator keeps a **Reset** button in its footer (only when the image has already been annotated) so you can revert to the untouched original from inside the popup. Reset removes only that image's unchanged generated annotation block; user-written or edited text is preserved. A larger compact **remove** target on the chip still deletes the attachment.

Annotated images are exported as PNG and downscaled automatically when they are large. If an image cannot be exported, the annotator stays open and shows an error instead of silently sending without the image.

### Selected file code

1. Open a chat’s file toolbar and choose **Files**.
2. Open a text file and select code in the editor.
3. Tap **Draft Craft** in the open file’s display bar, beside the file actions.
4. Choose a project and chat, then tap **Add to draft**.

Draft Craft appends only the file path with line range and the selected code. It adds no prose or Markdown fence around the selection. Existing draft text is preserved.

## Good to know

- Adding to a draft never sends the message and never starts a model run — you review the draft and send it yourself.
- A draft holds up to eight images in total, counted together with any images you already attached.
- Draft text and attachments that are already in the composer are preserved; Draft Craft only appends to them.
- If the project or chat list cannot be loaded, the picker shows a retryable error instead of a spinner that never ends.
