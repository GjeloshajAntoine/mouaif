# Markdown renderer — implementation notes

> Agent-facing reference for [`docs/features/markdown-renderer.md`](../../features/markdown-renderer.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Rendering pipeline

1. **Code blocks** are extracted first (fenced with ``` or ~~~). Text before, between, and after them is treated as paragraph blocks.
2. Each paragraph block is split by double newline into paragraphs.
3. Within each paragraph, block-level structure is detected: horizontal rule → blockquote → table → list → heading → plain paragraph.
4. Inline rendering runs per-line inside each block: backslash escapes → inline code → HTML escape → images → links → auto-links → bold → italic → strikethrough → restore placeholders.

## Auto-link safety

Auto-linking bare URLs is the most security/UX-sensitive step, so it deliberately refuses several shapes that tool output and code fragments produce:

- **Internal SPA routes** (`http(s)://…/#/…`) are never auto-linked. MCP/Chrome-debug tool results embed strings like `Page navigated to http://…/#/chat/<id>…`; wrapping them in anchors meant a stray tap navigated the app to another chat (a confusing "auto-redirect"). They now render as plain text.
- **Swallowed code/JSON punctuation** — if the matched URL already contains a `"`, `{`, `}`, `[`, `]`, or backslash, it is not linked. These are almost always JSON or template-literal fragments, not real URLs.
- **JS concatenation fragments** (`+ … +`) that sneak through with dots or `@` are not linked.

Legitimate external links, markdown links, and query strings (including `&`) are unaffected.

### Explicit links to internal routes

The same-origin SPA-route guard is not limited to auto-linked bare URLs. **Explicit markdown links** (`[label](url)`) whose target resolves to an internal SPA route — `/#/…` or `http(s)://…/#/…` — are also stripped of their anchor and rendered as the plain label text. Without this, a tool result containing `[open](http://127.0.0.1:5732/#/chat/<id>)` produced a live anchor, and a stray tap navigated the app to another chat — the "auto-redirect on load" symptom that the earlier auto-link guard did not cover. Only the anchor is removed; the visible label is preserved.

Non-`/#/` targets (external links, API paths like `/api/…`, root-relative asset paths) are unaffected and still render as normal anchors.

### Inline code is HTML-escaped

Inline code (`` `…` ``) is extracted before the HTML-escape pass, but its **content is itself HTML-escaped** before being wrapped in `<code>`. This matters because a model's reasoning trace frequently *quotes* code fragments — e.g. `` `<img src="/+ safe +">` `` or `` `![alt](url)` `` — as part of its analysis. Without escaping, that quoted fragment became a **live `<img>`/`<a>` element** whose `src`/`href` the browser then loaded, navigating the SPA to a garbage path like `/+%20safe%20+` (the "auto-redirect on load" bug). Escaping the code content renders it as literal text inside `<code>`, never as a real element.

### Images to internal routes

Markdown images (`![alt](url)`) whose target resolves to an internal SPA route (`/#/…` or `http(s)://…/#/…`) are rendered as their plain alt text instead of a live `<img>`. A live `<img src="/…">` would make the browser fetch the app shell as an image (and a quoted `![alt](url)` in a reasoning trace would otherwise load garbage paths).

### Mermaid diagram blocks (`frontend/src/mermaid.js`)

When `renderMarkdown` encounters a fenced block whose info language is `mermaid` or `mmd`, it passes the raw body to `renderMermaidSvg(source)`:
- Every node, participant, edge, and note label is XML-escaped (`&`, `<`, `>`, `"`, `'`) before SVG construction; no `<foreignObject>`, `<script>`, or event attributes are ever emitted.
- The resulting SVG is URI-encoded into `<img class="md-diagram__img" src="data:image/svg+xml;utf8,..." alt="Mermaid diagram" loading="lazy" />` inside `<div class="md-diagram">`, followed by a `<details class="md-diagram__details">` holding the escaped source `<pre class="md-diagram__source">`.
- Because `makeMarkdownImagesZoomable` in `frontend/src/components/chat/transcript.js` wraps every `<img>` in `renderMarkdown` output with `zoomableImage`, tapping a rendered Mermaid diagram opens the full-screen lightbox on mobile with zero extra wiring.
- `buildSubagentToolMermaid(toolName, result, args)` and `buildSubagentRunMermaid(result, args)` in `frontend/src/mermaid.js` synthesize Mermaid `flowchart` and `sequenceDiagram` definitions from subagent orchestration tool calls (`subagent_group_*`, `subagent_status`, `subagent_messages`, `subagent_send`, `subagent_stop`, `subagent_publish`, `subagent_read`, `subagent_decision`, `subagent_conflict`) and complex multi-agent `subagent` runs, rendered via `renderSubagentSchemaDiagram` in `frontend/src/components/chat/toolRender.js`.

