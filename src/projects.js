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
//     listDir(absPath)        -> { dir, entries: [{ name, path, hasChildren }] }
//     createDir(absPath)      -> { path }
//
//   Registered-project surface (the user's chosen projects):
//     listProjects()          -> [{ id, path, name, createdAt }]
//     getProject(id)          -> { id, path, name, createdAt } | null
//     registerProject(path)   -> { id, path, name, createdAt }
//     removeProject(id)       -> true | false
//
// Registered projects are stored in the app settings under the `projects`
// key. They survive restarts. Removing a registered project does NOT
// delete the folder on disk.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const settings = require('./settings.js');

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
      hasChildren: hasImmediateSubdirs(full)
    });
  }
  // Stable order: case-insensitive name.
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { dir: safe, entries };
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

function listProjects() {
  const list = readProjects();
  // Enrich each project with its persisted totalCost from the project file.
  for (const p of list) {
    try {
      const raw = settings.getProject(p.path);
      if (raw && raw.totalCost && typeof raw.totalCost.total === 'number') {
        p.totalCost = raw.totalCost;
      } else {
        p.totalCost = { total: 0, known: false, currency: 'USD' };
      }
    } catch {
      p.totalCost = { total: 0, known: false, currency: 'USD' };
    }
  }
  return list;
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
    createdAt: new Date().toISOString()
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
  // registered projects
  listProjects,
  getProject,
  registerProject,
  removeProject,
  renameProject,
  // helpers (exported for tests + future inspector)
  isUnderHome,
  ensureSafeRoot,
  ALLOW_ANY_ROOT
};
