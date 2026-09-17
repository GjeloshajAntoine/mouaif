'use strict';

// Native file tools — `read_file`, `list_files`, `search_files`, `write_file`,
// `edit_file`.
//
// Implements the "Native file tools" feature: read / list / search / write
// inside the project directory, with the same authorization gate and
// path-safety rules as the rest of the tool surface (decisions §16, §17).
//
// `read_file` also opens images: a path whose extension is a picture
// (`.png`, `.jpg`, `.gif`, `.webp`, `.bmp`, `.ico`) comes back as an
// `image` content block instead of a decoded text body, so the model
// actually sees the picture and the chat card renders a thumbnail. The
// block rides the same `toolResultImageParts` path MCP image results use
// (src/ai-stream.js). See docs/features/read-file-images.md.
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
// Defaults:
//   fileReadMaxLines     = 10000   (whole-file reads cap by line count; use startLine/endLine for larger files)
//   fileReadDefaultLines = 2000    (default window when the model asks for a slice)
//   fileReadMaxImageBytes = 4 MB   (cap on an image attached to the result)
//   fileListMaxEntries   = 1000    (cap on list_files result rows)
//   fileSearchMaxMatches = 200     (cap on search_files matches; in src/tools/searchEngine.js)
//   fileSearchMaxBytes   = 2 MB    (cap on matched line text returned by one search).
//                                   A match is redacted per line, so `search_files`
//                                   refuses `(?s)` rather than return a result it
//                                   cannot redact. See src/tools/searchEngine.js.
//   fileWriteMaxBytes    = 1 MB    (cap on a single write_file call)

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const hideFileContent = require('../hideFileContent.js');
// The search engine owns its own skip-dirs / text-extension list and its own
// default caps; importing them keeps list_files and the engine from drifting
// apart while the two live in different files.
const searchEngine = require('./searchEngine.js');

// Image extension knowledge (and the ext -> MIME map) lives in src/files.js
// — the same list the file editor previews with — so `read_file` and the
// editor never disagree about what counts as an image.
const { isImageExt, mimeForExt } = require('../files.js');

// ---- Constants ---------------------------------------------------------

const DEFAULT_READ_MAX_LINES = 10000;
const DEFAULT_READ_LINES = 2000;
const DEFAULT_READ_MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MiB
const DEFAULT_LIST_MAX_ENTRIES = 1000;
const DEFAULT_WRITE_MAX_BYTES = 1024 * 1024;

const MAX_TIMEOUT_MS = 60_000; // hard ceiling per call (defensive)

// The search engine owns the search caps and its skip-dir list. Re-exported
// from here because this module used to define them and tests reference the
// names through this module's exports.
const DEFAULT_SEARCH_MAX_MATCHES = searchEngine.DEFAULT_MAX_MATCHES;
const DEFAULT_SEARCH_MAX_BYTES = searchEngine.DEFAULT_MAX_BYTES;
const SKIP_DIRS = new Set(searchEngine.SKIP_DIRS);

// Extension allowlist for list_files. search_files decides for itself (the
// engine compares content, and the walk searches extensionless files).
const TEXT_EXTS = new Set(searchEngine.TEXT_EXTS);

// ---- Errors ------------------------------------------------------------

