'use strict';

// File editor — read/write text files inside a project folder.
//
// Implements the editor popup described in docs/features/chat-ui.md
// (file editor button next to the message composer). The popup is a
// CodeMirror-based UI served by the mobile web client; this module
// is the matching server surface.
//
// Public surface (all paths must live under a project folder that
// itself lives under the user home unless MOUAIF_ALLOW_ANY_ROOT=1):
//
//   listDir(projectDir, dir)   -> { projectDir, dir, entries: [...] }
//   readFile(projectDir, path) -> { projectDir, path, relPath, size, ext, content }
//   writeFile(projectDir, path, content) -> { projectDir, path, relPath, size, bytesWritten }
//
// `projectDir` and `dir` may be the same: listing the project root
// is the default. `path` for read/write may be absolute or
// project-relative.
//
// Text-only: the editor never opens binary files. A list entry has a
// `binary: true` flag so the UI can grey those out; read/write reject
// non-text files with a typed EBINARY error so the caller can show
// "this file cannot be edited here" instead of a 500.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const { err } = require('./util.js');
const projects = require('./projects.js');

// Default per-file size cap. The editor is for small fixes (config
// tweaks, prompts, READMEs), not 50 MB log dumps. Overridable per
// call when we need to (tests).
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

// Same allowlist as the file-tagging scan (docs/decisions.md §15).
// Anything outside is treated as binary for editor purposes unless
// the small-file text sniff in `isProbablyText` recognises it.
const TEXT_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.txt',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h',
  '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.cs', '.m', '.mm',
  '.css', '.scss', '.sass', '.less', '.html', '.htm',
  '.yml', '.yaml', '.toml', '.sh', '.bash', '.zsh', '.fish',
  '.xml', '.svg', '.ini', '.cfg', '.conf', '.env', '.gitignore',
  '.editorconfig', '.dockerignore', '.ps1', '.psm1', '.psd1',
  '.lua', '.pl', '.r', '.dart', '.php', '.phtml',
  '.sql', '.csv', '.tsv', '.vue', '.svelte',
  '.graphql', '.gql', '.proto', '.prisma', '.gradle', '.kts',
  '.rst', '.tex', '.diff', '.patch', '.log',
  '.lock', '.sum', '.mod', '.properties',
  '.nim', '.zig', '.v', '.sv', '.svh',
  '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.cljc',
  '.tf', '.hcl', '.nix', '.dhall'
]);
// Image extensions the file modal can preview inline. The same home
// + MOUAIF_ALLOW_ANY_ROOT guard protects reads, just like the text
// editor. SVG is included even though it's text — the editor still
// refuses to *edit* SVG, and treating it as a media file here means
// the user gets a visual preview in the modal.
const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'
]);
const EXT_TO_MIME = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.bmp':  'image/bmp',
  '.ico':  'image/x-icon'
};

// Names that the walker never descends into. Mirrors the file-tagging
// scan so the editor popup is consistent with the existing project
// views.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.mouaif', 'dist', 'build', '.next',
  '.cache', '.parcel-cache', '.turbo', '.vercel', '.nuxt',
  'coverage', '.pytest_cache', '__pycache__', 'target'
]);

// ---- Errors ------------------------------------------------------------

// err() is shared from src/util.js (files.js, tags.js and mcp.js used to
// each carry an identical private copy).

function isTextExt(ext) {
  if (!ext) return false;
  return TEXT_EXTS.has(ext.toLowerCase());
}
function isImageExt(ext) {
  if (!ext) return false;
  return IMAGE_EXTS.has(ext.toLowerCase());
}
function mimeForExt(ext) {
  if (!ext) return 'application/octet-stream';
  return EXT_TO_MIME[ext.toLowerCase()] || 'application/octet-stream';
}
// Sniff the first ~8 KiB of a small file and decide whether it looks
// like text. A NUL byte is the cheap, reliable tell: real text never
// has one in the first KB, but every binary format (PNG, ELF, ZIP,
// PDF, ...) starts with one. We only run this on files that fit under
// the editor size cap, so the read is bounded and the editor never
// tries to render a 50 MB file as text. The fallback exists so the
// user can open plain-text files with unfamiliar extensions (LICENSE
// without an extension, .gitattributes, dotfiles) instead of being
// forced to edit them in a different tool.
async function isProbablyText(abs) {
  let fd;
  try {
    fd = await fsp.open(abs, 'r');
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return true; // empty file is "text"
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0x00) return false;
    }
    // Also reject if the UTF-8 decode throws - a control-heavy
    // binary will fail the decode even without an explicit NUL.
    buf.toString('utf8', 0, bytesRead);
    return true;
  } catch {
    return false;
  } finally {
    if (fd) { try { await fd.close(); } catch { /* ignore */ } }
  }
}
// Sync version for use inside listDir, which is itself sync. Same
// 8 KiB NUL-byte heuristic. We do not call this on every entry; it
// is only used when the extension is missing or unknown and the file
// fits under the editor cap, so a one-off read here is fine.
function isProbablyTextSync(abs, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead === 0) return true; // empty file is "text"
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0x00) return false;
    }
    buf.toString('utf8', 0, bytesRead);
    return true;
  } catch {
    return false;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// ---- Path safety -------------------------------------------------------

// Resolve any incoming path to an absolute path that MUST be inside
// projectDir. The projectDir itself is also validated via
// projects.ensureSafeRoot so the same home / MOUAIF_ALLOW_ANY_ROOT
// rule that protects the rest of the app applies here too.
//
// `incoming` may be absolute or relative; relative is resolved against
// projectDir. Throws typed errors (EBADPATH, EOUTSIDE_PROJECT,
// ENOENT) instead of letting the underlying fs throw something the
// UI cannot render.
function resolveSafe(projectDir, incoming) {
  if (typeof projectDir !== 'string' || !projectDir) {
    throw err('EBADPATH', 'projectDir is required');
  }
  // Validate the project root. Throws EOUTSIDE_HOME etc.
  const root = projects.ensureSafeRoot(projectDir);
  if (!incoming || typeof incoming !== 'string') {
    throw err('EBADPATH', 'path is required');
  }
  const abs = path.isAbsolute(incoming) ? path.resolve(incoming) : path.resolve(root, incoming);
  // Must be inside root. `path.relative` returns '' for the same path.
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw err('EOUTSIDE_PROJECT', 'Path escapes the project root', { path: incoming });
  }
  return { root, abs, rel: rel || '.' };
}

