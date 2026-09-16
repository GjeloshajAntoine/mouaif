// mouaif web — Chat tool name + result coercion helpers
//
// Pure functions that don't touch the DOM or any state. They decide
// what "shell" means as a string, what `read_file` should look like
// when summarised, and how a stringy tool result should be turned
// into a structured object for the preview renderers.

// TOOL_ARGS_PREVIEW_CHARS
//
// Budget for the collapsed card head's one-line argument text, shared by
// the main card head and the nested subagent rows so the same call is not
// truncated at two different lengths. It bounds the TEXT only — CSS also
// clips the head to the row width — so the expanded card shows the full
// arguments regardless (see formatToolArgsFull below).
export const TOOL_ARGS_PREVIEW_CHARS = 220;

// normalizeToolName(name) -> string
//
// Strip the optional `functions.` prefix that some providers
// (notably OpenAI) prepend to tool names. The chat UI stores the
// canonical name in `data-tool-name` on every tool card and uses it
// to pick the right preview renderer.
export function normalizeToolName(name) {
  return String(name || '').replace(/^functions\./, '');
}

// isExpectedToolFailure(name, r, ok) -> boolean
//
// True when a tool result that was NOT reported as ok is still not a failure,
// because the user chose it: the only such result today is `ask_user` answered
// with Dismiss. The runner builds that result with `ok: false` on purpose
// (src/tools/ask.js `buildResult`), and `formatResultSummary` already reports
// it as `dismissed` — but both call sites only ask for a summary when the frame
// says ok, so a dismissed question rendered as a red error card with no
// summary. The `dismissed` branch was unreachable and the collapsed card read
// as a failure for something the user deliberately did.
//
// This does not change the error dot: a dismissal is still not success. It
// decides whether the *summary* is reported for a non-ok result, so the card
// reads "dismissed" the way docs/features/ask-user-tool.md describes.
export function isExpectedToolFailure(name, r, ok) {
  if (ok) return false;
  if (normalizeToolName(name) !== 'ask_user') return false;
  return !!(r && typeof r === 'object' && r.cancelled === true);
}

// parseToolArgs(text) -> object | null
//
// Converts user-typed argument text into a JSON object. Tries two
// formats:
//   1. Raw JSON       `{ "path": "/etc", "recursive": true }`
//   2. Key=value      `path=/etc recursive=true key="quoted val"`
//
// Returns null when the input is empty or doesn't match either format.
// The caller (stream.js send()) decides how to handle null — for MCP
// tools it means "no structured args" and the tool is sent to the model;
// for shell it falls back to `{ cmd: text }`.
export function parseAtInvocation(text) {
const match = String(text || '').match(/^@([^\s:]+)(?::([^\s=]+)=)?\s*([\s\S]*)$/);
if (!match) return null;
return {
toolName: match[1],
rest: ((match[2] ? match[2] + '=' : '') + match[3]).trim()
};
}
export function findCustomActionInvocation(text, actions) {
const invocation = parseAtInvocation(String(text || '').trim());
if (!invocation || invocation.rest || !Array.isArray(actions)) return null;
return actions.find((action) => action && action.id &&
action.id.toLowerCase() === invocation.toolName.toLowerCase()) || null;
}
export function buildDirectMcpCall({ projectDir, chatId, callId, serverId, toolName, args }) {
return { projectDir, chatId, callId, serverId, toolName, args: args || {} };
}
export function parseDirectRestartInvocation(text) {
const match = String(text || '').trim().match(/^@restart_app(?:\s+([\s\S]*))?$/i);
if (!match) return null;
return { reason: String(match[1] || '').trim() };
}
export function parseToolArgs(text) {
const s = (text || '').trim();
  if (!s) return null;

  // 1. Raw JSON
  try { return JSON.parse(s); } catch { /* not JSON */ }

// 2. key=value pairs (no regex – O(n) char walker, no backtracking).
//
// Accepts: key=val key="quoted val" key='quoted val' key=`quoted val`
// (escape: \"), including the backticks inserted by the @-mention picker.
// Rejects input with any non-kv=value token (e.g. plain words).
// Capped at 2048 chars to avoid pathological inputs.
  const len = Math.min(s.length, 2048);
  const isNameChar = (ch) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
    || (ch >= '0' && ch <= '9') || ch === '_' || ch === '.' || ch === '-';

  // Phase 1+2: single pass O(n) walker — respects quotes, no regex.
  // Rejects any token that isn't a valid key=value pair.
  const pairs = {};
  let i = 0;
  while (i < len) {
    // skip whitespace
    while (i < len && s[i] === ' ') i++;
    if (i >= len) break;

    // read name
    const nameStart = i;
    while (i < len && isNameChar(s[i])) i++;
    if (i === nameStart) return null; // non-name char where name expected
    const name = s.slice(nameStart, i);

    // expect =
    if (i >= len || s[i] !== '=') return null;
    i++; // skip =

    // read value
    if (i >= len) return null; // key without value

    let value;
if (s[i] === '"' || s[i] === "'" || s[i] === '`') {
const quote = s[i];
      i++; // skip opening quote
      const valStart = i;
      while (i < len && s[i] !== quote) {
        if (s[i] === '\\' && i + 1 < len) i += 2;
        else i++;
      }
      if (i >= len) return null; // unclosed quote
      value = s.slice(valStart, i).replace(/\\(.)/g, '$1');
      i++; // skip closing quote
    } else {
      // unquoted — read until space or end
      const valStart = i;
      while (i < len && s[i] !== ' ') i++;
      value = s.slice(valStart, i);
      if (!value) return null;
    }

    pairs[name] = value;
  }

  return Object.keys(pairs).length > 0 ? pairs : null;
}

