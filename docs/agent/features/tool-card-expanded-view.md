# Tool card expanded view — implementation notes

> Agent-facing reference for [`docs/features/tool-card-expanded-view.md`](../../features/tool-card-expanded-view.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

The render path is plain DOM (no Preact), so the SSE hot path stays as cheap as a `textContent` assignment:

- `frontend/src/components/chat/toolRender.js` — one renderer per tool, dispatched by `renderToolResultBody`.
- `frontend/src/components/chat/tools.js` — `formatToolArgs` (one line, for the head) and `formatToolArgsFull` (the complete call, for the expanded card), sharing `TOOL_ARGS_PREVIEW_CHARS` = 220. Both halves of the truncation rule read the same constant, so the head can never ellipsize at one budget while the body decides to render at another.
- `frontend/src/components/chat/transcript.js` — card construction, the head's tap handler, and the lazy body. The call's arguments are stashed on the card (`card._toolArgs`) because a `tool_result` frame carries only the result; a card rebuilt from persisted data recovers them from the persisted call row.
- `frontend/src/tool-cards.css` — `.tool-preview__args` (the full-arguments block) and `.tool-preview__pre--args` (its scroll cap).

`buildToolArgs(args, name)` returns `null` when the head already showed the arguments in full. It compares against the same head format rather than a length heuristic, which is why a 20-character command adds nothing to the expanded card while a 1900-character one adds everything.

Where the arguments come from: a `tool_result` row carries only the result, so the call's arguments are recovered by `toolCallArgsFor`, which scans `state.messages` for the matching `call` row. That lookup must run for **every** tool whose preview renders the call payload on the result side — `write_file` (the written content) and `shell` (the command). It used to be gated to `write_file`, which made the command appear only sometimes: a card built from its result row (the chunked latest-first render, a pagination page, a reconcile that had lost the stashed `card._toolArgs`) had nothing to render, while a card built from its call row did. The de-dup guard then skipped the late call row, so the arguments never arrived either. Same chat, same data — different result purely from which row the render reached first.

Mobile-first notes: the arguments block is a `<pre>` with `pre-wrap` so a long command wraps instead of forcing a horizontal scroll on a 360 px screen; its cap is expressed in `dvh` so it tracks the browser chrome; and the whole header row is the tap target, well over the 44 px minimum.

Colour and divider rule: the command block must not be styled as a separate surface. `.tool-preview__pre--args` mirrors the output's background, text colour and font size, and takes NO border of its own. When a command block is present the renderer adds `.tool-preview--with-args` to the body, and CSS drops the output pre's own border too — otherwise the output's top edge sits directly under the command text and reads as a horizontal divider between the two sections. The sections are separated by a 6 px margin, nothing else. The class is added only when the command block actually exists, so a shell card that shows output alone (a short command the head already showed in full) keeps its box.

One-surface rule: the card body itself (`renderToolResultBody`'s `body` element — it sets `body.className = 'tool-card__body'` and then appends the `tool-preview` classes to that *same* element, so both coexist) carries the box via `.tool-card__body.tool-preview--terminal.tool-preview--with-args`: `background: var(--bg)`, a 1 px `--border`, the `--r-sm` radius and the padding. Both `.tool-preview__pre--args` and `.tool-preview__terminal` are `background: transparent; border: 0; border-radius: 0; padding: 0` inside it. An earlier revision instead *removed* the output's surface when a command was present and put nothing in its place, so the body rendered in `--bg` over a `--bg` page with no border: legible text, but no card.

The selector must name `.tool-card__body` and match the specificity of `.tool-card.is-expanded .tool-card__body` (0,3,0), which already paints that element `background: transparent; border: 0`. A surface declared as `.tool-preview--terminal.tool-preview--with-args` alone (0,2,0) is *present but inert* — it loses the cascade, and the card renders unboxed with no visible error anywhere. `scripts/test-shell-card-command.js` compares the two selectors' specificity for exactly this reason: checking that the rule exists is not enough.

The container is also the only order-independent place for the surface — `renderShellToolResult` appends the command either immediately before the output (success) or separated from it by the status meta row (error), so anchoring the border to a child would make one card look like two.

Covered by `scripts/test-shell-card-command.js`, which pins the full command, its line breaks, its position above the output, the non-duplication of a short command, the flat-body flag, the error path, the no-arguments case, the one-surface CSS rule *and its specificity*, and — driving the real `renderMessageRow` through both render orders — that a command survives being built from either side of the call/result pair.
