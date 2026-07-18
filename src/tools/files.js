'use strict';

// Native file tools — `read_file`, `list_files`, `search_files`, `write_file`,
// `edit_file`.
//
// Implements the "Native file tools" feature: read / list / search / write
// inside the project directory, with the same authorization gate and
// path-safety rules as the rest of the tool surface (decisions §16, §17).
//
// Public surface:
//   SPECS                       : { 'read_file', 'list_files', 'search_files', 'write_file', 'edit_file' }
//                                 each value is an OpenAI-compatible function spec
//   runFileTool(name, opts)     -> Promise<{ ok, content, result }>
//   resolveSandbox(projectDir)  -> string  (re-exported from shell.js for parity)
//
// Each runner is self-contained: path safety, size caps, and the textual
// response shape are all enforced here. The AI client in src/ai.js maps
// any tool_call whose name matches one of the five over to runFileTool().
//
// Path safety: every path the model supplies is normalized to a
// POSIX-relative path under the project root, then resolved back to an
// absolute path with realpath. Anything that escapes the root (`. .`,
// absolute path, or a symlink that points outside) throws EOUTSIDE_PROJECT
// and the call becomes a typed EOUTSIDE_PROJECT tool_result — the same
// error shape the shell tool already uses.
//
// Defaults (overridable via app.<name>MaxBytes / app.<name>DefaultLines):
//   fileReadMaxBytes     = 256 KB   (whole-file reads; excerpts bypass the cap)
//   fileListMaxEntries   = 1000     (cap on list_files result rows)
//   fileSearchMaxMatches = 200      (cap on search_files matches)
//   fileSearchMaxBytes   = 2 MB     (cap on total bytes read by one search call)
//   fileWriteMaxBytes    = 1 MB     (cap on a single write_file call)
//   fileReadDefaultLines = 2000     (default window when the model asks for a slice)

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ---- Constants ---------------------------------------------------------

const DEFAULT_READ_MAX_BYTES = 256 * 1024;
const DEFAULT_LIST_MAX_ENTRIES = 1000;
const DEFAULT_SEARCH_MAX_MATCHES = 200;
const DEFAULT_SEARCH_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_WRITE_MAX_BYTES = 1024 * 1024;
const DEFAULT_READ_LINES = 2000;

const MAX_TIMEOUT_MS = 60_000; // hard ceiling per call (defensive)

// Directories the list_files / search_files walk never descends into.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.mouaif', 'dist', 'build'
]);

// Extension allowlist for list_files and search_files. It keeps the walk
// focused on files the model can reasonably consume as text.
const TEXT_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.mdx',
  '.txt', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.php',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
  '.yml', '.yaml', '.toml', '.ini', '.sh', '.bash', '.zsh', '.fish',
  '.lua', '.pl', '.r', '.dart', '.ex', '.exs', '.clj', '.scala',
  '.sql', '.graphql', '.vue', '.svelte', '.astro'
]);

// ---- Errors ------------------------------------------------------------

function err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// ---- Path safety -------------------------------------------------------

// Resolve a project root, refusing anything that is missing or not a
// directory. Returns the realpath so symlinks point to the real on-disk
// root; the rest of the path checks are then anchored on this string.
function resolveSandbox(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw err('EBADINPUT', 'projectDir is required');
  }
  let real;
  try { real = fs.realpathSync(projectDir); }
  catch { throw err('ENOENT', 'project directory not found'); }
  let st;
  try { st = fs.statSync(real); }
  catch { throw err('ENOENT', 'project directory not found'); }
  if (!st.isDirectory()) throw err('ENOTDIR', 'projectDir is not a directory');
  return real;
}

// Normalize a user- or model-supplied path to a POSIX-relative path
// under the resolved project root. Throws EOUTSIDE_PROJECT on escape.
function toRelPath(root, p) {
  if (typeof p !== 'string' || !p.trim()) throw err('EBADINPUT', 'path is required');
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw err('EOUTSIDE_PROJECT', 'Path escapes the project root', { path: p });
  }
  return rel.split(path.sep).join('/');
}

