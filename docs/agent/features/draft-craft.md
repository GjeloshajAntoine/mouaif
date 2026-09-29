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

## Zoom

The canvas frame is sized by the room left over, never by the stage it holds. The stage is the image at `zoom × 100%` of the frame's width, and it lives inside the frame's own scroller, so a zoomed-in screenshot must not change the frame's height. It used to: the frame was `flex: 1 1 auto` with `min-height: 0`, which made the stage's height part of the frame's flex base. Zooming in then grew the frame and shrank the tools panel below it — measured at 393 × 852 as 309 → 174 → 121 px while only the zoom changed — and at the next step the stage's flex base collapsed to zero, leaving the frame at `min-height: 0`: the screenshot disappeared. The frame is now `flex: 1 1 0` (base size zero, so its size comes from the leftover space) and the tools panel is `flex: 0 0 auto` (it keeps its own height, capped by `max-height: 52dvh` with its body scrolling inside it). Folding the tools bar still hands the freed space to the frame, and the resize observer re-fits the image there when the user has not zoomed in past the fit level.

The fit level is what `fitZoomFor(wrap, canvas)` measures: `min(1, frameHeight / (frameWidth × h/w))`. It returns **null** while either box is unmeasurable — the annotator opens inside an animated overlay, so the first read can legitimately be 0×0. That null used to fall through to the `MIN_ZOOM` (0.1) safety floor, so a fit taken before layout clamped the image to a 10% thumbnail, and the **Fit** button's gate (which compared 0.1 with 0.1) disabled the only one-tap way back. `fit()` now returns without touching the zoom when the level is not measurable, the resize observer takes that first real measurement, `minZoomFor()` gives the zoom floor as the fit level once it exists and the safety floor while it does not, and the **Fit** gate only disables when a real level has been reached. The **−** gate carries a half-step tolerance so a horizontal scrollbar changing the frame's client width cannot leave it enabled-but-dead.

A zoom also has to hold the point under the finger. The stage is centred by `margin: auto` while it is narrower than the frame, so the image's offset inside the frame grows and shrinks with the zoom. Adjusting the scroll alone ignored that centring lead and moved the image under the finger by the change in it. `applyZoom` now reads the frame fraction before the zoom and, on the next frame (when the zoomed stage has re-laid out and the frame's client and scroll boxes have settled), writes `anchor - lead - fraction × content`, clamped to the frame's real scroll range, through `zoomTargetScroll()`. A point that is already at the image's top/bottom edge keeps the scroll at that edge after zooming; a frame wider/taller than the image never scrolls at all.

`scripts/test-inspector-annotator-zoom.js` (in `npm run test:inspector`) pins the helpers — the null fit level, `minZoomFor`, `centredLead`, `zoomTargetScroll` and its clamps — the wiring gates, and the two CSS flex declarations.

## See also

- [`docs/features/draft-craft.md`](../../features/draft-craft.md) — the published guide.
- [`docs/features/inspector.md`](../../features/inspector.md) — the Inspector surface that hosts the image annotator.

## Screenshots

The six PNGs on the guide are produced by `npm run docs:shots:draft-craft` ([scripts/capture-draft-craft-shots.js](../../../scripts/capture-draft-craft-shots.js)), not by hand. The script reuses the landing-page harness's plumbing ([scripts/lib/capture-fixture.js](../../../scripts/lib/capture-fixture.js)) and the landing fixture's providers, models and seeded run, then shoots at 360 × 780 CSS px. Each frame is driven by a `recipe`: tapping `.chat-view__image-chipimg`, dragging `.draft-craft__marker-source` onto `.draft-craft__canvas-stage` and typing into `.draft-craft__marker-input`, tapping `.inspector__panel-draft-craft`, and — for the file-editor frame — opening `.file-toolbar__trigger` → **Files**, opening `src/store.js`, and selecting lines 7–9 in the CodeMirror `.cm-content`.

The marker text has to be set on a later tick than the dot's drop: the row is rendered only after Preact commits the new `markers` entry, so a same-tick write lands on a field that does not exist yet. `placeMarker()` therefore waits 250 ms and writes through the native `HTMLInputElement` value setter before dispatching `input`.

The attached image in the composer paths is a real capture of the Chats tab, taken first through the same CDP session and seeded into the empty chat's `draftAttachments`, so the annotation sits over the running app instead of a mock.

