// Synthetic approval requests using the summary shapes emitted by
// src/ai-stream.js. No tool runners, settings, or permission stores involved.
export function approvalRequest({ name, args }, callId, signal) {
  const first = Object.values(args).find(value => typeof value === 'string') || '';
  let summary = first;
  if (name === 'shell') summary = args.cmd;
  else if (name === 'subagent') summary = args.task;
  else if (name === 'group_cli') summary = args.commands.map((entry, index) =>
    (index + 1) + '. ' + entry.cmd + (entry.async ? '  [background]' : '')).join('\n');
  else if (name === 'change_working_folder') summary = 'Chat: ' + args.chatId
    + '\nDestination: /demo/project\nUse existing directory: ' + args.directory;
  else if (name === 'webpreview') summary = args.url;
  else if (name === 'group_read' || name === 'group_edit') summary =
    args[name === 'group_read' ? 'files' : 'edits'].map(item => item.path).join(', ');
  else if (['read_file', 'list_files', 'search_files', 'write_file', 'edit_file'].includes(name))
    summary = args.path || args.query || '';
  else if (name.startsWith('mcp__')) summary = name + (first ? ' ' + first : '');
  else if (name === 'create_mcp_app') summary = 'Prepare development draft: ' + args.name;
  return { tool: name, callId, summary, cmd: args.cmd, path: args.path, query: args.query,
    projectDir: '/demo/project', timeoutMs: 30000, signal,
    ...(name === 'subagent' ? { subagentModel: { providerId: 'demo-provider', modelId: 'demo-model', source: 'chat model' } } : {}) };
}

export function approvalNote(name) {
  if (name === 'report_progress' || name === 'list_features') return 'No approval prompt in the app. This read-only tool runs without asking when enabled.';
  if (name === 'ask_user') return 'The app asks a question instead of showing an Allow / Deny prompt. Answering here is demo-only.';
  return 'Approval when permission is Ask. These are demo buttons; nothing runs and real permissions stay unchanged.';
}
