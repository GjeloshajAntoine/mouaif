// Synthetic data only. Every native tool needs a deliberate fixture: the
// coverage test compares this list with the app's authoritative TOOL_GROUPS.
const file = { relPath: 'src/example.js', startLine: 1, endLine: 2, totalLines: 2, body: 'export const port = 5732;\n' };
const edit = { relPath: 'src/example.js', diff: '@@ -1 +1 @@\n-export const port = 3000;\n+export const port = 5732;' };
const chat = { id: 'demo-chat', title: 'Review expanded tool states', modelId: 'demo-model', draftSnippet: 'Keep the expanded card open.' };
const status = { callId: 'demo-worker', state: 'running', agent: 'reviewer', modelId: 'demo-model' };
const group = { groupId: 'demo-group', objective: 'Review mobile tool cards', members: [{ memberId: 'reviewer', state: 'running', workspace: '.', owns: ['frontend/src/components/chat/'] }] };
const artifact = { name: 'review', summary: 'Expanded cards should preserve the user’s choice.', files: ['docs/features/chat-view-mockup.md'] };
const task = { id: 'demo-task', title: 'Review expanded cards', description: 'Check the request and result on a phone.', status: 'in_progress', current: 1, total: 3 };
const settings = { scope: 'project', settings: { promptSize: 'average', tools: { shell: { mode: 'ask' } } } };
const features = { shell: { enabled: true, mode: 'ask' }, files: { enabled: true, mode: 'allow' } };
const models = [{ providerId: 'demo-provider', modelId: 'demo-model', label: 'Demo model' }];
export const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