// Shared typed-error helper; single definition lives in src/util.js.
const { err } = require('../util.js');

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
// a window. Whole-file reads over the line cap are refused with ETOOL_CAP.
//
// Images are the exception: a picture extension (`.png`, `.jpg`, `.jpeg`,
// `.gif`, `.webp`, `.bmp`, `.ico`) comes back as an `image` content block
// instead of decoded text, so the model gets the pixels and the chat card
// renders a thumbnail. `.svg` stays text — its markup is what a model can
// use, and the extension is on the text allowlist.
async function runReadFile(opts) {
  const { projectDir, args, settings } = opts;
  const root = resolveSandbox(projectDir);
  const rel = toRelPath(root, args && args.path);
  const abs = toAbsInside(root, rel);

  const st = await fsp.stat(abs);
  if (!st.isFile()) throw err('ENOTFILE', 'Not a file: ' + rel);
  const ext = path.extname(abs).toLowerCase();
  if (isImageExt(ext) && !TEXT_EXTS.has(ext)) {
    return await readImageFile(rel, abs, st, settings);
  }

  // The cap only applies to whole-file reads. A bounded slice always
  // succeeds, no matter how large the file is.
  const cap = (settings && settings.fileReadMaxLines) || DEFAULT_READ_MAX_LINES;
  const startLine = Number.isInteger(args && args.startLine) ? args.startLine : null;
  const endLine = Number.isInteger(args && args.endLine) ? args.endLine : null;
  const isSlice = startLine != null && endLine != null && endLine >= startLine;

  const raw = await fsp.readFile(abs, 'utf8');
  const totalLines = raw ? raw.split('\n').length : 0;
  // Project-level redaction: any 1-indexed line the user marked hidden in
  // project settings is replaced with the REDACT_MARKER before the model
  // sees the body. Applied to both whole-file reads and slices so a hidden
  // range cannot leak through a `startLine`/`endLine` window. Line numbers
  // and the total count stay identical to the on-disk file.
  if (!isSlice) {
    if (totalLines > cap) {
      throw err('ETOOL_CAP', 'file has ' + totalLines + ' lines, exceeds cap ' + cap + ' (use startLine/endLine)', { lines: totalLines, cap });
    }
    const out = hideFileContent.redactText(projectDir, rel, raw);
    return {
      relPath: rel,
      startLine: 1,
      endLine: totalLines,
      body: out.text,
      truncated: false,
      redacted: out.redacted,
      redactedLines: out.hiddenLines
    };
  }

  // Slice: split on \n, keep the inclusive range. If the range extends
  // past the end, the tail is returned. Line numbers in the response
  // header stay 1-indexed for human readability.
  const lines = raw.split('\n');
  const a = Math.max(1, startLine);
  const b = Math.min(totalLines, endLine);
  const slice = lines.slice(a - 1, b).join('\n');
  const sliceOut = hideFileContent.redactText(projectDir, rel, slice, a);
  return {
    relPath: rel,
    startLine: a,
    endLine: b,
    totalLines,
    body: sliceOut.text,
    truncated: b < endLine,
    redacted: sliceOut.redacted,
    redactedLines: sliceOut.hiddenLines
  };
}

// ---- read_file: images -------------------------------------------------

// readImageFile(rel, abs, st, settings) -> image result
//
// Reads a picture as base64 and returns it in the `content` array shape the
// MCP image path already uses (`[{ type: 'image', data, mimeType }]`), so
// src/ai-stream.js forwards it to a vision model as a real image part and the
// chat card can render it. The bytes are never decoded to text: a model
// handed 400 KB of base64 as a `tool` message learns nothing, and the text
// body would blow the tool-feedback budget.
//
// Cap: `fileReadMaxImageBytes` (default 4 MB). Bigger pictures are refused
// with ETOOL_CAP — the model can downscale with the shell tool and read
// again, and the transcript does not grow by tens of megabytes.
async function readImageFile(rel, abs, st, settings) {
  const capBytes = (settings && Number.isInteger(settings.fileReadMaxImageBytes) && settings.fileReadMaxImageBytes > 0)
    ? settings.fileReadMaxImageBytes
    : DEFAULT_READ_MAX_IMAGE_BYTES;
  if (st.size > capBytes) {
    throw err('ETOOL_CAP', 'image is ' + formatBytes(st.size) + ', exceeds cap ' + formatBytes(capBytes)
      + ' (downscale it — e.g. with the shell tool — then read it again)', { size: st.size, cap: capBytes });
  }
  let buf;
  try { buf = await fsp.readFile(abs); }
  catch (e) {
    if (e.code === 'EACCES') throw err('EACCES', e.message, { path: abs });
    throw e;
  }
  const mime = mimeForExt(path.extname(abs).toLowerCase());
  return {
    relPath: rel,
    kind: 'image',
    mimeType: mime,
    bytes: buf.length,
    // The model-facing summary. The pixels ride in `content` below and reach
    // the model as a vision message part attached after the tool result.
    note: 'The picture is attached to this tool result as an image part.',
    content: [{ type: 'image', data: buf.toString('base64'), mimeType: mime }]
  };
}