// Resolve a stored relPath back to an absolute path, with symlink check.
// For files that exist on disk, realpath is used so a symlink that
// points outside the project root is rejected. For files that don't
// exist yet (write_file, mkdir -p), we walk up to the first existing
// ancestor, realpath that, and verify the join is still inside the
// root. The path safety contract is "no escape", not "file exists",
// so the two cases share the same final check.
function toAbsInside(root, rel) {
  const abs = path.resolve(root, rel);
  // Fast path: file exists, realpath it, verify containment.
  let real;
  try { real = fs.realpathSync(abs); }
  catch { real = null; }
  if (real) {
    const rel2 = path.relative(root, real);
    if (!rel2 || rel2.startsWith('..') || path.isAbsolute(rel2)) {
      throw err('EOUTSIDE_PROJECT', 'Path escapes the project root', { path: rel });
    }
    return real;
  }
  // Slow path: file (or a parent) doesn't exist. Walk up until we
  // find an ancestor that does, realpath that, then re-join. Each
  // step is still subject to the same containment check. `suffix`
  // accumulates the parts we peeled off on the way up, joined back
  // on the way down.
  let probe = abs;
  let suffix = '';
  while (probe !== root && probe !== path.dirname(probe)) {
    let probeReal;
    try { probeReal = fs.realpathSync(probe); }
    catch {
      // Append the segment we are about to step over to `suffix`,
      // then step the probe up to its parent. Order matters: the
      // basename we are peeling is `path.basename(probe)` BEFORE we
      // reassign `probe` to its dirname.
      const peeled = path.basename(probe);
      probe = path.dirname(probe);
      suffix = suffix ? (peeled + path.sep + suffix) : peeled;
      continue;
    }
    if (suffix) probeReal = path.join(probeReal, suffix);
    const rel2 = path.relative(root, probeReal);
    if (!rel2 || rel2.startsWith('..') || path.isAbsolute(rel2)) {
      throw err('EOUTSIDE_PROJECT', 'Path escapes the project root', { path: rel });
    }
    return probeReal;
  }
  // If we walked all the way to the root, the file is "inside" (even
  // though the parent doesn't exist yet, e.g. mkdir -p). Verify the
  // original `abs` is at least lexically inside the root.
  const rel2 = path.relative(root, abs);
  if (!rel2 || rel2.startsWith('..') || path.isAbsolute(rel2)) {
    throw err('EOUTSIDE_PROJECT', 'Path escapes the project root', { path: rel });
  }
  return abs;
}

// ---- read_file ---------------------------------------------------------

// Read a file. Optional `startLine` / `endLine` (1-indexed, inclusive) pin
// a window. Whole-file reads over the cap are refused with ETOOL_CAP.
async function runReadFile(opts) {
  const { projectDir, args, settings } = opts;
  const root = resolveSandbox(projectDir);
  const rel = toRelPath(root, args && args.path);
  const abs = toAbsInside(root, rel);

  const st = await fsp.stat(abs);
  if (!st.isFile()) throw err('ENOTFILE', 'Not a file: ' + rel);

  // The cap only applies to whole-file reads. A bounded slice always
  // succeeds, no matter how large the file is.
  const cap = (settings && settings.fileReadMaxBytes) || DEFAULT_READ_MAX_BYTES;
  const startLine = Number.isInteger(args && args.startLine) ? args.startLine : null;
  const endLine = Number.isInteger(args && args.endLine) ? args.endLine : null;
  const isSlice = startLine != null && endLine != null && endLine >= startLine;
  if (!isSlice) {
    if (st.size > cap) {
      throw err('ETOOL_CAP', 'file is ' + st.size + ' bytes, exceeds cap ' + cap + ' (use startLine/endLine)', { size: st.size, cap });
    }
  }

  const raw = await fsp.readFile(abs, 'utf8');
  if (!isSlice) {
    return {
      relPath: rel,
      size: st.size,
      startLine: 1,
      endLine: raw ? raw.split('\n').length : 0,
      body: raw,
      truncated: false
    };
  }

  // Slice: split on \n, keep the inclusive range. If the range extends
  // past the end, the tail is returned. Line numbers in the response
  // header stay 1-indexed for human readability.
  const lines = raw.split('\n');
  const totalLines = lines.length;
  const a = Math.max(1, startLine);
  const b = Math.min(totalLines, endLine);
  const slice = lines.slice(a - 1, b).join('\n');
  return {
    relPath: rel,
    size: st.size,
    startLine: a,
    endLine: b,
    totalLines,
    body: slice,
    truncated: b < endLine
  };
}

