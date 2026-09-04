# @-mention autocomplete in the chat composer — implementation notes

> Agent-facing reference for [`docs/features/at-mention.md`](../../features/at-mention.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Source: `frontend/src/components/chat/atMention.js` — standalone imperative module. Mounted and unmounted via `mountAtMention(textarea, popupEl, preactState, argBarEl)` which returns a cleanup function. The 4th argument is a `<div>` that receives parameter suggestion chips.
- `mountAtMention` accepts an optional 4th argument — the arg bar DOM node. When missing, no chips are shown.
- The server's `/api/tools/list` now includes `parameters` (JSON Schema `{ properties, required }`) for every tool. File tool parameters come from `SPECS`; MCP tool parameters come from `listComposedToolSpecs` via the MCP SDK.
- The popup `<div>` lives inside `.chat-view__composer` as its first child (before the buttons and textarea), positioned above the textarea with `position: absolute; bottom: 100%`.
- State is module-level (one instance). The `uiState` reference points to the Preact mutable state bag so `buildItems` can read project dir, tools catalog, and chat model without passing them on every keystroke.
- Files are fetched on mount and every 5 s via a `setInterval` in the `ChatView` mount effect. The scan endpoint is called once per project-dir change (cached in `scanCache`).
- The `@` detection walks backwards from the cursor to find `@` preceded by whitespace or start-of-string. The query ends at the cursor and cannot contain whitespace.
- The Actions category is populated only by `GET /api/actions`, and action rows show their user-facing label and description rather than the underlying CLI/MCP implementation. Native catalog entries use the Tools category, while entries with `kind: "mcp"` use the MCP category and include their server slug in the subtitle. All three remain searchable and selectable.
- `filterItems` applies a `REST_PER_CATEGORY` cap (4 items per section) only when the query is empty; any typed query searches the full item list with only the 200-file global cap. Its final stable partition runs through `prioritizeAtMentionFiles`, ensuring all files precede non-files while retaining the existing order within each group.
- **Direct invocation** happens in `stream.js` `send()` — the popup itself never invokes tools. It always inserts `@<name>` into the composer, and the typed-Enter path in `send()` decides whether to dispatch (shell/MCP at start-of-text with args) or send to the model.
- Argument parsing in `tools.js` (`parseToolArgs`): tries JSON first, then `key=value` pairs. Unparseable text returns `null`, causing the tool dispatch to skip and fall through to normal model send.
- **Arg bar:** When a tool with `parameters` is selected, `selectItem()` calls `renderArgBar(props, required, filled)` which creates a chip for each unfilled parameter. Required args are marked with `.is-required` (bold/accent border). `appendArg(key, prop)` appends ` key=\`\`` for string types or ` key= ` for booleans/numbers, then updates the bar to remove the filled chip. The bar is cleared when a non-tool item (file, model) is selected or the popup is remounted.
- Mobile-first: the popup is full-width inside the composer, capped at 240 px height with scroll, uses system font stacks, and gives category and result controls 44 px tap targets. The compact arg chips wrap to a second row on narrow screens.
