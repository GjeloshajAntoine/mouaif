# Markdown renderer

## Overview

The chat view renders AI responses as HTML using a zero-dependency, server-side-markdown-safe renderer (`src/web/src/markdown.js`). It handles a CommonMark-like subset suitable for LLM output without needing a full parser or DOMParser. Output is injected via `innerHTML` — all HTML special characters are escaped except those produced by recognised patterns.

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

- **Internal SPA routes** (`http(s)://…/web/#/…`) are never auto-linked. MCP/Chrome-debug tool results embed strings like `Page navigated to http://…/web/#/chat/<id>…`; wrapping them in anchors meant a stray tap navigated the app to another chat (a confusing "auto-redirect"). They now render as plain text.
- **Swallowed code/JSON punctuation** — if the matched URL already contains a `"`, `{`, `}`, `[`, `]`, or backslash, it is not linked. These are almost always JSON or template-literal fragments, not real URLs.
- **JS concatenation fragments** (`+ … +`) that sneak through with dots or `@` are not linked.

Legitimate external links, markdown links, and query strings (including `&`) are unaffected.

## Mobile considerations

- Tables are wrapped in `overflow-x: auto` on the `<table>` itself so narrow viewports can scroll horizontally rather than breaking layout.
- Code blocks use `overflow-x: auto` and a compact `font-size: 0.7rem` to fit more text on small screens.
- Touch targets (checkboxes, links) are at least 44×44 px.
- No hover-only affordances — everything works on tap.