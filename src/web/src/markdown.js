// Simple server-side-markdown-safe renderer. Handles the common
// subset: fenced code blocks, inline code, headings, bold, italic,
// links, images, blockquotes, unordered/ordered lists, paragraphs,
// and line breaks. No dependencies, no DOMParser, no eval.
// Output is safe for innerHTML (all special chars escaped except
// those produced by the recognised patterns).

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Inline-only pass: bold (**), italic (*), inline code (`), links ([text](url)), images (![alt](url)), strikethrough (~~)
function renderInline(text) {
  // Inline code is extracted first so its contents are never re-processed
  // as bold/italic/links/etc. Private-use placeholders are swapped back
  // at the end (U+E001 cannot appear in real chat text).
  const codeSpans = [];
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, (m, code) => {
    codeSpans.push('<code>' + code + '</code>');
    return '\uE001' + (codeSpans.length - 1) + '\uE001';
  });
  // Images (must come before links)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />');
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // Bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // Italic
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  // Strikethrough
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // Restore inline code spans
  s = s.replace(/\uE001(\d+)\uE001/g, (m, i) => codeSpans[Number(i)]);
  return s;
}

function renderInlineLines(lines) {
  return lines.map((line) => renderInline(line)).join('<br>');
}

// Split into blocks by blank lines, then render each block.
// Fenced code blocks are detected first and left as-is.
export function renderMarkdown(text) {
  if (!text) return '';

  // Fenced code blocks: extract them before splitting into paragraphs.
  const blocks = [];
  let rest = String(text);
  // Opening fence: ``` or ~~~ followed by an optional info string.
  // The language is the first word of the info string (CommonMark-style);
  // any trailing words on the fence line are ignored.
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
      // Check for blockquote
      if (/^\s*>/.test(lines[0])) {
        const quoteLines = lines.map(l => l.replace(/^\s*> ?/, ''));
        out.push('<blockquote>' + renderInlineLines(quoteLines) + '</blockquote>');
        continue;
      }
      // Check for unordered list
      if (/^\s*[-*+]\s/.test(lines[0])) {
        out.push('<ul>');
        for (const line of lines) {
          const li = line.match(/^\s*[-*+]\s+(.*)/);
          if (li) {
            out.push('<li>' + renderInline(li[1]) + '</li>');
          } else {
            if (out[out.length - 1].startsWith('<li>')) out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, '<br>' + renderInline(line) + '</li>');
          }
        }
        out.push('</ul>');
        continue;
      }
      // Check for ordered list
      if (/^\s*\d+\.\s/.test(lines[0])) {
        out.push('<ol>');
        for (const line of lines) {
          const li = line.match(/^\s*\d+\.\s+(.*)/);
          if (li) {
            out.push('<li>' + renderInline(li[1]) + '</li>');
          } else {
            if (out[out.length - 1].startsWith('<li>')) out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, '<br>' + renderInline(line) + '</li>');
          }
        }
        out.push('</ol>');
        continue;
      }
      // Check for heading
      const hMatch = lines[0].match(/^(#{1,6})\s+(.*)/);
      if (hMatch) {
        const level = hMatch[1].length;
        const headingText = lines.slice(0, 1).map(l => l.replace(/^#+\s*/, '')).join(' ');
        const restLines = lines.slice(1).join('\n');
        out.push('<h' + level + '>' + renderInline(headingText) + '</h' + level + '>');
        if (restLines.trim()) {
          // Remaining text after heading inside same block
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