export const TOOL_CASES = [
  { name: 'shell', args: { cmd: 'node --check src/example.js', shell: '/bin/bash' }, result: { stdout: 'Syntax OK\n', stderr: '', exitCode: 0, durationMs: 24, identity: 'linux · bash (/bin/bash)' } },
  { name: 'subagent', args: { task: 'Review expanded cards on a narrow screen.', agent: 'reviewer' }, result: { ok: true, text: 'The card fits. Check keyboard access and state retention.', agent: 'reviewer', totalCost: 0.001, chat: [
    { role: 'system', content: 'Review only the delegated task.' },
    { role: 'user', content: 'Review expanded cards on a narrow screen.' },
    { role: 'assistant', tool_calls: [{ id: 'nested-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/example.js' }) } }] },
    { role: 'tool', tool_call_id: 'nested-read', name: 'read_file', content: JSON.stringify(file) },
    { role: 'assistant', content: 'The card fits. Check keyboard access and state retention.' }
  ] } },
  { name: 'subagent_messages', args: { callId: 'demo-worker', since: 0, limit: 10 }, result: { ...status, lines: [{ cursor: 1, text: 'Checking the tool cards.' }], nextCursor: 1 } },
  { name: 'subagent_status', args: { callId: 'demo-worker' }, result: status },
  { name: 'subagent_stop', args: { callId: 'demo-worker' }, result: { ...status, state: 'cancelled', alreadyFinished: false } },
  { name: 'subagent_send', args: { callId: 'demo-worker', message: 'Check 360px width first.' }, result: { callId: 'demo-worker', messageId: 'demo-message', state: 'queued' } },
  { name: 'subagent_group_create', args: { name: 'Mobile review', objective: group.objective, members: [{ memberId: 'reviewer', role: 'Inspect cards', workspace: '.', owns: ['frontend/src/components/chat/'], dependsOn: [] }] }, result: group },
  { name: 'subagent_group_update', args: { groupId: 'demo-group', action: 'approve', name: 'layout', contract: 'Keep the card within the phone width.' }, result: { ...group, decisions: [{ name: 'layout', state: 'approved' }] } },
  { name: 'subagent_publish', args: artifact, result: artifact },
  { name: 'subagent_read', args: { name: 'review' }, result: artifact },
  { name: 'subagent_group_status', args: { groupId: 'demo-group' }, result: group },
  { name: 'subagent_decision', args: { groupId: 'demo-group', name: 'layout', proposal: 'Keep the result visible before long arguments.' }, result: { groupId: 'demo-group', name: 'layout', state: 'proposed' } },
  { name: 'subagent_conflict', args: { groupId: 'demo-group', name: 'ownership', summary: 'Two reviewers need the same stylesheet.', members: ['reviewer', 'builder'] }, result: { groupId: 'demo-group', conflict: { name: 'ownership', state: 'pending' } } },
  { name: 'list_chats', args: { limit: 10 }, result: { chats: [chat], returned: 1, total: 1 } },
  { name: 'get_chat', args: { chatId: chat.id, includeMessages: true }, result: { chat, messages: [{ role: 'user', content: 'Review the chat view.' }] } },
  { name: 'create_chat', args: { title: chat.title, topic: 'Inspect expanded states.' }, result: { chat } },
  { name: 'update_chat', args: { chatId: chat.id, title: 'Mobile review' }, result: { chat: { ...chat, title: 'Mobile review' } } },
  { name: 'change_working_folder', args: { directory: '.', chatId: chat.id }, result: { chatId: chat.id, workingDirectory: '/demo/project', projectDir: '/demo/project' } },
  { name: 'search_models', args: { query: 'demo', limit: 10 }, result: { models, returned: 1, nextOffset: null } },
  { name: 'start_chat', args: { chatId: chat.id, content: 'Review the cards; do not edit.' }, result: { chatId: chat.id, started: true, url: '#/chat/demo-chat' } },
  { name: 'delete_chat', args: { chatId: chat.id, confirm: true }, result: { deleted: true, chatId: chat.id } },
  { name: 'search_chats', args: { query: 'expanded', limit: 10 }, result: { chats: [chat], returned: 1, total: 1 } },
  { name: 'attach_chat_image', args: { path: 'docs/images/review.png', target: 'draft', chatId: chat.id }, result: { chatId: chat.id, target: 'draft', attachment: { name: 'review.png', mimeType: 'image/png' } } },
  { name: 'list_chat_attachments', args: { chatId: chat.id, limit: 10 }, result: { attachments: [{ imageRef: 'message:1:0', name: 'review.png', mimeType: 'image/png' }], nextBeforeSeq: null } },
  { name: 'ask_user', args: { question: 'Which view needs review?', options: [{ label: 'Expanded tools', value: 'tools' }, { label: 'Composer', value: 'composer' }] }, result: { choice: 'tools', label: 'Expanded tools', extra: 'Check phone widths.' } },
  { name: 'task', args: { action: 'list' }, result: { tasks: [task, { id: 'done', title: 'Inspect the source', status: 'completed' }] } },
  { name: 'report_progress', args: { title: 'Review expanded cards', current: 1, total: 3, status: 'running', message: 'Checking the request and result.' }, result: { title: 'Review expanded cards', current: 1, total: 3, status: 'running', message: 'Checking the request and result.' } },
  { name: 'webpreview', args: { url: 'https://example.invalid/review', viewport: 'phone' }, result: { url: 'https://example.invalid/review', mode: 'screenshot' } },
  { name: 'create_mcp_app', args: { name: 'Review app', request: 'Create a local mobile card review app.' }, result: { mode: 'request', chatId: 'demo-app-draft', draft: 'Create a local mobile card review app.', started: false } },
  { name: 'get_settings', args: { scope: 'project', keys: ['promptSize'] }, result: settings },
  { name: 'update_settings', args: { scope: 'project', patch: { promptSize: 'average' } }, result: settings },
  { name: 'list_projects', args: {}, result: { projects: [{ name: 'Demo project', path: '/demo/project', cost: 0.12 }] } },
  { name: 'get_app_info', args: {}, result: { features, version: 'demo', defaultPort: 5732 } },
  { name: 'restart_app', args: { reason: 'Apply a reviewed server-side change.' }, result: { restarting: true, reason: 'Apply a reviewed server-side change.' } },
  { name: 'list_features', args: {}, result: features },
  { name: 'group_cli', args: { commands: [{ cmd: 'node --check src/example.js', label: 'Syntax' }, { cmd: 'npm test', label: 'Tests', async: true }] }, result: { succeededCount: 1, failedCount: 0, runningCount: 1, results: [
    { index: 0, label: 'Syntax', cmd: 'node --check src/example.js', ok: true, result: { stdout: 'Syntax OK', exitCode: 0, durationMs: 24 } },
    { index: 1, label: 'Tests', cmd: 'npm test', ok: true, result: { async: true, status: 'running', pid: 123, logPath: '.mouaif/logs/demo-tests.log' } }
  ] } },
  { name: 'read_file', args: { path: 'src/example.js', startLine: 1, endLine: 2 }, result: file },
  { name: 'list_files', args: { pattern: 'src/**/*.js' }, result: { entries: [{ path: 'src/example.js' }, { path: 'src/a-very-long-directory-name/another-long-directory-name/mobile-review-example.js' }], truncated: false } },
  { name: 'search_files', args: { query: 'port', path: 'src', include: '*.js' }, result: { query: 'port', matches: [{ path: 'src/example.js', line: 1, text: 'export const port = 5732;' }], truncated: false } },
  { name: 'write_file', args: { path: 'src/example.js', content: file.body }, result: { relPath: 'src/example.js', lines: 1, chars: file.body.length } },
  { name: 'edit_file', args: { path: 'src/example.js', oldText: '3000', newText: '5732' }, result: edit },
  { name: 'group_read', args: { files: [{ path: 'src/example.js' }, { path: 'src/missing.js' }] }, result: { succeededCount: 1, failedCount: 1, results: [{ path: 'src/example.js', ok: true, result: file }, { path: 'src/missing.js', ok: false, result: { error: 'ENOENT: file not found' } }] } },
  { name: 'group_edit', args: { edits: [{ path: 'src/example.js', oldText: '3000', newText: '5732' }] }, result: { succeededCount: 1, failedCount: 0, results: [{ path: 'src/example.js', ok: true, result: edit }] } },
  { name: 'mcp__demo__snapshot', args: { pageId: 1, verbose: false }, result: { content: [{ type: 'text', text: 'RootWebArea "Mobile tool review"\n  button "Expand tool"' }] } },
  { name: 'mcp__demo__image', args: { pageId: 1 }, result: { content: [{ type: 'image', mimeType: 'image/png', data: IMAGE.split(',')[1] }] } },
  { name: 'unknown_tool', args: { query: 'fallback rendering' }, result: { items: ['A tool without a dedicated renderer still shows request and result.'] } }
];

export const LONG_CASE = {
  name: 'shell', args: { cmd: "node <<'NODE'\n" + Array.from({ length: 45 }, (_, i) => '// Setup line ' + (i + 1)).join('\n') + '\nconsole.log("RESULT BELOW LONG COMMAND");\nNODE' },
  result: { stdout: 'RESULT BELOW LONG COMMAND\n', stderr: '', exitCode: 0, durationMs: 40 }
};

export function refs(host) {
  return { transcript: { current: host }, pinnedToBottom: { current: false },
    pendingCount: { current: 0 }, jumpBtn: { current: null }, status: { current: null }, usageSummary: { current: null },
    _suspendScrollPin: true, _insertAnchor: null };
}
