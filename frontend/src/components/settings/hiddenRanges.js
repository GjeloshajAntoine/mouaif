// Canonical, inclusive line ranges shared by the visual and manual editors.
// Keep invalid input as text in the UI; never silently clamp it on Save.
export function normalizeRanges(ranges) {
  const sorted = ranges.map(({ start, end }) => {
    const a = Number(start), b = Number(end);
    if (String(start).trim() === '' || String(end).trim() === '' ||
        !Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a) {
      throw new Error('Enter whole line numbers: From must be at least 1, and To must not be before From.');
    }
    return { start: a, end: b };
  }).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function lineIsSelected(ranges, line) {
  return ranges.some(({ start, end }) => line >= start && line <= end);
}

export function toggleLine(ranges, line) {
  const normalized = normalizeRanges(ranges);
  if (!lineIsSelected(normalized, line)) return normalizeRanges([...normalized, { start: line, end: line }]);
  return normalized.flatMap((range) => {
    if (line < range.start || line > range.end) return [range];
    const parts = [];
    if (range.start < line) parts.push({ start: range.start, end: line - 1 });
    if (line < range.end) parts.push({ start: line + 1, end: range.end });
    return parts;
  });
}

export function describeRanges(ranges) {
  return ranges.length ? 'Lines ' + ranges.map(({ start, end }) => start === end ? start : `${start}–${end}`).join(', ') : 'No lines selected';
}

// ---- Character spans -----------------------------------------------------
// A character span hides selected text on one or more lines. Shape:
//   { startLine, endLine, startCol, endCol }
// all 1-indexed and inclusive; a single-line span has startLine === endLine.
// A multi-line span hides from startCol on the first line, the full middle
// lines, and up to endCol on the last line.

export function isValidCharSpan(span) {
  if (!span || typeof span !== 'object') return false;
  const { startLine, endLine, startCol, endCol } = span;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return false;
  if (startLine < 1 || endLine < startLine) return false;
  if (!Number.isInteger(startCol) || !Number.isInteger(endCol)) return false;
  if (startCol < 1 || endCol < 1) return false;
  // A single-line span must not be empty (end >= start); a multi-line span
  // only needs its boundary columns to be at least 1.
  if (startLine === endLine && endCol < startCol) return false;
  return true;
}

export function normalizeChars(chars) {
  const kept = (Array.isArray(chars) ? chars : []).filter(isValidCharSpan);
  if (!kept.length) return [];
  // Merge within the same single line, and drop a span fully contained in
  // another. Keep order stable for the UI.
  const merged = [];
  for (const span of kept) {
    const contained = merged.some((m) =>
      m.startLine <= span.startLine && m.endLine >= span.endLine &&
      (m.startLine !== m.endLine || (m.startCol <= span.startCol && m.endCol >= span.endCol)));
    if (contained) continue;
    if (span.startLine === span.endLine) {
      const sameLine = merged.find((m) => m.startLine === span.startLine && m.endLine === span.endLine);
      if (sameLine) {
        sameLine.startCol = Math.min(sameLine.startCol, span.startCol);
        sameLine.endCol = Math.max(sameLine.endCol, span.endCol);
        continue;
      }
    }
    merged.push({ ...span });
  }
  return merged;
}

// Add or remove a character span. When a span is already present it is
// removed (a second tap on the same selection un-hides it); otherwise it
// is added and merged. Returns the new `chars` array.
export function toggleChar(chars, span) {
  const next = normalizeChars(chars);
  const present = next.some((s) =>
    s.startLine === span.startLine && s.endLine === span.endLine && s.startCol === span.startCol && s.endCol === span.endCol);
  if (present) return next.filter((s) =>
    !(s.startLine === span.startLine && s.endLine === span.endLine && s.startCol === span.startCol && s.endCol === span.endCol));
  return normalizeChars([...next, span]);
}

export function describeChars(chars) {
  if (!chars.length) return 'No text selected';
  return chars.map(({ startLine, endLine, startCol, endCol }) => {
    const loc = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
    const cols = startLine === endLine ? `, cols ${startCol}–${endCol}` : '';
    return `${loc}${cols}`;
  }).join(', ');
}

// Count the number of hidden characters across all spans (best-effort for
// the status footer; it is not the true redaction count because it cannot
// know the per-line widths).
export function charSpanCount(chars) {
  return chars.reduce((n, s) => {
    if (s.startLine !== s.endLine) return n + 2; // boundary lines at least
    return n + (s.endCol - s.startCol + 1);
  }, 0);
}

export function hiddenContentPath({ projectDir = '', from = '', filePath = '' } = {}) {
  const params = new URLSearchParams({ projectDir });
  if (from) params.set('from', from);
  if (filePath) params.set('file', filePath);
  return 'settings/project/hide?' + params.toString();
}
