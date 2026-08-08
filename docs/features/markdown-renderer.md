# Markdown renderer

## Overview

The chat view renders AI responses as HTML using a zero-dependency, server-side-markdown-safe renderer (`frontend/src/markdown.js`). It handles a CommonMark-like subset suitable for LLM output without needing a full parser or DOMParser. Output is injected via `innerHTML` — all HTML special characters are escaped except those produced by recognised patterns.

## Supported syntax

| Feature | Example |
|---|---|
| **Fenced code blocks** | `` ```js … ``` `` or `~~~ … ~~~` |
| **Inline code** | `` `code` `` |
| **Headings** | `# H1` through `###### H6` |
| **Bold** | `**bold**` or `__bold__` |
| **Italic** | `*italic*` or `_italic_` |
| **Strikethrough** | `~~strikethrough~~` |
| **Links** | `[text](url)` |
| **Images** | `![alt](url)` |
| **Auto-links** | Bare URLs starting with `http://`, `https://`, `ftp://`, `www.`, or email addresses |
| **Blockquotes** | Lines starting with `>` |
| **Unordered lists** | Lines starting with `-`, `*`, or `+` |
| **Ordered lists** | Lines starting with `1.` etc. |
| **Task lists** | `- [ ]` / `- [x]` items (rendered as disabled checkboxes) |
| **Tables** | Pipe tables with a separator row (e.g. `\| A \| B \|\n\| --- \| --- \|`) |
| **Horizontal rules** | `---`, `***`, or `___` alone in a paragraph block |
| **Line breaks** | Single newlines inside a paragraph produce `<br>` |
| **Backslash escapes** | `\*`, `\_`, `\[`, etc. produce the literal character |

## Unsupported (intentionally)

- HTML passthrough — all `<` and `>` are escaped.
- Reference-style links — only inline `[text](url)` works.
- Definition lists, footnotes, embedded HTML tables.
- Syntax-highlighted code blocks — the language class is set (e.g. `class="language-js"`) but the UI does not load a highlighter; code is plain monospace.

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

## Mobile considerations

- Tables are wrapped in `overflow-x: auto` on the `<table>` itself so narrow viewports can scroll horizontally rather than breaking layout.
- Code blocks use `overflow-x: auto` and a compact `font-size: 0.7rem` to fit more text on small screens.
- Touch targets (checkboxes, links) are at least 44×44 px.
- No hover-only affordances — everything works on tap.