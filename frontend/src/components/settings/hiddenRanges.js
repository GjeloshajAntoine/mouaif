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

export function hiddenContentPath({ projectDir = '', from = '', filePath = '' } = {}) {
  const params = new URLSearchParams({ projectDir });
  if (from) params.set('from', from);
  if (filePath) params.set('file', filePath);
  return 'settings/project/hide?' + params.toString();
}
