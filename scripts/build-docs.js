// scripts/build-docs.js
// Build a static HTML site from docs/. No external dependencies; CommonJS so
// it runs under plain `node` like every other script in this repo.
//
// Source layout:
//   docs/README.md            -> docs-dist/index.html     (presentation landing page)
//   docs/decisions.md         -> docs-dist/decisions.html
//   docs/features/<slug>.md   -> docs-dist/features/<slug>.html
//   docs/features/_<x>.md     -> skipped (templates / drafts)
//
// Output layout:
//   docs-dist/
//     index.html                  (presentation landing page)
//     documentation.html          (feature card index)
//     decisions.html
//     assets/site.css
//     features/<slug>.html
//     features/images/...          (recursively copied from docs/features/images/)
//
// Usage:
//   node scripts/build-docs.js
//   # or
//   npm run docs:build
//
// The renderer is intentionally small and safe for innerHTML: every text node
// is HTML-escaped before inline patterns are re-introduced. It is not a full
// CommonMark implementation — it covers the subset used by docs/:
//   - ATX headings (# … ######) with stable slug anchors
//   - fenced code blocks (3+ backticks OR tildes, matched by the same fence
//     length, so 4-backtick wrappers around 3-backtick bodies render correctly)
//   - blockquotes (> …)
//   - ordered (1. …) and unordered (- / * / +) lists, with one or more
//     levels of nesting (a deeper-indented list starts a nested <ul>/<ol>)
//   - GFM-style tables (| … | header | … |, | --- | … | separator, body rows)
//     with `:`-marked column alignment
//   - paragraphs and <br> for hard line breaks
//   - inline: **bold**, *italic*, ~~strike~~, `code`, [text](url), ![alt](url)
//     and image/link titles (`[text](url "title")`)

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const OUT_DIR = path.join(ROOT, 'docs-dist');

// ---- Markdown renderer ------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

// Inline pass. Operates on already-escaped text.
function renderInline(text, ctx) {
  let s = text;
  // Images first (before links so ![…](…) wins). Match the title
  // separator in either raw `"` (if the input didn't go through the
  // escaper, e.g. when renderInline is called on raw text) or the
  // escaped form `&quot;` (the normal case after escapeHtml).
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"([^"]*)"|&quot;([^&]*)&quot;))?\)/g,
    (_m, alt, url, t1, t2) => {
      const title = t1 != null ? t1 : (t2 != null ? t2 : '');
      const safeUrl = sanitizeUrl(url, ctx);
      if (!safeUrl) return escapeHtml(alt);
      return '<img src="' + escapeAttr(safeUrl) + '" alt="' + escapeAttr(alt) + '"' +
        (title ? ' title="' + escapeAttr(title) + '"' : '') + ' loading="lazy" />';
    });
  // Links: [text](url) — also support a "title" after the url in quotes.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+(?:"([^"]*)"|&quot;([^&]*)&quot;))?\)/g,
    (_m, label, url, t1, t2) => {
      const title = t1 != null ? t1 : (t2 != null ? t2 : '');
      const safeUrl = sanitizeUrl(url, ctx);
      if (!safeUrl) return escapeHtml(label);
      const isExternal = /^[a-z][a-z0-9+.-]*:/i.test(safeUrl) && !safeUrl.startsWith('docs/');
      const attrs = ' href="' + escapeAttr(safeUrl) + '"' +
        (title ? ' title="' + escapeAttr(title) + '"' : '') +
        (isExternal ? ' target="_blank" rel="noopener noreferrer"' : '');
      return '<a' + attrs + '>' + label + '</a>';
    });
  // Inline code: extract into placeholders so the bold/italic/strike
  // passes below do not touch the contents (e.g. `**not bold**`).
  const codeStash = [];
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeStash.length;
    codeStash.push('<code>' + code + '</code>');
    return '\u0000CODE' + idx + '\u0000';
  });
  // Strikethrough, then bold, then italic. The italic rules require the
  // delimiter to be preceded by a non-letter (or BOL) and followed by a
  // non-letter (or EOL); that stops `snake_case` identifiers inside a
  // paragraph from being half-italicised.
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>');
  // Restore inline code spans.
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, n) => codeStash[Number(n)]);
  return s;
}

