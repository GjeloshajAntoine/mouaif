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

// Resolve the folder for a tool call. A delegated run resolves its own
// registered folder (see registerRun); a chat resolves its stored folder.
// This is the single entry point tool dispatch uses, so a subagent can never
// fall back to the parent chat's directory or to the project root by accident
// — an unknown run id fails like a missing folder does.
function resolveForCall(projectDir, chatId, workspaceChatId) {
  if (workspaceChatId) {
    const store = runStoreFor(workspaceChatId);
    if (!store) throw err('ENOTFOUND', 'This subagent run is no longer active');
    return runDirectory(store);
  }
  return resolve(projectDir, chatId);
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

// ---- Per-subagent-run working folders ---------------------------------
// A delegated run carries the PARENT chat's id (approvals, images, tasks and
// the transcript all key off it), so without this it would resolve the
// parent's folder and could retarget the parent conversation with a folder
// change. A run instead registers its own folder under a synthetic id of the
// form `subagent:<runId>`, gives the nested stream that id separately as
// `opts.workspaceChatId`, and the resolver below returns the run's folder.
// `opts.chatId` stays the real parent chat for all chat-scoped subsystems.
//
// The store is deliberately module-global rather than keyed by that
// transcript-free id: it is process state for a live run only, cleared in the
// nested run's cleanup. Nothing here touches the chat database, so the
// synthetic id can never become a chat record or leak into chat storage.
//
// Each run captures the parent's current folder when it starts, then reads
// its own current folder live on every local tool dispatch. Checkouts stay
// plain directories: this module never runs Git and never prepares, copies,
// merges or deletes a worktree. Siblings share a starting directory unless
// they explicitly select different existing folders.
const runStores = new Map();
let runSeq = 0;

// Register a folder for one delegated run. Run ids are unique process-wide,
// so the store is keyed by id alone: the caller that resolves a folder (tool
// dispatch, holding the original project dir) and the caller that registered
// it (the nested launch, holding the parent's folder) need not agree on a
// root. `root` is the folder the run starts in — the parent chat's resolved
// folder — and it is also the fixed anchor a `directory` argument resolves
// against, so the same argument always means the same folder.
function registerRun(root, workspace, parentChatId) {
  // Only an inherited project outside home retains the legacy sandbox.
  // A selected folder under home must keep the same guard as its chat,
  // including after a directory is replaced by a symlink during the run.
  let rootUsesSandbox = false;
  try { projects.ensureSafeRoot(workspace.root); }
  catch (e) {
    if (e.code !== 'EOUTSIDE_HOME') throw e;
    rootUsesSandbox = true;
  }
  const runId = 'run-' + (++runSeq);
  runStores.set(runId, {
    root: workspace.root,
    current: workspace.current,
    rootUsesSandbox,
    currentUsesSandbox: rootUsesSandbox,
    // The chat the run was delegated from. Not used for resolution — every
    // `chatId`-scoped subsystem already keeps using the parent id — but the
    // approval card has nothing else to name, since dispatch only knows the
    // run id. Without it the card would say the run was delegated from itself.
    parentChatId: typeof parentChatId === 'string' && parentChatId.trim() ? parentChatId.trim() : null
  });
  return { runId, chatId: 'subagent:' + runId };
}

// Forget a finished run. Called from the nested run's cleanup, so a long
// session does not accumulate one entry per delegation.
function clearRun(runId) {
  runStores.delete(String(runId));
}

function isRunChatId(chatId) {
  return typeof chatId === 'string' && chatId.startsWith('subagent:run-');
}

function runStoreFor(chatId) {
  if (!isRunChatId(chatId)) return null;
  return runStores.get(String(chatId).slice('subagent:'.length)) || null;
}

function runDirectory(store, start = false) {
  const directory = start ? store.root : store.current;
  const usesSandbox = start ? store.rootUsesSandbox : store.currentUsesSandbox;
  return usesSandbox ? require('./tools/files.js').resolveSandbox(directory) : safeDirectory(directory);
}

function checkApprovedDirectory(directory, approvedDirectory) {
  if (approvedDirectory !== undefined && directory !== approvedDirectory) {
    throw err('ESTALE_PATH', 'Working folder destination changed since authorization; request approval again');
  }
}

// Switch a run's folder. A run never creates a folder: `created` is always
// false, because preparing a checkout is a separately authorized shell call
// and a run already has a folder to work in.
//
// `directory` resolves against the run's START folder — captured when the run
// was registered — not against its current folder and not against the project
// root. A fixed anchor is what keeps one argument meaning one folder: with the
// current folder as the anchor, "pkg" would mean `pkg` on the first call and
// `pkg/pkg` on the next. It also keeps a relative path inside the tree the run
// was given. An absolute directory is accepted on the same home-boundary terms
// the chat tool uses.
//
// Omitting `directory` (or passing false/null/"") returns the run to its start
// folder. There is deliberately no default-workspace branch here: a run has no
// `.mouaif/workspaces/<chatId>` counterfactual, and this tool is not the way a
// subagent acquires a checkout.
function changeRun(root, chatId, directory, signal, approvedDirectory) {
  const store = runStoreFor(chatId);
  if (!store) throw err('ENOTFOUND', 'This subagent run is no longer active');
  if (signal && signal.aborted) throw err('EABORTED', 'Working folder change cancelled');
  const wantsStart = directory === undefined || directory === false || directory === null || directory === '';
  if (!wantsStart && typeof directory !== 'string') {
    throw err('EBADINPUT', 'directory must be a string in a subagent run');
  }
  const destination = wantsStart ? runDirectory(store, true) : safeDirectory(path.resolve(store.root, directory));
  checkApprovedDirectory(destination, approvedDirectory);
  store.current = destination;
  store.currentUsesSandbox = wantsStart ? store.rootUsesSandbox : false;
  return { workingDir: store.current, created: false };
}

// Resolve the destination and summary together, without creating folders or
// changing state. The dispatcher keeps the canonical destination as server
// context while authorization waits; runners recheck it before any mutation.
function prepareChange(projectDir, currentChatId, args = {}, workspaceChatId) {
  const chatId = workspaceChatId || currentChatId;
  // A delegated run approves the same tool, but it has no chat record of its
  // own: its folder is live process state. The card must say so instead of
  // naming the parent chat as the target, which would claim the parent
  // conversation is about to be redirected.
  if (isRunChatId(chatId)) {
    const store = runStoreFor(chatId);
    if (!store) throw err('ENOTFOUND', 'This subagent run is no longer active');
    const directory = args.directory;
    const wantsDefault = directory === undefined || directory === false || directory === null || directory === '';
    if (!wantsDefault && typeof directory !== 'string') throw err('EBADINPUT', 'directory must be a string in a subagent run');
    const destination = wantsDefault ? runDirectory(store, true) : safeDirectory(path.resolve(store.root, directory));
    const action = wantsDefault ? 'Return the subagent to the folder it started in' : 'Use a different folder';
    // The run id is separate from the real chat id used for approvals.
    const parentId = store && store.parentChatId ? store.parentChatId : currentChatId;
    const parent = parentId ? chats.getChat(projectDir, parentId) : null;
    const parentLabel = parent && parent.title ? parent.title + ' (' + parentId + ')' : String(parentId || 'unknown chat');
    // No "starts empty; project files are not copied" wording: a run only ever
    // selects an existing folder, so the card must not imply one is created.
    const effect = 'Files read or edited and commands run by this subagent run will use this folder. '
      + 'The parent chat keeps its own folder; this selects an existing folder and does not create, move or copy files.';
    return { destination, summary: [action, 'Subagent run: ' + chatId, 'Delegated from: ' + parentLabel,
    'Folder: ' + destination, '', effect].join('\n') };
  }
  const chat = chats.getChat(projectDir, chatId);
  const root = safeDirectory(projectDir);
  const directory = args.directory;
  const wantsDefault = directory === undefined || directory === false || directory === null;
  if (!wantsDefault && typeof directory !== 'string') throw err('EBADINPUT', 'directory must be a string, or false/null for the default workspace');
  const destination = wantsDefault ? path.join(root, '.mouaif', 'workspaces', chatId)
    : safeDirectory(path.resolve(root, directory || '.'));
  const action = wantsDefault ? 'Use a separate folder'
    : destination === root ? 'Return to the project folder' : 'Use a different folder';
  const title = chat && chat.title ? String(chat.title).replace(/\s+/g, ' ').trim() : '';
  const effect = wantsDefault
    ? 'Files read or edited and commands run for this chat will use this folder. If created, it starts empty; project files are not copied.'
    : 'Files read or edited and commands run for this chat will use this folder. This change does not move or copy files.';
  return { destination, summary: [action, 'Chat: ' + (title ? title + ' (' + chatId + ')' : chatId),
    'Folder: ' + destination, '', effect].join('\n') };
}

// Stored as the authorization summary so live and recovered cards agree.
function describeChange(projectDir, currentChatId, args = {}, workspaceChatId) {
  return prepareChange(projectDir, currentChatId, args, workspaceChatId).summary;
}

async function change(projectDir, chatId, directory, signal, approvedDirectory) {
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
      const destination = safeDirectory(path.resolve(root, directory || '.'));
      checkApprovedDirectory(destination, approvedDirectory);
      workspace = { workingDir: destination, branch: null, created: false };
    } else {
      // Creating a folder is opt-in: the project (or the app default) must
      // set `autoWorkspace`. Off means the tool reports why instead of
      // quietly putting a folder in the user's checkout.
      if (!autoWorkspaceEnabled(projectDir)) {
        throw err('EOFF', 'Creating a workspace is disabled for this project. Ask the user to turn on "Allow automatic workspaces" in Settings → Project → General (or the app default in Settings → App defaults), or pass an existing directory.');
      }
      checkApprovedDirectory(path.join(root, '.mouaif', 'workspaces', chatId), approvedDirectory);
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

module.exports = { resolve, resolveForCall, change, changeRun, prepareChange, describeChange, registerRun, clearRun, isRunChatId };
