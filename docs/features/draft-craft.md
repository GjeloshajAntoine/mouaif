# Draft Craft

## Overview

Draft Craft adds material to any existing chat draft without sending it immediately. It supports annotated Inspector images and code selected in the project file editor.

## Usage

### Annotated Inspector image

1. Open **Inspector** and connect to a browser tab.
2. In the **Preview** panel, tap **Draft Craft**.
3. Pinch with two fingers to zoom from 100% to 400%, or use the **−** and **+** controls. Switch between **Pan** and **Draw**, annotate the image, and optionally add a note.
4. Tap **Add to chat draft**, then choose a project and pick a chat from the project-style chat list.

The pinch midpoint stays under your fingers while zooming. In **Pan** mode, drag the image to move around the zoomed screenshot. The annotated image is appended to that chat’s pending image attachments. The page title, URL, and optional note are appended to the text draft.

### Selected file code

1. Open a chat’s file toolbar and choose **Files**.
2. Open a text file and select code in the editor.
3. Tap **Draft Craft** at the top of the Files modal.
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