// Decide whether a URL is safe to render as href / src.
//   - Reject anything that isn't a relative path, a fragment, or a
//     http(s)/mailto scheme. This blocks javascript:, data:, vbscript:,
//     file:, etc. from slipping into a static doc.
//   - For .md links inside docs/, rewrite to .html so the static site
//     navigates to the generated page instead of the raw source.
function sanitizeUrl(url, ctx) {
  if (!url) return '';
  // Strip any leading/trailing whitespace and angle brackets already in the
  // text (markdown spec allows <…> wrappers, but they should be inert here).
  url = url.replace(/^<+|>+$/g, '').trim();
  if (!url) return '';
  // Allow in-page anchors.
  if (url.startsWith('#')) return url;
  // Allow http(s) and mailto.
  if (/^(https?:|mailto:)/i.test(url)) return url;
  // Allow protocol-relative URLs only when the scheme is http(s).
  if (url.startsWith('//')) return url;
  // Reject any other explicit scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return '';
  // Relative path. If it points to a .md file under docs/, rewrite to .html
  // (only when we are inside a docs/ page — the caller sets ctx.rewriteMd).
  if (ctx && ctx.rewriteMd && /\.md(#|$)/.test(url)) {
    url = url.replace(/\.md(?=#|$)/, '.html');
  }
  return url;
}

// Block parser. Splits the source on blank lines (and a few other block
// boundaries) and dispatches to a per-block renderer.
function renderMarkdown(src, ctx) {
  if (!src) return '';
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines between blocks.
    if (!line.trim()) { i++; continue; }

    // Fenced code block. Match the leading run of ` or ~ (3 or more);
    // the closing fence must use the same char and be at least the same
    // length. Indentation of 0-3 spaces is allowed per CommonMark.
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1].length;
      const fence = fenceMatch[2];
      const fenceChar = fence[0];
      const fenceLen = fence.length;
      const info = fenceMatch[3].trim();
      const lang = info.split(/\s+/)[0] || '';
      const codeLines = [];
      i++;
      while (i < lines.length) {
        const closeMatch = new RegExp('^( {0,3})(' + fenceChar + '{' + fenceLen + ',})\\s*$').exec(lines[i]);
        if (closeMatch) { i++; break; }
        // Strip up to `indent` leading spaces from each code line.
        if (lines[i].length >= indent) codeLines.push(lines[i].slice(indent));
        else codeLines.push(lines[i]);
        i++;
      }
      out.push('<pre><code' + (lang ? ' class="language-' + escapeAttr(lang) + '"' : '') + '>' +
        escapeHtml(codeLines.join('\n')) + '</code></pre>');
      continue;
    }

    // ATX heading. The trailing # run and trailing whitespace are stripped.
    const headingMatch = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (headingMatch && !/^#{7,}/.test(line)) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const slug = slugify(text);
      out.push('<h' + level + (slug ? ' id="' + escapeAttr(slug) + '"' : '') + '>' +
        renderInline(escapeHtml(text), ctx) + '</h' + level + '>');
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^ {0,3}([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // GFM table. Header row, separator row, then zero or more body rows.
    // A row is a `|`-delimited line; a leading/trailing `|` is optional.
    if (isTableStart(lines, i)) {
      const consumed = renderTable(lines, i, out, ctx);
      i += consumed;
      continue;
    }

    // Blockquote (one or more consecutive lines starting with `>`).
    if (/^ {0,3}>/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && (/^ {0,3}>/.test(lines[i]) || (quoteLines.length && lines[i].trim() && !isBlockStart(lines[i])))) {
        if (/^ {0,3}>/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^ {0,3}> ?/, ''));
        } else {
          // Lazy continuation inside a blockquote.
          quoteLines.push(lines[i]);
        }
        i++;
      }
      const inner = renderMarkdown(quoteLines.join('\n'), ctx);
      out.push('<blockquote>' + inner + '</blockquote>');
      continue;
    }

    // Ordered list. Detect at any indent so a nested list inside a
    // paragraph or another block is recognised. The actual list parser
    // decides what to do with the indent.
    if (/^\s*\d+\.\s+/.test(line)) {
      i = renderList(lines, i, out, ctx, 'ol', /^\s*(\d+)\.\s+(.*)/);
      continue;
    }

    // Unordered list. Same caveat as above: detect at any indent.
    if (/^\s*[-*+]\s+/.test(line)) {
      i = renderList(lines, i, out, ctx, 'ul', /^\s*[-*+]\s+(.*)/);
      continue;
    }

    // Paragraph. Collect lines until blank line or another block start.
    const paraLines = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (!cur.trim()) break;
      if (isBlockStart(cur)) break;
      paraLines.push(cur);
      i++;
    }
    if (paraLines.length) {
      const html = renderInline(escapeHtml(paraLines.join('\n')), ctx)
        .replace(/\n/g, '<br>');
      out.push('<p>' + html + '</p>');
    }
  }
  return out.join('\n');
}

