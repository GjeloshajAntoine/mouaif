// A review harness, not an alternative chat implementation. All cards use
// production renderers and production CSS. No tool runner is imported.
import { TOOL_GROUPS, toolGroupId } from '../../frontend/src/toolGroups.js';
import { appendToolCallCard, appendToolResultCard, handleShellOutputEvent,
  reconcileTranscriptRows } from '../../frontend/src/components/chat/transcript.js';
import { askUserCard, authorizationCard } from '../../frontend/src/components/chat/cards.js';
import { TOOL_CASES, LONG_CASE, IMAGE, refs } from './fixtures.js';

const tools = document.querySelector('#tools');
const states = document.querySelector('#states');
const status = document.querySelector('#review-status');
const search = document.querySelector('#search');
const family = document.querySelector('#family');
const renderPath = document.querySelector('#render-path');
const mounted = [];
const nativeNames = TOOL_GROUPS.flatMap(group => group.tools);
const groupNames = Object.fromEntries(TOOL_GROUPS.map(group => [group.id, group.name]));
for (const [id, name] of Object.entries({ ...groupNames, mcp: 'MCP', fallback: 'Fallback' })) {
  const option = document.createElement('option');
  option.value = id; option.textContent = name; family.appendChild(option);
}

function panel(parent, id, title, note) {
  const section = document.createElement('article');
  section.className = 'review-case'; section.id = id;
  const heading = document.createElement('h3'); heading.textContent = title;
  section.appendChild(heading);
  if (note) { const p = document.createElement('p'); p.textContent = note; section.appendChild(p); }
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
  document.querySelector('#visible-count').textContent = visible + ' of ' + mounted.length + ' tool examples';
  document.querySelector('#no-matches').hidden = visible !== 0;
}

function renderTools() {
  mounted.length = 0; tools.replaceChildren();
  for (const test of TOOL_CASES) {
    const groupId = toolGroupId(test.name) || (test.name.startsWith('mcp__') ? 'mcp' : 'fallback');
    const host = panel(tools, 'tool-' + test.name, test.name, groupNames[groupId] || groupId);
    host.section.dataset.family = groupId;
    mounted.push(draw(test, host, 'review-' + test.name, renderPath.value));
  }
  applyFilter();
  const covered = nativeNames.filter(name => TOOL_CASES.some(test => test.name === name)).length;
  document.querySelector('#coverage').textContent = covered + ' / ' + nativeNames.length
    + ' native tools · 2 MCP examples · 1 fallback · live and failure cases below';
}

search.addEventListener('input', applyFilter);
family.addEventListener('change', applyFilter);
renderPath.addEventListener('change', () => { renderTools(); status.textContent = 'Rebuilt through ' + renderPath.selectedOptions[0].textContent + '.'; });
document.querySelector('#expand').addEventListener('click', () => mounted.forEach(item => setExpanded(item.card, true)));
document.querySelector('#collapse').addEventListener('click', () => mounted.forEach(item => setExpanded(item.card, false)));
document.querySelector('#reconcile').addEventListener('click', () => {
  const stable = mounted.every(item => {
    const wasOpen = item.card.classList.contains('is-expanded');
    reconcileTranscriptRows(item.state, item.refs, [0, 1]);
    return item.box.firstElementChild === item.card && item.card.classList.contains('is-expanded') === wasOpen;
  });
  status.textContent = stable ? 'Replay kept every card and its expanded / collapsed state.' : 'State changed during replay — inspect the cards.';
});

renderTools();

const transition = panel(states, 'state-transition', 'Running → successful result', 'Open or close this running shell, then finish it. A deliberate choice must survive the result.');
const shell = TOOL_CASES.find(test => test.name === 'shell');
appendToolCallCard({ id: 'transition-shell', name: shell.name, args: shell.args }, transition.refs);
handleShellOutputEvent({ id: 'transition-shell', stream: 'stdout', delta: 'Checking syntax…\n' }, transition.refs);
const finish = document.createElement('button'); finish.type = 'button'; finish.textContent = 'Finish running tool';
finish.addEventListener('click', () => {
  appendToolResultCard({ id: 'transition-shell', name: shell.name, ok: true, result: shell.result }, transition.refs);
  finish.disabled = true; finish.textContent = 'Result received';
});
transition.section.appendChild(finish);

for (const [id, title, test, note] of [
  ['long-command', 'Long command → output below the fold', LONG_CASE, 'The production 40dvh cap is unchanged; no mockup-only uncap hides the problem.'],
  ['failed-tool', 'Failed tool', { name: 'read_file', args: { path: 'src/missing.js' }, ok: false, result: { error: 'ENOENT: file not found: src/missing.js' } }, 'Errors auto-expand in production.'],
  ['dismissed-question', 'Dismissed question', { name: 'ask_user', args: { question: 'Continue?' }, ok: false, result: { cancelled: true } }, 'A deliberate dismissal is not a tool execution failure.'],
  ['empty-result', 'No matching files', { name: 'list_files', args: { pattern: 'missing/**/*.js' }, result: { entries: [], truncated: false } }, 'Empty is a valid result, not a loading state.'],
  ['read-image', 'Image read result', { name: 'read_file', args: { path: 'docs/images/review.png' }, result: { kind: 'image', relPath: 'docs/images/review.png', mimeType: 'image/png', bytes: 70, content: [{ type: 'image', data: IMAGE.split(',')[1], mimeType: 'image/png' }] } }, 'Synthetic 1px PNG; tap opens the production image lightbox.'],
  ['completed-progress', 'Completed progress', { name: 'report_progress', args: { title: 'Review complete', current: 3, total: 3, status: 'completed' }, result: { title: 'Review complete', current: 3, total: 3, status: 'completed' } }, 'Completion must not look like an active spinner.'],
  ['failed-progress', 'Failed progress', { name: 'report_progress', args: { title: 'Review blocked', current: 1, total: 3, status: 'failed' }, result: { title: 'Review blocked', current: 1, total: 3, status: 'failed', message: 'Browser unavailable.' } }, 'Failure keeps the actual percentage rather than pretending completion.']
]) draw(test, panel(states, id, title, note), id, 'call-first');

const question = panel(states, 'pending-question', 'Question awaiting an answer', 'Interactive locally: answering never posts to a server.');
askUserCard({ callId: 'review-question', ...TOOL_CASES.find(test => test.name === 'ask_user').args,
  multiSelect: false, presets: ['Expanded tools'] }, '/demo/project', 'demo-chat', question.refs, () => {});
const approval = panel(states, 'pending-approval', 'Tool awaiting approval', 'Production authorization card; decisions are handled by the isolated preview server only.');
void authorizationCard({ callId: 'review-approval', tool: 'shell', cmd: 'node --check src/example.js', timeoutMs: 30000 },
  '/demo/project', 'demo-chat', approval.refs, () => {}, { chat: {}, models: [] });

// Deliberately bounded public diagnostics for browser tests and review tools.
window.mockup = { mounted, nativeNames, ready: true };
if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
