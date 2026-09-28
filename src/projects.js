'use strict';

// Project / folder picker — files API + registered-project store.
//
// Implements docs/decisions.md section 4 (full filesystem browse) and the
// "new project opens a folder list + create new folder" rule from
// .github/copilot-instructions.md.
//
// Two surfaces:
//
//   Filesystem surface (the picker):
//     listDir(absPath)        -> { dir, dirHasConfig, entries: [{ name, path,
//                                  hasChildren, hasConfig }] }
//     createDir(absPath)      -> { path }
//
//   Registered-project surface (the user's chosen projects):
//     listProjects()          -> [{ id, path, name, createdAt }]
//     getProject(id)          -> { id, path, name, createdAt } | null
//     registerProject(path)   -> { id, path, name, createdAt }
//     removeProject(id)       -> true | false
//
//   Project config file (the per-project settings file, `.mouaif.json`):
//     configPath(absPath)     -> <absPath>/.mouaif.json
//     hasConfig(absPath)      -> true | false
//     ensureProjectConfig(absPath)
//                             -> { path, created, adopted, name }
//
// Registered projects are stored in the app settings under the `projects`
// key. They survive restarts. Removing a registered project does NOT
// delete the folder on disk.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const settings = require('./settings.js');

// The per-project config file. Same name as settings.PROJECT_FILE: this is the
// file the "Config file in the folder" option writes at add time and adopts
// when it is already there.
const PROJECT_CONFIG_FILE = '.mouaif.json';

const ALLOW_ANY_ROOT = process.env.MOUAIF_ALLOW_ANY_ROOT === '1';

// ---- Path safety --------------------------------------------------------

function isAbsolutePath(p) {
  return typeof p === 'string' && path.isAbsolute(p);
}

