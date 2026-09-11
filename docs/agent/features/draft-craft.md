# Draft Craft — implementation notes

> Agent-facing reference for [`docs/features/draft-craft.md`](../../features/draft-craft.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Persistence

Draft Craft uses the existing chat REST API. It reads the latest chat before patching, so any draft text and image attachments already stored are retained:

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

Draft Craft never sends a message and never starts a model run. Image drafts keep the existing eight-image limit.

## Annotator reuse

The annotator is reusable across surfaces. When a callback is provided (composer replace-in-place) it hands the annotated image back directly instead of opening the chat-picker sheet; the Inspector path keeps the sheet. The composer keeps the original image data URL on the chip so **reset** can restore it, then strips that marker before the send, mention, or draft-persist path. Reset metadata stays client-only, and public attachment fields are allowlisted before draft storage or provider requests.

## Size limit

Annotated images are exported as PNG and downscaled when necessary to stay within the server's 12 MiB data-URL limit. An image that cannot be exported within that limit leaves the annotator open with an error rather than sending the message without the image.

## Marker list

Each dot gets one row in a vertically scrollable list (`.draft-craft__marker-list`, capped at `9rem`), so the tools panel height does not grow with the number of dots. A row is `[dot button | text input | remove button]`; the dot button selects the row for highlight and the input writes `marker.text` directly, replacing the old shared "text for the selected dot" row. Selecting a dot or dragging a new one onto the image scrolls its row into view (`markerListRef` / `activeMarkerRowRef`) so the last dot in a long list stays reachable.

## Loading behavior

Project and chat loading are tracked independently, so an overlapping response cannot leave the picker in a permanent loading state. Requests time out with a retryable error instead of showing an endless spinner.

## See also

- [`docs/features/draft-craft.md`](../../features/draft-craft.md) — the published guide.
- [`docs/features/inspector.md`](../../features/inspector.md) — the Inspector surface that hosts the image annotator.
