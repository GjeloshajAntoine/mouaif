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
// Anything outside is treated as binary for editor purposes.
const TEXT_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.txt',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h',
  '.cpp', '.hpp', '.css', '.scss', '.sass', '.less', '.html', '.htm',
  '.yml', '.yaml', '.toml', '.sh', '.bash', '.zsh', '.fish',
  '.xml', '.svg', '.ini', '.cfg', '.conf', '.env', '.gitignore',
  '.editorconfig', '.dockerignore', '.ps1', '.psm1', '.psd1', '.lua', '.pl', '.r',
  '.sql', '.csv', '.tsv', '.vue', '.svelte'
]);

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
    const text = isTextExt(ext);
    entries.push({
      name,
      path: full,
      relPath: rel === '.' ? name : (rel + '/' + name),
      type: 'file',
      size: st.size,
      ext: ext || '',
      binary: !text,
      text
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
  if (!isTextExt(ext)) throw err('EBINARY', 'Binary files cannot be edited here', { path: abs, ext });
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
  if (!isTextExt(ext)) throw err('EBINARY', 'Binary files cannot be edited here', { path: abs, ext });
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
  writeFile,
  // helpers (exported for tests)
  resolveSafe,
  isTextExt,
  TEXT_EXTS,
  SKIP_DIRS,
  DEFAULT_MAX_BYTES
};
