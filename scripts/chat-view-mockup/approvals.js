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
  else if (name === 'wait_for') summary = 'wait for ' + args.jobId + ' (up to ' + args.seconds + 's)';
  else if (name === 'job_status' || name === 'job_cancel') summary = args.jobId;
  else if (name === 'schedule_wake') summary = ['in ' + args.in, args.every ? 'every ' + args.every : '', args.message].filter(Boolean).join(' \u2014 ');
  else if (name === 'run_start') summary = [args.goal, args.maxTurns + ' turns', '$' + args.maxCostUsd, args.maxHours + 'h'].join(' \u2014 ');
  else if (name === 'run_end') summary = [args.outcome, args.summary].filter(Boolean).join(': ');
  else if (name === 'run_status') summary = 'read the run';
  else if (name === 'schedule_cancel') summary = args.id;
  else if (name === 'schedule_list') summary = 'pending wake-ups';
  else if (name === 'webpreview') summary = args.url;
  else if (name === 'group_read' || name === 'group_edit') summary =
    args[name === 'group_read' ? 'files' : 'edits'].map(item => item.path).join(', ');
  else if (['read_file', 'list_files', 'search_files', 'write_file', 'edit_file'].includes(name))
    summary = args.path || args.query || '';
  else if (name.startsWith('mcp__')) summary = name + (first ? ' ' + first : '');
  else if (name === 'create_mcp_app') summary = 'Prepare development draft: ' + args.name;
  const details = { args, workingDirectory: '/demo/project',
    targetChat: { title: 'Review expanded tool states', id: args.chatId || 'demo-chat' },
    ...(name === 'update_settings' ? { before: { promptSize: 'very-small' } } : {}),
    ...(name === 'update_chat' ? { before: { title: 'Review expanded tool states' } } : {}) };
  return { tool: name, callId, summary, details, cmd: args.cmd, path: args.path, query: args.query,
    projectDir: '/demo/project', timeoutMs: 30000, signal,
    ...(name === 'subagent' ? { subagentModel: { providerId: 'demo-provider', modelId: 'demo-model', source: 'chat model' } } : {}) };
}

export function approvalNote(name) {
  if (name === 'report_progress' || name === 'list_features') return 'No approval prompt in the app. This read-only tool runs without asking when enabled.';
  if (name === 'ask_user') return 'The app asks a question instead of showing an Allow / Deny prompt. Answering here is demo-only.';
  return 'Approval when permission is Ask. These are demo buttons; nothing runs and real permissions stay unchanged.';
}