// isSubagentTool(name) -> bool
export function isSubagentTool(name) {
  return name === 'subagent' || name === 'functions.subagent';
}

// formatToolArgs(args, toolName) -> string
//
// One-line human summary of the args, shown in the tool card header.
// Strings pass through. Objects go through per-tool formatters and
// fall back to JSON.stringify for unknown shapes.
export function formatToolArgs(args, toolName) {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  const name = normalizeToolName(toolName);
  if (name === 'shell') return args.cmd || '';
  if (name === 'read_file') {
    const range = args.startLine != null || args.endLine != null
      ? (' lines ' + (args.startLine || 1) + '-' + (args.endLine || 'end'))
      : '';
    return (args.path || args.file || '') + range;
  }
  if (name === 'list_files') return args.pattern || 'all text and image files';
  if (name === 'search_files') return [args.path, args.query].filter(Boolean).join(': ');
  if (name === 'write_file' || name === 'edit_file') return args.path || args.file || '';
  if (name === 'subagent') return args.task || '';
  if (name === 'ask_user') return args.question || '';
  if (name === 'task') return (args.action || '') + (args.title ? ': ' + args.title : '');
if (name === 'webpreview') return args.url || '';
if (name === 'restart_app') return args.reason || '';
try { return JSON.stringify(args, null, 2); }

  catch { return String(args); }
}

