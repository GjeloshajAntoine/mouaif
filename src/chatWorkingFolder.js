'use strict';

// Chat identity, settings and permissions stay anchored to the original
// project. Only local shell/file operations use this directory.
const fs = require('node:fs');
const path = require('node:path');
const chats = require('./chats.js');
const projects = require('./projects.js');
const settings = require('./settings.js');
const { err } = require('./util.js');
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
async function createDefaultWorkspace(root, chatId) {
  // This tool only creates a directory. Repository setup belongs to the
  // assistant's coding workflow through separately authorized shell calls.
  // Validate existing parents before creating anything; redirected state
  // and workspace parents are rejected even when they stay inside home.
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
  let created = false;
  if (targetExisted) {
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
  // Keep the result shape compatible; this tool never inspects branches.
  return { workingDir: safeDirectory(target), branch: null, created };
}

// Approval text is computed without creating folders or changing the chat.
// Stored as the authorization summary so live and recovered cards agree.
function describeChange(projectDir, currentChatId, args = {}) {
  const chatId = typeof args.chatId === 'string' && args.chatId.trim()
    ? args.chatId.trim().slice(0, 128) : currentChatId;
  const chat = chats.getChat(projectDir, chatId);
  const root = safeDirectory(projectDir);
  const directory = args.directory;
  const wantsDefault = directory === undefined || directory === false || directory === null;
  const destination = wantsDefault ? path.join(root, '.mouaif', 'workspaces', chatId)
    : typeof directory === 'string' ? path.resolve(root, directory || '.') : '(invalid directory)';
  const action = wantsDefault ? 'Create or reuse workspace folder (no Git)'
    : destination === root ? 'Reset to original project folder' : 'Switch to existing folder';
  const title = chat && chat.title ? String(chat.title).replace(/\s+/g, ' ').trim() : '';
  return [action, 'Target chat: ' + chatId + (title ? ' — ' + title : ''), 'Destination: ' + destination].join('\n');
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
      // quietly putting a folder in the user's checkout.
      if (!autoWorkspaceEnabled(projectDir)) {
        throw err('EOFF', 'Creating a workspace is disabled for this project. Ask the user to turn on "Allow automatic workspaces" in Settings → Project → General (or the app default in Settings → App defaults), or pass an existing directory.');
      }
      workspace = await createDefaultWorkspace(root, chatId);
    }
    const { workingDir, branch, created } = workspace;
    // Do not resurrect a chat deleted during the change. Preserve all
    // unrelated metadata by merging into the latest stored record.
    const updated = chats.updateChat(projectDir, chatId, { workingDir: workingDir === root ? null : workingDir });
    if (!updated) throw err('ENOTFOUND', 'Chat was deleted while creating the workspace; the folder has been kept');
    return { chat: updated, workingDir, branch, created };
  } finally {
    changing.delete(key);
  }
}

module.exports = { resolve, change, describeChange };