function formatReadFileResult(r) {
  const header = '# File: ' + r.relPath + '\n# Bytes: ' + r.size + '\n# Lines: ' + r.startLine + '-' + r.endLine + (r.totalLines ? ' / ' + r.totalLines : '') + (r.truncated ? '\n# Truncated: yes' : '');
  return header + '\n\n' + r.body;
}

// ---- list_files --------------------------------------------------------

// One-pass directory walk honoring the same skip-dirs and text-extension
// allowlist as src/tags.js. Files are returned as POSIX-relative paths
// with `binary` flagged by the same NUL-byte heuristic.
async function runListFiles(opts) {
  const { projectDir, args, settings } = opts;
  const root = resolveSandbox(projectDir);
  const cap = (settings && settings.fileListMaxEntries) || DEFAULT_LIST_MAX_ENTRIES;

  const pattern = (args && typeof args.pattern === 'string' && args.pattern.trim()) ? args.pattern.trim() : null;
  // Compile a simple glob: '*' matches any path segment, '**' matches
  // any number of segments. Anything else is a literal segment match.
  const re = pattern ? globToRegExp(pattern) : null;

  const out = [];
  let truncated = false;
  let total = 0;
  let skipped = 0;

  async function walk(dirAbs, dirRel) {
    if (out.length >= cap) { truncated = true; return; }
    let entries;
    try { entries = await fsp.readdir(dirAbs, { withFileTypes: true }); }
    catch { skipped++; return; }
    for (const ent of entries) {
      if (out.length >= cap) { truncated = true; return; }
      const childAbs = path.join(dirAbs, ent.name);
      const childRel = (dirRel ? dirRel + '/' : '') + ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) { skipped++; continue; }
        await walk(childAbs, childRel);
        continue;
      }
      if (!ent.isFile()) { skipped++; continue; }
      // Pattern filter.
      if (re && !re.test(childRel)) continue;
      // Extension allowlist — keeps the result list to text files the
      // model can actually read.
      const ext = path.extname(ent.name).toLowerCase();
      if (!TEXT_EXTS.has(ext)) { skipped++; continue; }
      let st;
      try { st = await fsp.stat(childAbs); } catch { skipped++; continue; }
      out.push({ path: childRel, size: st.size });
      total++;
    }
  }
  await walk(root, '');
  return { entries: out, total, skipped, truncated, cap, pattern: pattern || '' };
}

function formatListFilesResult(r) {
  const header = '# Listing: ' + (r.pattern || '<all text files>') + '\n# Count: ' + r.entries.length + (r.truncated ? ' (capped at ' + r.cap + ')' : '') + (r.skipped ? '\n# Skipped: ' + r.skipped : '');
  if (!r.entries.length) return header + '\n\n(no matching files)';
  const body = r.entries.map((e) => e.path + '\t' + e.size).join('\n');
  return header + '\n\n' + body;
}

