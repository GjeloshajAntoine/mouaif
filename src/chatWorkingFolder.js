'use strict';

// Chat identity, settings and permissions stay anchored to the original
// project. Only local shell/file operations use this directory.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const chats = require('./chats.js');
const projects = require('./projects.js');
const settings = require('./settings.js');
const { err } = require('./util.js');
const exec = promisify(execFile);
const changing = new Set();

function safeDirectory(directory) {
  const safe = projects.ensureSafeRoot(path.resolve(directory));
  const real = projects.ensureSafeRoot(fs.realpathSync(safe));
  if (!fs.statSync(real).isDirectory()) throw err('ENOTDIR', 'Working folder must be a directory');
  return real;
}

function resolve(projectDir, chatId) {
  const chat = chatId ? chats.getChat(projectDir, chatId) : null;
  // Preserve the existing local-tool sandbox for unchanged chats (which
  // can also be used by temp-directory fixtures). Only switched folders
  // need the project picker's additional home-boundary validation.
  return chat && chat.workingDir ? safeDirectory(chat.workingDir) : require('./tools/files.js').resolveSandbox(projectDir);
}

async function git(projectDir, args, signal) {
  return exec('git', args, { cwd: projectDir, signal, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } });
}

// Does this project allow creating the default workspace folder? The
// resolved settings are defaults -> app -> project, so a project (or the app
// default) that never sets `autoWorkspace` resolves to the `false` floor in
// src/settings.js. Reading the store can fail on a corrupt project file, and
// that must not be a way to create a folder, so any error means "not
// allowed". Explicit directory arguments do not consult this at all.
function autoWorkspaceEnabled(projectDir) {
  try {
    return settings.getResolved(projectDir).autoWorkspace === true;
  } catch {
    return false;
  }
}

// Create or reuse the default workspace for a chat. Only reached when the
// project allows it (see autoWorkspaceEnabled).
async function createDefaultWorkspace(root, chatId, signal) {
  // Preflight the workspace parents without creating them. Creating
  // `.mouaif` / `.mouaif/workspaces` up front used to leave empty
  // directories behind whenever the Git step or the chat update failed, so
  // the folders now appear only once success is likely. Existing segments
  // are still validated here, which keeps rejecting a redirected parent
  // even when its symlink stays inside home.
  const missingParents = [];
  let parent = root;
  for (const segment of ['.mouaif', 'workspaces']) {
    parent = path.join(parent, segment);
    if (!fs.existsSync(parent)) {
      missingParents.push(parent);
      continue;
    }
    if (fs.lstatSync(parent).isSymbolicLink()) throw err('EOUTSIDE_PROJECT', 'Workspace parent must not be a symlink');
    safeDirectory(parent);
  }
  const target = path.join(parent, chatId);
  const targetExisted = fs.existsSync(target);
  // Undo only what this call created: the target when it did not exist
  // before, then the parents, innermost first, and only while they are
  // empty. A pre-existing folder and a workspace holding work survive.
  const prune = () => {
    if (!targetExisted) {
      try { fs.rmdirSync(target); } catch { /* kept: not empty or already gone */ }
    }
    for (const dir of missingParents.slice().reverse()) {
      try { fs.rmdirSync(dir); } catch { /* kept: not empty or already gone */ }
    }
  };
  const createParents = () => {
    for (const dir of missingParents) {
      try { fs.mkdirSync(dir); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  };
  let branch = null;
  let created = false;
  let repository = false;
  try {
    repository = (await git(root, ['rev-parse', '--is-inside-work-tree'], signal)).stdout.trim() === 'true';
  } catch (e) {
    if (!String(e.stderr || '').includes('not a git repository')) { prune(); throw e; }
  }
  if (repository) {
    branch = 'mouaif/chat-' + chatId;
    if (targetExisted) {
      // Retry only reuses this exact worktree, not an arbitrary folder
      // or a symlink to another checkout. Never reset or force a branch.
      const real = safeDirectory(target);
      const top = (await git(real, ['rev-parse', '--show-toplevel'], signal)).stdout.trim();
      const currentBranch = (await git(real, ['symbolic-ref', '--short', 'HEAD'], signal)).stdout.trim();
      const common = async (dir) => (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).stdout.trim();
      if (real !== target || top !== real || currentBranch !== branch || await common(root) !== await common(real)) {
        throw err('EEXIST', 'Default workspace exists but is not this chat’s Git worktree');
      }
    } else {
      try {
        createParents();
        await git(root, ['worktree', 'add', '-b', branch, target, 'HEAD'], signal);
      } catch (e) {
        prune();
        throw e;
      }
      created = true;
    }
  } else if (targetExisted) {
    if (fs.lstatSync(target).isSymbolicLink()) throw err('EEXIST', 'Default workspace must not be a symlink');
  } else {
    try {
      createParents();
      fs.mkdirSync(target);
    } catch (e) {
      prune();
      throw e;
    }
    created = true;
  }
  return { workingDir: safeDirectory(target), branch, created };
}

async function change(projectDir, chatId, directory, signal) {
  const key = projectDir + '\0' + chatId;
  if (changing.has(key)) throw err('EBUSY', 'This chat is already changing its working folder');
  const chat = chats.getChat(projectDir, chatId);
  if (!chat) throw err('ENOTFOUND', 'Chat not found: ' + chatId);
  changing.add(key);
  try {
    if (signal && signal.aborted) throw err('EABORTED', 'Working folder change cancelled');
    const root = safeDirectory(projectDir);
    let workspace;
    // `directory` omitted, or explicitly false/null, asks for the default
    // workspace. A string always selects an existing directory and never
    // creates one. `false`/`null` exists because a compact profile may strip
    // the parameter enumeration, so the explicit opt-in must not depend on
    // the argument being absent.
    const wantsDefault = directory === undefined || directory === false || directory === null;
    if (!wantsDefault) {
      if (typeof directory !== 'string') {
        throw err('EBADINPUT', 'directory must be a string, or false/null for the default workspace');
      }
      // Relative paths always refer to the original project, never the
      // previous working folder. Empty string resets to the project root.
      workspace = { workingDir: safeDirectory(path.resolve(root, directory || '.')), branch: null, created: false };
    } else {
      // Creating a folder is opt-in: the project (or the app default) must
      // set `autoWorkspace`. Off means the tool reports why instead of
      // quietly putting a worktree in the user's checkout.
      if (!autoWorkspaceEnabled(projectDir)) {
      throw err('EOFF', 'Creating a workspace is disabled for this project. Ask the user to turn on "Allow automatic workspaces" in Settings → Project → General (or the app default in Settings → App defaults), or pass an existing directory.');
      }
      workspace = await createDefaultWorkspace(root, chatId, signal);
    }
    const { workingDir, branch, created } = workspace;
    // Do not resurrect a chat deleted while Git was running. Preserve all
    // unrelated metadata by merging into the latest stored record.
    const updated = chats.updateChat(projectDir, chatId, { workingDir: workingDir === root ? null : workingDir });
    if (!updated) throw err('ENOTFOUND', 'Chat was deleted while creating the workspace; the folder has been kept');
    return { chat: updated, workingDir, branch, created };
  } catch (e) {
    if (e.stderr) throw err('EGIT', String(e.stderr).trim());
    throw e;
  } finally {
    changing.delete(key);
  }
}

module.exports = { resolve, change };
