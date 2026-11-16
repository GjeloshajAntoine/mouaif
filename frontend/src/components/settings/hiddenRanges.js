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

// Remove one normalized range [start, end] from `ranges`.
export function removeRange(ranges, target) {
  let normalized = [];
  try { normalized = normalizeRanges(ranges); } catch { normalized = Array.isArray(ranges) ? ranges : []; }
  return normalized.filter((r) => !(r.start === target.start && r.end === target.end));
}

export function rangeChipLabel({ start, end }) {
  return start === end ? `Line ${start}` : `Lines ${start}–${end}`;
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

// Check if `span` matches or overlaps any saved character span.
export function findMatchingCharSpan(chars, span) {
  if (!isValidCharSpan(span)) return null;
  const next = normalizeChars(chars);
  const exact = next.find((s) =>
    s.startLine === span.startLine && s.endLine === span.endLine && s.startCol === span.startCol && s.endCol === span.endCol);
  if (exact) return exact;
  return next.find((s) => {
    if (span.endLine < s.startLine || span.startLine > s.endLine) return false;
    if (s.startLine === s.endLine && span.startLine === span.endLine) {
      return Math.max(s.startCol, span.startCol) <= Math.min(s.endCol, span.endCol);
    }
    return true;
  }) || null;
}

// Remove one character span from `chars`.
export function removeCharSpan(chars, target) {
  if (!target) return normalizeChars(chars);
  return normalizeChars(chars).filter((s) =>
    !(s.startLine === target.startLine && s.endLine === target.endLine && s.startCol === target.startCol && s.endCol === target.endCol));
}

// Add or remove a character span. When a span is already present it is
// removed (a second tap on the same selection un-hides it); otherwise it
// is added and merged. Returns the new `chars` array.
export function toggleChar(chars, span) {
  const next = normalizeChars(chars);
  const present = next.some((s) =>
    s.startLine === span.startLine && s.endLine === span.endLine && s.startCol === span.startCol && s.endCol === span.endCol);
  if (present) return removeCharSpan(next, span);
  return normalizeChars([...next, span]);
}

// One span as a short location, e.g. `line 5, cols 8–17` or `lines 4–7`.
export function charSpanLabel({ startLine, endLine, startCol, endCol }) {
  const loc = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  const cols = startLine === endLine ? `, cols ${startCol}–${endCol}` : '';
  return `${loc}${cols}`;
}
// One label for a stored rule or an in-progress selection that can carry
// both whole-line ranges and character spans, so a list row never claims
// lines are hidden when only text is, e.g.
//   `Lines 3–5 · Text on line 8, cols 4–9`
//   `Text on line 8, cols 4–9`
//   `Lines 3–5`
//   `Nothing hidden`
export function describeHidden({ ranges = [], chars = [] } = {}) {
  const lines = Array.isArray(ranges) ? ranges : [];
  const spans = normalizeChars(chars);
  const parts = [];
  if (lines.length) parts.push(describeRanges(lines));
  if (spans.length) parts.push('Text on ' + spans.map(charSpanLabel).join('; '));
  return parts.join(' · ') || 'Nothing hidden';
}

// Apply a rule's ranges and character spans to `text`, returning the exact
// string the agent's read_file tool will see (`[hidden]` in place of hidden
// lines and character spans, preserving line numbers).
export function previewRedactedText(text, { ranges = [], chars = [] } = {}) {
  if (typeof text !== 'string') return '';
  let normRanges = [];
  try { normRanges = normalizeRanges(ranges); } catch { normRanges = []; }
  const normChars = normalizeChars(chars);
  if (!normRanges.length && !normChars.length) return text;
  const marker = '[hidden]';
  return text.split('\n').map((line, idx) => {
    const lineNumber = idx + 1;
    if (normRanges.some((r) => lineNumber >= r.start && lineNumber <= r.end)) return marker;
    const selected = normChars.filter((s) => lineNumber >= s.startLine && lineNumber <= s.endLine);
    if (!selected.length) return line;
    const codePoints = Array.from(line);
    const length = codePoints.length;
    const span = selected.reduce((acc, s) => {
      let from, to;
      if (s.startLine === s.endLine) {
        from = s.startCol - 1;
        to = s.endCol;
      } else if (lineNumber === s.startLine) {
        from = s.startCol - 1;
        to = length;
      } else if (lineNumber === s.endLine) {
        from = 0;
        to = s.endCol;
      } else {
        from = 0;
        to = length;
      }
      from = Math.max(0, Math.min(length, from));
      to = Math.max(from, Math.min(length, to));
      return { from: Math.min(acc.from, from), to: Math.max(acc.to, to) };
    }, { from: length, to: 0 });
    if (span.to <= span.from) return line;
    return codePoints.slice(0, span.from).join('') + marker + codePoints.slice(span.to).join('');
  }).join('\n');
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

export function hiddenContentPath({ projectDir = '', from = '', chatId = '', filePath = '' } = {}) {
  const params = new URLSearchParams({ projectDir });
  if (from) params.set('from', from);
  // `chatId` rides through the hide page (list ⇄ per-file editor) so the
  // whole project drill-down can hand it back on the way out and return to
  // the chat it started in.
  if (chatId) params.set('chatId', chatId);
  if (filePath) params.set('file', filePath);
  return 'settings/project/hide?' + params.toString();
}
