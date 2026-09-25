# Message copy — implementation notes

> Agent-facing reference for [`docs/features/message-copy.md`](../../features/message-copy.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- **Where the button is built** — `buildCopyButton()` in [frontend/src/components/chat/transcript.js](../../../frontend/src/components/chat/transcript.js) returns the element; `appendMessageToTranscript()` mounts it in a `.chat-msg__actions` block appended after the bubble body for `user` and `assistant` rows only. Appending rather than floating keeps it off the text on a 360 px screen and matches the shape of the error card's action row.
- **The three glyphs** — `COPY_GLYPH_IDLE` / `COPY_GLYPH_COPIED` / `COPY_GLYPH_FAILED` in the same file are inline SVG drawn with `fill="none"` and `stroke="currentColor"`, so the CSS tint (`--muted` → `--success` / `--danger`) is the only color decision and the glyph follows the button's state classes. The state also travels on `aria-label` / `title`, because an icon alone says nothing to a screen reader.
- **Live turns** — a streaming assistant row writes into the row itself (`row._content`, `row._reasoning`), not into the placeholder message it was created from, so the button resolves its payload at click time through a closure rather than capturing a snapshot. A settled row simply returns its message object.
- **What a message copies** — `messageCopyText()` in [frontend/src/components/chat/utils.js](../../../frontend/src/components/chat/utils.js) is the single place that decides this, so the button and any future copy entry point cannot disagree.
- **Clipboard access** — the same module exports `copyText()`, which tries `navigator.clipboard.writeText()` and falls back to a hidden `textarea` + `document.execCommand('copy')` for embedded web views and non-secure origins. It returns a boolean rather than throwing, so the button can report a refusal in place. The helper mirrors the ones already used by `chat/GitModal.jsx` and `Inspector.jsx`.
- **Styling** — `.chat-msg__actions` / `.chat-msg__copy` (with the `is-copied` / `is-failed` states) live in [frontend/src/chat-transcript.css](../../../frontend/src/chat-transcript.css). The button takes the shared compact glyph box (`--tap-sm`, 32 px) with no border or label, and pairs it with `.tap-target` from [frontend/src/base.css](../../../frontend/src/base.css) so the *hit* area still reaches the 44 px touch floor without painting a 44 px square. It inherits the row's alignment, so it sits under the right edge of a user bubble and the left edge of an assistant bubble.
- **Covered by** `scripts/test-message-copy.js` (wired into `npm run test:chat-view`): it asserts what each message shape copies, that the button is icon-only with a `currentColor` glyph and a `.tap-target` hit area, that the glyph flips on success, and that user/assistant rows mount the button while error cards mount only Retry.

## Layout and tap target

> Moved from the public page, which carried it as an "Implementation notes" section.

- **Compact painted box, legal tap area.** The glyph is the whole button, so the painted box is the smallest glyph-control size, `--tap-xs` (26px in [frontend/src/base.css](../../../frontend/src/base.css)) — smaller than the `--tap-sm` send / MCP toggles because it repeats under every bubble. `.tap-target` expands the hit area to the `--tap` floor (44px) without painting it, so the mobile-first tap rule still holds.
- **State lives in the glyph.** The three SVGs are `COPY_GLYPH_IDLE` / `_COPIED` / `_FAILED`, drawn in `currentColor`; the CSS tint (muted → success / danger) is the only color decision. The glyph and the `aria-label` / `title` flip together, so the state is never carried by color alone.
