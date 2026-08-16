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

## Mobile considerations

- Tables are wrapped in `overflow-x: auto` on the `<table>` itself so narrow viewports can scroll horizontally rather than breaking layout.
- Code blocks use `overflow-x: auto` and a compact `font-size: 0.7rem` to fit more text on small screens.
- Touch targets (checkboxes, links) are at least 44×44 px.
- No hover-only affordances — everything works on tap.