function isUnderHome(absPath) {
  const home = os.homedir();
  const resolved = path.resolve(absPath);
  const homeResolved = path.resolve(home);
  // Same path, or a descendant.
  if (resolved === homeResolved) return true;
  const rel = path.relative(homeResolved, resolved);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function ensureSafeRoot(absPath) {
  if (!isAbsolutePath(absPath)) {
    const e = new Error('Path must be absolute');
    e.code = 'EBADPATH';
    throw e;
  }
  if (!ALLOW_ANY_ROOT && !isUnderHome(absPath)) {
    const e = new Error('Path must be under the user home. Set MOUAIF_ALLOW_ANY_ROOT=1 to opt out.');
    e.code = 'EOUTSIDE_HOME';
    throw e;
  }
  return path.resolve(absPath);
}
// The top-most directory the file editor / picker may browse to. With
// MOUAIF_ALLOW_ANY_ROOT the whole filesystem is reachable so the boundary
// is the root path; otherwise it is the user's home. Used by the frontend
// to clamp the Up button at the natural top so it never asks the server
// for a directory that would fail the home guard.
function browseTop(absPath) {
  if (!absPath || !isAbsolutePath(absPath)) return null;
  if (ALLOW_ANY_ROOT) {
    const root = path.parse(path.resolve(absPath)).root;
    return root;
  }
  return os.homedir();
}
// True when `absPath` sits at or above the browse boundary (home, or /)
// for the given home/ALLOW key — i.e. there is no parent to go up to.
function isBrowseTop(absPath) {
  const top = browseTop(absPath);
  if (!top) return true;
  const resolved = path.resolve(absPath || '');
  const topResolved = path.resolve(top);
  return resolved === topResolved;
}

// ---- Filesystem surface -------------------------------------------------

function listDir(absPath) {
  const safe = ensureSafeRoot(absPath);
  let names;
  try {
    names = fs.readdirSync(safe);
  } catch (e) {
    // Surface typed errors so the UI can show "permission denied" vs "no such dir".
    const wrapped = new Error(e.message);
    wrapped.code = e.code || 'EREAD';
    wrapped.path = safe;
    throw wrapped;
  }
  const entries = [];
  for (const name of names) {
    // Skip hidden by default — chat list / project picker doesn't need dotfiles.
    if (name.startsWith('.')) continue;
    const full = path.join(safe, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    entries.push({
      name,
      path: full,
      hasChildren: hasImmediateSubdirs(full),
      // Whether this folder already carries a `.mouaif.json`. The picker
      // uses it to offer "Use this config file" instead of writing one.
      hasConfig: hasConfig(full)
    });
  }
  // Stable order: case-insensitive name.
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { dir: safe, dirHasConfig: hasConfig(safe), entries };
}

function hasImmediateSubdirs(absPath) {
  let names;
  try { names = fs.readdirSync(absPath); } catch { return false; }
  for (const n of names) {
    if (n.startsWith('.')) continue;
    try {
      const st = fs.statSync(path.join(absPath, n));
      if (st.isDirectory()) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function createDir(absPath) {
  const safe = ensureSafeRoot(absPath);
  try {
    fs.mkdirSync(safe, { recursive: false });
  } catch (e) {
    if (e.code === 'EEXIST') {
      const wrapped = new Error('Directory already exists');
      wrapped.code = 'EEXIST';
      wrapped.path = safe;
      throw wrapped;
    }
    throw e;
  }
  return { path: safe };
}

// ---- Project config file ------------------------------------------------

// The per-project settings file inside a folder.
function configPath(absPath) {
  return path.join(absPath, PROJECT_CONFIG_FILE);
}

// Whether a folder already carries a config file. A plain file check, not a
// parse: the picker only asks "is one here?" so it can offer to adopt it, and
// a project whose file happens to be malformed must still be registerable
// (the settings route reports the parse error where the user can fix it).
function hasConfig(absPath) {
  if (!absPath || !isAbsolutePath(absPath)) return false;
  try {
    return fs.statSync(configPath(absPath)).isFile();
  } catch {
    return false;
  }
}

// ensureProjectConfig(absPath, opts) — the "Config file in the folder" action
// of the add-project flow.
//
//   * The folder already has a `.mouaif.json`: it is adopted — the file is
//     read (so a malformed one fails loudly instead of being silently
//     overwritten), left byte-for-byte untouched, and `adopted: true` comes
//     back with the name it carries (if any).
//   * No file yet: one is written with `{ name }` (the folder's basename) so
//     the project starts from a file that is there to be committed and
//     hand-edited. Writes go through settings.writeProjectJson — the same
//     staged + fsync + atomic-rename writer every other project write uses.
//
// Filesystem-backed only: a folder that is opted into DB-backed settings is
// never given a file by this call (its storage choice wins).
function ensureProjectConfig(absPath, opts) {
  const safe = ensureSafeRoot(absPath);
  const stat = fs.statSync(safe);
  if (!stat.isDirectory()) {
    const e = new Error('Path is not a directory');
    e.code = 'ENOTDIR';
    e.path = safe;
    throw e;
  }
  const file = configPath(safe);
  const name = (opts && typeof opts.name === 'string' && opts.name.trim())
    ? opts.name.trim()
    : path.basename(safe);

  if (fs.existsSync(file)) {
    // Read it through settings so a corrupt file is reported as
    // MOUAIF_PROJECT_PARSE_ERROR rather than adopted as-is.
    const existing = settings.readProjectJson(file, {});
    return {
      path: file,
      created: false,
      adopted: true,
      name: (existing && typeof existing.name === 'string' && existing.name.trim()) ? existing.name.trim() : null
    };
  }

  settings.writeProjectJson(file, { name });
  return { path: file, created: true, adopted: false, name };
}

// ---- Registered-project surface ----------------------------------------

function id() {
  return crypto.randomBytes(8).toString('hex');
}

function readProjects() {
  const app = settings.getApp();
  const list = Array.isArray(app.projects) ? app.projects : [];
  // Defensive copy, validated.
  return list.filter(p => p && typeof p.path === 'string' && typeof p.id === 'string');
}

function writeProjects(list) {
  // Single shallow patch — settings.setApp does the merge.
  settings.setApp({ projects: list });
}

function emptyTotalCost() {
  return { total: 0, known: false, currency: 'USD', knownCount: 0 };
}
function normalizeTotalCost(value) {
  if (!value || typeof value.total !== 'number' || !Number.isFinite(value.total)) return emptyTotalCost();
  const knownCount = Number.isInteger(value.knownCount) && value.knownCount >= 0
    ? value.knownCount
    : (value.known === true ? 1 : 0);
  return {
    total: Math.max(0, value.total),
    known: knownCount > 0,
    currency: 'USD',
    knownCount
  };
}
function listProjects() {
  return readProjects().map((project) => ({
    ...project,
    totalCost: normalizeTotalCost(project.totalCost)
  }));
}
function setProjectTotalCost(projectDir, totalCost) {
  const list = readProjects();
  const idx = list.findIndex((project) => path.resolve(project.path) === path.resolve(projectDir));
  if (idx < 0) return null;
  const normalized = normalizeTotalCost(totalCost);
  list[idx] = { ...list[idx], totalCost: normalized };
  writeProjects(list);
  return normalized;
}
function adjustProjectTotalCost(projectDir, totalDelta, knownCountDelta) {
  const list = readProjects();
  const idx = list.findIndex((project) => path.resolve(project.path) === path.resolve(projectDir));
  if (idx < 0) return null;
  const current = normalizeTotalCost(list[idx].totalCost);
  const knownCount = Math.max(0, current.knownCount + knownCountDelta);
  const totalCost = {
    total: knownCount > 0 ? Math.max(0, current.total + totalDelta) : 0,
    known: knownCount > 0,
    currency: 'USD',
    knownCount
  };
  list[idx] = { ...list[idx], totalCost };
  writeProjects(list);
  return totalCost;
}

function getProject(pid) {
  return readProjects().find(p => p.id === pid) || null;
}

function registerProject(absPath) {
  const safe = ensureSafeRoot(absPath);
  // The folder must exist. Use stat, not existsSync, to get a real error
  // for ENOTDIR / EACCES.
  const stat = fs.statSync(safe);
  if (!stat.isDirectory()) {
    const e = new Error('Path is not a directory');
    e.code = 'ENOTDIR';
    e.path = safe;
    throw e;
  }
  const existing = readProjects();
  // Dedupe by canonical path.
  const dupe = existing.find(p => path.resolve(p.path) === safe);
  if (dupe) return dupe;
  const row = {
id: id(),
path: safe,
name: path.basename(safe),
createdAt: new Date().toISOString(),
totalCost: emptyTotalCost()
};
  writeProjects([...existing, row]);
  return row;
}

function removeProject(pid) {
  const before = readProjects();
  const after = before.filter(p => p.id !== pid);
  if (after.length === before.length) return false;
  writeProjects(after);
  return true;
}

// Rename a registered project's display label. The on-disk folder
// is not touched. Trims and validates the new name; returns null if
// the project doesn't exist or the name is empty.
function renameProject(pid, newName) {
  if (!pid || typeof pid !== 'string') return null;
  if (typeof newName !== 'string') return null;
  const trimmed = newName.trim();
  if (!trimmed) return null;
  const list = readProjects();
  const idx = list.findIndex(p => p.id === pid);
  if (idx < 0) return null;
  const updated = Object.assign({}, list[idx], { name: trimmed });
  list[idx] = updated;
  writeProjects(list);
  return updated;
}

module.exports = {
  // filesystem
  listDir,
  createDir,
  // project config file
  configPath,
  hasConfig,
  ensureProjectConfig,
  PROJECT_CONFIG_FILE,
  // registered projects
  listProjects,
  getProject,
  registerProject,
  removeProject,
  renameProject,
  setProjectTotalCost,
  adjustProjectTotalCost,
// helpers (exported for tests + future inspector)
isUnderHome,
ensureSafeRoot,
browseTop,
isBrowseTop,
ALLOW_ANY_ROOT
};
