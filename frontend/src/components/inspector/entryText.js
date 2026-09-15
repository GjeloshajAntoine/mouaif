// Inspector entry text — turn a tapped detail-sheet entry (a console log, an
// exception, or a network request) into the plain text the "Add to chat"
// button appends to a chat draft.
//
// Kept as a pure function so the formatting is unit-testable without a DOM,
// and so the draft text stays identical no matter which panel opened the
// sheet. The sheet itself only supplies the page identity as context
// (`pageTitle` / `pageUrl`), because the entry carries the *source* URL but
// not the page the inspector is attached to.

import { fmtTime, fmtBytes, fmtDur, statusLabel } from './format.js';

// pageLabel — name the inspected page in the draft. The document title is
// the readable identity; fall back to the URL, then to a neutral phrase so
// the draft still reads as a sentence when the inspector is unattached.
function pageLabel(context) {
  const title = context && typeof context.pageTitle === 'string' ? context.pageTitle.trim() : '';
  if (title) return title;
  const url = context && typeof context.pageUrl === 'string' ? context.pageUrl.trim() : '';
  if (url) return url;
  return 'the inspected page';
}

function sourceLine(item) {
  if (!item.url) return '';
  return 'Source: ' + item.url + (item.line ? ':' + item.line : '');
}

// buildConsoleText — a console log or an uncaught exception.
function buildConsoleText(item, context) {
  const level = item.level || 'log';
  const kindLabel = item.kind === 'exception' ? 'exception' : 'console ' + level;
  const head = 'Inspector ' + kindLabel + ' — ' + pageLabel(context);
  const lines = [head];
  const prefix = [fmtTime(item.ts), String(level).toUpperCase()].filter(Boolean).join(' ');
  lines.push((prefix ? prefix + ' ' : '') + (item.text || ''));
  const src = sourceLine(item);
  if (src) lines.push(src);
  if (item.stack) lines.push('Stack:', item.stack);
  return lines.join('\n');
}

// buildNetworkText — a network request row.
function buildNetworkText(item, context) {
  const status = statusLabel(item.status);
  const head = 'Inspector request ' + (item.method || 'GET') + ' ' + status + ' — ' + pageLabel(context);
  const lines = [head, item.url || ''];
  const meta = [
    item.type || '',
    item.mimeType ? String(item.mimeType).split(';')[0] : '',
    fmtBytes(item.size),
    fmtDur(item.duration)
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(' · '));
  // A transport failure names the cause; an HTTP status's text ("Not Found")
  // is not an error and is already implied by the status in the header.
  if (item.status === 'failed' && item.statusText) lines.push('Error: ' + item.statusText);
  return lines.join('\n');
}

// buildEntryText — dispatch on the entry kind. Returns '' for a missing
// entry so the caller can disable the button instead of appending blanks,
// and never throws on a partial entry (a row can arrive before its
// response headers, with no status or size yet).
export function buildEntryText(item, context) {
  if (!item || typeof item !== 'object') return '';
  const text = item.kind === 'request' ? buildNetworkText(item, context) : buildConsoleText(item, context);
  return text.trim();
}
