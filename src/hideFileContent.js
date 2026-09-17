'use strict';
// Per-project "hide file content" (redaction) rules.
//
// The user can mark line ranges of a specific source file that the agent
// file tools should not reveal, and can also select arbitrary text to hide
// by character range. This module owns the read side: it loads the rules
// from the project settings (<projectDir>/.mouaif.json or the DB-backed
// project row, via src/settings.js) and tells the file-tool runners which
// lines (and which characters within a line) of which file are hidden.
//
// The rules are stored on the project object under `hideFileContent`:
//   [
//     { path: 'src/index.js',
//       ranges: [ { start: 12, end: 20 }, { start: 45, end: 45 } ],   // whole lines
//       chars:  [ { startLine: 3, endLine: 3, startCol: 5, endCol: 11 } ] } // character spans
//   ]
// `path` is a POSIX-relative path from the project root (the same value
// the file picker reports). `ranges` are 1-indexed, inclusive line spans;
// `chars` are 1-indexed, inclusive line & column spans. Both are optional
// per rule (older saved rules only have `ranges`), so existing data stays
// valid. A character span hides the selected characters on its boundary
// lines and the full lines between them.
//
// Scope: only the tools that *reveal* content are redacted — `read_file`
// and `search_files`. `list_files` lists paths (no content), and
// `write_file` / `edit_file` modify the on-disk file rather than exposing
// it, so they are not changed. The user-facing authorization preview card
// is also left intact: it is shown to the project owner who configured the
// redaction, not to the model.
//
// Everything here is best-effort and never throws: a missing project, a
// malformed rule, or a file that no longer exists must not crash a tool
// call. If the rules cannot be read, the tools behave exactly as if no
// redaction were configured.
const settings = require('./settings.js');
// Marker that replaces the body of a hidden line. Kept short so it does
// not dominate the model context, but distinct enough that the model can
// tell a line was intentionally withheld.
const REDACT_MARKER = '[hidden]';
// Return the stored redaction entries for a project. Always returns an
// array; any read problem yields [] so the callers can no-op.
function getEntries(projectDir) {
if (!projectDir || typeof projectDir !== 'string') return [];
let project;
try { project = settings.getProject(projectDir); }
catch { return []; }
const entries = project && project.hideFileContent;
return Array.isArray(entries) ? entries : [];
}
// Normalize a project file path to a POSIX-relative path with no leading
// './'. Mirrors src/tools/files.js toRelPath's output so rule paths match
// the rel paths the tools compute. Returns '' for anything non-string so a
// malformed rule can never match and hide the wrong file.
function normalizePath(p) {
if (typeof p !== 'string' || !p.trim()) return '';
// Strip a leading `./` BEFORE the slash collapsing, so a rule the user
// saved as `./src/a.js` (the editor reports paths with the prefix in some
// flows) lands on the same value src/tools/files.js toRelPath computes.
// Otherwise the rule is silently dead: it never matches the file it was
// written to hide. This was the previously-broken `while (s.startsWith`
// line, which ran before `s` was declared.
let s = p.trim().replace(/\\/g, '/');
while (s.startsWith('./')) s = s.slice(2);
s = s.replace(/\/+/g, '/').replace(/\/+$/, '');
return s;
}
// Sanitize a single character span to { startLine, endLine, startCol,
// endCol }. Columns are 1-indexed, inclusive character positions; lines
// are 1-indexed, inclusive. A span must be non-empty (the end position
// must be at or after the start) to be worth storing. Returns null for a
// malformed span so the caller can drop it.
function normalizeCharSpan(raw) {
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
const startLine = Number.isInteger(raw.startLine) ? raw.startLine : 0;
const endLine = Number.isInteger(raw.endLine) ? raw.endLine : 0;
const startCol = Number.isInteger(raw.startCol) ? raw.startCol : 0;
const endCol = Number.isInteger(raw.endCol) ? raw.endCol : 0;
// Validate line ordering first, then the column ordering for a
// single-line span (a multi-line span allows any column, since the
// middle lines are fully hidden and the boundary lines are partial).
if (startLine < 1 || endLine < startLine) return null;
if (startCol < 1 || endCol < startCol) {
// A multi-line span only needs its boundary columns to be at least 1.
if (startLine === endLine) return null;
if (startCol < 1 || endCol < 1) return null;
}
return { startLine, endLine, startCol, endCol };
}
// Sanitize a single rules entry to a { path, ranges, chars } shape. Invalid
// spans are dropped; valid spans are kept with start clamped to <= end.
// Returns null for a malformed entry (no path, or no spans at all) so the
// caller can skip it. Both `ranges` (line spans) and `chars` (character
// spans) are optional; a rule needs at least one of them to be worth
// storing.
function normalizeEntry(raw) {
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
const path = normalizePath(raw.path);
if (!path) return null;
const ranges = Array.isArray(raw.ranges)
? raw.ranges.filter((r) => r && typeof r === 'object').map((r) => {
const start = Number.isInteger(r.start) ? r.start : 0;
const end = Number.isInteger(r.end) ? r.end : 0;
if (start < 1 || end < start) return null;
return { start, end };
}).filter(Boolean)
: [];
const chars = Array.isArray(raw.chars)
? raw.chars.filter((c) => c && typeof c === 'object').map(normalizeCharSpan).filter(Boolean)
: [];
if (!ranges.length && !chars.length) return null;
// Keep the serialized shape clean and backward-compatible: only include
// `chars` when there are character spans, so a line-only rule stays
// `{ path, ranges }` exactly as it was before character ranges existed.
const entry = { path, ranges };
if (chars.length) entry.chars = chars;
return entry;
}
// Are `line` (1-indexed) and any other line within a hidden range of the
// given rule? `line` is a single 1-indexed line number.
function isLineHidden(rule, line) {
if (!rule || !rule.ranges || !Number.isInteger(line) || line < 1) return false;
return rule.ranges.some((r) => line >= r.start && line <= r.end);
}
// Apply the character spans of `rule` to a single line of text and return
// the redacted line (or the original). `lineNumber` is the 1-indexed line
// in the file; the whole-line `hidden` flag is also honoured. Character
// spans on a line are redacted in place: the selected characters are
// replaced by the marker. A single-line span hides [startCol, endCol]; a
// multi-line span hides from startCol on the first line, the full middle
// lines, and up to endCol on the last. Returns { text, redacted }.
function redactLine(rule, lineNumber, line, hidden) {
let text = line;
let redacted = false;
if (hidden) return { text: REDACT_MARKER, redacted: true };
const spans = rule && rule.chars ? rule.chars : [];
const selected = spans.filter((s) => lineNumber >= s.startLine && lineNumber <= s.endLine);
if (!selected.length) return { text, redacted };
const chars = Array.from(text);
const length = chars.length;
// Collect the absolute [start, end) character range to hide. We clamp to
// the line length so a stale span (line shrunk since it was saved) never
// throws and never hides beyond the line. Suffixes / prefixes that fall
// outside the file are simply not hidden.
const range = selected.reduce((acc, s) => {
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
if (from < 0) from = 0;
if (to > length) to = length;
if (to < from) to = from;
if (from < acc.from) acc.from = from;
if (to > acc.to) acc.to = to;
return acc;
}, { from: length, to: 0 });
if (range.to <= range.from) return { text, redacted };
const before = chars.slice(0, range.from).join('');
const after = chars.slice(range.to).join('');
text = before + REDACT_MARKER + after;
redacted = text !== line;
return { text, redacted };
}
// Replace every hidden line in `text` with the REDACT_MARKER, keeping the
// newline structure intact so line numbers and the total line count stay
// identical to the on-disk file. Whole-line ranges collapse to the marker;
// character spans redact the selected characters in place. Returns
// { text, redacted, hiddenLines }. `redacted` is true when at least one
// line was changed; `hiddenLines` is the count of lines that were fully
// hidden. A rule that no longer matches the file leaves the text
// untouched. `startLine` is the original 1-indexed line of the first line
// in a read_file slice.
function redactText(projectDir, relPath, text, startLine = 1) {
const rule = ruleForPath(projectDir, relPath);
if (!rule || typeof text !== 'string') {
return { text, redacted: false, hiddenLines: 0, rule };
}
let hiddenLines = 0;
let changed = false;
const lines = text.split('\n').map((line, idx) => {
const lineNumber = idx + startLine;
if (isLineHidden(rule, lineNumber)) {
hiddenLines++;
changed = true;
return REDACT_MARKER;
}
const out = redactLine(rule, lineNumber, line, false);
if (out.redacted) changed = true;
return out.text;
});
return { text: lines.join('\n'), redacted: changed, hiddenLines, rule };
}
// Build a normalized (read-only) rule list for a project. Also used by the
// settings UI to show a clean view of what is stored.
function getRules(projectDir) {
return getEntries(projectDir)
.map(normalizeEntry)
.filter(Boolean);
}
// Build one lookup index for a whole search: the normalized rules plus a
// Map from normalized path to rule, and a Map from normalized path to the
// rules that match it by path *suffix*.
//
// This exists because the redaction check used to call `getRules()` (and
// therefore re-read and re-parse the project settings) once per line of
// every scanned file — 27k settings reads for one 2-second search. Callers
// with many paths to test build the index once and hand it to
// `matchIsHiddenIn` / `lineIsHiddenIn`.
//
// The suffix map is the safety net: the engine that produces the paths can
// report them differently from the rule (`./src/a.js` vs `src/a.js`,
// absolute vs relative) and a rule that fails to match is a leak, not a
// cosmetic bug. So a rule also applies to any path that ends with the rule
// path on a `/` boundary.
function buildRuleIndex(projectDir) {
const rules = getRules(projectDir);
const byPath = new Map();
const bySuffix = new Map();
for (const rule of rules) {
byPath.set(rule.path, rule);
const parts = rule.path.split('/');
for (let i = 1; i < parts.length; i++) {
const suffix = parts.slice(i).join('/');
if (!bySuffix.has(suffix)) bySuffix.set(suffix, []);
bySuffix.get(suffix).push(rule);
}
}
return { rules, byPath, bySuffix };
}
// Resolve the rules that apply to one path against a prebuilt index.
// Exact normalized match first, then the suffix map. Returns [] when
// nothing applies. Never throws.
function rulesForPathIn(index, relPath) {
if (!index || !relPath) return [];
const target = normalizePath(relPath);
if (!target) return [];
const exact = index.byPath.get(target);
const suffix = index.bySuffix.get(target);
if (exact && suffix) return [exact].concat(suffix.filter((r) => r !== exact));
if (exact) return [exact];
return suffix || [];
}
// Return the { path, ranges, chars } rule for a given project file, or null.
function ruleForPath(projectDir, relPath) {
const target = normalizePath(relPath);
if (!target) return null;
for (const rule of getRules(projectDir)) {
if (rule.path === target) return rule;
}
return null;
}
// Predicate over a prebuilt rule index: true when the given 1-indexed line
// is fully hidden by any rule that applies to `relPath`. The no-index
// `lineIsHidden` wrapper below keeps the single-path callers (and tests)
// working.
function lineIsHiddenIn(index, relPath, line) {
if (!Number.isInteger(line) || line < 1) return false;
for (const rule of rulesForPathIn(index, relPath)) {
if (isLineHidden(rule, line)) return true;
}
return false;
}
// Same, for a match that occupies columns [colStart, colEnd] on the line.
// The whole line, or an overlapping character span, suppresses the match.
function matchIsHiddenIn(index, relPath, line, colStart, colEnd) {
if (!Number.isInteger(line) || line < 1) return false;
for (const rule of rulesForPathIn(index, relPath)) {
if (isLineHidden(rule, line)) return true;
const spans = rule.chars || [];
for (const s of spans) {
if (line < s.startLine || line > s.endLine) continue;
if (typeof colStart !== 'number' || typeof colEnd !== 'number') return true;
const startCol = line === s.startLine ? s.startCol : 1;
const endCol = line === s.endLine ? s.endCol : Number.MAX_SAFE_INTEGER;
if (Math.max(startCol, colStart) <= Math.min(endCol, colEnd)) return true;
}
}
return false;
}
// A predicate used by callers that only have a project dir and a path (the
// search engine, when it did not bother to build an index). Returns true
// when the given 1-indexed line of the given file is hidden and should
// therefore be excluded from any match list. `colStart`/`colEnd` are
// 1-indexed inclusive character columns occupied by the match on that line;
// when omitted the whole line is treated as potentially hidden so a search
// result is conservatively suppressed. Never throws.
function matchIsHidden(projectDir, relPath, line, colStart, colEnd) {
return matchIsHiddenIn(buildRuleIndex(projectDir), relPath, line, colStart, colEnd);
}
// Convenience predicate for callers that only care about whole lines.
function lineIsHidden(projectDir, relPath, line) {
return lineIsHiddenIn(buildRuleIndex(projectDir), relPath, line);
}
// The rule that applies to a path, resolved through the same exact-then-
// suffix lookup the search engine uses, so a one-path caller and the
// engine never disagree about whether a file is covered.
function ruleForPathIn(index, relPath) {
const matches = rulesForPathIn(index, relPath);
return matches.length ? matches[0] : null;
}
module.exports = {
REDACT_MARKER,
getEntries,
getRules,
buildRuleIndex,
rulesForPathIn,
ruleForPath,
ruleForPathIn,
isLineHidden,
redactText,
lineIsHidden,
lineIsHiddenIn,
matchIsHidden,
matchIsHiddenIn,
normalizePath,
normalizeEntry,
normalizeCharSpan
};