function isBlockStart(line) {
  // Detect any block-level construct the top-level renderer cares about.
  // List items are detected at ANY indent so a deeply-nested list inside
  // a paragraph or another block is still recognised; the actual list
  // parser decides what to do with the indent.
  return (
    /^ {0,3}```/.test(line) ||
    /^ {0,3}~~~/.test(line) ||
    /^ {0,3}#{1,6}\s+/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line)
  );
}

function isTableStart(lines, i) {
  // Need at least two more lines (separator) and a header line with `|`.
  if (i + 1 >= lines.length) return false;
  if (!lines[i].includes('|')) return false;
  const sep = lines[i + 1].trim();
  if (!/^\|?\s*:?-{3,}:?(\s*\|\s*:?-{3,}:?)+\s*\|?$/.test(sep)) return false;
  return true;
}

function splitTableRow(line) {
  // Trim leading/trailing whitespace and outer pipes, then split on `|`.
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  // Split on unescaped `|`. The docs don't use `\|` for escapes, so a plain
  // split is enough; we still trim each cell.
  return s.split('|').map((c) => c.trim());
}

function parseTableAlignment(sepCells) {
  return sepCells.map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
}

function renderTable(lines, i, out, ctx) {
  const headerCells = splitTableRow(lines[i]);
  const sepCells = splitTableRow(lines[i + 1]);
  const aligns = parseTableAlignment(sepCells);
  let rows = [];
  let j = i + 2;
  while (j < lines.length && lines[j].trim() && lines[j].includes('|') && !isBlockStart(lines[j])) {
    rows.push(splitTableRow(lines[j]));
    j++;
  }
  const head = headerCells.map((c, idx) =>
    '<th' + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '') + '>' +
    renderInline(escapeHtml(c), ctx) + '</th>').join('');
  const body = rows.map((row) => {
    const cells = headerCells.map((_, idx) => {
      const cell = row[idx] != null ? row[idx] : '';
      return '<td' + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '') + '>' +
        renderInline(escapeHtml(cell), ctx) + '</td>';
    }).join('');
    return '<tr>' + cells + '</tr>';
  }).join('');
  out.push('<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>');
  return j - i;
}

function renderList(lines, i, out, ctx, tagName, itemRe) {
  // Render an ordered or unordered list, supporting one or more levels of
  // nesting. We re-parse the body of each item through renderMarkdown so
  // nested lists, code blocks, etc. all render the same way they would at
  // the top level. The collected item body preserves the original
  // indentation so the recursive call sees a nested list as a nested
  // list, not as a sibling.
  //
  // The `itemRe` regex matches `<indent>(-|\*|\+)<space>...` (or a digit
  // dot for ordered). The loop stops at the first non-blank line that is
  // either a list item at the same or shallower indent (a sibling), or a
  // new block start (heading, fence, blockquote, etc.). A list item at a
  // deeper indent is a nested list and is included in the current item's
  // body so the recursive renderMarkdown call can render it.
  const items = [];
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // Blank line: peek ahead. A blank line followed by another list
      // item at the same indent is allowed (and is a list separator);
      // anything else closes the list.
      let k = i + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k >= lines.length) break;
      if (isBlockStart(lines[k])) break;
      if (itemRe.test(lines[k])) { i = k; continue; }
      break;
    }
    const m = itemRe.exec(line);
    if (!m) break;
    const itemIndent = line.length - line.replace(/^\s*/, '').length;
    const itemBody = [m[m.length - 1]];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      const nextIndent = next.length - next.replace(/^\s*/, '').length;
      if (!next.trim()) {
        let k = i + 1;
        while (k < lines.length && !lines[k].trim()) k++;
        if (k >= lines.length) break;
        if (isBlockStart(lines[k])) break;
        if (itemRe.test(lines[k])) {
          const peekIndent = lines[k].length - lines[k].replace(/^\s*/, '').length;
          // A nested list item is at a deeper indent; treat as continuation
          // of the current item. A same-or-shallower-indent list item is
          // a sibling and ends the current item.
          if (peekIndent > itemIndent) {
            itemBody.push('');
            i = k;
            continue;
          }
          break;
        }
        // A non-list, non-block-start line that is at least as indented
        // as the current item is a continuation paragraph; include it.
        const peekIndent2 = lines[k].length - lines[k].replace(/^\s*/, '').length;
        if (peekIndent2 < itemIndent) break;
        itemBody.push('');
        i = k;
        continue;
      }
      if (itemRe.test(next)) {
        // A new list item at a deeper indent is a nested list; keep it.
        // A new list item at the same or shallower indent is a sibling
        // and ends the current item.
        if (nextIndent > itemIndent) {
          itemBody.push(next);
          i++;
          continue;
        }
        break;
      }
      if (isBlockStart(next)) break;
      if (nextIndent < itemIndent) break;
      itemBody.push(next);
      i++;
    }
    const inner = renderMarkdown(itemBody.join('\n'), ctx);
    items.push('<li>' + inner + '</li>');
  }
  out.push('<' + tagName + '>' + items.join('') + '</' + tagName + '>');
  return i;
}

// Heading anchors. Lowercase, ASCII-folded, non-alphanumerics -> `-`, collapse
// repeats, trim. Empty -> empty. Matches what the auto-linker would generate
// for in-page #fragments.
function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

// ---- Site model --------------------------------------------------------

function readDocFile(rel) {
  const abs = path.join(DOCS_DIR, rel);
  return fs.readFileSync(abs, 'utf8');
}

function listFeatureFiles() {
  if (!fs.existsSync(path.join(DOCS_DIR, 'features'))) return [];
  return fs.readdirSync(path.join(DOCS_DIR, 'features'))
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .sort();
}
function listAgentFeatureFiles() {
  if (!fs.existsSync(path.join(DOCS_DIR, 'agent', 'features'))) return [];
  return fs.readdirSync(path.join(DOCS_DIR, 'agent', 'features'))
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .sort();
}

// Recursively copy docs/features/images/ into docs-dist/features/images/.
// Features embed their screenshots as `./images/<feature>/<shot>.png` in
// markdown; without this step the static site has no PNGs to serve even
// though the HTML references them. We use fs.cpSync (Node ≥ 16.7) so the
// recursion, mtime preservation, and directory creation are handled by
// the runtime. The function is a no-op when the source dir is missing,
// so an empty `docs/features/images/` tree doesn't fail the build.
function copyFeatureImages(outDir) {
  const srcDir = path.join(DOCS_DIR, 'features', 'images');
  const dstDir = path.join(outDir, 'features', 'images');
  if (!fs.existsSync(srcDir)) return;
  fs.cpSync(srcDir, dstDir, { recursive: true, dereference: false });
}

function parseFeatureListItem(line) {
  // Matches the bullet shape used in docs/README.md:
  //   - [Title](features/foo.md) — short blurb.
  // Tolerates CRLF: strip a trailing \r so $ matches.
  const clean = line.replace(/\r$/, '');
  const m = /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:\u2014\s*|\-\s+)?(.*)$/.exec(clean);
  if (!m) return null;
  let slug = m[2];
  slug = slug.replace(/^features\//, '').replace(/\.md$/, '');
  return { title: m[1].trim(), slug, blurb: m[3].trim() };
}

// ---- HTML template -----------------------------------------------------

const SITE_CSS = `
:root {
  color-scheme: dark;
  --bg: #0e1116;
  --surface: #161b22;
  --surface-2: #1c2230;
  --border: #2a3140;
  --text: #e6edf3;
  --muted: #8b96a8;
  --accent: #4f8cff;
  --accent-soft: rgba(79, 140, 255, 0.14);
  --code-bg: #0b0f15;
  --shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.55;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: var(--code-bg);
  padding: 0.1em 0.35em;
  border-radius: 4px;
  border: 1px solid var(--border);
}
pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  overflow-x: auto;
  box-shadow: var(--shadow);
}
pre code {
  background: transparent;
  border: 0;
  padding: 0;
  font-size: 13px;
  line-height: 1.5;
}
hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
blockquote {
  margin: 16px 0;
  padding: 8px 14px;
  border-left: 3px solid var(--accent);
  background: var(--surface-2);
  border-radius: 0 6px 6px 0;
  color: var(--muted);
}
blockquote p:first-child { margin-top: 0; }
blockquote p:last-child { margin-bottom: 0; }
img { max-width: 100%; height: auto; border-radius: 6px; }
table { border-collapse: collapse; width: 100%; }
.table-wrap { overflow-x: auto; margin: 16px 0; border: 1px solid var(--border); border-radius: 8px; }
table th, table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
table th { background: var(--surface-2); text-align: left; font-weight: 600; }
table tr:last-child td { border-bottom: 0; }

/* Layout */
.site {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  min-height: 100vh;
}
.sidebar {
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 20px 16px;
  position: sticky;
  top: 0;
  align-self: start;
  max-height: 100vh;
  overflow-y: auto;
}
.sidebar h1 {
  font-size: 18px;
  margin: 0 0 4px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.sidebar .logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px; height: 24px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  font-size: 14px;
}
.sidebar .tag { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
.sidebar h2 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 18px 0 6px 0;
}
.sidebar ul { list-style: none; padding: 0; margin: 0; }
.sidebar li a {
  display: block;
  padding: 6px 8px;
  border-radius: 6px;
  color: var(--text);
  font-size: 14px;
  line-height: 1.3;
}
.sidebar li a:hover { background: var(--surface-2); text-decoration: none; }
.sidebar li a.is-active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.main { padding: 28px 32px 64px 32px; max-width: 920px; }
.main h1 { font-size: 28px; margin: 0 0 4px 0; }
.main h1 + p { color: var(--muted); margin-top: 0; }
.main h2 { font-size: 20px; margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--border); }
.main h3 { font-size: 16px; margin-top: 24px; }
.main p, .main li { line-height: 1.6; }
.main ul, .main ol { padding-left: 22px; }
.main li + li { margin-top: 4px; }

