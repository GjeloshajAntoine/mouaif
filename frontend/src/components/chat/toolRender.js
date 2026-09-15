// mouaif web — Chat tool result preview renderers
//
// For each known tool name, render a structured preview of the
// result. Pure DOM (no Preact) so the SSE hot path stays as cheap
// as a textContent assignment. The subagent tool gets a separate
// chat-style render via renderSubagentChat in transcript.js.

import {
  coerceToolResult,
  formatBytes,
  formatReadableToolResult,
  formatToolArgsFull,
  normalizeToolName,
  parsePlainFileToolResult,
  TOOL_ARGS_PREVIEW_CHARS
} from './tools.js';
import { publish as publishWebPreview } from './webpreviewState.js';

// Caps for the expanded write_file content preview. The tool itself
// allows a 1 MB write; painting that as one text node would jank the
// expand, so the preview truncates and says so.
const MAX_WRITE_PREVIEW_LINES = 2000;
const MAX_WRITE_PREVIEW_CHARS = 200000;

// renderToolMeta(parent, items)
//
// Render the small "file.ts · 12 lines" header above a preview.
function renderToolMeta(parent, items) {
  const meta = document.createElement('div');
  meta.className = 'tool-preview__meta';
  meta.textContent = items.filter(Boolean).join(' · ');
  parent.appendChild(meta);
}

// buildToolArgs(parent, args, name) -> Element | null
//
// Build the card's complete call arguments when the head could not show
// them. The head is a single ellipsized line capped at
// TOOL_ARGS_PREVIEW_CHARS, so a long `shell` command — a commit-message
// heredoc, a compound `&&` command — is unreadable there and the
// expanded card is the only place the user can read what ran. Returns
// null when the head already showed everything, so a short call's
// expanded card carries no duplicate of its own header.
function buildToolArgs(args, name) {
  if (args == null) return null;
  const full = formatToolArgsFull(args, name);
  if (!full) return null;
  const head = full.length > TOOL_ARGS_PREVIEW_CHARS ? full.slice(0, TOOL_ARGS_PREVIEW_CHARS - 1).trimEnd() + '…' : full;
  if (head === full) return null;
  const wrap = document.createElement('div');
  wrap.className = 'tool-preview__args';
  const label = document.createElement('div');
  label.className = 'tool-preview__meta';
  label.textContent = name === 'shell' ? 'Command' : 'Arguments';
  const pre = createPreviewPre(full, 'tool-preview__pre tool-preview__pre--args');
  wrap.appendChild(label);
  wrap.appendChild(pre);
  return wrap;
}

// createPreviewPre(text, className)
//
// Build a <pre> without appending it, so a renderer can place it in the
// exact order it wants (an expanded shell card puts the command above the
// output).
function createPreviewPre(text, className) {
  const pre = document.createElement('pre');
  pre.className = className || 'tool-preview__pre';
  pre.textContent = text || '';
  return pre;
}

// renderPreviewPre(parent, text, className)
//
// Render a <pre> with the right class. Shared by every preview.
function renderPreviewPre(parent, text, className) {
  const pre = createPreviewPre(text, className);
  parent.appendChild(pre);
  return pre;
}

// renderDiffPreview(parent, text)
//
// Render a unified diff as a simple line-by-line HTML preview
// (gutter number + line text). CodeMirror is only used inside the
// file editor; the chat preview is plain DOM.
function renderDiffPreview(parent, text) {
  const host = document.createElement('div');
  host.className = 'tool-preview__diff';
  const raw = text == null ? '' : String(text);
  const lines = raw ? raw.split('\n') : ['(edit applied)'];
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const line = document.createElement('div');
    let kind = 'ctx';
    if (lineText.startsWith('+') && !lineText.startsWith('+++')) kind = 'add';
    else if (lineText.startsWith('-') && !lineText.startsWith('---')) kind = 'del';
    else if (lineText.startsWith('@@')) kind = 'hunk';
    else if (lineText.startsWith('---') || lineText.startsWith('+++')) kind = 'meta';
    line.className = 'tool-preview__diff-line tool-preview__diff-line--' + kind;

    const gutter = document.createElement('span');
    gutter.className = 'tool-preview__diff-gutter';
    gutter.textContent = String(i + 1);
    const code = document.createElement('span');
    code.className = 'tool-preview__diff-code';
    code.textContent = lineText || ' ';
    line.appendChild(gutter);
    line.appendChild(code);
    host.appendChild(line);
  }
  parent.appendChild(host);
  return host;
}

