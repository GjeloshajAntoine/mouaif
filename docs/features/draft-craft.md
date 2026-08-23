# Draft Craft

## Overview

Draft Craft adds material to any existing chat draft without sending it immediately. It supports annotated Inspector images and code selected in the project file editor.

## Usage

### Annotated Inspector image

1. Open **Inspector** and connect to a browser tab.
2. In the **Preview** panel, tap **Draft Craft**.
3. Draw on the captured page image and optionally add a note.
4. Tap **Add to chat draft**, then choose a project and chat.

The annotated image is appended to that chat’s pending image attachments. The page title, URL, and optional note are appended to the text draft.

### Selected file code

1. Open a chat’s file toolbar and choose **Files**.
2. Open a text file and select code in the editor.
3. Tap **Draft Craft**.
4. Choose a project and chat, then tap **Add to draft**.

Draft Craft includes the source path and selected line range with the code. Existing draft text is preserved and the selection is appended.

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