/* Index page: feature cards. */
.features-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
  margin-top: 16px;
}
.feature-card {
  display: block;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  color: var(--text);
  transition: border-color 120ms ease, transform 120ms ease;
}
.feature-card:hover {
  border-color: var(--accent);
  text-decoration: none;
  transform: translateY(-1px);
}
.feature-card h3 { margin: 0 0 6px 0; font-size: 15px; color: var(--accent); }
.feature-card p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }

.footer {
  margin-top: 40px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
}

@media (max-width: 760px) {
  .site { grid-template-columns: 1fr; }
  .sidebar { position: static; max-height: none; order: 2; }
  .main { padding: 20px 16px 48px 16px; order: 1; }
}
/* Top navigation (shared across pages). */
.topnav {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 12px 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 20;
}
.topnav-brand {
  font-weight: 700;
  font-size: 16px;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.topnav-brand .logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px; height: 22px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  font-size: 13px;
}
.topnav-links {
  display: flex;
  gap: 4px;
  margin-left: auto;
  flex-wrap: wrap;
}
.topnav-links a {
  padding: 7px 10px;
  border-radius: 6px;
  color: var(--muted);
  font-size: 14px;
  white-space: nowrap;
}
.topnav-links a:hover {
  background: var(--surface-2);
  color: var(--text);
  text-decoration: none;
}
/* Full-width layout (landing page has no sidebar). */
.site--full .main {
  max-width: 1000px;
  margin: 0 auto;
}
/* Landing page. */
.hero {
  padding: 56px 32px 40px;
  text-align: center;
}
.hero .eyebrow {
  margin: 0 0 12px;
  color: var(--accent);
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-weight: 600;
}
.hero h1 {
  font-size: 52px;
  margin: 0 0 14px;
  letter-spacing: -0.02em;
}
.hero .tagline {
  max-width: 640px;
  margin: 0 auto 24px;
  color: var(--muted);
  font-size: 17px;
  line-height: 1.6;
}
.hero-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 10px 18px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
}
.btn:hover { text-decoration: none; border-color: var(--accent); }
.btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.btn--primary:hover { filter: brightness(1.06); }
/* Feature sections with a screenshot + copy. */
.feature {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 32px;
  align-items: center;
  margin: 56px 0;
}
.feature--flip .shot { order: 2; }
.feature--flip .feature-copy { order: 1; }
.feature-copy h2 { margin-top: 0; padding-top: 0; border-top: 0; }
.feature-copy p, .feature-copy li { color: var(--muted); }
.shot {
  position: relative;
  margin: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.shot-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  color: var(--muted);
  border: 1px dashed var(--border);
  border-radius: 11px;
  font-size: 13px;
  text-align: center;
  padding: 16px;
  z-index: 0;
}
.shot img {
  position: relative;
  z-index: 1;
  width: 100%;
  height: auto;
  display: block;
  border-radius: 12px;
}
.shot figcaption {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--muted);
  border-top: 1px solid var(--border);
  background: var(--surface-2);
}
.section {
  margin: 56px 0;
}
.section h2 {
  font-size: 22px;
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
.section p, .section li { color: var(--muted); }
.section .lead { color: var(--text); }
@media (max-width: 760px) {
  .site { grid-template-columns: 1fr; }
  .sidebar { position: static; max-height: none; }
  .main { padding: 20px 16px 48px 16px; }
  .topnav { padding: 10px 14px; gap: 8px; }
  .topnav-links { gap: 2px; }
  .topnav-links a { padding: 7px 8px; font-size: 13px; }
  .hero { padding: 40px 16px 32px; }
  .hero h1 { font-size: 40px; }
  .hero .tagline { font-size: 15px; }
  .feature { grid-template-columns: 1fr; gap: 20px; }
  .feature--flip .shot { order: 0; }
  .feature--flip .feature-copy { order: 0; }
}
`;

function htmlPage({ title, body, sidebar, description, topnav = '', fullWidth = false }) {
  const siteClass = fullWidth ? ' class="site site--full"' : ' class="site"';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — mouaif docs</title>
  <meta name="description" content="${escapeAttr(description || title)}" />
  <link rel="stylesheet" href="./assets/site.css" />
</head>
<body>
  ${topnav}
  <div${siteClass}>
    ${sidebar}
    <main class="main">
      ${body}
      <div class="footer">Generated from <code>docs/</code> by <code>scripts/build-docs.js</code>. Open an issue on the repo to suggest changes.</div>
    </main>
  </div>
</body>
</html>
`;
}

