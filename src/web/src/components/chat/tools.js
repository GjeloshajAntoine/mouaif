// mouaif web — Chat tool name + result coercion helpers
//
// Pure functions that don't touch the DOM or any state. They decide
// what "shell" means as a string, what `read_file` should look like
// when summarised, and how a stringy tool result should be turned
// into a structured object for the preview renderers.

// normalizeToolName(name) -> string
//
// Strip the optional `functions.` prefix that some providers
// (notably OpenAI) prepend to tool names. The chat UI stores the
// canonical name in `data-tool-name` on every tool card and uses it
// to pick the right preview renderer.
export function normalizeToolName(name) {
  return String(name || '').replace(/^functions\./, '');
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
  if (name === 'list_files') return args.pattern || 'all text files';
  if (name === 'search_files') return [args.path, args.query].filter(Boolean).join(': ');
  if (name === 'write_file' || name === 'edit_file') return args.path || args.file || '';
  if (name === 'subagent') return args.task || '';
  try { return JSON.stringify(args, null, 2); }
  catch { return String(args); }
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
    } else if ((m = line.match(/^# Listing: (.*)$/))) out.pattern = m[1] === '<all text files>' ? '' : m[1];
    else if ((m = line.match(/^# Search: (.*)$/))) out.query = m[1];
    else if ((m = line.match(/^# Wrote: (.*)$/))) out.relPath = m[1];
  }
  return out;
}