function ensureDir(root, abs, kind) {
  // kind: 'list' (must be a dir), 'parent' (must be a dir, used for writes)
  let st;
  try { st = fs.statSync(abs); }
  catch (e) {
    if (e.code === 'ENOENT') {
      throw err('ENOENT', kind === 'parent' ? 'Parent directory does not exist' : 'Directory does not exist', { path: abs });
    }
    throw e;
  }
  if (!st.isDirectory()) {
    throw err('ENOTDIR', 'Path is not a directory', { path: abs });
  }
  return st;
}

function hasImmediateSubdirs(abs) {
  let names;
  try { names = fs.readdirSync(abs); }
  catch { return false; }
  for (const n of names) {
    if (n.startsWith('.') || SKIP_DIRS.has(n)) continue;
    try {
      const st = fs.statSync(path.join(abs, n));
      if (st.isDirectory()) return true;
    } catch { /* ignore */ }
  }
  return false;
}

// ---- Public: list ------------------------------------------------------

function listDir(projectDir, dir) {
  const target = (dir && typeof dir === 'string') ? dir : projectDir;
  const { root, abs, rel } = resolveSafe(projectDir, target);
  ensureDir(root, abs, 'list');
  let names;
  try { names = fs.readdirSync(abs); }
  catch (e) {
    throw err(e.code === 'EACCES' ? 'EACCES' : 'EREAD', e.message, { path: abs });
  }
  const entries = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(abs, name);
    let st;
    try { st = fs.statSync(full); }
    catch { continue; }
    if (st.isDirectory()) {
      entries.push({
        name,
        path: full,
        relPath: rel === '.' ? name : (rel + '/' + name),
        type: 'dir',
        hasChildren: hasImmediateSubdirs(full)
      });
      continue;
    }
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    let text = isTextExt(ext);
    const image = isImageExt(ext);
    // Sniff small files with an unknown extension (e.g. LICENSE,
    // .gitattributes) so the modal offers to open them as text. A
    // known image extension is never treated as text even if the
    // first 8 KiB happen to contain no NUL bytes.
    if (!text && !image && st.size <= DEFAULT_MAX_BYTES) {
      text = isProbablyTextSync(full, DEFAULT_MAX_BYTES);
    }
    entries.push({
      name,
      path: full,
      relPath: rel === '.' ? name : (rel + '/' + name),
      type: 'file',
      size: st.size,
      ext: ext || '',
      binary: !text,
      text,
      image
    });
  }
  // Dirs first, then files; both sorted case-insensitively.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return { projectDir: root, dir: abs, relDir: rel, entries };
}

// ---- Public: read ------------------------------------------------------

