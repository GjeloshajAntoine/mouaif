// Simple server-side-markdown-safe renderer. Handles the common
// subset: fenced code blocks, inline code, headings, bold, italic,
// links, images, blockquotes, unordered/ordered lists, task lists,
// tables, horizontal rules, auto-linking bare URLs, backslash
// escapes, and line breaks. No dependencies, no DOMParser, no eval.
// Output is safe for innerHTML (all special chars escaped except
// those produced by the recognised patterns).

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Auto-link bare URLs that start with a protocol (http, https, ftp,
// mailto) or a www. prefix. Also link text like user@host for email.
function autoLink(text) {
  const urlRe = /(^|[\s([{>])(https?:\/\/[^\s<]+[^\s<.,:;!?)}\]'"\]>]|[a-z0-9.+-]+@[a-z0-9.-]+\.[a-z]{2,}|www\.[a-z0-9.-]+[^\s<.,:;!?)}\]'"\]>]+)/gi;
  return text.replace(urlRe, (match, before, url) => {
    // If it looks like an email
    if (/^[a-z0-9.+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(url)) {
      return before + '<a href="mailto:' + url + '">' + url + '</a>';
    }
    // If it starts with www, prepend http
    const href = url.match(/^www\./i) ? 'http://' + url : url;
    // Never auto-link the app's own SPA routes. Tool output (e.g. the
    // chrome-debug MCP "Page navigated to http://…/#/chat/<id>" text)
    // embeds these URLs; wrapping them in anchors means a stray tap
    // navigates the SPA to another chat. Keep them as plain text.
    if (/^https?:\/\/[^/]*\/#\//i.test(href)) return match;
    // Reject URLs that swallowed surrounding code/JSON punctuation
    // (quotes, braces, brackets, backslash). These are almost always
    // tool JSON or template-literal fragments, not real links.
    if (/["{}[\]\\]/.test(href)) return match;
    // Reject JS concatenation fragments like ' + safe + ' that sneak
    // through when they contain dots or @ signs.
    if (/\+\S*\+/.test(href)) return match;
    return before + '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
  });
}

// Inline-only pass: bold (**), italic (*), inline code (`), links
// ([text](url)), images (![alt](url)), strikethrough (~~),
// auto-link bare URLs, backslash-escaped special chars.
function renderInline(text) {
  let s = String(text);

  // Step 0: backslash escapes — replace escaped chars with
  // private-use placeholders so they survive all other passes.
  // Only escape \, `, *, _, ~, [, ], (, ), #, +, -, ., !, |, {, },
  // <, >, ".
  const escaped = [];
  s = s.replace(/\\([\\`*_~\[\]()#+\-.!|{}<>"])/g, (m, ch) => {
    escaped.push(ch);
    return '\uE002' + (escaped.length - 1) + '\uE002';
  });

  // Step 1: extract inline code so its contents are never re-processed.
  // The code content is HTML-escaped here so that code fragments the model
  // quotes (e.g. `<img src="/+ safe +">` or `![alt](url)` in a reasoning
  // trace) render as literal text, never as live <img>/<a> elements. Without
  // this, a quoted `<img src="/+ safe +">` becomes a real <img> whose src
  // the browser loads — navigating the SPA to a garbage path like
  // '/+%20safe%20+' (the "auto-redirect" bug).
  const codeSpans = [];
  s = s.replace(/`([^`]+)`/g, (m, code) => {
    codeSpans.push('<code>' + escapeHtml(code) + '</code>');
    return '\uE001' + (codeSpans.length - 1) + '\uE001';
  });

  // Step 2: escape remaining HTML special chars (code was already safe)
  s = escapeHtml(s);

  // Step 3: images (before links). Never let an image target the app's own
  // SPA routes — a live <img src="/..."> makes the browser fetch the app
  // shell as an image (and a quoted `![alt](url)` in a reasoning trace would
  // otherwise load garbage paths). Render the alt text as plain text instead.
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
    if (/^(https?:\/\/[^/]*)?\/#\//i.test(url.trim())) return alt;
    return '<img src="' + url + '" alt="' + alt + '" loading="lazy" />';
  });

  // Step 4: links. Never let an explicit link target the app's own SPA
  // routes (http(s)://…/#/… or a root-relative /#/…). Tool output
  // embeds these URLs; a live anchor lets a stray tap navigate the SPA to
  // another chat/route (the "auto-redirect" bug). Render the label as plain
  // text instead. autoLink() already guards the bare-URL shape; this closes
  // the explicit-link shape it never covered. (label/url are already
  // HTML-escaped by step 2.)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
    if (/^(https?:\/\/[^/]*)?\/#\//i.test(url.trim())) return label;
    return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });

  // Step 5: auto-link bare URLs (only on text not already inside a tag)
  s = autoLink(s);

  // Step 6: bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Step 7: italic
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Step 8: strikethrough
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Step 9: restore inline code spans
  s = s.replace(/\uE001(\d+)\uE001/g, (m, i) => codeSpans[Number(i)] || m);

  // Step 9b: escape auto-linked hrefs that are actually code fragments
  // containing '+' concatenation or other JS expressions — these look like
  // real URLs after auto-linking but would navigate to garbage paths like
  // '/+%20safe%20+'. The inline-code step above already extracted backtick
  // content, but code fragments written without backticks (e.g. ' + safe + '
  // in a server-side template literal) can reach autoLink as bare text.
  s = s.replace(/<a\s+href="([^"]*)"[^>]*>[^<]+<\/a>/gi, (match, href) => {
    if (/\+[^=]*\+/.test(href) && /^https?:\/\//i.test(href)) {
      return match.replace(/<a\s+/i, '<a rel="nofollow noopener noreferrer" onclick="return false" ');
    }
    return match;
  });

  // Step 10: restore backslash-escaped literal characters
  s = s.replace(/\uE002(\d+)\uE002/g, (m, i) => escaped[Number(i)] || m);

  return s;
}

function renderInlineLines(lines) {
  return lines.map((line) => renderInline(line)).join('<br>');
}

// Render a pipe table. Returns the HTML string or null if the lines
// don't look like a table.
function renderTable(lines) {
  // A table must have at least 3 lines: header, separator, first row.
  // The separator line has |, -, and optional : for alignment.
  if (lines.length < 2) return null;
  // Check for a separator line (second line is |--...--| or similar).
  const sepRe = /^\|?[\s:]*-{3,}[\s:]*(\|[\s:]*-{3,}[\s:]*)*\|?$/;
  if (!sepRe.test(lines[1].replace(/\s+/g, ''))) return null;
  // First line is the header.
  const headerCells = lines[0].split('|').filter(c => c.trim() !== '');
  // If it doesn't start/end with |, assume the first/last split is empty
  // but we already filtered empties. But we need to handle leading/trailing
  // pipes properly. Let's do it properly:
  const splitRow = (row) => {
    const parts = row.split('|');
    // If the row starts with |, first element is empty; if ends with |, last is empty.
    const startIdx = /^\s*\|/.test(row) ? 1 : 0;
    const endIdx = /\|\s*$/.test(row) ? parts.length - 1 : parts.length;
    return parts.slice(startIdx, endIdx).map(c => c.trim());
  };
  const headers = splitRow(lines[0]);
  const aligns = splitRow(lines[1]).map(a => {
    a = a.replace(/\s+/g, '');
    if (/^:-+$/.test(a)) return ' style="text-align:left"';
    if (/^-+:$/.test(a)) return ' style="text-align:right"';
    if (/^:-+:$/.test(a)) return ' style="text-align:center"';
    return '';
  });
  let html = '<table><thead><tr>';
  for (let i = 0; i < headers.length; i++) {
    html += '<th' + (aligns[i] || '') + '>' + renderInline(headers[i]) + '</th>';
  }
  html += '</tr></thead><tbody>';
  for (let r = 2; r < lines.length; r++) {
    const cells = splitRow(lines[r]);
    if (cells.length === 0) continue; // empty row
    html += '<tr>';
    for (let c = 0; c < Math.max(cells.length, headers.length); c++) {
      html += '<td' + ((aligns[c] || '') && c < aligns.length ? aligns[c] : '') + '>' + renderInline(cells[c] || '') + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// Split into blocks by blank lines, then render each block.
// Fenced code blocks are detected first and left as-is.
export function renderMarkdown(text) {
  if (!text) return '';

  // Fenced code blocks: extract them before splitting into paragraphs.
  const blocks = [];
  let rest = String(text);
  // Opening fence: ``` or ~~~ followed by an optional info string.
  const codeBlockRe = /^(```|~~~)([^\n]*)$/m;

  while (rest.length) {
    const m = codeBlockRe.exec(rest);
    if (!m) break;
    const fence = m[1];
    const lang = (m[2].trim().split(/\s+/)[0] || '');
    const fenceEndRe = new RegExp('^' + fence + '\\s*$', 'm');
    // Everything before the code fence is normal text
    const before = rest.slice(0, m.index);
    if (before.trim()) blocks.push({ type: 'para', text: before });
    rest = rest.slice(m.index + m[0].length);
    // Find the closing fence
    const endMatch = fenceEndRe.exec(rest);
    if (!endMatch) {
      // No closing fence — treat as regular text
      blocks.push({ type: 'para', text: fence + m[2] + '\n' + rest });
      rest = '';
      break;
    }
    const codeContent = rest.slice(0, endMatch.index);
    rest = rest.slice(endMatch.index + endMatch[0].length);
    blocks.push({ type: 'code', lang, content: codeContent });
  }
  // Any remaining text
  if (rest.trim()) blocks.push({ type: 'para', text: rest });

  const out = [];
  for (const block of blocks) {
    if (block.type === 'code') {
      out.push('<pre><code' + (block.lang ? ' class="language-' + escapeHtml(block.lang) + '"' : '') + '>' + escapeHtml(block.content) + '</code></pre>');
      continue;
    }
    // Paragraph block — split by double newline into paragraphs
    const paragraphs = block.text.split(/\n\n+/);
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      const lines = trimmed.split('\n');

      // Horizontal rule: a line that is ---, ***, or ___ (3+ chars,
      // optionally with spaces). Must be the only content in the block.
      if (lines.length === 1 && /^ {0,3}([-*_]){3,}\s*$/.test(lines[0])) {
        out.push('<hr>');
        continue;
      }

      // Blockquote
      if (/^\s*>/.test(lines[0])) {
        const quoteLines = lines.map(l => l.replace(/^\s*> ?/, ''));
        out.push('<blockquote>' + renderInlineLines(quoteLines) + '</blockquote>');
        continue;
      }

      // Table detection: if the block has ≥ 2 lines and line 2 is a
      // separator (|---...---|), treat the whole block as a table.
      if (lines.length >= 2) {
        const tableHtml = renderTable(lines);
        if (tableHtml) {
          out.push(tableHtml);
          continue;
        }
      }

      // Unordered list (also handles task lists)
      if (/^\s*[-*+]\s/.test(lines[0]) || /^\s*[-*+]\s+\[[ x]\]\s/i.test(lines[0])) {
        out.push('<ul>');
        for (const line of lines) {
          // Check for task list item: - [ ] or - [x]
          const taskMatch = line.match(/^\s*[-*+]\s+\[([ x])\]\s+(.*)/i);
          if (taskMatch) {
            const checked = taskMatch[1].toLowerCase() === 'x' ? ' checked' : '';
            out.push('<li class="task-list-item">'
              + '<label><input type="checkbox" disabled' + checked + '> '
              + renderInline(taskMatch[2]) + '</label></li>');
            continue;
          }
          const li = line.match(/^\s*[-*+]\s+(.*)/);
          if (li) {
            out.push('<li>' + renderInline(li[1]) + '</li>');
          } else {
            // Continuation line — append <br> to previous li
            if (out[out.length - 1].startsWith('<li')) {
              out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, '<br>' + renderInline(line) + '</li>');
            }
          }
        }
        out.push('</ul>');
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s/.test(lines[0])) {
        out.push('<ol>');
        for (const line of lines) {
          const li = line.match(/^\s*\d+\.\s+(.*)/);
          if (li) {
            out.push('<li>' + renderInline(li[1]) + '</li>');
          } else {
            if (out[out.length - 1].startsWith('<li')) {
              out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, '<br>' + renderInline(line) + '</li>');
            }
          }
        }
        out.push('</ol>');
        continue;
      }

      // Heading
      const hMatch = lines[0].match(/^(#{1,6})\s+(.*)/);
      if (hMatch) {
        const level = hMatch[1].length;
        const headingText = lines.slice(0, 1).map(l => l.replace(/^#+\s*/, '')).join(' ');
        const restLines = lines.slice(1).join('\n');
        out.push('<h' + level + '>' + renderInline(headingText) + '</h' + level + '>');
        if (restLines.trim()) {
          out.push('<p>' + renderInlineLines(restLines.trim().split('\n')) + '</p>');
        }
        continue;
      }

      // Regular paragraph (with line breaks)
      out.push('<p>' + renderInlineLines(lines) + '</p>');
    }
  }
  return out.join('\n');
}