// Minimal glob: **/foo matches foo anywhere; foo/** matches a directory
// tree under foo; otherwise treat the pattern as a right-anchored regex
// of `^pattern$` with `*` -> `[^/]*` and `?` -> `[^/]`. We deliberately
// avoid a full glob library — the model only needs "everything under
// src/", "all *.test.js", "the file named README.md".
function globToRegExp(pattern) {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      src += '.*';
      i++;
      if (pattern[i + 1] === '/') i++;
    } else if (c === '*') {
      src += '[^/]*';
    } else if (c === '?') {
      src += '[^/]';
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      src += '\\' + c;
    } else {
      src += c;
    }
  }
  return new RegExp('^' + src + '$');
}

function stripSearchPathFilter(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let s = raw.trim().replace(/\\/g, '/');
  if (s === '.' || s === './') return null;
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/+/g, '/');
  return s;
}

function makeSearchPathFilter(root, rawPath) {
  const rel = stripSearchPathFilter(rawPath);
  if (!rel) return null;
  const safeRel = toRelPath(root, rel);
  const abs = toAbsInside(root, safeRel);
  let isDir = rel.endsWith('/');
  try { isDir = fs.statSync(abs).isDirectory(); } catch { /* keep slash heuristic */ }
  if (isDir) {
    const prefix = safeRel.replace(/\/+$/, '');
    return {
      mayContain: (childRel) => childRel === prefix || childRel.startsWith(prefix + '/'),
      matchesFile: (childRel) => childRel.startsWith(prefix + '/')
    };
  }
  return {
    mayContain: (childRel) => safeRel.startsWith(childRel + '/'),
    matchesFile: (childRel) => childRel === safeRel
  };
}

// ---- search_files ------------------------------------------------------

// ripgrep-style text search. Walks the project, reads each candidate
// text file and emits a line-oriented match list. Capped by maxMatches
// and maxBytes so a model that asks for "every TODO in the repo" can't
// blow the budget.
async function runSearchFiles(opts) {
  const { projectDir, args, settings } = opts;
  const root = resolveSandbox(projectDir);
  const cap = {
    matches: (settings && settings.fileSearchMaxMatches) || DEFAULT_SEARCH_MAX_MATCHES,
    bytes: (settings && settings.fileSearchMaxBytes) || DEFAULT_SEARCH_MAX_BYTES
  };

  const query = (args && typeof args.query === 'string') ? args.query : '';
  if (!query) throw err('EBADINPUT', 'query is required');

  let re;
  try { re = new RegExp(query); }
  catch (e) { throw err('EBADINPUT', 'invalid regex: ' + e.message); }

  const pathFilter = makeSearchPathFilter(root, args && args.path);

  const matches = [];
  let bytesRead = 0;
  let filesScanned = 0;
  let truncated = false;

  async function walk(dirAbs, dirRel) {
    if (matches.length >= cap.matches || bytesRead >= cap.bytes) { truncated = true; return; }
    let entries;
    try { entries = await fsp.readdir(dirAbs, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (matches.length >= cap.matches || bytesRead >= cap.bytes) { truncated = true; return; }
      const childAbs = path.join(dirAbs, ent.name);
      const childRel = (dirRel ? dirRel + '/' : '') + ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (pathFilter && !pathFilter.mayContain(childRel)) continue;
        await walk(childAbs, childRel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (pathFilter && !pathFilter.matchesFile(childRel)) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!TEXT_EXTS.has(ext)) continue;
      filesScanned++;
      let content;
      try { content = await fsp.readFile(childAbs, 'utf8'); }
      catch { continue; }
      bytesRead += Buffer.byteLength(content, 'utf8');
      if (bytesRead > cap.bytes) { truncated = true; return; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push({ path: childRel, line: i + 1, text: lines[i].slice(0, 240) });
          if (matches.length >= cap.matches) { truncated = true; return; }
        }
      }
    }
  }
  await walk(root, '');
  return { query, matches, filesScanned, bytesRead, truncated, cap };
}