async function readFile(projectDir, filePath, opts) {
  const { root, abs, rel } = resolveSafe(projectDir, filePath);
  const max = (opts && Number.isInteger(opts.maxBytes) && opts.maxBytes > 0) ? opts.maxBytes : DEFAULT_MAX_BYTES;
  let st;
  try { st = await fsp.stat(abs); }
  catch (e) {
    if (e.code === 'ENOENT') throw err('ENOENT', 'File does not exist', { path: abs });
    throw e;
  }
  if (!st.isFile()) throw err('ENOTFILE', 'Path is not a file', { path: abs });
  const ext = path.extname(abs).toLowerCase();
  if (!isTextExt(ext) && (isImageExt(ext) || !(st.size <= max && await isProbablyText(abs)))) {
    throw err('EBINARY', 'Binary files cannot be edited here', { path: abs, ext });
  }
  if (st.size > max) {
    throw err('ETOOLARGE', 'File exceeds the editor size cap', { path: abs, size: st.size, maxBytes: max });
  }
  let content;
  try { content = await fsp.readFile(abs, 'utf8'); }
  catch (e) {
    if (e.code === 'EACCES') throw err('EACCES', e.message, { path: abs });
    throw e;
  }
  return { projectDir: root, path: abs, relPath: rel, size: st.size, ext: ext || '', content };
}
// ---- Public: readMedia -------------------------------------------------
// Read an image (or any binary the modal can preview) as a
// base64-encoded data URL. The file editor is the only caller: it
// builds a <img src="data:..."> from the result so the preview does
// not need a separate auth-bearing URL. Files larger than the
// editor cap (1 MiB) are rejected with the same ETOOLARGE code the
// text read uses, so the UI shows a consistent error pill.
async function readMedia(projectDir, filePath, opts) {
  const { root, abs, rel } = resolveSafe(projectDir, filePath);
  const max = (opts && Number.isInteger(opts.maxBytes) && opts.maxBytes > 0) ? opts.maxBytes : DEFAULT_MAX_BYTES;
  let st;
  try { st = await fsp.stat(abs); }
  catch (e) {
    if (e.code === 'ENOENT') throw err('ENOENT', 'File does not exist', { path: abs });
    throw e;
  }
  if (!st.isFile()) throw err('ENOTFILE', 'Path is not a file', { path: abs });
  const ext = path.extname(abs).toLowerCase();
  if (!isImageExt(ext)) {
    throw err('ENOTIMAGE', 'File is not a previewable image', { path: abs, ext });
  }
  if (st.size > max) {
    throw err('ETOOLARGE', 'Image exceeds the preview size cap', { path: abs, size: st.size, maxBytes: max });
  }
  let buf;
  try { buf = await fsp.readFile(abs); }
  catch (e) {
    if (e.code === 'EACCES') throw err('EACCES', e.message, { path: abs });
    throw e;
  }
  const mime = mimeForExt(ext);
  return {
    projectDir: root,
    path: abs,
    relPath: rel,
    size: st.size,
    ext: ext || '',
    mime,
    dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64')
  };
}

// ---- Public: write -----------------------------------------------------

// Atomic write: stage to <file>.mouaif-tmp then rename. Same pattern
// used by src/tools/files.js so a crash mid-write cannot truncate the
// real file. Preserves the existing file mode when overwriting.
async function writeFile(projectDir, filePath, content) {
  if (typeof content !== 'string') {
    throw err('EBADINPUT', 'content must be a string');
  }
  const { root, abs, rel } = resolveSafe(projectDir, filePath);
  // The parent must exist; we do not auto-create folders. The editor
  // is for "edit existing files", not "create new project trees".
  const parent = path.dirname(abs);
  ensureDir(root, parent, 'parent');

  // Refuse to clobber an existing directory at the target path BEFORE
  // checking the extension allowlist: "this is a directory" is the
  // real reason the write is invalid, not "the directory has no
  // extension so it looks binary".
  let existing;
  try { existing = await fsp.stat(abs); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing && existing.isDirectory()) {
    throw err('EISDIR', 'Target is a directory', { path: abs });
  }

  const ext = path.extname(abs).toLowerCase();
  // Match readFile: known images are never text, everything else
  // is allowed if it has a text extension or has no extension. A
  // brand-new file (existing is undefined) cannot be sniffed, so we
  // fall back to the extension allowlist only - this matches the
  // original "must have a text extension" behavior for new files
  // and means the user can save to .LICENSE, .gitattributes, etc.,
  // by re-opening an existing one.
  if (existing && !isTextExt(ext) && (isImageExt(ext) || !(await isProbablyText(abs)))) {
    throw err('EBINARY', 'Binary files cannot be edited here', { path: abs, ext });
  }
  if (!existing && !isTextExt(ext)) {
    throw err('EBINARY', 'Refusing to write to a non-text extension', { path: abs, ext });
  }
  const size = Buffer.byteLength(content, 'utf8');
  if (size > DEFAULT_MAX_BYTES) {
    throw err('ETOOLARGE', 'Refusing to write file larger than the editor size cap', { path: abs, size, maxBytes: DEFAULT_MAX_BYTES });
  }

  const tmp = abs + '.mouaif-tmp';
  let st;
  try { st = await fsp.stat(abs); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  try {
    await fsp.writeFile(tmp, content, { encoding: 'utf8', mode: st ? st.mode : 0o644 });
    await fsp.rename(tmp, abs);
  } catch (e) {
    // Clean up the staging file on failure.
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    if (e.code === 'EACCES') throw err('EACCES', e.message, { path: abs });
    throw e;
  }
  return { projectDir: root, path: abs, relPath: rel, size, bytesWritten: size };
}

module.exports = {
  // operations
  listDir,
  readFile,
  readMedia,
  writeFile,
  // helpers (exported for tests)
  resolveSafe,
  isTextExt,
  isImageExt,
  mimeForExt,
  isProbablyText,
  isProbablyTextSync,
  TEXT_EXTS,
  IMAGE_EXTS,
  SKIP_DIRS,
  DEFAULT_MAX_BYTES
};
