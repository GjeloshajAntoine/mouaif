'use strict';

// Chat identity, settings and permissions stay anchored to the original
// project. Only local shell/file operations use this directory.
//
// This tool selects an EXISTING directory, or resets to the project root.
// It creates nothing: `.mouaif/workspaces/<chatId>` and the "Allow automatic
// workspaces" opt-in that gated it were removed, because preparing a folder
// (including a checkout) belongs to the assistant's shell workflow, where the
// command is visible and separately authorized. See docs/decisions.md §34.
const fs = require('node:fs');
const path = require('node:path');
const chats = require('./chats.js');
const projects = require('./projects.js');
const { err } = require('./util.js');


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

// The `directory` argument is always a directory: a string naming an existing
// folder, or "" / "." to reset to the project root (a run resets to the folder
// it started in). Nothing else is accepted — the boolean/null forms that used
// to select the default workspace are gone with the workspace itself. The
// chat, preview and run paths share one helper so a caller cannot learn two
// different stories about the same argument.
function directoryTypeError() {
  return err('EBADINPUT', 'directory must be a string naming an existing directory, or "" to reset to the project root');
}

function checkApprovedDirectory(directory, approvedDirectory) {
  if (approvedDirectory !== undefined && directory !== approvedDirectory) {
    throw err('ESTALE_PATH', 'Working folder destination changed since authorization; request approval again');
  }
}

// Switch a run's folder to an existing directory. A run never creates one:
// `created` is always false, because preparing a checkout is a separately
// authorized shell call and a run already has a folder to work in.
//
// `directory` resolves against the run's START folder — captured when the run
// was registered — not against its current folder and not against the project
// root. A fixed anchor is what keeps one argument meaning one folder: with the
// current folder as the anchor, "pkg" would mean `pkg` on the first call and
// `pkg/pkg` on the next. It also keeps a relative path inside the tree the run
// was given. An absolute directory is accepted on the same home-boundary terms
// the chat tool uses.
//
// An empty string (or ".") returns the run to its start folder — the run's
// equivalent of a chat's reset to the project root.
function changeRun(root, chatId, directory, signal, approvedDirectory) {
  const store = runStoreFor(chatId);
  if (!store) throw err('ENOTFOUND', 'This subagent run is no longer active');
  if (signal && signal.aborted) throw err('EABORTED', 'Working folder change cancelled');
  if (typeof directory !== 'string') throw directoryTypeError();
  const wantsStart = directory === '';
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
  // The preview must name the same chat the call will act on. An explicit
  // `chatId` argument wins over the calling chat, exactly as it does in
  // src/tools/mouaif.js; a delegated run's own folder id wins over both,
  // because a run resolves relative paths against its own start folder.
  const explicit = typeof args.chatId === 'string' ? args.chatId.trim() : '';
  const chatId = workspaceChatId || explicit || currentChatId;
  // A delegated run approves the same tool, but it has no chat record of its
  // own: its folder is live process state. The card must say so instead of
  // naming the parent chat as the target, which would claim the parent
  // conversation is about to be redirected.
  if (isRunChatId(chatId)) {
    const store = runStoreFor(chatId);
    if (!store) throw err('ENOTFOUND', 'This subagent run is no longer active');
    const directory = args.directory;
    if (typeof directory !== 'string') throw directoryTypeError();
    const wantsStart = directory === '';
    const destination = wantsStart ? runDirectory(store, true) : safeDirectory(path.resolve(store.root, directory));
    const action = wantsStart ? 'Return the subagent to the folder it started in' : 'Use a different folder';
    // The run id is separate from the real chat id used for approvals.
    const parentId = store && store.parentChatId ? store.parentChatId : currentChatId;
    const parent = parentId ? chats.getChat(projectDir, parentId) : null;
    const parentLabel = parent && parent.title ? parent.title + ' (' + parentId + ')' : String(parentId || 'unknown chat');
    // Nothing here creates a folder, for a run or for a chat, so the card
    // says so once and nothing implies otherwise.
    const effect = 'Files read or edited and commands run by this subagent run will use this folder. '
      + 'The parent chat keeps its own folder; this selects an existing folder and does not create, move or copy files.';
    return { destination, summary: [action, 'Subagent run: ' + chatId, 'Delegated from: ' + parentLabel,
    'Folder: ' + destination, '', effect].join('\n') };
  }
  const chat = chats.getChat(projectDir, chatId);
  const root = safeDirectory(projectDir);
  const directory = args.directory;
  if (typeof directory !== 'string') throw directoryTypeError();
  const destination = safeDirectory(path.resolve(root, directory || '.'));
  const action = destination === root ? 'Return to the project folder' : 'Use a different folder';
  const title = chat && chat.title ? String(chat.title).replace(/\s+/g, ' ').trim() : '';
  const effect = 'Files read or edited and commands run for this chat will use this folder. This change does not move or copy files.';
  return { destination, summary: [action, 'Chat: ' + (title ? title + ' (' + chatId + ')' : chatId),
    'Folder: ' + destination, '', effect].join('\n') };
}

// Stored as the authorization summary so live and recovered cards agree.
function describeChange(projectDir, currentChatId, args = {}, workspaceChatId) {
  return prepareChange(projectDir, currentChatId, args, workspaceChatId).summary;
}

// Change a chat's working folder to an existing directory. Synchronous from
// the caller's point of view: it validates, then writes one field. The
// per-chat `EBUSY` guard that used to serialize overlapping calls existed for
// folder creation and Git, both of which are gone — with no await between the
// check and the write, two calls cannot interleave.
function change(projectDir, chatId, directory, signal, approvedDirectory) {
  const chat = chats.getChat(projectDir, chatId);
  if (!chat) throw err('ENOTFOUND', 'Chat not found: ' + chatId);
  if (signal && signal.aborted) throw err('EABORTED', 'Working folder change cancelled');
  const root = safeDirectory(projectDir);
  if (typeof directory !== 'string') throw directoryTypeError();
  // Relative paths always refer to the original project, never the
  // previous working folder. Empty string resets to the project root.
  const destination = safeDirectory(path.resolve(root, directory || '.'));
  checkApprovedDirectory(destination, approvedDirectory);
  // Do not resurrect a chat deleted during the change. Preserve all
  // unrelated metadata by merging into the latest stored record.
  const updated = chats.updateChat(projectDir, chatId, { workingDir: destination === root ? null : destination });
  if (!updated) throw err('ENOTFOUND', 'Chat was deleted while changing its working folder');
  // `branch` and `created` keep their shape for callers that read them:
  // this tool never inspected Git, and it never creates a folder.
  return { chat: updated, workingDir: destination, branch: null, created: false };
}

module.exports = { resolve, resolveForCall, change, changeRun, prepareChange, describeChange, registerRun, clearRun, isRunChatId };