function formatSearchFilesResult(r) {
  const header = '# Search: ' + r.query + '\n# Matches: ' + r.matches.length + (r.truncated ? ' (capped at ' + r.cap.matches + ' matches / ' + r.cap.bytes + ' bytes)' : '') + '\n# Files scanned: ' + r.filesScanned;
  if (!r.matches.length) return header + '\n\n(no matches)';
  const body = r.matches.map((m) => m.path + ':' + m.line + ': ' + m.text).join('\n');
  return header + '\n\n' + body;
}

// ---- write_file / edit_file --------------------------------------------

// Normalize line endings for comparison while retaining a map from each
// normalized character boundary back to its byte-for-byte source offset.
// This lets edit_file accept an LF oldText for a CRLF file (and vice versa)
// without rewriting any content outside the matched block.
function normalizedTextWithOffsets(text) {
  let normalized = '';
  const offsets = [];
  for (let i = 0; i < text.length;) {
    offsets.push(i);
    if (text[i] === '\r') {
      normalized += '\n';
      i += text[i + 1] === '\n' ? 2 : 1;
    } else {
      normalized += text[i];
      i++;
    }
  }
  offsets.push(text.length);
  return { normalized, offsets };
}

// Pick the file's dominant newline convention. Ties use the first newline,
// which keeps small or mixed files stable. A file with no newline leaves the
// replacement exactly as supplied by the caller.
function detectLineEnding(text) {
  const counts = { '\r\n': 0, '\n': 0, '\r': 0 };
  let first = null;
  for (let i = 0; i < text.length; i++) {
    let eol = null;
    if (text[i] === '\r') {
      eol = text[i + 1] === '\n' ? '\r\n' : '\r';
      if (eol === '\r\n') i++;
    } else if (text[i] === '\n') {
      eol = '\n';
    }
    if (!eol) continue;
    if (!first) first = eol;
    counts[eol]++;
  }
  if (!first) return null;
  return Object.keys(counts).reduce((best, eol) => counts[eol] > counts[best] ? eol : best, first);
}

function convertLineEndings(text, eol) {
  return eol ? text.replace(/\r\n|\r|\n/g, eol) : text;
}

function previewEditDiff(rel, before, after) {
  const oldLines = String(before || '').replace(/\r\n|\r/g, '\n').split('\n');
  const newLines = String(after || '').replace(/\r\n|\r/g, '\n').split('\n');
  const out = ['--- ' + rel, '+++ ' + rel];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const a = i < oldLines.length ? oldLines[i] : null;
    const b = i < newLines.length ? newLines[i] : null;
    if (a === b) {
      if (out.length < 80) out.push(' ' + a);
    } else {
      if (a != null) out.push('-' + a);
      if (b != null) out.push('+' + b);
    }
    if (out.length >= 80) {
      out.push('...[diff truncated]');
      break;
    }
  }
  return out.join('\n');
}