// Shared top navigation bar. Used by every page so the primary sections
// (landing, how-to-run, projects, MCP & tools, documentation) are always
// one tap away, matching the "presentation page first, docs second" goal.
function renderTopNav() {
  return `<nav class="topnav" aria-label="Primary">
  <a class="topnav-brand" href="index.html"><span class="logo">m</span> mouaif</a>
  <div class="topnav-links">
    <a href="index.html">Home</a>
    <a href="index.html#how-to-run">How to run</a>
    <a href="index.html#projects">Projects</a>
    <a href="index.html#mcp-tools">MCP &amp; tools</a>
    <a href="documentation.html">Documentation</a>
    <a href="agent-notes.html">Agent notes</a>
  </div>
</nav>`;
}

// ---- Build orchestration ----------------------------------------------

function extractFirstH1(md) {
  const m = /^#\s+(.+?)\s*$/m.exec(md);
  return m ? m[1].trim() : '';
}

function extractBlurb(md, maxLen) {
  // The first paragraph after the H1, trimmed and clamped to maxLen chars.
  const after = md.replace(/^#\s+.+?\n+/, '');
  const para = after.split(/\n\n+/).find((p) => p.trim() && !/^#/.test(p.trim()));
  if (!para) return '';
  const cleaned = para.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1).replace(/\s+\S*$/, '') + '…';
}

function buildFeaturePages(features, renderSidebar, outDir) {
  const featureDir = path.join(outDir, 'features');
  fs.mkdirSync(featureDir, { recursive: true });
  for (const f of features) {
    const src = readDocFile('features/' + f.slug + '.md');
    const ctx = { rewriteMd: true };
    const body = renderMarkdown(src, ctx);
    const html = htmlPage({
      title: f.title,
      body,
      sidebar: renderSidebar(f.slug),
      description: f.blurb || f.title,
      topnav: renderTopNav()
    });
    // Feature pages are at features/<slug>.html, so the CSS path is
    // ../assets/site.css, and root-level links (index, documentation,
    // decisions) need a ../ prefix too. The sidebar already emits
    // features/<slug>.html links, which are correct from inside features/.
    const out = html
      .replace('href="./assets/site.css"', 'href="../assets/site.css"')
      .replace(/href="documentation\.html"/g, 'href="../documentation.html"')
      .replace(/href="index\.html(#|")/g, 'href="../index.html$1')
      .replace(/href="decisions\.html"/g, 'href="../decisions.html"')
      // Sidebar feature links are emitted as features/<slug>.html; from
      // inside features/<slug>.html they need a ../ prefix to resolve.
      .replace(/href="features\//g, 'href="../features/');
    fs.writeFileSync(path.join(featureDir, f.slug + '.html'), out);
  }
}
// Build the agent-facing implementation notes tree (docs/agent/features/*.md).
// These pages mirror the human feature pages but contain only the technical
// reference (REST, wire shapes, source paths). The docs-dist/agent/ prefix
// keeps the two audiences separate so the presentation site never bleeds
// implementation detail into the landing/docs pages.
function buildAgentFeaturePages(agentFeatures, outDir) {
  const agentDir = path.join(outDir, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const linkItem = (slug, title) => {
    const href = slug + '.html';
    return '<li><a href="' + href + '">' + escapeHtml(title) + '</a></li>';
  };
  for (const f of agentFeatures) {
    const src = readDocFile('agent/features/' + f.slug + '.md');
    const ctx = { rewriteMd: true };
    const body = renderMarkdown(src, ctx);
    const sidebar = `<aside class="sidebar">
<h1><span class="logo">m</span> mouaif docs</h1>
<div class="tag">agent notes</div>
<h2>Overview</h2>
<ul>
<li><a href="../index.html">Home</a></li>
<li><a href="../documentation.html">Documentation</a></li>
<li><a href="../decisions.html">Architectural decisions</a></li>
<li><a href="../agent-notes.html">Agent notes</a></li>
</ul>
<h2>Implementation notes</h2>
<ul>
${agentFeatures.map((a) => linkItem(a.slug, a.title)).join('\n    ')}
</ul>
</aside>`;
    const html = htmlPage({
      title: f.title + ' — implementation notes',
      body,
      sidebar,
      description: 'Agent-facing implementation notes for ' + f.title,
      topnav: renderTopNav()
    });
    // Agent pages are at agent/<slug>.html (one level deep), so root-level
    // links need a ../ prefix, and sibling agent pages are relative.
    const out = html
      .replace('href="./assets/site.css"', 'href="../assets/site.css"')
      .replace(/href="documentation\.html"/g, 'href="../documentation.html"')
      .replace(/href="index\.html(#|")/g, 'href="../index.html$1')
      .replace(/href="decisions\.html"/g, 'href="../decisions.html"')
      .replace(/href="agent-notes\.html"/g, 'href="../agent-notes.html"');
    fs.writeFileSync(path.join(agentDir, f.slug + '.html'), out);
  }
}
// Build the agent-notes index page listing all implementation-note pages.
function buildAgentNotesPage(agentFeatures, outDir) {
  const cards = agentFeatures.map((f) => {
    return `<a class="feature-card" href="agent/${f.slug}.html"><h3>${escapeHtml(f.title)}</h3><p>${escapeHtml(f.blurb || '')}</p></a>`;
  }).join('\n        ');
  const body = `
<h1>Agent notes — implementation reference</h1>
<p>Agent-facing implementation notes, wire shapes, and source paths. Each page mirrors a human-facing feature page in <code>docs/features/*.md</code>; the technical reference lives here.</p>
<div class="features-grid">
${cards}
</div>
`;
  const sidebar = `<aside class="sidebar">
<h1><span class="logo">m</span> mouaif docs</h1>
<div class="tag">agent notes</div>
<h2>Overview</h2>
<ul>
<li><a href="index.html">Home</a></li>
<li><a href="documentation.html">Documentation</a></li>
<li><a href="decisions.html">Architectural decisions</a></li>
</ul>
</aside>`;
  const html = htmlPage({
    title: 'Agent notes',
    body,
    sidebar,
    description: 'mouaif — agent-facing implementation notes index',
    topnav: renderTopNav()
  });
  fs.writeFileSync(path.join(outDir, 'agent-notes.html'), html);
}

// Screenshot placeholder markup. When a real PNG lands at the path (or the
// caller passes a src), the <img> renders on top of the dashed fallback slot.
function shotFigure(src, alt, caption) {
  const img = src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt || caption || '')}" loading="lazy" />` : '';
  const fallback = img ? escapeHtml(alt || caption || 'Screenshot placeholder') : '';
  const spacer = img ? '' : '<div style="min-height:220px"></div>';
  const cap = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : '';
  return `<figure class="shot">
  <div class="shot-fallback">${fallback}</div>
  ${spacer}${img}
  ${cap}
</figure>`;
}

