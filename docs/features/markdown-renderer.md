# Markdown renderer

## Overview

The chat view renders AI responses as HTML using a zero-dependency, server-side-markdown-safe renderer (`frontend/src/markdown.js`). It handles a CommonMark-like subset suitable for LLM output without needing a full parser or DOMParser. Output is injected via `innerHTML` — all HTML special characters are escaped except those produced by recognised patterns.

## Supported syntax

| Feature | Example |
|---|---|
| **Fenced code blocks** | `` ```js … ``` `` or `~~~ … ~~~` |
| **Mermaid diagrams** | `` ```mermaid … ``` `` or `` ```mmd … ``` `` (rendered as visual SVG with tap-to-zoom and collapsible source) |
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

## Safety model

The renderer's output is injected with `innerHTML` on the app's own origin
(`frontend/src/components/chat/transcript.js`), so anything it emits is live
DOM running with the user's session. Two rules follow, and both are pinned by
`scripts/test-markdown-safety.mjs`:

1. **Escaping happens last.** A backslash escape (`\<`, `\>`, `\"`) is stored
   in a placeholder *before* the HTML-escape pass, so the placeholder is
   resolved back to its *escaped* form (`&lt;`, `&gt;`, `&quot;`) — a literal
   character, never live markup.

   ```js
   // Writing \<img src=x onerror=alert(1)> renders as text:
   renderMarkdown('\\<img src=x onerror=alert(1)>');
   // → <p>&lt;img src=x onerror=alert(1)&gt;</p>
   ```

2. **Link and image targets are scheme-checked.** A target is rendered as a
   real `href`/`src` only when its scheme is `http`, `https`, `mailto`, `ftp`
   or `ftps`, or when it has no scheme at all (relative path, `#fragment`,
   `//host`). Everything else — `javascript:`, `data:`, `vbscript:`,
   `blob:`, `file:` — falls back to plain text.

   ```js
   renderMarkdown('[click](javascript:alert(1))');      // → click (text)
   renderMarkdown('[click](&#106;avascript:alert(1))'); // → click (text)
   renderMarkdown('[docs](https://example.com/a?b=1)'); // → live link
   ```

   Entity-encoded and whitespace-split schemes (`java&Tab;script:`,
   `java\tscript:`) are rejected too: control characters are collapsed the way
   a browser collapses them, and a candidate whose pre-colon text contains `&`
   is refused rather than guessed at.

Urls that address the app's own SPA routes (`…/#/chat/<id>`) are deliberately
rendered as plain text, so a stray tap on tool output cannot navigate the app
away from the current chat.

## Mermaid diagram rendering

Fenced code blocks tagged `mermaid` or `mmd` are rendered into responsive SVG diagrams (`frontend/src/mermaid.js`) for the common diagram families LLMs emit:

- **Flowcharts & graphs** (`flowchart TD`, `flowchart LR`, `graph TD`, subgraphs, node shapes `[]`, `()`, `{}`, `(())`, `([])`, `[()]`, labelled and dashed/thick edges).
- **Sequence diagrams** (`sequenceDiagram`, participants/actors, sync/async/dashed messages, self-calls, `Note`, and `loop`/`alt`/`opt` blocks).
- **State diagrams** (`stateDiagram`, `stateDiagram-v2`, `[*]` start/end transitions).
- **Class & ER diagrams** (`classDiagram`, `erDiagram`, entities/attributes, and relationship connectors).

Each rendered diagram includes:
- A tap-to-zoom `<img class="md-diagram__img">` backed by an inert `data:image/svg+xml;utf8,…` URI, so tapping the diagram on a phone opens it in the full-screen image lightbox.
- A collapsible **Mermaid source** / **Schema source** `<details>` disclosure below the diagram to inspect or copy the raw definition.
- Automatic fallback to a standard `<pre><code class="language-mermaid">` block when a diagram uses an unrecognised directive.
- Automatic structure & communication schema generation (`buildSubagentToolMermaid`, `buildSubagentRunMermaid`) inside expanded subagent orchestration tool cards (`subagent_group_*`, `subagent_status`, `subagent_messages`, `subagent_send`, `subagent_stop`, `subagent_publish`, `subagent_read`, `subagent_decision`, `subagent_conflict`) and complex multi-agent `subagent` runs.

## Mobile considerations

- Tables are wrapped in `overflow-x: auto` on the `<table>` itself so narrow viewports can scroll horizontally rather than breaking layout.
- Code blocks use `overflow-x: auto` and a compact `font-size: 0.7rem` to fit more text on small screens.
- Touch targets (checkboxes, links) are at least 44×44 px.
- No hover-only affordances — everything works on tap.

## Related

- [Chat UI](./chat-ui.md) — where rendered markdown is displayed.

