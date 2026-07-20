// mouaif web — Chat tool result preview renderers
//
// For each known tool name, render a structured preview of the
// result. Pure DOM (no Preact) so the SSE hot path stays as cheap
// as a textContent assignment. The subagent tool gets a separate
// chat-style render via renderSubagentChat in transcript.js.

import { RangeSetBuilder } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import {
  coerceToolResult,
  formatReadableToolResult,
  normalizeToolName,
  parsePlainFileToolResult
} from './tools.js';

// renderToolMeta(parent, items)
//
// Render the small "file.ts · 12 lines" header above a preview.
function renderToolMeta(parent, items) {
  const meta = document.createElement('div');
  meta.className = 'tool-preview__meta';
  meta.textContent = items.filter(Boolean).join(' · ');
  parent.appendChild(meta);
}

// renderPreviewPre(parent, text, className)
//
// Render a <pre> with the right class. Shared by every preview.
function renderPreviewPre(parent, text, className) {
  const pre = document.createElement('pre');
  pre.className = className || 'tool-preview__pre';
  pre.textContent = text || '';
  parent.appendChild(pre);
  return pre;
}

// diffDecorations(view)
//
// Build a CodeMirror RangeSet that color-codes the +/-/@@ lines
// of a unified diff. Used by the edit_file preview when the file
// is opened in the chat's file editor.
function diffDecorations(view) {
  const builder = new RangeSetBuilder();
  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    const text = line.text;
    const cls = text.startsWith('+') && !text.startsWith('+++')
      ? 'cm-diff-added'
      : text.startsWith('-') && !text.startsWith('---')
        ? 'cm-diff-removed'
        : text.startsWith('@@')
          ? 'cm-diff-hunk'
          : '';
    if (cls) builder.add(line.from, line.from, Decoration.line({ class: cls }));
  }
  return builder.finish();
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

// renderReadFileToolResult(body, r)
function renderReadFileToolResult(body, r) {
  body.classList.add('tool-preview', 'tool-preview--file');
  if (typeof r === 'string') r = parsePlainFileToolResult(r);
  if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
  renderToolMeta(body, [
    r.relPath || r.path,
    (r.startLine != null && r.endLine != null)
      ? ('lines ' + r.startLine + '-' + r.endLine + (r.totalLines ? ' / ' + r.totalLines : ''))
      : null
  ]);
  renderPreviewPre(body, r.body || '', 'tool-preview__pre tool-preview__pre--content');
}

// renderListFilesToolResult(body, r)
function renderListFilesToolResult(body, r) {
  body.classList.add('tool-preview', 'tool-preview--list');
  if (typeof r === 'string') r = parsePlainFileToolResult(r);
  if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
  renderToolMeta(body, [
    r.pattern ? ('pattern ' + r.pattern) : 'all text files',
    Array.isArray(r.entries) ? (r.entries.length + ' shown') : null,
    r.skipped ? (r.skipped + ' skipped') : null,
    r.truncated ? 'capped' : null
  ]);
  const lines = Array.isArray(r.entries)
    ? r.entries.map((e) => (e.path || '') + (e.size != null ? '\t' + e.size : ''))
    : String(r.body || '').split('\n');
  renderPreviewPre(body, lines.length && lines[0] ? lines.join('\n') : '(no matching files)', 'tool-preview__pre tool-preview__pre--list');
}

// renderSearchFilesToolResult(body, r)
function renderSearchFilesToolResult(body, r) {
  body.classList.add('tool-preview', 'tool-preview--list');
  if (typeof r === 'string') r = parsePlainFileToolResult(r);
  if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
  renderToolMeta(body, [r.query ? ('search ' + r.query) : null, Array.isArray(r.matches) ? (r.matches.length + ' matches') : null]);
  const lines = Array.isArray(r.matches)
    ? r.matches.map((m) => (m.path || '') + ':' + m.line + ': ' + (m.text || ''))
    : String(r.body || '').split('\n');
  renderPreviewPre(body, lines.length && lines[0] ? lines.join('\n') : '(no matches)', 'tool-preview__pre tool-preview__pre--list');
}

// renderEditFileToolResult(body, r)
function renderEditFileToolResult(body, r) {
  body.classList.add('tool-preview', 'tool-preview--diff');
  if (typeof r === 'string') r = parsePlainFileToolResult(r);
  if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
  renderToolMeta(body, [r.relPath || r.path]);
  renderDiffPreview(body, r.diff || '(edit applied)');
}

// renderWriteFileToolResult(body, r)
function renderWriteFileToolResult(body, r) {
  body.classList.add('tool-preview', 'tool-preview--file');
  if (typeof r === 'string') r = parsePlainFileToolResult(r);
  if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
  renderToolMeta(body, [r.relPath || r.path]);
  renderPreviewPre(body, 'write complete', 'tool-preview__pre');
}

// renderShellToolResult(body, r)
function renderShellToolResult(body, r) {
  body.classList.add('tool-preview', 'tool-preview--terminal');
  if (typeof r === 'string') r = coerceToolResult(r, 'shell');
  if (!r || r.error) {
    renderToolMeta(body, [r && r.code, r && r.durationMs != null ? (r.durationMs + 'ms') : null]);
    return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__terminal');
  }
  renderToolMeta(body, ['exit ' + (r.exitCode ?? 0), r.durationMs != null ? (r.durationMs + 'ms') : null]);
  const out = [];
  if (r.stdout) out.push(r.stdout);
  if (r.stderr) {
    if (r.stdout) out.push('── stderr ──');
    out.push(r.stderr);
  }
  renderPreviewPre(body, out.length ? out.join('\n\n') : '(exit ' + (r.exitCode ?? 0) + ', no output)', 'tool-preview__terminal');
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
      } else if (c && c.type === 'resource') lines.push('[resource] ' + JSON.stringify(c.resource || c));
      else lines.push(String(c && (c.text || c.type) || c));
    }
    if (lines.length) renderPreviewPre(body, lines.join('\n'), 'tool-preview__pre');
    return;
  }
  renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
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
  if (name === 'shell') return renderShellToolResult(body, r);
  if (name === 'read_file') return renderReadFileToolResult(body, r);
  if (name === 'list_files') return renderListFilesToolResult(body, r);
  if (name === 'search_files') return renderSearchFilesToolResult(body, r);
  if (name === 'edit_file') return renderEditFileToolResult(body, r);
  if (name === 'write_file') return renderWriteFileToolResult(body, r);
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
      if (c && c.type === 'resource') return JSON.stringify(c.resource || c);
      return JSON.stringify(c);
    });
    return parts.join('\n');
  }
  if (r.error) return JSON.stringify(r.error, null, 2);
  try { return JSON.stringify(r, null, 2); } catch { return String(r); }
}

export {
  diffDecorations,
  imageBlockToElement,
  renderShellToolResult,
  renderReadFileToolResult,
  renderListFilesToolResult,
  renderSearchFilesToolResult,
  renderEditFileToolResult,
  renderWriteFileToolResult
};
