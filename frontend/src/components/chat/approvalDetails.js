// Display helpers only: authorization continues to be owned by the server.
const TITLES = {
  shell: 'Run command', group_cli: 'Run commands', subagent: 'Delegate a task',
  read_file: 'Read file', list_files: 'List files', search_files: 'Search files', write_file: 'Write file', edit_file: 'Edit file',
  group_read: 'Read files', group_edit: 'Edit files', list_chats: 'List chats', get_chat: 'Read chat', create_chat: 'Create chat',
  update_chat: 'Update chat', change_working_folder: 'Change working folder', search_models: 'Search models', start_chat: 'Send message and start chat',
  delete_chat: 'Delete chat', search_chats: 'Search chats', attach_chat_image: 'Attach image', list_chat_attachments: 'List chat images',
  get_settings: 'Read settings', update_settings: 'Change settings', list_projects: 'List projects', get_app_info: 'Read app information',
  restart_app: 'Restart app', create_mcp_app: 'Create MCP App', task: 'Update tasks', webpreview: 'Open web preview',
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
export function approvalTitle(request) {
  const args = request.details?.args || request.args || {};
  if (request.tool === 'create_mcp_app' && args.request !== undefined) return 'Prepare app development draft';
  if (request.tool === 'task') return ({ list: 'List tasks', create: 'Create task', update_progress: 'Update task progress', complete: 'Complete task' })[args.action] || 'Manage task';
  const count = args.edits?.length || args.files?.length || args.commands?.length;
  const title = TITLES[request.tool] || request.tool.replace(/^mcp__/, '').replace(/__/g, ' · ').replace(/_/g, ' ');
  return count ? title + ' (' + count + ')' : title;
}
export function approvalText(request) {
  const details = request.details || {};
  const args = redacted(details.args || request.args);
  const lines = [];
  if (details.targetChat) lines.push('Chat: ' + details.targetChat.title + ' (' + details.targetChat.id + ')');
  if (details.workingDirectory) lines.push('Working folder: ' + details.workingDirectory);
  const hasArgs = args && Object.keys(args).length > 0;
  if ((!hasArgs || request.tool === 'change_working_folder') && (request.summary || request.cmd)) lines.push(request.summary || request.cmd);
  if (request.tool.startsWith('mcp__')) lines.push('External tool: ' + request.tool.split('__').slice(1).join(' / ') + '\nEffects depend on this server; not assumed read-only.');
  if (request.tool === 'delete_chat') lines.push('Deletes this chat and its transcript. This cannot be undone.');
  if (request.tool === 'write_file') lines.push(details.fileExists === true ? 'Replaces an existing file.'
    : details.fileExists === false ? 'Creates a new file.' : 'Creates the file or replaces its current contents if it exists.');
  if (typeof details.fileBefore === 'string') lines.push('File before (bounded snapshot):\n' + details.fileBefore);
  if (args && request.tool === 'edit_file') lines.push('Proposed replacement:\n' + String(args.oldText || '') + '\n→\n' + String(args.newText || ''));
  if (request.tool === 'change_working_folder') lines.push('Selects an existing folder only. Does not create a folder or run Git.');
  if (request.tool === 'create_mcp_app') lines.push(args?.request !== undefined ? 'Creates an unsent development draft only; no adapter is registered or started.'
    : 'Registers and starts a trusted local MCP adapter. No installs, Node execution of app source, or automatic permission changes.');
  if (request.tool === 'update_settings' || request.tool === 'get_settings') lines.push('Scope: ' + (args?.scope || (request.tool === 'get_settings' ? 'app' : 'project')));
  if (details.before) lines.push('Before (snapshot):\n' + JSON.stringify(redacted(details.before), null, 2));
  if (hasArgs) {
    if (request.tool === 'shell') {
      lines.push('Command:\n' + args.cmd);
      if (args.shell) lines.push('Interpreter: ' + args.shell);
    } else if (request.tool === 'group_cli' && Array.isArray(args.commands)) {
      lines.push('Commands:\n' + args.commands.map((entry, index) => !entry || typeof entry !== 'object' ? String(entry) : (index + 1) + '. ' + (entry.cmd || entry.command || '(missing command)')
        + (entry.async || args.async ? ' [background]' : '')
        + (entry.shell ? '\n   Interpreter: ' + entry.shell : '')
        + (entry.timeoutMs ? '\n   Timeout: ' + entry.timeoutMs + ' ms' : '')).join('\n'));
    } else {
      const labels = { path: 'File', query: 'Search', include: 'File filter', startLine: 'From line', endLine: 'To line',
        chatId: 'Chat ID', callId: 'Worker', groupId: 'Group', content: 'Content', scope: 'Scope', patch: 'Proposed settings',
        unset: 'Remove keys', url: 'URL', mode: 'Mode', viewport: 'Size', agent: 'Agent', task: 'Task', background: 'Background',
        oldText: 'Replace', newText: 'With', edits: 'Proposed edits', files: 'Files' };
      for (const [key, value] of Object.entries(args)) {
        if ((key === 'scope' && (request.tool === 'get_settings' || request.tool === 'update_settings')) || (key === 'chatId' && details.targetChat?.id === value)
          || (request.tool === 'edit_file' && (key === 'oldText' || key === 'newText'))) continue;
        const label = labels[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
        lines.push(label + ': ' + (value && typeof value === 'object' ? '\n' + JSON.stringify(value, null, 2) : String(value)));
      }
    }
  } else if (!request.summary && !request.cmd) lines.push('No arguments.');
  if (request.projectDir && request.projectDir !== details.workingDirectory) lines.push('Project: ' + request.projectDir);
  if (request.timeoutMs) lines.push('Timeout: ' + Math.round(request.timeoutMs / 1000) + ' s');
  return lines.join('\n\n');
}
export function permissionExplanation(request, familyMembers = []) {
  const members = request.details?.permissionScope || (familyMembers.length ? familyMembers : [request.tool]);
  return 'Allow session: future calls to ' + request.tool + ' in this chat’s in-memory session.\n'
    + 'Always allow: project-wide permission for ' + members.join(', ') + ', including other chats and after restart. '
    + 'Arguments and targets are not restricted to this example. Existing more-specific overrides and mandatory approvals still apply.';
}
