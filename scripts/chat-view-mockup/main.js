// A review harness, not an alternative chat implementation. All cards use
// production renderers and production CSS. No tool runner is imported.
import { TOOL_GROUPS, toolGroupId } from '../../frontend/src/toolGroups.js';
import { appendToolCallCard, appendToolResultCard, handleShellOutputEvent,
  reconcileTranscriptRows } from '../../frontend/src/components/chat/transcript.js';
import { askUserCard, authorizationCard } from '../../frontend/src/components/chat/cards.js';
import { TOOL_CASES, LONG_CASE, IMAGE, refs } from './fixtures.js';
import { approvalRequest, approvalNote } from './approvals.js';

// Keep production approval/question controls local even when this page is
// served through the app-origin preview proxy (which cannot forward POST).
// Never send synthetic decisions to the real app's authorization endpoint.
const browserFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
  if (url.pathname.startsWith('/api/')) {
    const decision = url.pathname === '/api/tools/authorization/decision' && init?.method === 'POST';
    return Promise.resolve(new Response(JSON.stringify(decision ? { ok: true } : { error: 'Preview has no app API' }),
      { status: decision ? 200 : 404, headers: { 'Content-Type': 'application/json' } }));
  }
  return browserFetch(input, init);
};

const tools = document.querySelector('#tools');
const states = document.querySelector('#states');
const status = document.querySelector('#review-status');
const search = document.querySelector('#search');
const family = document.querySelector('#family');
const renderPath = document.querySelector('#render-path');
const view = document.querySelector('#view');
view.value = new URLSearchParams(location.search).get('view') === 'approvals' ? 'approvals' : 'results';
const mounted = [];
let approvalController;
const nativeNames = TOOL_GROUPS.flatMap(group => group.tools);
const groupNames = Object.fromEntries(TOOL_GROUPS.map(group => [group.id, group.name]));
for (const [id, name] of Object.entries({ ...groupNames, mcp: 'MCP', fallback: 'Fallback' })) {
  const option = document.createElement('option');
  option.value = id; option.textContent = name; family.appendChild(option);
}

function panel(parent, id) {
  const section = document.createElement('article');
  section.className = 'review-case'; section.id = id;
  const box = document.createElement('div');
  box.className = 'chat-view__transcript review-box';
  section.appendChild(box); parent.appendChild(section);
  return { section, box, refs: refs(box) };
}

function messagesFor(test, id) {
  return [
    { role: 'tool', phase: 'call', seq: 1, name: test.name, toolCallId: id, args: test.args, content: JSON.stringify(test.args) },
    { role: 'tool', phase: 'result', seq: 2, name: test.name, toolCallId: id, ok: test.ok !== false, content: JSON.stringify(test.result) }
  ];
}

function setExpanded(card, expanded) {
  if (!card) return;
  card.classList.toggle('is-expanded', expanded);
  // The same user intent marker that a production header tap writes.
  card._userCollapsed = !expanded;
  card.querySelector('.tool-card__head')?.setAttribute('aria-expanded', String(expanded));
  if (expanded && typeof card._lazyBody === 'function') card._lazyBody();
  // The delegated tool previews are production toggles too; expand them
  // for the all-expanded review rather than hiding evidence a level down.
  for (const toggle of card.querySelectorAll('.tool-card__subagent-toggle')) {
    if ((toggle.getAttribute('aria-expanded') === 'true') !== expanded) toggle.click();
  }
}

function draw(test, host, id, path) {
  const call = { id, name: test.name, args: test.args };
  const result = { ...call, ok: test.ok !== false, result: test.result };
  const state = { chat: {}, messages: messagesFor(test, id) };
  if (path === 'result-first') appendToolResultCard(result, host.refs);
  else if (path === 'reconciled') reconcileTranscriptRows(state, host.refs, [0, 1]);
  else { appendToolCallCard(call, host.refs, true); appendToolResultCard(result, host.refs); }
  const card = host.box.firstElementChild;
  setExpanded(card, true);
  return { ...host, state, card, test };
}

function applyFilter() {
  const term = search.value.trim().toLowerCase();
  let visible = 0;
  for (const item of mounted) {
    const groupId = item.section.dataset.family;
    const matches = (!term || (item.test.name + ' ' + (groupNames[groupId] || groupId)).toLowerCase().includes(term))
      && (family.value === 'all' || family.value === groupId);
    item.section.hidden = !matches;
    if (matches) visible++;
  }
  document.querySelector('#visible-count').textContent = visible + '/' + mounted.length;
  document.querySelector('#no-matches').hidden = visible !== 0;
}

function drawApproval(test, host, id) {
  if (test.name === 'report_progress' || test.name === 'list_features') {
    const note = document.createElement('p');
    note.className = 'review-case__note';
    note.textContent = test.name + ' · ' + approvalNote(test.name);
    host.section.insertBefore(note, host.box);
    host.section.dataset.approval = 'not-required';
    return { ...host, test };
  }
  host.section.dataset.approval = test.name === 'ask_user' ? 'question' : 'permission';
  if (test.name === 'ask_user') {
    askUserCard({ callId: id, ...test.args }, '/demo/project', 'demo-chat', host.refs, () => {}, { autoScroll: false });
  } else {
    void authorizationCard(approvalRequest(test, id, approvalController.signal),
      '/demo/project', 'demo-chat', host.refs, () => {}, {
        chat: { providerId: 'demo-provider', modelId: 'demo-model' },
        models: [{ id: 'demo-model', provider: 'demo-provider', label: 'Demo model' }]
      }, { autoFocus: false, autoScroll: false });
  }
  return { ...host, card: host.box.firstElementChild, test };
}