function buildLandingPage(outDir) {
  const body = `
<section class="hero">
  <p class="eyebrow">Mobile-first AI coding assistant</p>
  <h1>mouaif</h1>
  <p class="tagline">A CLI tool with an integrated HTTP server and a mobile-first web UI. Chat with your AI providers, manage projects, inspect a running page over CDP, and give the model native shell, file, and MCP tools — all from one process, no API key leaving your box.</p>
  <div class="hero-actions">
    <a class="btn btn--primary" href="#how-to-run">Run it</a>
    <a class="btn" href="documentation.html">Read the docs</a>
  </div>
</section>

<section class="feature" id="chats">
  <div class="feature-copy">
    <h2>Projects &amp; chats</h2>
    <p>Registered projects group chats under a project card. Pick a folder, open a chat, and stream responses back over SSE.</p>
    <ul>
      <li>Project-grouped chat list, scrolling inside each card</li>
      <li>Model picker with per-provider sections and search</li>
      <li>Per-message cost and token speed</li>
    </ul>
  </div>
  ${shotFigure('features/images/project-card/chats-tab.png', 'mouaif projects and chats view', 'Projects & chats')}
</section>

<section class="feature feature--flip" id="inspector">
  <div class="feature-copy">
    <h2>Inspector</h2>
    <p>A from-scratch, mobile-friendly DevTools-style UI on top of Chrome DevTools Protocol. Preview, console, network, and info panels stacked vertically.</p>
    <ul>
      <li>Live console with an editable JavaScript console</li>
      <li>Network request inspection</li>
      <li>Target management: reload, navigate, close</li>
    </ul>
  </div>
  ${shotFigure('features/images/inspector/mobile-360-all-on.png', 'mouaif inspector view', 'Inspector')}
</section>

<section class="feature" id="settings">
  <div class="feature-copy">
    <h2>Settings &amp; auth</h2>
    <p>App-level defaults and per-project overrides, provider connections, and OAuth sign-in — all from the mobile Settings tab.</p>
    <ul>
      <li>App settings vs project settings, project wins</li>
      <li>Provider connections and model catalogs</li>
      <li>OS keychain OAuth tokens</li>
    </ul>
  </div>
  ${shotFigure('features/images/settings-ui/project-settings.png', 'mouaif settings view', 'Settings')}
</section>

<section class="section" id="how-to-run">
  <h2>Quick start</h2>
  <p class="lead">Start the assistant server with a single command:</p>
  <pre><code class="language-bash">mouaif serve</code></pre>
  <p>Open <code>http://127.0.0.1:5732/</code> on your phone or desktop browser. Tap <strong>+ Add project</strong> to pick a folder, connect an AI provider in <strong>Settings</strong>, and start chatting.</p>
</section>

<section class="section" id="projects">
  <h2>How projects work</h2>
  <p class="lead">A project is any directory on your computer, paired with settings tailored to that codebase.</p>
  <ul>
    <li><strong>Project workspace</strong> — register any workspace directory or create a new one directly from the UI.</li>
    <li><strong>Scoped configuration</strong> — customize prompts, tools, and model choices per project.</li>
    <li><strong>Provider flexibility</strong> — connect global providers once, then select models per project or chat.</li>
    <li><strong>Persistent chats</strong> — chats and turn history are saved and organized under each project card.</li>
  </ul>
  <p>See <a href="features/project-card.html">Project card</a> and <a href="features/folder-picker.html">Folder picker</a> for details.</p>
</section>

<section class="section" id="mcp-tools">
  <h2>Tools &amp; integrations</h2>
  <p class="lead">Give the model real tools — terminal execution, file inspection, task management, and third-party MCP servers.</p>
  <ul>
    <li><strong>Native capabilities</strong> — terminal commands, reading and editing files, task tracking, interactive prompts, and agent delegation.</li>
    <li><strong>Model Context Protocol (MCP)</strong> — easily connect custom or registry MCP servers for browser automation, database queries, and more.</li>
    <li><strong>Safety &amp; permissions</strong> — complete control with per-tool authorization gates (Ask, Allow, or Off).</li>
  </ul>
  <p>See <a href="features/tool-authorization.html">Tool authorization</a>, <a href="features/mcp.html">MCP</a>, and <a href="features/shell-tool.html">Shell tool</a>.</p>
</section>
`;
  const html = htmlPage({
    title: 'mouaif',
    body,
    sidebar: '',
    description: 'mouaif — mobile-first AI coding assistant',
    topnav: renderTopNav(),
    fullWidth: true
  });
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
}