// Create or overwrite a file. `dirs: true` allows the path to include
// new directories (the runner mkdir -p's them); otherwise the parent
// dir must already exist. Refuses paths that escape the root.
async function runWriteFile(opts) {
  const { projectDir, args, settings } = opts;
  const root = resolveSandbox(projectDir);
  const requestedPath = args && (args.path || args.file);
  const rel = toRelPath(root, requestedPath);
  const abs = toAbsInside(root, rel);
  if (!args || typeof args.content !== 'string') throw err('EBADINPUT', 'content is required');
  const content = args.content;
  const cap = (settings && settings.fileWriteMaxBytes) || DEFAULT_WRITE_MAX_BYTES;
  if (Buffer.byteLength(content, 'utf8') > cap) {
    throw err('ETOOL_CAP', 'content is ' + Buffer.byteLength(content, 'utf8') + ' bytes, exceeds cap ' + cap);
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  const st = await fsp.stat(abs);
  return { relPath: rel, size: st.size, bytesWritten: Buffer.byteLength(content, 'utf8') };
}

// Replace one unique block in an existing text file. Line-ending styles are
// considered equivalent during matching. This is kept
// deliberately separate from write_file: coding models commonly interpret
// "edit" as a patch operation and send only the changed line. Treating that
// payload as a full-file body silently destroys the rest of the file.
async function runEditFile(opts) {
  const { projectDir, args, settings } = opts;
  const root = resolveSandbox(projectDir);
  const requestedPath = args && (args.path || args.file);
  const rel = toRelPath(root, requestedPath);
  const abs = toAbsInside(root, rel);
  const oldText = args && (typeof args.oldText === 'string' ? args.oldText : args.old_string);
  const newText = args && (typeof args.newText === 'string' ? args.newText : args.new_string);
  if (typeof oldText !== 'string' || !oldText) {
    throw err('EBADINPUT', 'oldText is required and must be a non-empty exact block; use write_file for full-file replacement');
  }
  if (typeof newText !== 'string') throw err('EBADINPUT', 'newText is required');

  const st = await fsp.stat(abs);
  if (!st.isFile()) throw err('ENOTFILE', 'Not a file: ' + rel);
  const original = await fsp.readFile(abs, 'utf8');
  const source = normalizedTextWithOffsets(original);
  const needle = normalizedTextWithOffsets(oldText).normalized;
  const first = source.normalized.indexOf(needle);
  if (first < 0) throw err('ENO_MATCH', 'oldText was not found in ' + rel + '; read the file and retry with an exact block');
  if (source.normalized.indexOf(needle, first + needle.length) >= 0) {
    throw err('EMULTI_MATCH', 'oldText occurs more than once in ' + rel + '; include more surrounding context');
  }

  const originalStart = source.offsets[first];
  const originalEnd = source.offsets[first + needle.length];
  const replaced = original.slice(originalStart, originalEnd);
  const replacement = convertLineEndings(newText, detectLineEnding(original));
  const content = original.slice(0, originalStart) + replacement + original.slice(originalEnd);
  const cap = (settings && settings.fileWriteMaxBytes) || DEFAULT_WRITE_MAX_BYTES;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > cap) throw err('ETOOL_CAP', 'edited file is ' + bytes + ' bytes, exceeds cap ' + cap);

  // Write beside the target and rename so an interrupted write cannot leave a
  // partially-written source file. Preserve the existing permission bits.
  const tmp = abs + '.mouaif-edit-' + process.pid + '-' + Math.random().toString(16).slice(2);
  try {
    await fsp.writeFile(tmp, content, { encoding: 'utf8', mode: st.mode });
    await fsp.rename(tmp, abs);
  } finally {
    try { await fsp.unlink(tmp); } catch { /* rename succeeded or cleanup best-effort */ }
  }
  return {
    relPath: rel,
    size: bytes,
    bytesWritten: Buffer.byteLength(replacement, 'utf8'),
    replacedBytes: Buffer.byteLength(replaced, 'utf8'),
    diff: previewEditDiff(rel, replaced, replacement)
  };
}

function formatWriteFileResult(r) {
  return '# Wrote: ' + r.relPath + '\n# Bytes: ' + r.bytesWritten + ' / ' + r.size;
}

// ---- Dispatcher --------------------------------------------------------

