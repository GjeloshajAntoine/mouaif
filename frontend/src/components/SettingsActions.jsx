// mouaif web — project custom action list + editor
import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../api.js';
import { nav } from '../router.js';
import { schemaJson } from './settings/actionSchema.js';
function projectQS(projectDir) { return '?projectDir=' + encodeURIComponent(projectDir || ''); }
function emptyAction() {
return { id: '', label: '', description: '', kind: 'cli', command: '', timeoutMs: '', serverId: '', toolName: '', argsText: '{}' };
}
function toForm(action) {
return {
...emptyAction(), ...action,
timeoutMs: action.timeoutMs || '',
argsText: JSON.stringify(action.args || {}, null, 2)
};
}
export function SettingsActionsView({ projectDir = '', from = '' }) {
const [actions, setActions] = useState([]);
const [status, setStatus] = useState('loading…');
useEffect(() => {
let cancelled = false;
fetchJson('/api/actions?projectDir=' + encodeURIComponent(projectDir)).then((r) => {
if (cancelled) return;
if (r.status === 200) { setActions(r.body.actions || []); setStatus(''); }
else setStatus((r.body && r.body.error) || ('HTTP ' + r.status));
}).catch((err) => { if (!cancelled) setStatus(String(err)); });
return () => { cancelled = true; };
}, [projectDir]);
return h(Fragment, null,
h('div', { class: 'view-head' },
h('a', { href: '#/settings/project' + projectQS(projectDir) + (from ? '&from=' + encodeURIComponent(from) : ''), class: 'view-back', 'aria-label': 'Back to project settings' }, '←'),
h('h2', { class: 'view-title' }, 'Custom actions')
),
h('section', null,
h('p', { class: 'hint hint--compact' }, 'Project shortcuts backed by a CLI command or MCP tool. Run one by typing ', h('code', null, '@action-id'), ' as the complete composer message.'),
h('ul', { class: 'prompts__list', 'aria-label': 'Custom actions' },
actions.length ? actions.map((action) => h('li', { key: action.id, class: 'prompt-row' },
h('a', { class: 'prompt-row__main', href: '#/settings/actions/' + encodeURIComponent(action.id) + projectQS(projectDir) },
h('div', { class: 'prompt-row__title' }, action.label || action.id),
h('div', { class: 'prompt-row__meta' }, '@' + action.id + ' · ' + (action.kind === 'mcp' ? action.serverId + ' / ' + action.toolName : action.command)),
h('div', { class: 'prompt-row__chev', 'aria-hidden': 'true' }, '›')
)
)) : h('li', { class: 'prompts__empty' }, status || 'No custom actions yet.')
),
h('div', { class: 'row row--actions' },
h('a', { class: 'btn btn--primary', href: '#/settings/actions/new' + projectQS(projectDir) }, '+ Add action'),
h('span', { class: 'status', 'aria-live': 'polite' }, status)
)
)
);
}
export function SettingsActionEditView({ id = '', projectDir = '', from = '' }) {
const isNew = !id || id === 'new';
const fromQS = from ? '&from=' + encodeURIComponent(from) : '';
const actionsListHref = '#/settings/actions' + projectQS(projectDir) + fromQS;
const [form, setForm] = useState(emptyAction);
const [servers, setServers] = useState([]);
const [tools, setTools] = useState([]);
const [status, setStatus] = useState(isNew ? '' : 'loading…');
useEffect(() => {
let cancelled = false;
Promise.all([
fetchJson('/api/actions?projectDir=' + encodeURIComponent(projectDir)),
fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(projectDir))
]).then(([ar, sr]) => {
if (cancelled) return;
if (sr.status === 200) setServers(sr.body.servers || []);
if (!isNew && ar.status === 200) {
const found = (ar.body.actions || []).find((action) => action.id === id);
if (found) { setForm(toForm(found)); setStatus(''); } else setStatus('Action not found');
}
}).catch((err) => { if (!cancelled) setStatus(String(err)); });
return () => { cancelled = true; };
}, [projectDir, id, isNew]);
useEffect(() => {
const server = servers.find((item) => item.id === form.serverId);
setTools(server && Array.isArray(server.tools) ? server.tools : []);
}, [servers, form.serverId]);
function patch(key, value) { setForm((current) => ({ ...current, [key]: value })); }
function selectMcpServer(serverId) {
setForm((current) => ({ ...current, serverId, toolName: '', argsText: '{}' }));
}
function selectMcpTool(toolName) {
const tool = tools.find((item) => item && item.name === toolName);
setForm((current) => ({
...current,
toolName,
argsText: tool ? schemaJson(tool.inputSchema || tool.parameters) : '{}'
}));
}
async function save() {
let args = {};
if (form.kind === 'mcp') {
try { args = JSON.parse(form.argsText || '{}'); }
catch { setStatus('MCP arguments must be valid JSON'); return; }
if (!args || Array.isArray(args) || typeof args !== 'object') { setStatus('MCP arguments must be a JSON object'); return; }
}
const action = {
id: form.id.trim(), label: form.label.trim(), description: form.description.trim(), kind: form.kind,
...(form.kind === 'cli'
? { command: form.command.trim(), ...(form.timeoutMs ? { timeoutMs: Number(form.timeoutMs) } : {}) }
: { serverId: form.serverId, toolName: form.toolName, args })
};
setStatus('saving…');
const r = await fetchJson('/api/actions', {
method: 'POST', headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ projectDir, originalId: isNew ? '' : id, action })
});
if (r.status !== 200) { setStatus((r.body && r.body.error) || ('HTTP ' + r.status)); return; }
nav('settings/actions' + projectQS(projectDir) + fromQS);
}
async function remove() {
if (!confirm('Delete custom action "' + id + '"?')) return;
const r = await fetchJson('/api/actions/' + encodeURIComponent(id) + projectQS(projectDir), { method: 'DELETE' });
if (r.status === 200) nav('settings/actions' + projectQS(projectDir) + fromQS);
else setStatus((r.body && r.body.error) || ('HTTP ' + r.status));
}
return h(Fragment, null,
h('div', { class: 'view-head' },
h('a', { href: actionsListHref, class: 'view-back', 'aria-label': 'Back to custom actions' }, '←'),
h('h2', { class: 'view-title' }, isNew ? 'Add action' : (form.label || form.id || 'Edit action'))
),
h('section', null,
h('div', { class: 'row' },
h('label', { class: 'label', for: 'action-id' }, 'Action ID'),
h('input', { class: 'input', id: 'action-id', value: form.id, placeholder: 'test', onInput: (e) => patch('id', e.currentTarget.value), autocapitalize: 'off', spellcheck: false }),
h('p', { class: 'hint hint--compact' }, 'Used as ', h('code', null, '@action-id'), '. Letters, digits, dot, underscore, and dash only.')
),
h('div', { class: 'row' }, h('label', { class: 'label', for: 'action-label' }, 'Label'), h('input', { class: 'input', id: 'action-label', value: form.label, placeholder: 'Run tests', onInput: (e) => patch('label', e.currentTarget.value) })),
h('div', { class: 'row' }, h('label', { class: 'label', for: 'action-description' }, 'Description'), h('input', { class: 'input', id: 'action-description', value: form.description, placeholder: 'What this action does', onInput: (e) => patch('description', e.currentTarget.value) })),
h('div', { class: 'row' },
h('span', { class: 'label' }, 'Runs with'),
h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Action type' },
[['cli', 'CLI'], ['mcp', 'MCP']].map(([value, label]) => h('label', { key: value, class: 'seg__item' + (form.kind === value ? ' seg__item--on' : '') },
h('input', { type: 'radio', name: 'action-kind', value, checked: form.kind === value, onChange: () => patch('kind', value) }),
h('span', { class: 'seg__pill' }, label)
)))
),
form.kind === 'cli' ? h(Fragment, null,
h('div', { class: 'row' }, h('label', { class: 'label', for: 'action-command' }, 'Command'), h('textarea', { class: 'input settings-project__mono', id: 'action-command', rows: 4, value: form.command, placeholder: 'npm test', onInput: (e) => patch('command', e.currentTarget.value), spellcheck: false })),
h('div', { class: 'row' }, h('label', { class: 'label', for: 'action-timeout' }, 'Timeout (ms, optional)'), h('input', { class: 'input', id: 'action-timeout', type: 'number', min: 1, max: 600000, inputmode: 'numeric', value: form.timeoutMs, placeholder: '30000', onInput: (e) => patch('timeoutMs', e.currentTarget.value) }))
) : h(Fragment, null,
h('div', { class: 'row' }, h('label', { class: 'label', for: 'action-server' }, 'MCP server'), h('select', { class: 'input', id: 'action-server', value: form.serverId, onChange: (e) => selectMcpServer(e.currentTarget.value) }, h('option', { value: '' }, 'Choose a server'), servers.map((server) => h('option', { key: server.id, value: server.id }, server.name || server.id)))),
h('div', { class: 'row' }, h('label', { class: 'label', for: 'action-tool' }, 'MCP tool'), h('select', { class: 'input', id: 'action-tool', value: form.toolName, onChange: (e) => selectMcpTool(e.currentTarget.value) }, h('option', { value: '' }, tools.length ? 'Choose a tool' : 'Start server to discover tools'), tools.map((tool) => h('option', { key: tool.name, value: tool.name }, tool.name)))),
h('div', { class: 'row' }, h('label', { class: 'label', for: 'action-args' }, 'Arguments (JSON)'), h('textarea', { class: 'input settings-project__mono', id: 'action-args', rows: 6, value: form.argsText, onInput: (e) => patch('argsText', e.currentTarget.value), spellcheck: false }), h('p', { class: 'hint hint--compact' }, 'Selecting a tool prefills this object from its input schema. Replace placeholder values before saving.'))
),
h('div', { class: 'row row--actions' },
h('button', { class: 'btn btn--primary', type: 'button', onClick: save }, 'Save'),
!isNew && h('button', { class: 'btn btn--danger', type: 'button', onClick: remove }, 'Delete'),
h('span', { class: 'status', 'aria-live': 'polite' }, status)
)
)
);
}