function buildDocumentationPage(features, sidebarHtmlStr, outDir) {
  const cards = features.map((f) => {
    // Render the blurb through the same inline pipeline the feature pages
    // use, so backticked identifiers and links show up as <code> and <a>
    // in the cards too.
    const blurbHtml = renderInline(escapeHtml(f.blurb || ''), { rewriteMd: true });
    return `<a class="feature-card" href="features/${f.slug}.html"><h3>${escapeHtml(f.title)}</h3><p>${blurbHtml}</p></a>`;
  }).join('\n        ');
  const body = `
<h1>mouaif — documentation</h1>
<p>One page per shipped feature. The source of truth is the <code>docs/features/*.md</code> tree; this site is generated by <code>npm run docs:build</code>.</p>
<h2>Feature index</h2>
<div class="features-grid">
        ${cards}
</div>
<h2>Architectural decisions</h2>
<p>Locked-in stack, storage, and build order: see <a href="decisions.html">decisions.html</a>.</p>
`;
  const html = htmlPage({
    title: 'Documentation',
    body,
    sidebar: sidebarHtmlStr,
    description: 'mouaif — feature documentation index',
    topnav: renderTopNav()
  });
  fs.writeFileSync(path.join(outDir, 'documentation.html'), html);
}

function buildDecisionsPage(sidebarHtmlStr, outDir) {
  const src = readDocFile('decisions.md');
  const body = renderMarkdown(src, { rewriteMd: true });
  const html = htmlPage({
    title: 'Architectural decisions',
    body,
    sidebar: sidebarHtmlStr,
    description: 'Locked-in stack, storage, and build order for mouaif.',
    topnav: renderTopNav()
  });
  fs.writeFileSync(path.join(outDir, 'decisions.html'), html);
}