// formatToolArgsFull(args, toolName) -> string
//
// The complete call arguments, as the expanded tool card renders them.
// The head shows one clipped line — bounded by TOOL_ARGS_PREVIEW_CHARS in
// text and by the row width in CSS — so a `shell` command (a commit-message
// heredoc, a compound `&&` chain) is unreadable there and the expanded card
// is the only place the user can read what the model actually ran. This
// restores the line breaks the head's one-line formatter collapses, and
// falls back to pretty JSON for unknown shapes — both render in a <pre>.
export function formatToolArgsFull(args, toolName) {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  const name = normalizeToolName(toolName);
  if (name === 'shell') return String(args.cmd || '');
  if (name === 'read_file') {
    const range = args.startLine != null || args.endLine != null
      ? (' lines ' + (args.startLine || 1) + '-' + (args.endLine || 'end'))
      : '';
    return String(args.path || args.file || '') + range;
  }
  if (name === 'list_files') return String(args.pattern || 'all text and image files');
  if (name === 'search_files') return [args.path, args.query].filter(Boolean).join(': ');
  if (name === 'write_file' || name === 'edit_file') return String(args.path || args.file || '');
  if (name === 'subagent') return String(args.task || '');
  if (name === 'ask_user') return String(args.question || '');
  if (name === 'task') return String(args.action || '') + (args.title ? ': ' + args.title : '');
  if (name === 'webpreview') return String(args.url || '');
  if (name === 'restart_app') return String(args.reason || '');
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

// coerceToolResult(r, name) -> object | string
//
// Stringify-shaped results come back from the server as text (the
// server wraps them in MCP envelopes). Try to parse, recurse on a
// double-encoded string, and fall back to a plain-text parser for
// the file tools (which emit "# File: …" headers).
export function coerceToolResult(r, name) {
  if (typeof r !== 'string') return r;
  const s = r.trim();
  if (!s) return r;
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === 'string') return coerceToolResult(parsed, name);
    return parsed;
  } catch { /* plain text */ }
  if (['read_file', 'list_files', 'search_files', 'write_file', 'edit_file'].includes(name)) {
    return parsePlainFileToolResult(r);
  }
  return r;
}

// formatBytes(n) -> "70 B" / "12 KB" / "1.4 MB"
//
// Shared by the collapsed card summary and the read_file image preview so a
// size never reads differently in the two places.
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return String(n);
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB';
  return (Math.round((v / (1024 * 1024)) * 10) / 10) + ' MB';
}

// formatResultSummary(name, r) -> string | null
//
// Ultra-compact one-line summary shown in the collapsed card head
// (next to the status dot) so the user sees key info without tapping.
// Returns null when there's nothing worth adding.
export function formatResultSummary(name, r) {
  if (!r || r.error) return null;
  const n = normalizeToolName(name);
  if (n === 'shell') {
    const parts = ['exit ' + (r.exitCode ?? 0)];
    if (r.durationMs != null) parts.push(r.durationMs + 'ms');
    return parts.join(' ');
  }
  if (n === 'read_file') {
    if (r.kind === 'image') {
      const kind = String(r.mimeType || 'image').replace(/^image\//, '').toUpperCase();
      return r.bytes != null ? kind + ' · ' + formatBytes(r.bytes) : kind;
    }
    if (r.lines != null) return r.lines + ' line' + (r.lines === 1 ? '' : 's');
    if (r.chars != null) return r.chars + ' chars';
    if (r.size != null && r.size < 1024) return r.size + 'B';
    if (r.size != null) return Math.round(r.size / 1024) + 'KB';
    return null;
  }
  if (n === 'list_files') {
    const count = r.entryCount != null ? r.entryCount : (Array.isArray(r.entries) ? r.entries.length : 0);
    const suffix = r.truncated ? ' (capped at ' + (r.cap != null ? r.cap : count) + ')' : '';
    return count + ' file' + (count === 1 ? '' : 's') + suffix;
  }
  if (n === 'search_files') {
    const count = r.matchCount != null ? r.matchCount : (Array.isArray(r.matches) ? r.matches.length : 0);
    const suffix = r.truncated ? ' (capped at ' + (r.capMatches != null ? r.capMatches : count) + ')' : '';
    return count + ' match' + (count === 1 ? '' : 'es') + suffix;
  }
  if (n === 'edit_file') {
    if (r.addedChars != null) return '+' + r.addedChars + ' chars';
    if (r.bytesWritten != null) return '+' + r.bytesWritten + 'B';
    return null;
  }
  if (n === 'write_file') {
    if (r.chars != null) return r.chars + ' chars';
    if (r.bytesWritten != null) return r.bytesWritten + 'B';
    if (r.size != null) return r.size + 'B';
    return null;
  }
  if (n === 'ask_user') {
    // The question is already the card's head line; what the user needs on
    // the collapsed card is the answer that was recorded for it.
    if (r.cancelled) return 'dismissed';
    const choice = Array.isArray(r.choice) ? r.choice.filter(Boolean) : (r.choice ? [r.choice] : []);
    if (!choice.length) return null;
    return choice.length > 1 ? choice.length + ' choices' : String(choice[0]);
  }
  if (n === 'task') {
    if (r.action === 'completed' && r.task) return r.task.title + ' ✓';
    if (r.task && r.task.status) return r.task.status;
    if (Array.isArray(r.tasks)) return r.tasks.length + ' task' + (r.tasks.length === 1 ? '' : 's');
    return null;
  }
  return null;
}

// formatReadableToolResult(r) -> string
//
// Best-effort string view of a structured result. Used when the
// per-tool renderer doesn't have a richer preview.
export function formatReadableToolResult(r) {
  if (r == null) return '';
  if (typeof r === 'string') {
    const s = r.trim();
    try { return formatReadableToolResult(JSON.parse(s)); } catch { return r; }
  }
  if (r.error) return typeof r.error === 'string' ? r.error : (r.error.message || 'error');
  if (typeof r.output === 'string') return r.output;
  if (typeof r.text === 'string') return r.text;
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    return [r.stdout, r.stderr].filter(Boolean).join('\n');
  }
  const lines = [];
  for (const [k, v] of Object.entries(r)) {
    if (v == null || v === '') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') lines.push(k + ': ' + v);
  }
  return lines.length ? lines.join('\n') : '(no preview)';
}

