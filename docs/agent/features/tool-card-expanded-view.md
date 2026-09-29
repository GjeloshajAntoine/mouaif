# Tool card expanded view — implementation notes

> Agent-facing reference for [`docs/features/tool-card-expanded-view.md`](../../features/tool-card-expanded-view.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

The render path is plain DOM (no Preact), so the SSE hot path stays as cheap as a `textContent` assignment:

- `frontend/src/components/chat/toolRender.js` — one renderer per tool, dispatched by `renderToolResultBody`, which passes the call's `args` to every renderer that can use them (`renderShellToolResult`, `renderWriteFileToolResult`, `renderSearchFilesToolResult`, `renderWebpreviewToolResult`, `renderGenericToolResult`).
- `frontend/src/components/chat/tools.js` — `formatToolArgs` (one line, for the head) and `formatToolArgsFull` (the complete call, for the expanded card), sharing `TOOL_ARGS_PREVIEW_CHARS` = 220. Both halves of the truncation rule read the same constant, so the head can never ellipsize at one budget while the body decides to render at another.
- `frontend/src/components/chat/transcript.js` — card construction, the head's tap handler, and the lazy body. The call's arguments are stashed on the card (`card._toolArgs`) because a `tool_result` frame carries only the result; a card rebuilt from persisted data recovers them from the persisted call row.
- `frontend/src/tool-cards.css` — `.tool-preview__args` (the full-arguments block) and `.tool-preview__pre--args`.

### The call is shown for every tool, not just shell

`buildToolArgs(args, name)` renders the complete call: what the model actually ran or asked for. It is **not** conditional on the collapsed head having been truncated, because the two are not comparable — the head truncates the ARGUMENT TEXT at `TOOL_ARGS_PREVIEW_CHARS` (220) while CSS also clips it to the row width (`flex: 1 1 auto` + `overflow: hidden` + `text-overflow: ellipsis`), which on a 390 px screen lands around 30–50 characters. A length test therefore concluded "the head already showed it" for a 50-character command that rendered as `cd /home/ubuntu/mouaif && git diff --ca…`; in the reference chat all 92 shell heads were visually clipped and 52 of them took that path.

It is **not** shell-specific either: `renderShellToolResult` was the only caller, so an MCP card showed the result and never what was asked, and a `search_files` card never showed the scope it ran against (the scope is an argument; the result carries only the query). Every renderer that has arguments to show now calls it, and the block is placed above the result on every card so each reads "what ran, then what came back". An empty `{}` / `[]` argument object renders no block (`buildToolArgs` rejects a string that trims to those).

### Where the arguments come from

A `tool_result` row carries only the result, so the call's arguments are recovered by `toolCallArgsFor`, which reads a `toolCallId -> args` map built from `state.messages` (indexed — see [chat-load-performance.md](./chat-load-performance.md)). That lookup must run for **every** tool whose preview renders the call, and the recovered args must reach the **head** as well as the body.

`appendToolResultCard` used to format `headArgs` only for subagent / shell / a `cmd` field, so a card built from its result row alone (the tail-first chunked render, a pagination page, a reconcile that had lost the stashed `card._toolArgs`) rendered `Read | ok` — no path, no range — while the same call built from its call row rendered `Read | src/a.js lines 1-50 | ok`. The head now formats the recovered args for every type, and the call→result rebuild prefers the recovered args over the old head's clipped text. `scripts/test-tool-card-expanded-consistency.js` renders each type both ways and asserts the head and body are byte-identical.

### Rows wrap, they do not clip

`.tool-preview__file`, `.tool-preview__match` and `.tool-preview__match-text` used `white-space: nowrap` + `overflow: hidden` + `text-overflow: ellipsis`. The expanded card is the only place a result is readable, so a clipped row there meant the content was nowhere at all. They now use `overflow-wrap: anywhere` and let the content wrap inside the grouped box.

Mobile-first notes: the arguments block is a `<pre>` with `pre-wrap` so a long command wraps instead of forcing a horizontal scroll on a 360 px screen; its cap is expressed in `dvh` so it tracks the browser chrome; and the whole header row is the tap target, well over the 44 px minimum.

Colour and divider rule: the command block must not be styled as a separate surface. `.tool-preview__pre--args` mirrors the output's background, text colour and font size, and takes NO border of its own. When a shell command block is present the renderer adds `.tool-preview--with-args` to the body, and CSS drops the output pre's own border too — otherwise the output's top edge sits directly under the command text and reads as a horizontal divider between the two sections. The sections are separated by a 6 px margin, nothing else. The class tracks the presence of a `shell` command block specifically (it is what makes one terminal out of a command and its output); the block itself is rendered for every tool type.

One-surface rule: the card body itself (`renderToolResultBody`'s `body` element — it sets `body.className = 'tool-card__body'` and then appends the `tool-preview` classes to that *same* element, so both coexist) carries the box via `.tool-card__body.tool-preview--terminal.tool-preview--with-args`: `background: var(--bg)`, a 1 px `--border`, the `--r-sm` radius and the padding. Both `.tool-preview__pre--args` and `.tool-preview__terminal` are `background: transparent; border: 0; border-radius: 0; padding: 0` inside it. An earlier revision instead *removed* the output's surface when a command was present and put nothing in its place, so the body rendered in `--bg` over a `--bg` page with no border: legible text, but no card.

The selector must name `.tool-card__body` and match the specificity of `.tool-card.is-expanded .tool-card__body` (0,3,0), which already paints that element `background: transparent; border: 0`. A surface declared as `.tool-preview--terminal.tool-preview--with-args` alone (0,2,0) is *present but inert* — it loses the cascade, and the card renders unboxed with no visible error anywhere. `scripts/test-shell-card-command.js` compares the two selectors' specificity for exactly this reason: checking that the rule exists is not enough.

The container is also the only order-independent place for the surface — `renderShellToolResult` appends the command either immediately before the output (success) or separated from it by the status meta row (error), so anchoring the border to a child would make one card look like two.

Covered by `scripts/test-shell-card-command.js`, which pins the shell command, its line breaks, its position above the output, the flat-body flag, the error path, the no-arguments case, the one-surface CSS rule *and its specificity*, and — driving the real `renderMessageRow` through both render orders — that a command survives being built from either side of the call/result pair.

Covered for **every** tool type by `scripts/test-tool-card-expanded-consistency.js`: it renders one case per renderer family (`shell`, `read_file`, `search_files`, `webpreview`, an MCP tool, a custom action) through both render orders, asserts the head and body are byte-identical either way, that each head and each body carries the call, that an empty `{}` adds no block, and that the list/search rows no longer declare `nowrap` / `ellipsis`. Restoring any of the three defects fails it (20 assertions on the pre-change tree).
