'use strict';

// Display-only approval context. Never executes the proposed operation or
// changes permissions. Bound and redact before publishing to SSE/pending UI.
const SECRET = /api.?key|authorization|password|secret|token|cookie|credential/i;
function safeValue(value, depth = 0, budget = { nodes: 0, chars: 60000 }) {
  if (depth > 6 || ++budget.nodes > 2000 || budget.chars <= 0) return '[detail capped]';
  if (typeof value === 'string') {
    const cap = Math.min(12000, budget.chars); budget.chars -= Math.min(cap, value.length);
    return value.length > cap ? value.slice(0, cap) + '\n[preview capped]' : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(item => safeValue(item, depth + 1, budget))
    .concat(value.length > 50 ? ['[additional items capped]'] : []);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return Object.fromEntries(entries.slice(0, 60)
      .map(([key, item]) => [key, SECRET.test(key) ? '[redacted]' : safeValue(item, depth + 1, budget)])
      .concat(entries.length > 60 ? [['[preview]', 'additional fields capped']] : []));
  }
  return value;
}
function buildApprovalDetails(input) {
  const args = input.args || {};
  const details = { args: safeValue(args), tool: input.tool };
  try {
    const chatId = args.chatId || input.chatId;
    const chat = require('./chats.js').getChat(input.projectDir, chatId);
    if (chat) details.targetChat = { id: chatId, title: chat.title || 'Untitled chat' };
    if (chat && input.tool === 'update_chat') details.before = safeValue(Object.fromEntries(
      Object.keys(args).filter(key => key !== 'chatId').map(key => [key, chat[key] ?? null])));
  } catch { /* IDs and proposed args still show when the target is unavailable */ }
  if (['shell', 'group_cli', 'subagent', 'read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'group_read', 'group_edit'].includes(input.tool)) {
    try { details.workingDirectory = require('./chatWorkingFolder.js').resolveForCall(input.projectDir, input.chatId, input.workspaceChatId); }
    catch { details.workingDirectory = input.projectDir; }
  }
  if (input.tool === 'write_file' || input.tool === 'edit_file') {
    const fs = require('node:fs');
    const path = require('node:path');
    try {
      const root = fs.realpathSync(details.workingDirectory);
      const target = fs.realpathSync(path.resolve(root, args.path || args.file));
      const relative = path.relative(root, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside working folder');
      const stat = fs.statSync(target);
      details.fileExists = true;
      if (stat.isFile()) {
        const fd = fs.openSync(target, 'r');
        try {
          const bytes = Buffer.alloc(Math.min(stat.size, 12000));
          const read = fs.readSync(fd, bytes, 0, bytes.length, 0);
          const raw = bytes.subarray(0, read).toString('utf8');
          details.fileBefore = require('./hideFileContent.js').redactText(input.projectDir,
          path.relative(root, path.resolve(root, args.path || args.file)).split(path.sep).join('/'), raw).text
          + (stat.size > bytes.length ? '\n[preview capped]' : '');
        } finally { fs.closeSync(fd); }
      }
    } catch (error) {
      if (error.code === 'ENOENT') details.fileExists = false;
      else details.filePreviewUnavailable = true;
    }
  }
  if (input.tool === 'update_settings') {
    try {
      const settings = require('./settings.js');
      const current = args.scope === 'app' ? settings.getApp() : settings.getProject(input.projectDir);
      const keys = [...new Set([...Object.keys(args.patch || {}), ...(args.unset || [])])];
      details.before = safeValue(Object.fromEntries(keys.map(key => [key, current[key] ?? null])));
    } catch { details.beforeUnavailable = true; }
  }
  // The persistent grant currently resolves native leaves to their family.
  // Expose the actual scope instead of suggesting it only covers this call.
  const auth = require('./tools/authorization.js');
  const family = auth.configToolName(input.tool);
  const members = [...auth.familyTools(family)];
  details.permissionScope = members.length ? members : [input.tool];
  return details;
}
module.exports = { safeValue, buildApprovalDetails };
