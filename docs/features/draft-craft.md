# Draft Craft

## Overview

Draft Craft adds material to any existing chat draft without sending it immediately. It supports annotated Inspector images, images attached to the chat composer, and code selected in the project file editor.

## Usage

### Annotated Inspector image

1. Open **Inspector** and connect to a browser tab.
2. In the **Preview** panel, tap **Draft Craft**.
3. Pinch with two fingers to zoom from 100% to 400%, or use the **−** and **+** controls. Switch between **Pan** and **Draw** to make freehand marks.
4. In **Marker dots**, choose sequential numbers or letters, then drag the next dot from the marker bar onto the image. Add text in the matching row below. Existing dots can be dragged to a new image position or removed.
5. Optionally add a general image note, then tap **Add to chat draft** and choose a project and chat.

The pinch midpoint stays under your fingers while zooming. In **Pan** mode, drag the image to move around the zoomed screenshot. Marker labels increase automatically up to 26 dots. The exported image contains each dot, while the text draft includes the corresponding numbered or lettered annotation list along with the page title, URL, and general note.

The **Add to chat draft** button is pinned in a footer below the scrollable tools panel, so it stays visible even after many marker rows push the marker list beyond the panel's scroll area.

### Annotated composer image

1. Attach one or more images to the chat composer (via the **add image** button, paste, or drag).
2. Tap an attached image chip to open the same Draft Craft annotator over that image.
3. Draw freehand marks, add numbered/lettered marker dots with text, and optionally add a note, exactly as in the Inspector flow.
4. Tap **Use annotated image** to replace that attachment in-place and write the annotation note into the composer. The annotated version is the one that gets sent.

The annotator keeps a **Reset** button in its footer (only when the image has already been annotated) so you can revert to the untouched original from inside the popup. A **remove** control on the chip still deletes the attachment. The reset marker is client-only: it is never sent to the server or a provider, and it is dropped when the chat draft is persisted.

### Selected file code

1. Open a chat’s file toolbar and choose **Files**.
2. Open a text file and select code in the editor.
3. Tap **Draft Craft** in the open file’s display bar, beside the file actions.
4. Choose a project and chat, then tap **Add to draft**.

Draft Craft appends only the file path with line range and the selected code. It adds no prose or Markdown fence around the selection. Existing draft text is preserved.

## Implementation notes

Draft Craft uses the existing chat REST API. It reads the latest chat before patching so existing draft text and image attachments are retained.

```http
GET /api/chats/:id?projectDir=/path/to/project
PATCH /api/chats/:id
Content-Type: application/json
{
"projectDir": "/path/to/project",
"draft": "existing draft\n\nselected code",
"draftAttachments": []
}
```

Image drafts keep the existing eight-image limit. Draft Craft does not send a message or start a model run.

The annotator is reusable across surfaces. When a callback is provided (composer replace-in-place) it hands the annotated image back directly instead of opening the chat-picker sheet; the Inspector path keeps the sheet. The composer keeps the original image data URL on the chip so **reset** can restore it, then strips that marker before the send, mention, or draft-persist path.

Project and chat loading are tracked independently so an overlapping response cannot leave the picker in a permanent loading state. Requests also time out with a retryable error instead of showing an endless spinner.
