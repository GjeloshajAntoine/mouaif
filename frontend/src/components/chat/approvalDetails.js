// Display helpers only: authorization continues to be owned by the server.
const TITLES = {
  shell: 'Run command', group_cli: 'Run commands', subagent: 'Delegate task',
  read_file: 'Read file', list_files: 'List files', search_files: 'Search files', write_file: 'Write file', edit_file: 'Edit file',
  group_read: 'Read files', group_edit: 'Edit files', list_chats: 'List chats', get_chat: 'Read chat', create_chat: 'Create chat',
  update_chat: 'Update chat', change_working_folder: 'Change working folder', search_models: 'Search models', start_chat: 'Start chat',
  delete_chat: 'Delete chat', search_chats: 'Search chats', attach_chat_image: 'Attach image', list_chat_attachments: 'List chat images',
  get_settings: 'Read settings', update_settings: 'Change settings', list_projects: 'List projects', get_app_info: 'Read app info',
  restart_app: 'Restart app', create_mcp_app: 'Create MCP App', task: 'Update tasks', webpreview: 'Open preview',
  subagent_messages: 'Read worker messages', subagent_status: 'Check worker', subagent_stop: 'Stop worker', subagent_send: 'Message worker',
  subagent_group_create: 'Create worker group', subagent_group_update: 'Update worker group', subagent_publish: 'Publish handoff',
  subagent_read: 'Read handoff', subagent_group_status: 'Check worker group', subagent_decision: 'Propose group decision', subagent_conflict: 'Report group conflict'
};
const SECRET = /api.?key|authorization|password|secret|token|cookie|credential/i;
function redacted(value, depth = 0, budget = { nodes: 0, chars: 60000 }) {
  if (depth > 6 || ++budget.nodes > 2000 || budget.chars <= 0) return '[detail capped]';
  if (typeof value === 'string') {
    const cap = Math.min(12000, budget.chars); budget.chars -= Math.min(value.length, cap);
    return value.length > cap ? value.slice(0, cap) + '\n[preview capped]' : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redacted(item, depth + 1, budget))
    .concat(value.length > 50 ? ['[additional items capped]'] : []);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return Object.fromEntries(entries.slice(0, 60).map(([key, item]) =>
      [key, SECRET.test(key) ? '[redacted]' : redacted(item, depth + 1, budget)])
      .concat(entries.length > 60 ? [['[preview]', 'additional fields capped']] : []));
  }
  return value;
}
function compactValue(v) {
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
const CHAT_TARGET_TOOLS = new Set(['get_chat', 'update_chat', 'change_working_folder', 'start_chat', 'delete_chat', 'attach_chat_image', 'list_chat_attachments']);
export function approvalTitle(request) {
  const args = request.details?.args || request.args || {};
  if (request.tool === 'create_mcp_app' && args.request !== undefined) return 'Prepare app draft';
  if (request.tool === 'task') return ({ list: 'List tasks', create: 'Create task', update_progress: 'Update task', complete: 'Complete task' })[args.action] || 'Manage task';
  const count = args.edits?.length || (request.tool === 'group_read' && args.files?.length) || args.commands?.length;
  const title = TITLES[request.tool] || request.tool.replace(/^mcp__/, '').replace(/__/g, ' · ').replace(/_/g, ' ');
  return count ? title + ' (' + count + ')' : title;
}
export function approvalText(request) {
  const details = request.details || {};
  const args = redacted(details.args || request.args) || {};
  const tool = request.tool || '';
  const lines = [];
  if (tool === 'shell') {
    lines.push(args.cmd || request.cmd || request.summary || '');
  } else if (tool === 'group_cli' && Array.isArray(args.commands)) {
    lines.push(args.commands.map((entry, i) => !entry || typeof entry !== 'object' ? String(entry)
      : (i + 1) + '. ' + (entry.cmd || entry.command || '(missing command)') + (entry.async || args.async ? ' [background]' : '')).join('\n'));
  } else if (tool === 'edit_file') {
    if (args.path || args.file) lines.push(String(args.path || args.file));
    lines.push('- ' + String(args.oldText || '') + '\n+ ' + String(args.newText || ''));
  } else if (tool === 'write_file') {
    const tag = details.fileExists === true ? ' (overwrite)' : details.fileExists === false ? ' (new file)' : '';
    lines.push(String(args.path || args.file || '') + tag);
    if (args.content) lines.push(String(args.content));
  } else if (tool === 'read_file') {
    const range = args.startLine != null || args.endLine != null ? ' :' + (args.startLine || 1) + '-' + (args.endLine || 'end') : '';
    lines.push(String(args.path || args.file || '') + range);
  } else if (tool === 'search_files') {
    lines.push([args.path, args.query].filter(Boolean).join(': ') + (args.include ? ' (' + args.include + ')' : ''));
  } else if (tool === 'list_files') {
    lines.push(args.pattern || 'all files');
  } else  if (tool === 'group_read' || tool === 'group_edit') {
    const list = args[tool === 'group_read' ? 'files' : 'edits'] || [];
    lines.push(list.map(x => {
      if (!x) return '?';
      const p = x.path || x.file || '?';
      return tool === 'group_edit' && (x.oldText != null || x.newText != null)
        ? p + '\n- ' + String(x.oldText || '') + '\n+ ' + String(x.newText || '')
        : p;
    }).join('\n'));
  } else if (tool === 'delete_chat') {
    const t = details.targetChat;
    lines.push('Delete "' + (t ? t.title + '" (' + t.id + ')' : (args.chatId || 'chat') + '"') + ' permanently');
  } else if (tool === 'change_working_folder') {
    lines.push('Chat: ' + (args.chatId || details.targetChat?.id || 'current') + ' → ' + (details.workingDirectory || request.projectDir || '.') + ' (' + (args.directory || '.') + ')');
  } else if (tool === 'subagent') {
    lines.push((args.agent ? '@' + args.agent + ': ' : '') + (args.task || request.summary || ''));
  } else if (tool === 'webpreview') {
    lines.push([args.url || request.summary, args.viewport, args.mode].filter(Boolean).join(' · '));
  } else {
    if (details.targetChat && CHAT_TARGET_TOOLS.has(tool)) {
      lines.push('Chat: ' + details.targetChat.title + ' (' + details.targetChat.id + ')');
    }
    const entries = Object.entries(args).filter(([k, v]) => v !== undefined && !(k === 'chatId' && details.targetChat?.id === v));
    if (entries.length) lines.push(entries.map(([k, v]) => k + ': ' + compactValue(v)).join(' · '));
    else if (request.summary || request.cmd) lines.push(request.summary || request.cmd);
    if (details.before) lines.push('before: ' + compactValue(redacted(details.before)));
  }
  if (details.workingDirectory && request.projectDir && details.workingDirectory !== request.projectDir && tool !== 'change_working_folder') {
    lines.push('cwd: ' + details.workingDirectory);
  }
  const out = lines.filter(Boolean).join('\n');
  return out || 'No arguments.';
}
export function permissionExplanation(request, familyMembers = []) {
  const members = request.details?.permissionScope || (familyMembers.length ? familyMembers : [request.tool]);
  return 'Session: ' + request.tool + ' · Always: ' + members.join(', ');
}