// imageBlockToElement(block) -> HTMLImageElement | null
//
// Render an MCP image content block. Supports both base64 (data +
// mimeType) and direct URL payloads.
function imageBlockToElement(block) {
  const data = block && (block.data || block.base64);
  const mimeType = (block && (block.mimeType || block.mime_type || block.mediaType || block.media_type)) || 'image/png';
  let src = block && (block.url || block.uri);
  if (!src && typeof data === 'string' && data) {
    src = data.startsWith('data:') ? data : ('data:' + mimeType + ';base64,' + data);
  }
  if (!src) return null;
  const img = document.createElement('img');
  img.className = 'tool-card__image';
  img.src = src;
  img.alt = 'MCP image result';
  img.loading = 'lazy';
  return img;
}

// resourceImageBlock(block) -> normalized image block | null
//
// MCP `resource` content blocks can carry an image blob
// ({ type:'resource', resource:{ blob, mimeType:'image/*' } }). Map
// those to the shape imageBlockToElement understands so they render
// inline instead of as a JSON stub.
function resourceImageBlock(block) {
  const res = block && block.resource;
  if (!res || typeof res !== 'object') return null;
  const mimeType = res.mimeType || res.mime_type || res.mediaType || res.media_type || '';
  if (!/^image\//i.test(mimeType)) return null;
  const data = res.blob || res.data || res.base64;
  if (typeof data !== 'string' || !data) return null;
  return { type: 'image', data, mimeType };
}

// renderReadFileToolResult(body, r)
//
// Text reads show the body. An image read shows the picture itself: the
// tool attaches the file's pixels as an `image` content block, so the card
// renders exactly what the model received. Tapping it opens a full-screen
// lightbox — the inline thumbnail is capped at 220 px, which is too small
// to read a screenshot on a phone.
function renderReadFileToolResult(body, r) {
  body.classList.add('tool-preview', 'tool-preview--file');
  if (typeof r === 'string') r = parsePlainFileToolResult(r);
  if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
  const meta = [];
  meta.push(r.relPath || r.path);
  if (r.kind === 'image') {
    meta.push(r.mimeType || 'image');
    if (r.bytes != null) meta.push(formatBytes(r.bytes));
    renderToolMeta(body, meta);
    return renderReadFileImage(body, r);
  }
  if (r.startLine != null && r.endLine != null) {
    meta.push('lines ' + r.startLine + '-' + r.endLine + (r.totalLines ? ' / ' + r.totalLines : ''));
  }
  if (r.truncated) meta.push('truncated');
  renderToolMeta(body, meta);
  renderPreviewPre(body, r.body || '', 'tool-preview__pre tool-preview__pre--content');
}

// renderReadFileImage(body, r)
//
// The pixels live in the result's `content` array (the same block shape an
// MCP image result uses). When the result reached the UI as plain text —
// subagent-nested rows, a replayed transcript — the base64 is gone, so the
// card says so instead of pretending the picture is there.
function renderReadFileImage(body, r) {
  const block = Array.isArray(r.content)
    ? r.content.find((c) => c && (c.type === 'image' || c.mimeType))
    : null;
  const img = block ? imageBlockToElement(block) : null;
  if (!img) {
    return renderPreviewPre(body, 'Image bytes are not part of this result.', 'tool-preview__pre');
  }
  img.alt = 'Image ' + (r.relPath || '');
  img.className = 'tool-card__image tool-card__image--zoomable';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool-card__image-button';
  button.setAttribute('aria-label', 'Open ' + (r.relPath || 'image') + ' full screen');
  button.appendChild(img);
  button.addEventListener('click', () => openImageLightbox(img.src, img.alt));
  body.appendChild(button);
  const note = document.createElement('div');
  note.className = 'tool-preview__image-note';
  note.textContent = 'Sent to the model as an image.';
  body.appendChild(note);
}

// openImageLightbox(src, alt)
//
// Full-screen viewer for a tool-card image, plain DOM so it works from the
// transcript's hot path. Closes on the button, on Escape, and on a tap
// outside the picture; the close target is 44 px so it works one-handed.
//
// The overlay lives at the document root, OUTSIDE the chat view, so unmounting
// the chat does not remove it — and nothing here is owned by Preact. Navigating
// away with it open (browser Back, a route change) used to leave a fixed,
// full-viewport cover on top of the next screen with its keydown listener still
// armed: every later open stacked another overlay and another listener. The
// teardown is therefore published as a cancelable window event the chat view
// fires on unmount, so the viewer has no import dependency on the app router.
const LIGHTBOX_TEARDOWN_EVENT = 'mouaif:teardown-lightbox';
function openImageLightbox(src, alt) {
  if (!src) return;
  // Only one lightbox at a time: a second open replaces the first (and drops
  // the listener with it) instead of covering it.
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try { window.dispatchEvent(new CustomEvent(LIGHTBOX_TEARDOWN_EVENT)); } catch { /* pre-CustomEvent host */ }
  }
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', alt || 'Image');
  const picture = document.createElement('img');
  picture.className = 'image-lightbox__image';
  picture.src = src;
  picture.alt = alt || '';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'image-lightbox__close';
  close.setAttribute('aria-label', 'Close image');
  close.textContent = '✕';
  const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
  function dismiss() {
    document.removeEventListener('keydown', onKey);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener(LIGHTBOX_TEARDOWN_EVENT, dismiss);
    }
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
  close.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener(LIGHTBOX_TEARDOWN_EVENT, dismiss);
  }
  overlay.appendChild(picture);
  overlay.appendChild(close);
  document.body.appendChild(overlay);
}