// formatBytes(n) -> "12 KB" / "1.4 MB" (approximate, for headers only).
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (Math.round((n / (1024 * 1024)) * 10) / 10) + ' MB';
}

function formatReadFileResult(r, structure) {
  if (structure === 'json') return JSON.stringify(r);
  if (r && r.kind === 'image') {
    return '# File: ' + r.relPath
      + '\n# Kind: image (' + r.mimeType + ', ' + r.bytes + ' bytes)'
      + '\n# ' + (r.note || 'The picture is attached to this tool result as an image part.');
  }
  const header = '# File: ' + r.relPath
    + '\n# Lines: ' + r.startLine + '-' + r.endLine + (r.totalLines ? ' / ' + r.totalLines : '')
    + (r.truncated ? '\n# Truncated: yes' : '');
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
  // A bare (non-glob) pattern is resolved against the filesystem first:
  //   - an existing directory → everything under it (`src` → all of src/);
  //   - an existing file → just that file;
  //   - a non-existing path → the longest existing ancestor, so `src/util`
  //     (typo or new dir) still lists something instead of nothing (`doc`
  //     falls back to the whole project).
  // This is the same prefix-tolerant behavior the search_files `path`
  // parameter uses; the two surfaces should not disagree.
  let re = pattern ? globToRegExp(pattern) : null;
  if (pattern && !/[\\*?]/.test(pattern)) {
    const rawPath = pattern.replace(/\/+$/, '');
    try {
      const safe = toRelPath(root, rawPath);
      const absProbe = path.resolve(root, safe);
      const probeStat = fs.statSync(absProbe);
      if (probeStat.isDirectory()) {
        re = globToRegExp(safe + '/**');
      } else {
        re = globToRegExp(safe);
      }
    } catch {
      // Outside root or otherwise invalid — keep the strict literal glob so
      // the model gets an honest empty result instead of a fallback walk.
      re = globToRegExp(pattern);
    }
  } else if (pattern && pattern.endsWith('/')) {
    // A trailing slash is a directory intent; match everything under it.
    re = globToRegExp(pattern + '**');
  }

  const out = [];
  let truncated = false;
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
      // Extension allowlist — text files the model can read, plus pictures
      // it can now open with `read_file`. Images are flagged in the entry so
      // the model knows which read returns pixels instead of a body.
      const ext = path.extname(ent.name).toLowerCase();
      const image = !TEXT_EXTS.has(ext) && isImageExt(ext);
      if (!TEXT_EXTS.has(ext) && !image) { skipped++; continue; }
      out.push(image ? { path: childRel, image: true } : { path: childRel });
    }
  }
  await walk(root, '');
  return { entries: out, skipped, truncated, cap, pattern: pattern || '' };
}