// parsePlainFileToolResult(text) -> object
//
// Splits the "# File: …\n# Lines: …\n\nbody" envelope that the
// native file tools (read_file, list_files, search_files,
// write_file, edit_file) emit into a structured object the
// per-tool preview renderers can read.
export function parsePlainFileToolResult(text) {
  const s = typeof text === 'string' ? text : '';
  const parts = s.split(/\n\n/);
  const header = parts.shift() || '';
  const body = parts.join('\n\n');
  const out = { body };
  for (const line of header.split('\n')) {
    let m;
    if ((m = line.match(/^# File: (.*)$/))) out.relPath = m[1];
    else if ((m = line.match(/^# Lines: (\d+)-(\d+)(?: \/ (\d+))?/))) {
      out.startLine = Number(m[1]); out.endLine = Number(m[2]); if (m[3]) out.totalLines = Number(m[3]);
    } else if ((m = line.match(/^# Listing: (.*)$/))) out.pattern = /^<all text/.test(m[1]) ? '' : m[1];
    else if ((m = line.match(/^# Kind: image \((.*), (\d+) bytes\)$/))) {
      out.kind = 'image'; out.mimeType = m[1]; out.bytes = Number(m[2]);
    }
    else if ((m = line.match(/^# Search: (.*)$/))) out.query = m[1];
    else if ((m = line.match(/^# Wrote: (.*)$/))) out.relPath = m[1];
    else if ((m = line.match(/^# Count: (\d+)(?: \(capped at (\d+)\))?/))) {
      out.entryCount = Number(m[1]);
      if (m[2] != null) { out.truncated = true; out.cap = Number(m[2]); }
    } else if ((m = line.match(/^# Matches: (\d+)(?: \(capped at (\d+) matches \/ (\d+) chars\))?/))) {
      out.matchCount = Number(m[1]);
      if (m[2] != null) { out.truncated = true; out.capMatches = Number(m[2]); out.capBytes = Number(m[3]); }
    } else if ((m = line.match(/^# Skipped: (\d+)/))) out.skipped = Number(m[1]);
  }
  // Rebuild the structured arrays the per-tool renderers and the
  // collapsed summary rely on. The plain-text form prints each file as an
  // indented tree path (the model-facing layout), so parse the body back
  // into the same `entries` / `matches` objects the live SSE path emits.
  // Without this, a list_files / search_files result that reaches the UI as
  // text (subagent nested results, tool-feedback replay) would report an
  // empty count and the summary would say "0 files" / "0 matches".
  // Transcripts written before the tree layout — the old `# dir/` grouped
  // header form — still parse, because a `# ` header line is handled too.
  if (out.pattern != null) {
    out.entries = parseListEntriesBody(out.body);
    if (out.entryCount != null && out.entries.length > out.entryCount) out.entries = out.entries.slice(0, out.entryCount);
  } else if (out.query != null) {
    out.matches = parseSearchMatchesBody(out.body);
    if (out.matchCount != null && out.matches.length > out.matchCount) out.matches = out.matches.slice(0, out.matchCount);
  }
  return out;
}
// Rebuild `entries: [{ path }]` from the list_files body. Two text forms:
//
//   tree (current)    indentation encodes the path — every `name/` line
//                     pushes a directory level, every other line is a file
//                     under the directories currently on the stack;
//   `# dir/` (legacy) a `# dir/` header sets the current directory, and the
//                     bare names under it belong to that directory.
//
// Both are recognized so a card replayed from an old transcript renders the
// same rows the live result did.
function parseListEntriesBody(body) {
  const entries = [];
  const stack = [];       // tree: directory names at each depth
  let legacyDir = '';     // legacy: current `# dir/` header
  let legacy = false;
  for (const line of String(body || '').split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('# ')) {
      legacy = true;
      legacyDir = line.slice(2).replace(/\/+$/, '');
      continue;
    }
    if (legacy) {
      // Legacy: the whole (two-space indented) line is a bare basename.
      pushListEntry(entries, legacyDir ? legacyDir + '/' + line.trim() : line.trim());
      continue;
    }
    const indent = line.match(/^ */)[0].length;
    const depth = Math.floor(indent / 2);
    let name = line.trim();
    // A directory row ends with `/`; everything else is a file.
    if (name.endsWith('/')) {
      stack.length = depth;
      stack[depth] = name.slice(0, -1);
      continue;
    }
    stack.length = depth;
    pushListEntry(entries, stack.filter(Boolean).concat(name).join('/'));
  }
  return entries;
}
// One list_files row. An image row is flagged by the tool (`dot.png (image)`);
// keep the flag so the replayed card renders the same row the live result did.
function pushListEntry(entries, raw) {
  let path = raw;
  let image = false;
  if (path.endsWith(' (image)')) { image = true; path = path.slice(0, -8); }
  entries.push(image ? { path, image: true } : { path });
}
// Rebuild `matches: [{ path, line, text }]` from the search_files body. The
// tree layout prints each file's path segments once (`dir/` then a deeper
// `name`), then its `lineno: text` rows one level deeper; the legacy grouped
// layout used a `# path` header followed by the same rows.
function parseSearchMatchesBody(body) {
  const matches = [];
  const stack = [];
  let currentPath = '';
  let legacy = false;
  const rowRe = /^(\d+): ?(.*)$/;
  for (const line of String(body || '').split('\n')) {
    if (line.startsWith('# ')) {
      legacy = true;
      currentPath = line.slice(2);
      continue;
    }
    // Tree rows are indented one level under their file, so match on the
    // trimmed line; the legacy grouped rows are already flush left.
    const row = line.trim().match(rowRe);
    if (row) {
      matches.push({ path: currentPath, line: Number(row[1]), text: row[2] });
      continue;
    }
    if (legacy || !line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    const depth = Math.floor(indent / 2);
    const name = line.trim();
    if (name.endsWith('/')) {
      stack.length = depth;
      stack[depth] = name.slice(0, -1);
      continue;
    }
    stack.length = depth;
    currentPath = stack.filter(Boolean).concat(name).join('/');
  }
  return matches;
}