// teardownImageLightbox()
//
// Drop any open tool-card image viewer. Called by the chat view's unmount
// cleanup so a viewer left open cannot outlive the transcript that opened it.
export function teardownImageLightbox() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try { window.dispatchEvent(new CustomEvent(LIGHTBOX_TEARDOWN_EVENT)); } catch { /* nothing to tear down */ }
}

// renderListFilesToolResult(body, r)
//
// Grouped by directory: one small dir label per group, then one line
// per file with just the basename. Fewer DOM nodes and no repeated
// path prefix on every row.
function renderListFilesToolResult(body, r) {
  body.classList.add('tool-preview', 'tool-preview--list');
  if (typeof r === 'string') r = parsePlainFileToolResult(r);
  if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
  const meta = [];
  meta.push(r.pattern ? ('pattern ' + r.pattern) : 'all text and image files');
  if (Array.isArray(r.entries)) {
    meta.push(r.entries.length + ' shown');
    if (r.total != null && r.total !== r.entries.length) meta.push(r.total + ' total'); // legacy results only
  }
  if (r.skipped) meta.push(r.skipped + ' skipped');
  if (r.truncated) meta.push('capped');
  renderToolMeta(body, meta);
  if (!Array.isArray(r.entries)) {
    const lines = String(r.body || '').split('\n');
    return renderPreviewPre(body, lines.length && lines[0] ? lines.join('\n') : '(no matching files)', 'tool-preview__pre');
  }
  if (!r.entries.length) return renderPreviewPre(body, '(no matching files)', 'tool-preview__pre');
  const wrap = document.createElement('div');
  wrap.className = 'tool-preview__grouped';
  const sorted = [...r.entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let currentDir = null;
  let dirLabel = null;
  let list = null;
  for (const e of sorted) {
    const p = String(e.path || '');
    const slash = p.lastIndexOf('/');
    const dir = slash === -1 ? '.' : p.slice(0, slash);
    const name = slash === -1 ? p : p.slice(slash + 1);
    if (dir !== currentDir) {
      currentDir = dir;
      dirLabel = document.createElement('div');
      dirLabel.className = 'tool-preview__dir';
      dirLabel.textContent = dir === '.' ? '' : dir + '/';
      wrap.appendChild(dirLabel);
      list = document.createElement('div');
      list.className = 'tool-preview__group';
      wrap.appendChild(list);
    }
    const row = document.createElement('div');
    row.className = 'tool-preview__file';
    row.textContent = e.image ? (name + ' (image)') : name;
    list.appendChild(row);
  }
  body.appendChild(wrap);
}

// renderSearchFilesToolResult(body, r)
//
// Grouped by file: one path label per file, then "line: text" rows.
function renderSearchFilesToolResult(body, r) {
  body.classList.add('tool-preview', 'tool-preview--list');
  if (typeof r === 'string') r = parsePlainFileToolResult(r);
  if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
  const meta = [];
  meta.push(r.query ? ('search ' + r.query) : 'no query');
  if (Array.isArray(r.matches)) meta.push(r.matches.length + ' matches');
  if (r.filesScanned != null) meta.push(r.filesScanned + ' files');
  if (r.truncated) meta.push('capped');
  renderToolMeta(body, meta);
  if (!Array.isArray(r.matches)) {
    const lines = String(r.body || '').split('\n');
    return renderPreviewPre(body, lines.length && lines[0] ? lines.join('\n') : '(no matches)', 'tool-preview__pre');
  }
  if (!r.matches.length) return renderPreviewPre(body, '(no matches)', 'tool-preview__pre');
  const wrap = document.createElement('div');
  wrap.className = 'tool-preview__grouped';
  let currentPath = null;
  let list = null;
  for (const m of r.matches) {
    if (m.path !== currentPath) {
      currentPath = m.path;
      const dirLabel = document.createElement('div');
      dirLabel.className = 'tool-preview__dir';
      dirLabel.textContent = currentPath || '';
      wrap.appendChild(dirLabel);
      list = document.createElement('div');
      list.className = 'tool-preview__group';
      wrap.appendChild(list);
    }
    const row = document.createElement('div');
    row.className = 'tool-preview__match';
    const lineNo = document.createElement('span');
    lineNo.className = 'tool-preview__match-line';
    lineNo.textContent = String(m.line);
    const text = document.createElement('span');
    text.className = 'tool-preview__match-text';
    text.textContent = m.text || '';
    row.appendChild(lineNo);
    row.appendChild(text);
    list.appendChild(row);
  }
  body.appendChild(wrap);
}

// renderEditFileToolResult(body, r)
function renderEditFileToolResult(body, r) {
  body.classList.add('tool-preview', 'tool-preview--diff');
  if (typeof r === 'string') r = parsePlainFileToolResult(r);
  if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
  const meta = [r.relPath || r.path];
  if (r.addedChars != null) {
    meta.push('+' + r.addedChars + (r.removedChars != null ? ' / -' + r.removedChars : '') + ' chars');
  } else if (r.bytesWritten != null) {
    meta.push('+' + r.bytesWritten + 'B' + (r.replacedBytes != null ? ' / -' + r.replacedBytes + 'B' : ''));
  }
  renderToolMeta(body, meta);
  renderDiffPreview(body, r.diff || '(edit applied)');
}

// renderWriteFileToolResult(body, r, args)
//
// The result object carries metadata only (path, chars, lines), so the
// written content shown when the card is expanded comes from the call's
// arguments (`content`). When the arguments were lost — a result with no
// matching call row, or a nested preview with no call data — the card
// falls back to the plain "write complete" line.
function renderWriteFileToolResult(body, r, args) {
  body.classList.add('tool-preview', 'tool-preview--file');
  if (typeof r === 'string') r = parsePlainFileToolResult(r);
  if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
  const writeMeta = [r.relPath || r.path];
  if (r.chars != null) writeMeta.push(r.chars + ' chars' + (r.lines != null ? ' · ' + r.lines + ' lines' : ''));
  else if (r.bytesWritten != null) writeMeta.push(r.bytesWritten + 'B');
  else if (r.size != null) writeMeta.push(r.size + 'B');
  renderToolMeta(body, writeMeta);
  const content = args && typeof args.content === 'string' ? args.content : '';
  if (!content) return renderPreviewPre(body, 'write complete', 'tool-preview__pre');
  renderPreviewPre(body, writeContentPreview(content), 'tool-preview__pre tool-preview__pre--content');
}

// writeContentPreview(content) -> string
//
// Cap what one expanded write_file card paints. The write itself is
// capped server-side by `fileWriteMaxBytes` (1 MB default); rendering a
// file that size as a single text node janks the frame, so the preview
// stops at MAX_WRITE_PREVIEW_LINES / MAX_WRITE_PREVIEW_CHARS and says so.
function writeContentPreview(content) {
  const text = String(content);
  const lines = text.split('\n');
  if (lines.length <= MAX_WRITE_PREVIEW_LINES && text.length <= MAX_WRITE_PREVIEW_CHARS) return text;
  let kept = lines.slice(0, MAX_WRITE_PREVIEW_LINES).join('\n');
  if (kept.length > MAX_WRITE_PREVIEW_CHARS) kept = kept.slice(0, MAX_WRITE_PREVIEW_CHARS);
  return kept + '\n… preview truncated (' + lines.length + ' lines, ' + text.length + ' chars written)';
}

// renderShellToolResult(body, r, args)
//
// `args` is the call's own arguments when the caller has them; the full
// command is shown above the output when the head's one-line form had to
// ellipsize it (see buildToolArgs).
function renderShellToolResult(body, r, args) {
  body.classList.add('tool-preview', 'tool-preview--terminal');
  if (typeof r === 'string') r = coerceToolResult(r, 'shell');
  // What the model ran, when the collapsed head had to ellipsize it. Built
  // up front so both branches below can place it above the output.
  const cmdArgs = buildToolArgs(args, 'shell');
  // The command block is only present when the head had to truncate, and
  // its presence is what makes the body one continuous terminal: the
  // output's own border is dropped so there is no divider line between the
  // two sections (see .tool-preview--with-args). A card that shows output
  // alone keeps its box.
  if (cmdArgs) body.classList.add('tool-preview--with-args');
  if (!r || r.error) {
    if (cmdArgs) body.appendChild(cmdArgs);
    renderToolMeta(body, [r && r.identity, r && r.code, r && r.durationMs != null ? (r.durationMs + 'ms') : null]);
    return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__terminal');
  }
  const meta = [];
  if (r.identity) meta.push(r.identity);
  meta.push('exit ' + (r.exitCode ?? 0));
  if (r.durationMs != null) meta.push(r.durationMs + 'ms');
  if (r.stdout) meta.push(r.stdout.length + ' chars out');
  if (r.stderr) meta.push(r.stderr.length + ' chars err');
  renderToolMeta(body, meta);
  const out = [];
  if (r.stdout) out.push(r.stdout);
  if (r.stderr) {
    if (r.stdout) out.push('── stderr ──');
    out.push(r.stderr);
  }
  if (cmdArgs) body.appendChild(cmdArgs);
  renderPreviewPre(body, out.length ? out.join('\n\n') : '(exit ' + (r.exitCode ?? 0) + ', no output)', 'tool-preview__terminal');
}

// renderWebpreviewToolResult(body, r)
//
// The screenshot is a user-facing preview, not model feedback. Publish it
// to the dock above the composer and keep only a short status in the tool
// card so image bytes never become part of the scrolling transcript.
function renderWebpreviewToolResult(body, r) {
  body.classList.add('tool-preview', 'tool-preview--webpreview');
  if (typeof r === 'string') r = coerceToolResult(r, 'webpreview');
  if (!r || r.error) {
    return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
  }
  publishWebPreview(r);
  renderPreviewPre(body, 'Preview ready for the user.', 'tool-preview__pre');
}

// renderGenericToolResult(body, r)
//
// Fallback for tools without a dedicated renderer (MCP tools, etc.).
// Walks the `content` array of an MCP envelope and renders text
// blocks, images, and resource stubs.
function renderGenericToolResult(body, r) {
  if (r && Array.isArray(r.content)) {
    const lines = [];
    for (const c of r.content) {
      if (c && typeof c.text === 'string') lines.push(c.text);
      else if (c && c.type === 'image') {
        const img = imageBlockToElement(c);
        if (img) body.appendChild(img);
        else lines.push('[image]');
      } else if (c && c.type === 'resource') {
        const imgBlock = resourceImageBlock(c);
        const img = imgBlock && imageBlockToElement(imgBlock);
        if (img) body.appendChild(img);
        else lines.push('[resource] ' + JSON.stringify(c.resource || c));
      }
      else lines.push(String(c && (c.text || c.type) || c));
    }
    if (lines.length) renderPreviewPre(body, lines.join('\n'), 'tool-preview__pre');
    return;
  }
  renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
}

// renderTaskToolResult(body, r)
//
// Renders a task card with title, description, and progress bar.
// Supports both single-task results and task list results.
function renderTaskToolResult(body, r) {
  body.classList.add('tool-preview', 'tool-preview--task');
  if (typeof r === 'string') {
    try { r = JSON.parse(r); } catch { return renderPreviewPre(body, r, 'tool-preview__pre'); }
  }
  if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');

  // Task list
  if (Array.isArray(r.tasks)) {
    if (!r.tasks.length) {
      body.innerHTML = '<div class="tool-preview__task-empty">No tasks yet.</div>';
      return;
    }
    const list = document.createElement('div');
    list.className = 'tool-preview__task-list';
    for (const t of r.tasks) {
      const item = document.createElement('div');
      item.className = 'tool-preview__task-item tool-preview__task-item--' + (t.status === 'completed' ? 'done' : 'progress');
      const check = document.createElement('span');
      check.className = 'tool-preview__task-check';
      check.textContent = t.status === 'completed' ? '✓' : '○';
      const label = document.createElement('span');
      label.className = 'tool-preview__task-label';
      label.textContent = t.title;
      item.appendChild(check);
      item.appendChild(label);
      if (t.status !== 'completed' && t.total > 0) {
        const bar = document.createElement('div');
        bar.className = 'tool-preview__task-bar';
        const fill = document.createElement('div');
        fill.className = 'tool-preview__task-bar-fill';
        const pct = Math.min(100, Math.max(0, Math.round((t.current / t.total) * 100)));
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        item.appendChild(bar);
        const stat = document.createElement('div');
        stat.className = 'tool-preview__task-stat';
        stat.textContent = t.current + ' / ' + t.total;
        item.appendChild(stat);
      }
      if (t.description) {
        const desc = document.createElement('div');
        desc.className = 'tool-preview__task-desc';
        desc.textContent = t.description;
        item.appendChild(desc);
      }
      list.appendChild(item);
    }
    body.appendChild(list);
    return;
  }

  // Single task result (created / updated / completed)
  const task = r.task;
  if (!task) return renderGenericToolResult(body, r);
  const container = document.createElement('div');
  container.className = 'tool-preview__task-item tool-preview__task-item--' + (task.status === 'completed' ? 'done' : 'progress');
  const check = document.createElement('span');
  check.className = 'tool-preview__task-check';
  check.textContent = task.status === 'completed' ? '✓' : '○';
  const inner = document.createElement('div');
  inner.className = 'tool-preview__task-inner';
  const title = document.createElement('div');
  title.className = 'tool-preview__task-label';
  title.textContent = task.title;
  inner.appendChild(title);
  if (task.status !== 'completed' && task.total > 0) {
    const bar = document.createElement('div');
    bar.className = 'tool-preview__task-bar';
    const fill = document.createElement('div');
    fill.className = 'tool-preview__task-bar-fill';
    const pct = Math.min(100, Math.max(0, Math.round((task.current / task.total) * 100)));
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    inner.appendChild(bar);
    const stat = document.createElement('div');
    stat.className = 'tool-preview__task-stat';
    stat.textContent = task.current + ' / ' + task.total;
    inner.appendChild(stat);
  }
  if (task.description) {
    const desc = document.createElement('div');
    desc.className = 'tool-preview__task-desc';
    desc.textContent = task.description;
    inner.appendChild(desc);
  }
  container.appendChild(check);
  container.appendChild(inner);
  body.appendChild(container);
}

// renderToolResultBody(body, toolResult, isSubagentFn)
//
// The dispatcher called by appendToolResultCard in transcript.js.
// Strips the live streaming container for subagent cards (the
// final chat render replaces it) and then routes to the right
// per-tool renderer.
export function renderToolResultBody(body, toolResult, isSubagentFn) {
  if (isSubagentFn(toolResult && toolResult.name)) {
    const live = body.querySelector('.tool-card__subagent-live');
    if (live) live.remove();
  }
  body.textContent = '';
  body.className = 'tool-card__body';
  const cardTool = body.closest && body.closest('.tool-card');
  const name = normalizeToolName((toolResult && toolResult.name) || (cardTool && cardTool.dataset.toolName));
  const r = coerceToolResult(toolResult && toolResult.result, name);
  // Arguments a preview may need (write_file's content). The caller passes
  // them on the toolResult when it has them; the card keeps them too, so a
  // render reached through another path still finds them.
  const args = (toolResult && toolResult.args) || (cardTool && cardTool._toolArgs) || null;
  if (name === 'shell') return renderShellToolResult(body, r, args);
  if (name === 'read_file') return renderReadFileToolResult(body, r);
  if (name === 'list_files') return renderListFilesToolResult(body, r);
  if (name === 'search_files') return renderSearchFilesToolResult(body, r);
  if (name === 'edit_file') return renderEditFileToolResult(body, r);
  if (name === 'write_file') return renderWriteFileToolResult(body, r, args);
  if (name === 'task') return renderTaskToolResult(body, r);
  if (name === 'webpreview') return renderWebpreviewToolResult(body, r);
  if (isSubagentFn(toolResult && toolResult.name)) {
    // The full chat is rendered by renderSubagentChat in
    // transcript.js, which is called by the caller right after
    // this body fill. Nothing else to add here.
    return;
  }
  renderGenericToolResult(body, r);
}

// formatToolResult(toolResult) -> string
//
// Plain-text view of a tool result, used for inline summaries
// where structured rendering isn't appropriate.
export function formatToolResult(toolResult) {
  const r = toolResult && toolResult.result;
  if (!r) return '';
  if (Array.isArray(r.content)) {
    const parts = r.content.map((c) => {
      if (c && typeof c.text === 'string') return c.text;
      if (c && c.type === 'image') return '[image]';
      if (c && c.type === 'resource') return resourceImageBlock(c) ? '[image]' : JSON.stringify(c.resource || c);
      return JSON.stringify(c);
    });
    return parts.join('\n');
  }
  if (r.error) return JSON.stringify(r.error, null, 2);
  try { return JSON.stringify(r, null, 2); } catch { return String(r); }
}

export {
  imageBlockToElement,
  renderShellToolResult,
  renderReadFileToolResult,
  renderReadFileImage,
  openImageLightbox,
  renderListFilesToolResult,
  renderSearchFilesToolResult,
  renderEditFileToolResult,
  renderWriteFileToolResult,
  renderTaskToolResult
};