function main() {
  // Parse args: --out <dir> overrides the default docs-dist/.
  const args = process.argv.slice(2);
  let outDir = OUT_DIR;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && i + 1 < args.length) {
      outDir = path.resolve(args[++i]);
    } else if (args[i] === '-h' || args[i] === '--help') {
      process.stdout.write('Usage: node scripts/build-docs.js [--out <dir>]\n');
      process.stdout.write('  Builds docs-dist/ from docs/. Default output: docs-dist/.\n');
      process.exit(0);
    }
  }
  if (!fs.existsSync(DOCS_DIR)) {
    process.stderr.write('error: docs/ directory not found at ' + DOCS_DIR + '\n');
    process.exit(2);
  }
  // Resolve the index from docs/README.md so the order and the blurbs are
  // driven by the same source as the GitHub-rendered page.
  const readmeSrc = readDocFile('README.md');
  const indexSection = readmeSrc.split(/^##\s+Index\s*$/m)[1] || '';
  // The "Index" section ends at the next "##" heading.
  const indexBlock = indexSection.split(/\n##\s+/)[0] || '';
  const parsed = indexBlock.split('\n')
    .map(parseFeatureListItem)
    .filter(Boolean);
  // Merge: README order wins, but the file list on disk is the source of
  // truth for existence. Drop README entries that no longer have a file,
  // and append any on-disk files missing from the README (with a generic
  // blurb from the file's first paragraph).
  const onDisk = listFeatureFiles().map((f) => ({
    slug: f.replace(/\.md$/, ''),
    file: f
  }));
  const diskSlugs = new Set(onDisk.map((x) => x.slug));
  const readmeSlugs = new Set(parsed.map((x) => x.slug));
  const features = [];
  for (const item of parsed) {
    if (!diskSlugs.has(item.slug)) continue; // stale README entry
    const src = readDocFile('features/' + item.slug + '.md');
    const h1 = extractFirstH1(src) || item.title;
    features.push({
      slug: item.slug,
      title: h1,
      blurb: item.blurb || extractBlurb(src, 160)
    });
  }
  for (const disk of onDisk) {
    if (readmeSlugs.has(disk.slug)) continue;
    const src = readDocFile('features/' + disk.slug + '.md');
    features.push({
      slug: disk.slug,
      title: extractFirstH1(src) || disk.slug,
      blurb: extractBlurb(src, 160)
    });
  }

  // Agent-facing implementation notes (docs/agent/features/*.md). Each page
  // mirrors a human feature page; the file list on disk is the source of truth.
  const agentFeatures = listAgentFeatureFiles().map((f) => {
    const slug = f.replace(/\.md$/, '');
    const src = readDocFile('agent/features/' + f);
    return {
      slug,
      title: extractFirstH1(src) || slug,
      blurb: extractBlurb(src, 160)
    };
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'assets', 'site.css'), SITE_CSS);
  copyFeatureImages(outDir);

  // Sidebar HTML is shared across every page. The active link class is
  // applied inline so each page can highlight its own entry. Feature
  // pages are at features/<slug>.html, so the CSS link target is
  // ../assets/site.css from inside a feature page (root pages use
  // ./assets/site.css).
  const renderSidebar = (activeSlug) => {
    const linkItem = (slug, title) => {
      const cls = activeSlug === slug ? ' class="is-active"' : '';
      const href = slug ? 'features/' + slug + '.html' : 'index.html';
      return '<li><a' + cls + ' href="' + href + '">' + escapeHtml(title) + '</a></li>';
    };
    return `<aside class="sidebar">
  <h1><span class="logo">m</span> mouaif docs</h1>
  <div class="tag">v1.0.0</div>
  <h2>Overview</h2>
  <ul>
    <li><a href="index.html"${activeSlug === 'home' ? ' class="is-active"' : ''}>Home</a></li>
    <li><a href="documentation.html"${activeSlug === 'documentation' ? ' class="is-active"' : ''}>Documentation</a></li>
    <li><a href="decisions.html"${activeSlug === 'decisions' ? ' class="is-active"' : ''}>Architectural decisions</a></li>
    <li><a href="agent-notes.html"${activeSlug === 'agent-notes' ? ' class="is-active"' : ''}>Agent notes</a></li>
  </ul>
  <h2>Features</h2>
  <ul>
    ${features.map((f) => linkItem(f.slug, f.title)).join('\n    ')}
  </ul>
</aside>`;
  };

  buildLandingPage(outDir);
  buildDocumentationPage(features, renderSidebar('documentation'), outDir);
  buildDecisionsPage(renderSidebar('decisions'), outDir);
  buildFeaturePages(features, renderSidebar, outDir);
  buildAgentNotesPage(agentFeatures, outDir);
  buildAgentFeaturePages(agentFeatures, outDir);

  process.stdout.write('[docs] built landing + documentation + decisions + ' + features.length +
    ' feature page(s) + ' + agentFeatures.length + ' agent note page(s) -> ' +
    path.relative(ROOT, outDir) + '/\n');
}

main();