// runFileTool(name, opts) -> Promise<{ ok, content, result }>
//   ok       : true on success, false on handled error
//   content  : the JSON-serialized object sent back as the model's tool
//              message (the same shape the shell tool uses)
//   result   : the richer object surfaced to the chat UI in the
//              tool_result SSE event
async function runFileTool(name, opts) {
  let out;
  try {
    if (name === 'read_file') out = await runReadFile(opts);
    else if (name === 'list_files') out = await runListFiles(opts);
    else if (name === 'search_files') out = await runSearchFiles(opts);
    else if (name === 'write_file') out = await runWriteFile(opts);
    else if (name === 'edit_file') out = await runEditFile(opts);
    else throw err('EUNKNOWN_TOOL', 'Unknown file tool: ' + name);
  } catch (e) {
    const r = { error: { code: e.code || 'EUNKNOWN', message: e.message } };
    if (e.path) r.error.path = e.path;
    return { ok: false, content: JSON.stringify(r), result: r };
  }
  // Format the model's response as a clean header + body string. The
  // model-facing content is the string the upstream API will see as
  // the `tool` message; the chat UI gets the structured result.
  let content;
  try {
    if (name === 'read_file') content = formatReadFileResult(out);
    else if (name === 'list_files') content = formatListFilesResult(out);
    else if (name === 'search_files') content = formatSearchFilesResult(out);
    else if (name === 'write_file' || name === 'edit_file') content = formatWriteFileResult(out);
    else content = JSON.stringify(out);
  } catch (e) {
    const r = { error: { code: 'EENCODE', message: 'failed to encode result: ' + e.message } };
    return { ok: false, content: JSON.stringify(r), result: r };
  }
  return { ok: true, content, result: out };
}

// ---- Tool specs (OpenAI-compatible function shape) --------------------

const SPECS = Object.freeze({
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the project directory. Returns the file body with a header that shows the path, size, and line range. Use startLine/endLine (1-indexed, inclusive) to read a slice of a large file; whole-file reads over 256 KB are refused.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'POSIX path relative to the project root (e.g. "src/index.js").' },
          startLine: { type: 'integer', description: 'Optional 1-indexed start line for a slice.' },
          endLine: { type: 'integer', description: 'Optional 1-indexed inclusive end line for a slice.' }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  list_files: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List text files in the project directory. Honors a simple glob pattern ("src/**/*.js", "**/*.test.*", "README.md"). Skips node_modules, .git, .mouaif, dist, build. Result is capped at 1000 entries.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Optional glob relative to the project root. Omit to list every text file.' }
        },
        additionalProperties: false
      }
    }
  },
  search_files: {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a regex in text files under the project directory. Returns one match per line as "path:line: text". Optional `path` filters to a directory or single file; ".", "./", "src", "src/", and "src/file.js" are accepted. Capped at 200 matches / 2 MB scanned.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'JavaScript regular expression source (no flags).' },
          path: { type: 'string', description: 'Optional directory or single file to scope the search. Use "." or omit for the whole project.' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file in the project directory. Creates parent directories as needed. Content is capped at 1 MB. Use with care — this overwrites without a merge.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'POSIX path relative to the project root (e.g. "src/utils/helper.js").' },
          content: { type: 'string', description: 'The full file body to write.' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  edit_file: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Safely edit an existing text file by replacing one unique block. Read the relevant lines first, then send their text as oldText and the replacement as newText. LF and CRLF are treated as equivalent, and newText adopts the file line endings. Fails without changing the file if oldText is missing or appears more than once. Use write_file only to create a file or intentionally replace its complete contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'POSIX path relative to the project root.' },
          file: { type: 'string', description: 'Compatibility alias for path.' },
          oldText: { type: 'string', description: 'Existing text to replace. LF/CRLF differences are ignored. Include surrounding lines when needed to make it unique.' },
          newText: { type: 'string', description: 'Replacement text. May be empty to delete the matched block.' }
        },
        required: ['oldText', 'newText'],
        additionalProperties: false
      }
    }
  }
});

const FILE_TOOL_NAMES = Object.freeze(['read_file', 'list_files', 'search_files', 'write_file', 'edit_file']);

function isFileToolName(name) {
  return FILE_TOOL_NAMES.indexOf(name) !== -1;
}

module.exports = {
  SPECS,
  FILE_TOOL_NAMES,
  isFileToolName,
  runFileTool,
  resolveSandbox,
  // exposed for tests
  globToRegExp,
  // constants
  DEFAULT_READ_MAX_BYTES,
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_SEARCH_MAX_MATCHES,
  DEFAULT_SEARCH_MAX_BYTES,
  DEFAULT_WRITE_MAX_BYTES,
  DEFAULT_READ_LINES,
  MAX_TIMEOUT_MS
};