function renderTools() {
  approvalController?.abort();
  approvalController = new AbortController();
  mounted.length = 0; tools.replaceChildren();
  const approvals = view.value === 'approvals';
  for (const id of ['expand', 'collapse', 'reconcile']) document.getElementById(id).hidden = approvals;
  document.querySelector('#reset-approvals').hidden = !approvals;
  renderPath.disabled = approvals;
  states.hidden = approvals;
  status.hidden = true;
  for (const test of TOOL_CASES) {
    const groupId = toolGroupId(test.name) || (test.name.startsWith('mcp__') ? 'mcp' : 'fallback');
    const host = panel(tools, 'tool-' + test.name);
    host.section.dataset.family = groupId;
    mounted.push(approvals ? drawApproval(test, host, 'approval-' + test.name)
    : draw(test, host, 'review-' + test.name, renderPath.value));
  }
  applyFilter();
  const covered = nativeNames.filter(name => TOOL_CASES.some(test => test.name === name)).length;
  document.querySelector('#coverage').textContent = covered + ' / ' + nativeNames.length;
}

search.addEventListener('input', applyFilter);
family.addEventListener('change', applyFilter);
view.addEventListener('change', renderTools);
document.querySelector('#reset-approvals').addEventListener('click', renderTools);
renderPath.addEventListener('change', () => { renderTools(); status.hidden = false; status.textContent = 'Rebuilt through ' + renderPath.selectedOptions[0].textContent + '.'; });
document.querySelector('#expand').addEventListener('click', () => mounted.forEach(item => setExpanded(item.card, true)));
document.querySelector('#collapse').addEventListener('click', () => mounted.forEach(item => setExpanded(item.card, false)));
document.querySelector('#reconcile').addEventListener('click', () => {
  const stable = mounted.every(item => {
    const wasOpen = item.card.classList.contains('is-expanded');
    reconcileTranscriptRows(item.state, item.refs, [0, 1]);
    return item.box.firstElementChild === item.card && item.card.classList.contains('is-expanded') === wasOpen;
  });
  status.hidden = false;
  status.textContent = stable ? 'Replay kept every card and its expanded / collapsed state.' : 'State changed during replay — inspect the cards.';
});

renderTools();

const transition = panel(states, 'state-transition');
const shell = TOOL_CASES.find(test => test.name === 'shell');
appendToolCallCard({ id: 'transition-shell', name: shell.name, args: shell.args }, transition.refs);
handleShellOutputEvent({ id: 'transition-shell', stream: 'stdout', delta: 'Checking syntax…\n' }, transition.refs);
const finish = document.createElement('button'); finish.type = 'button'; finish.textContent = 'Finish running tool';
finish.addEventListener('click', () => {
  appendToolResultCard({ id: 'transition-shell', name: shell.name, ok: true, result: shell.result }, transition.refs);
  finish.disabled = true; finish.textContent = 'Result received';
});
transition.section.appendChild(finish);

for (const [id, , test] of [
  ['long-command', 'Long command', LONG_CASE],
  ['failed-tool', 'Failed tool', { name: 'read_file', args: { path: 'src/missing.js' }, ok: false, result: { error: 'ENOENT: file not found: src/missing.js' } }],
  ['dismissed-question', 'Dismissed question', { name: 'ask_user', args: { question: 'Continue?' }, ok: false, result: { cancelled: true } }],
  ['empty-result', 'No matching files', { name: 'list_files', args: { pattern: 'missing/**/*.js' }, result: { entries: [], truncated: false } }],
  ['read-image', 'Image read result', { name: 'read_file', args: { path: 'docs/images/review.png' }, result: { kind: 'image', relPath: 'docs/images/review.png', mimeType: 'image/png', bytes: 70, content: [{ type: 'image', data: IMAGE.split(',')[1], mimeType: 'image/png' }] } }],
  ['completed-progress', 'Completed progress', { name: 'report_progress', args: { title: 'Review complete', current: 3, total: 3, status: 'completed' }, result: { title: 'Review complete', current: 3, total: 3, status: 'completed' } }],
  ['failed-progress', 'Failed progress', { name: 'report_progress', args: { title: 'Review blocked', current: 1, total: 3, status: 'failed' }, result: { title: 'Review blocked', current: 1, total: 3, status: 'failed', message: 'Browser unavailable.' } }]
]) draw(test, panel(states, id), id, 'call-first');

const question = panel(states, 'pending-question');
askUserCard({ callId: 'review-question', ...TOOL_CASES.find(test => test.name === 'ask_user').args,
  multiSelect: false, presets: ['Expanded tools'] }, '/demo/project', 'demo-chat', question.refs, () => {}, { autoScroll: false });
const approval = panel(states, 'pending-approval');
void authorizationCard({ callId: 'review-approval', tool: 'shell', cmd: 'node --check src/example.js', timeoutMs: 30000 },
  '/demo/project', 'demo-chat', approval.refs, () => {}, { chat: {}, models: [] }, { autoFocus: false, autoScroll: false });

// Deliberately bounded public diagnostics for browser tests and review tools.
window.mockup = { mounted, nativeNames, ready: true };
if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
