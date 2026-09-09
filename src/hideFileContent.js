'use strict';
// Per-project "hide file content" (redaction) rules.
//
// The user can mark line ranges of a specific source file that the agent
// file tools should not reveal. This module owns the read side: it loads
// the rules from the project settings (<projectDir>/.mouaif.json or the
// DB-backed project row, via src/settings.js) and tells the file-tool
// runners which lines of which file are hidden.
//
// The rules are stored on the project object under `hideFileContent`:
//   [
//     { path: 'src/index.js', ranges: [ { start: 12, end: 20 }, { start: 45, end: 45 } ] }
//   ]
// `path` is a POSIX-relative path from the project root (the same value
// the file picker reports); `ranges` are 1-indexed, inclusive line spans.
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
let s = p.trim().replace(/\\/g, '/');
while (s.startsWith('./')) s = s.slice(2);
s = s.replace(/\/+/g, '/').replace(/\/+$/, '');
return s;
}
// Sanitize a single rules entry to a { path, ranges } shape. Invalid
// ranges are dropped; valid ranges are clamped to start <= end. Returns
// null for a malformed entry so the caller can skip it.
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
if (!ranges.length) return null;
return { path, ranges };
}
// Build a normalized (read-only) rule list for a project. Also used by the
// settings UI to show a clean view of what is stored.
function getRules(projectDir) {
return getEntries(projectDir)
.map(normalizeEntry)
.filter(Boolean);
}
// Return the { path, ranges } rule for a given project file, or null.
function ruleForPath(projectDir, relPath) {
const target = normalizePath(relPath);
if (!target) return null;
const rules = getRules(projectDir);
for (const rule of rules) {
if (rule.path === target) return rule;
}
return null;
}
// Are `line` (1-indexed) and any other line within a hidden range of the
// given rule? `line` is a single 1-indexed line number.
function isLineHidden(rule, line) {
if (!rule || !rule.ranges || !Number.isInteger(line) || line < 1) return false;
return rule.ranges.some((r) => line >= r.start && line <= r.end);
}
// Replace every hidden line in `text` with the REDACT_MARKER, keeping the
// newline structure intact so line numbers and the total line count stay
// identical to the on-disk file. Returns { text, redacted, hiddenLines }.
// `redacted` is true when at least one line was replaced; `hiddenLines`
// is the count of lines hidden. A rule that no longer matches the file
// (path changed, ranges empty) leaves the text untouched. `startLine` is
// the original 1-indexed line of the first line in a read_file slice.
function redactText(projectDir, relPath, text, startLine = 1) {
const rule = ruleForPath(projectDir, relPath);
if (!rule || typeof text !== 'string') {
return { text, redacted: false, hiddenLines: 0, rule };
}
let hiddenLines = 0;
const lines = text.split('\n').map((line, idx) => {
if (isLineHidden(rule, idx + startLine)) {
hiddenLines++;
return REDACT_MARKER;
}
return line;
});
return { text: lines.join('\n'), redacted: hiddenLines > 0, hiddenLines, rule };
}
// A predicate used by search_files: returns true when the given 1-indexed
// line of the given file is hidden and should therefore be excluded from
// any match list. Never throws.
function lineIsHidden(projectDir, relPath, line) {
const rule = ruleForPath(projectDir, relPath);
return rule ? isLineHidden(rule, line) : false;
}
module.exports = {
REDACT_MARKER,
getEntries,
getRules,
ruleForPath,
isLineHidden,
redactText,
lineIsHidden,
normalizePath,
normalizeEntry
};