function formatListFilesResult(r, structure) {
  const header = '# Listing: ' + (r.pattern || '<all text and image files>') + '\n# Count: ' + r.entries.length + (r.truncated ? ' (capped at ' + r.cap + ')' : '') + (r.skipped ? '\n# Skipped: ' + r.skipped : '');
  if (!r.entries.length) return header + '\n\n(no matching files)';

  const sorted = [...r.entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  // `json` — the structured result verbatim, so the model can parse it.
  if (structure === 'json') return JSON.stringify(r);

  // `tree` (default) — an indented hierarchical tree: each path segment is
  // a node, directories printed once and files nested under their parent.
  // Two spaces per depth level, matching how a file explorer reads. This is
  // the only text layout: it prints every shared path prefix once, which is
  // what the old `# dir/` group-header layout did, without the header lines
  // the model has to context-switch on.
  const treeLines = [];
  let prev = [];
  for (const e of sorted) {
    const parts = e.path.split('/');
    const name = parts[parts.length - 1];
    const dirs = parts.slice(0, -1);
    let shared = 0;
    while (shared < dirs.length && shared < prev.length && dirs[shared] === prev[shared]) shared++;
    for (let i = shared; i < dirs.length; i++) treeLines.push('  '.repeat(i) + dirs[i] + '/');
    treeLines.push('  '.repeat(dirs.length) + name + (e.image ? ' (image)' : ''));
    prev = dirs;
  }
  return header + '\n\n' + treeLines.join('\n');
}

// Minimal glob: **/foo matches foo anywhere; foo/** matches a directory
// tree under foo; otherwise treat the pattern as a right-anchored regex
// of `^pattern$` with `*` -> `[^/]*` and `?` -> `[^/]`. We deliberately
// avoid a full glob library — the model only needs "everything under
// src/", "all *.test.js", "the file named README.md".
//
// Two relaxations over a strict pure glob:
//   - A pattern with no wildcard at all (a bare path like `src` or
//     `README.md`) is treated as a directory-or-file *prefix*: `src`
//     matches everything under src/, `src/utils/index.js` matches that
//     file and any subtree under it. This is what the file tools'
//     `search_files path` parameter already does, and it keeps "list
//     src" from silently returning nothing when the model forgets the
//     `/**`.
//   - Globs are case-insensitive (`README*` matches `readme.md`). Path
//     matching works on the lowercase form so the model doesn't have to
//     guess the project's casing.
function globToRegExp(pattern) {
  let src = '';
  if (!/[\\*?]/.test(pattern)) {
    // Bare path: anchor the literal, then allow a deeper subtree.
    return new RegExp('^' + escapeGlob(pattern) + '(?:/.*)?$', 'i');
  }
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
  return new RegExp('^' + src + '$', 'i');
}
function escapeGlob(pattern) {
  return String(pattern).replace(/[.+^$()|{}[\]\\]/g, '\\$&');
}

// ---- search_files ------------------------------------------------------

// Text search over the project. The engine (ripgrep when available, a JS
// walk when not) lives in src/tools/searchEngine.js; this function owns the
// tool-facing contract only: validate the input, hand the caps over, and
// return the same result shape the formatter and the tests expect.
async function runSearchFiles(opts) {
  const { projectDir, args, settings } = opts;
  return await searchEngine.runSearch({ projectDir, args, settings });
}

function formatSearchFilesResult(r, structure) {
  const header = '# Search: ' + r.query
    + '\n# Matches: ' + r.matches.length + (r.truncated ? ' (capped at ' + r.capMatches + ' matches / ' + r.capBytes + ' chars)' : '');
  if (!r.matches.length) return header + '\n\n(no matches)';

  // `json` — the structured result verbatim.
  if (structure === 'json') return JSON.stringify(r);

  // `tree` (default) — matches nested under an indented path hierarchy.
  // Each file's path segments are printed once, then its matching lines are
  // indented one level deeper.
  const treeLines = [];
  let prevDirs = [];
  let currentPath = null;
  for (const m of r.matches) {
    if (m.path !== currentPath) {
      const parts = m.path.split('/');
      const name = parts[parts.length - 1];
      const dirs = parts.slice(0, -1);
      let shared = 0;
      while (shared < dirs.length && shared < prevDirs.length && dirs[shared] === prevDirs[shared]) shared++;
      for (let i = shared; i < dirs.length; i++) treeLines.push('  '.repeat(i) + dirs[i] + '/');
      treeLines.push('  '.repeat(dirs.length) + name);
      prevDirs = dirs;
      currentPath = m.path;
    }
    treeLines.push('  '.repeat(prevDirs.length + 1) + m.line + ': ' + m.text);
  }
  return header + '\n\n' + treeLines.join('\n');
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

// ---- Indentation helpers (ported from crush's edit_whitespace.go) -------
//
// `edit_file` matches a block even when the caller's indentation differs from
// the file (leading whitespace is formatter-inert), but the replacement must
// land at the file's indentation depth, not the caller's. These helpers detect
// the file's indent unit and re-offset the replacement lines so the edit reads
// as if written by a native tool rather than spliced in at a random depth.

// Detect the indentation unit used by the given lines: "\t" for tab-indented
// files, or a string of N spaces for space-indented files. Returns "" when
// indentation cannot be determined (no indented non-empty lines).
function detectIndentUnit(lines) {
  let minSpaces = 0;
  let hasTabs = false;
  for (const line of lines) {
    const trimmed = String(line).replace(/^[ \t]+/, '');
    if (!trimmed) continue;
    const leading = String(line).slice(0, String(line).length - trimmed.length);
    if (!leading) continue;
    if (leading.indexOf('\t') !== -1) { hasTabs = true; break; }
    const n = leading.length;
    if (n > 0 && (minSpaces === 0 || n < minSpaces)) minSpaces = n;
  }
  if (hasTabs) return '\t';
  if (minSpaces > 0) return ' '.repeat(minSpaces);
  return '';
}

// Count how many `unit` deep the leading whitespace of `leading` represents.
// Returns a whole number so the caller can safely use it in `repeat()`.
function measureIndentDepth(leading, unit) {
  if (!unit) return 0;
  if (unit === '\t') return leading.split('\t').length - 1;
  return Math.floor((leading.split(' ').length - 1) / unit.length);
}

// Depth of the first non-empty line in `lines`, in units of `unit`.
function firstIndentDepth(lines, unit) {
  for (const line of lines) {
    const trimmed = String(line).replace(/^[ \t]+/, '');
    if (!trimmed) continue;
    const leading = String(line).slice(0, String(line).length - trimmed.length);
    return measureIndentDepth(leading, unit);
  }
  return 0;
}

// Re-indent `newStr` to match the file `unit`, offsetting by the difference in
// nesting depth between the actual matched text (`actualStr`) and the caller's
// `oldStr`. Mirrors crush's `adaptIndentation`, but only when a unit could be
// inferred and the two strings are not already depth-consistent.
function adaptIndentation(actualStr, oldStr, newStr, fileUnit) {
  if (!fileUnit) return newStr;
  const actualLines = String(actualStr).split('\n');
  const oldLines = String(oldStr).split('\n');
  const newLines = String(newStr).split('\n');

  const sourceUnit = detectIndentUnit(oldLines) || detectIndentUnit(newLines) || fileUnit;
  const actualBase = firstIndentDepth(actualLines, fileUnit);
  const oldBase = firstIndentDepth(oldLines, sourceUnit);
  const depthOffset = actualBase - oldBase;
  if (sourceUnit === fileUnit && depthOffset === 0) return newStr;

  const out = [];
  for (const line of newLines) {
    const trimmed = String(line).replace(/^[ \t]+/, '');
    if (!trimmed) { out.push(line); continue; }
    const leading = String(line).slice(0, String(line).length - trimmed.length);
    const depth = Math.max(measureIndentDepth(leading, sourceUnit) + depthOffset, 0);
    out.push(fileUnit.repeat(depth) + trimmed);
  }
  return out.join('\n');
}

// Undo JSON-style escaping ("\n", "\t", "\"", "\\", "\r", etc.) in a string a
// model authored as a literal. This rescues `edit_file` calls where the model
// emitted its block with doubled escape sequences, so the bytes on disk match
// the literal text the model intended. Only applied when it actually differs,
// and only as a fallback after the direct match fails.
function unescapeEditString(str) {
  return String(str).replace(/\\(n|t|r|'|"|`|\\|\/|\$)/g, (m, c) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case "'": return "'";
      case '"': return '"';
      case '`': return '`';
      case '\\': return '\\';
      case '/': return '/';
      case '$': return '$';
      default: return m;
    }
  });
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

// Find the closest matching snippet in the file to help an agent understand
// why `oldText` was not matched (e.g. stale cache or slight typo).
function findClosestContext(original, oldText) {
  const fileLines = String(original || '').split(/\r?\n/);
  const oldLines = String(oldText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!oldLines.length || !fileLines.length) return null;

  function tokenize(str) {
    return str.toLowerCase().match(/[a-zA-Z0-9_$]+/g) || [];
  }

  const oldTokens = new Set(tokenize(oldText));
  if (oldTokens.size === 0) return null;

  let bestScore = 0;
  let bestIndex = -1;
  const windowLen = Math.max(1, oldLines.length);

  for (let i = 0; i < fileLines.length; i++) {
    const windowLines = fileLines.slice(i, i + windowLen);
    const windowText = windowLines.join('\n');
    const windowTokens = tokenize(windowText);
    if (windowTokens.length === 0) continue;

    let overlap = 0;
    for (const t of windowTokens) {
      if (oldTokens.has(t)) overlap++;
    }
    const score = overlap / Math.max(windowTokens.length, oldTokens.size);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestScore >= 0.25 && bestIndex >= 0) {
    const startLine = Math.max(1, bestIndex + 1);
    const endLine = Math.min(fileLines.length, bestIndex + windowLen);
    const excerptLines = [];
    for (let i = startLine; i <= endLine; i++) {
      excerptLines.push(i + ': ' + (fileLines[i - 1] || ''));
    }
    return {
      startLine,
      endLine,
      score: bestScore,
      excerpt: excerptLines.join('\n')
    };
  }
  return null;
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
  return { relPath: rel, chars: content.length, lines: content ? content.split('\n').length : 0 };
}

// Replace one unique block in an existing text file. Line-ending styles are
// considered equivalent during matching. This is kept
// deliberately separate from write_file: coding models commonly interpret
// "edit" as a patch operation and send only the changed line. Treating that
// payload as a full-file body silently destroys the rest of the file.
function matchEditSpan(original, needleText, rel) {
  const source = normalizedTextWithOffsets(original);
  // Normalized comparison form: line endings are equalized and runs of
  // spaces/tabs inside a line are collapsed, so a block that differs from
  // the file only by indentation or extra whitespace still matches. The
  // collapse keeps a 1:1 character->position map (offsets) so the matched
  // span still maps back to exact original byte offsets.
  function softNormalizeWithOffsets(text) {
    let norm = '';
    const off = [];
    for (let i = 0; i < text.length;) {
      off.push(i);
      const c = text[i];
      if (c === '\r') {
        norm += '\n';
        i += text[i + 1] === '\n' ? 2 : 1;
      } else if (c === ' ' || c === '\t') {
        norm += ' ';
        i++;
        while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
      } else {
        norm += c;
        i++;
      }
    }
    off.push(text.length);
    return { norm, off };
  }
  const needle = softNormalizeWithOffsets(needleText);
  const target = softNormalizeWithOffsets(source.normalized);

  // Strategy 1: Direct soft match on collapsed horizontal whitespace.
  let normStart = -1;
  let normEnd = -1;
  const first = target.norm.indexOf(needle.norm);
  if (first >= 0) {
    if (target.norm.indexOf(needle.norm, first + needle.norm.length) >= 0) {
      throw err('EMULTI_MATCH', 'oldText occurs more than once in ' + rel + '; include more surrounding context');
    }
    normStart = target.off[first];
    normEnd = target.off[first + needle.norm.length];
  } else {
    // Strategy 2: Formatter-tolerant match. Whitespace between punctuation is
    // insignificant, while a separator between word characters remains
    // significant (`return x` must not match `returnx`). This accepts line
    // wraps, blank lines, and spacing around operators without accepting
    // changed code.
    function layoutNormalizeWithOffsets(text) {
      let norm = '';
      const starts = [];
      const ends = [];
      const isWord = (c) => !!c && /[\p{L}\p{N}_$]/u.test(c);
      let quote = '';
      let escaped = false;
      for (let i = 0; i < text.length;) {
        const c = text[i];
        if (quote || !/\s/u.test(c)) {
          starts.push(i);
          ends.push(i + 1);
          norm += c;
          if (quote) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === quote) quote = '';
          } else if (c === "'" || c === '"' || c === '`') {
            quote = c;
          }
          i++;
          continue;
        }
        const wsStart = i;
        while (i < text.length && /\s/u.test(text[i])) i++;
        const prev = norm[norm.length - 1] || '';
        const next = text[i] || '';
        if (isWord(prev) && isWord(next)) {
          starts.push(wsStart);
          ends.push(i);
          norm += ' ';
        }
      }
      return { norm, starts, ends };
    }
    const layoutNeedle = layoutNormalizeWithOffsets(needleText);
    const layoutTarget = layoutNormalizeWithOffsets(source.normalized);
    if (layoutNeedle.norm) {
      const layoutFirst = layoutTarget.norm.indexOf(layoutNeedle.norm);
      if (layoutFirst >= 0) {
        if (layoutTarget.norm.indexOf(layoutNeedle.norm, layoutFirst + layoutNeedle.norm.length) >= 0) {
          throw err('EMULTI_MATCH', 'oldText occurs more than once in ' + rel + '; include more surrounding context');
        }
        normStart = layoutTarget.starts[layoutFirst];
        normEnd = layoutTarget.ends[layoutFirst + layoutNeedle.norm.length - 1];
      }
    }

    // Strategy 3: Line-trimmed block match (ignoring leading/trailing blank
    // lines in oldText and line-by-line whitespace variations).
    if (normStart < 0 || normEnd < 0) {
      const needleLines = needle.norm.split('\n');
      let nStart = 0;
      let nEnd = needleLines.length;
      while (nStart < nEnd && !needleLines[nStart].trim()) nStart++;
      while (nEnd > nStart && !needleLines[nEnd - 1].trim()) nEnd--;

      let matchedLineIdx = -1;
      let isMulti = false;
      if (nEnd > nStart) {
        const targetLines = target.norm.split('\n');
        const targetLineOffsets = [0];
        for (let i = 0; i < target.norm.length; i++) {
          if (target.norm[i] === '\n') targetLineOffsets.push(i + 1);
        }
        const needleLineCount = nEnd - nStart;
        const matches = [];
        for (let i = 0; i <= targetLines.length - needleLineCount; i++) {
          let match = true;
          for (let j = 0; j < needleLineCount; j++) {
            if (targetLines[i + j].trim() !== needleLines[nStart + j].trim()) {
              match = false;
              break;
            }
          }
          if (match) matches.push(i);
        }
        if (matches.length === 1) {
          matchedLineIdx = matches[0];
          const lineStartNorm = targetLineOffsets[matchedLineIdx];
          const endLineIdx = matchedLineIdx + needleLineCount - 1;
          const lineEndNorm = (endLineIdx + 1 < targetLineOffsets.length)
            ? targetLineOffsets[endLineIdx + 1] - 1
            : target.norm.length;
          normStart = target.off[lineStartNorm];
          normEnd = target.off[lineEndNorm];
        } else if (matches.length > 1) {
          isMulti = true;
        }
      }

      if (isMulti) {
        throw err('EMULTI_MATCH', 'oldText occurs more than once in ' + rel + '; include more surrounding context');
      }

      if (normStart < 0 || normEnd < 0) {
        // Find closest matching snippet to give the model actionable feedback.
        const hint = findClosestContext(original, needleText);
        let msg = 'oldText was not found in ' + rel + '; read the file and retry with an exact block';
        if (hint && hint.excerpt) {
          msg += '\n\nClosest match found around lines ' + hint.startLine + '-' + hint.endLine + ':\n' + hint.excerpt;
        }
        throw err('ENO_MATCH', msg);
      }
    }
  }
  return { normStart, normEnd };
}

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

  // Try the caller's oldText verbatim. If it fails with ENO_MATCH and the
  // block was authored with escape sequences (so it matches nothing on disk),
  // retry the whole match against its unescaped form so a JSON-escaped block
  // can still land. When that rescues the match we also unescape the
  // replacement, because a model that escapes the block escapes both sides.
  let matched;
  let matchedOld = oldText;
  let escapedFallback = false;
  try {
    matched = matchEditSpan(original, oldText, rel);
  } catch (e) {
    if (e && e.code === 'ENO_MATCH') {
      const unescaped = unescapeEditString(oldText);
      if (unescaped !== oldText) {
        matched = matchEditSpan(original, unescaped, rel);
        matchedOld = unescaped;
        escapedFallback = true;
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  // Map the normalized source positions back to original byte offsets.
  const originalStart = source.offsets[matched.normStart];
  const originalEnd = source.offsets[matched.normEnd];
  const replaced = original.slice(originalStart, originalEnd);

  // Re-indent the replacement so it lands at the file's indentation depth,
  // not the caller's — but only when the matched span sits on its own line
  // boundaries. A mid-line (substring) match keeps its leading whitespace as
  // part of the surrounding slice, so re-indenting there would double-indent.
  let newTextToApply = escapedFallback ? unescapeEditString(newText) : newText;
  const alignedStart = originalStart === 0 || original[originalStart - 1] === '\n';
  const alignedEnd = originalEnd >= original.length
    || original[originalEnd] === '\n' || original[originalEnd] === '\r';
  if (alignedStart && alignedEnd) {
    const fileUnit = detectIndentUnit(original.split('\n'));
    newTextToApply = adaptIndentation(replaced, matchedOld, newTextToApply, fileUnit);
  }
  const replacement = convertLineEndings(newTextToApply, detectLineEnding(original));
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
    addedChars: replacement.length,
    removedChars: replaced.length,
    diff: previewEditDiff(rel, replaced, replacement)
  };
}
function formatWriteFileResult(r) {
  let out = '# Wrote: ' + r.relPath;
  if (r.chars != null) out += '\n# Chars: ' + r.chars + (r.lines != null ? ' · ' + r.lines + ' lines' : '');
  else if (r.addedChars != null) out += '\n# Chars: +' + r.addedChars + ' / -' + (r.removedChars || 0);
  return out;
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
  // Pick the file-listing layout from the per-project tool-output profile.
  // Only the two file structures (`json` / `tree`) change rendering here;
  // every other value (including the legacy `grouped`, `full`, `concise`)
  // falls through to the default `tree` layout.
  const FILE_STRUCTURES = ['json', 'tree'];
  const rawStructure = opts && opts.toolOutput && typeof opts.toolOutput === 'object'
    ? opts.toolOutput.structure : null;
  const structure = FILE_STRUCTURES.includes(rawStructure) ? rawStructure : 'tree';

  let content;
  try {
    if (name === 'read_file') content = formatReadFileResult(out, structure);
    else if (name === 'list_files') content = formatListFilesResult(out, structure);
    else if (name === 'search_files') content = formatSearchFilesResult(out, structure);
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
      description: 'Read a text file from the project directory, or open an image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.ico`) by attaching its pixels as an image part so a vision model can see it. A text read returns the file body with a header that shows the path, line range, and total line count. Use startLine/endLine (1-indexed, inclusive) to read a slice of a large file; whole-file reads over 10000 lines are refused. An image read returns a header (path, MIME type, size) plus the picture; images over 4 MB are refused — downscale first.',
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
      description: 'List text and image files in the project directory. Honors a simple glob pattern ("src/**/*.js", "**/*.test.*", "README.md"). Image files are marked "(image)" — read them with read_file to see the picture. Skips node_modules, .git, .mouaif, dist, build. Result is capped at 1000 entries.',
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
      description: 'Search file contents with a ripgrep-style regular expression. Honors the project\'s .gitignore, so generated and build output trees are skipped. Binary files are skipped. Matches are printed as an indented tree: each file\'s path segments once, then its "line: text" rows one level deeper. Optional `path` scopes the search to a directory or a single file, and a path that does not exist yet still searches its nearest existing ancestor ("src/util" searches "src/"). Optional `include` filters by glob, e.g. "*.js" or "*.{ts,tsx}". Destructive and named patterns stay plain: backreferences (\\1), lookahead and lookbehind are rejected. Capped at 200 matches / 2M chars scanned.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Ripgrep-style regular expression, matched one line at a time. `(?i)` for case-insensitive is honored. `(?s)` is not: matches are reported and redacted per line, so search for the two anchors separately. Lookaround and backreferences are not supported.' },
          path: { type: 'string', description: 'Optional directory or single file to scope the search. Use "." or omit for the whole project.' },
          include: { type: 'string', description: 'Optional glob to filter the files searched, e.g. "*.js", "*.{ts,tsx}", "src/**/*.test.js", "src/[ab].js".' }
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
  DEFAULT_READ_MAX_LINES,
  DEFAULT_READ_LINES,
  DEFAULT_READ_MAX_IMAGE_BYTES,
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_SEARCH_MAX_MATCHES,
  DEFAULT_SEARCH_MAX_BYTES,
  DEFAULT_WRITE_MAX_BYTES,
  MAX_TIMEOUT_MS
};
