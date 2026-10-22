// Long-running agent mockup — an interactive review harness.
//
// The chat view uses the production stylesheet and the production transcript
// renderers (bubbles and tool cards). Only the run surface itself — the
// long-running agent card and the run designer — is mockup-local: it is a
// proposal, not a shipped feature, so it has no production renderer yet.
//
// Nothing here talks to an app API, a provider, a tool runner or a settings
// store. Every run is a local simulation with synthetic data.

import { appendMessageToTranscript, appendToolCallCard, appendToolResultCard } from '../../frontend/src/components/chat/transcript.js';

const transcriptEl = document.querySelector('#transcript');
const designerEl = document.querySelector('#designer');
const scrimEl = document.querySelector('#scrim');
const statusEl = document.querySelector('#status-line');
const openBtn = document.querySelector('#open-designer');
const speedEl = document.querySelector('#speed');
const resetBtn = document.querySelector('#reset');
const usageContext = document.querySelector('#usage-context');
const usageTotal = document.querySelector('#usage-total');

// ---- The refs bag the production renderers write into -----------------

const refs = {
  transcript: { current: transcriptEl },
  pinnedToBottom: { current: true },
  pendingCount: { current: 0 },
  jumpBtn: { current: null },
  status: { current: statusEl },
  usageSummary: { current: null },
  _suspendScrollPin: false,
  _insertAnchor: null
};
const state = { chat: { modelId: 'demo-model', title: 'Long-running refactor' } };

// ---- Model of a run ---------------------------------------------------

// The presets are the shapes a long-running agent run can take. A preset is
// a step list plus the budget and autonomy defaults that go with it.
const PRESETS = {
  refactor: {
    label: 'Refactor',
    budget: 40,
    autonomy: 'guarded',
    steps: [
      { title: 'Map the affected modules', tool: 'search_files', args: { query: 'export function', path: 'src', include: '*.js' } },
      { title: 'Read the current implementation', tool: 'read_file', args: { path: 'src/example.js', startLine: 1, endLine: 40 } },
      { title: 'Rewrite the module', tool: 'edit_file', args: { path: 'src/example.js', oldText: '3000', newText: '5732' } },
      { title: 'Run the tests', tool: 'shell', args: { cmd: 'node --check src/example.js', shell: '/bin/bash' } },
      { title: 'Update the docs', tool: 'write_file', args: { path: 'docs/features/example.md', content: '# Example\n' } },
      { title: 'Summarise the change', tool: null, args: null }
    ]
  },
  investigate: {
    label: 'Investigate',
    budget: 20,
    autonomy: 'guarded',
    steps: [
      { title: 'Reproduce the failure', tool: 'shell', args: { cmd: 'npm test --silent', shell: '/bin/bash' } },
      { title: 'Inspect the failing module', tool: 'read_file', args: { path: 'src/example.js', startLine: 1, endLine: 60 } },
      { title: 'Search for related code', tool: 'search_files', args: { query: 'TODO', path: 'src', include: '*.js' } },
      { title: 'Write the findings', tool: null, args: null }
    ]
  },
  audit: {
    label: 'Audit',
    budget: 15,
    autonomy: 'read-only',
    steps: [
      { title: 'List the project files', tool: 'list_files', args: { pattern: 'src/**/*.js' } },
      { title: 'Read the entry point', tool: 'read_file', args: { path: 'src/index.js', startLine: 1, endLine: 40 } },
      { title: 'Report the audit', tool: null, args: null }
    ]
  }
};

const AUTONOMY = {
  'read-only': { label: 'Read-only', hint: 'The run may read and search, but never writes. Every write asks first.' },
  'guarded': { label: 'Guarded', hint: 'Writes are proposed and applied one step at a time; a risky step waits for you.' },
  'auto': { label: 'Autonomous', hint: 'The run applies its own steps until the budget is spent. You can stop it at any time.' }
};

const AGENTS = ['reviewer', 'builder', 'verifier'];

// ---- The designer form ------------------------------------------------

let designerMode = 'create';   // 'create' | 'tweak'
let draft = null;               // the run being designed / tweaked

function newDraft() {
  const preset = PRESETS.refactor;
  return {
    name: 'Long-running refactor',
    goal: 'Split the chat renderer into per-tool modules and keep every card behaviour identical.',
    preset: 'refactor',
    steps: preset.steps.map(step => ({ ...step })),
    budget: preset.budget,
    autonomy: preset.autonomy,
    agent: 'reviewer',
    model: 'demo-model',
    instruction: ''
  };
}

function field(label, control, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'lra-field';
  const lab = document.createElement('label');
  lab.textContent = label;
  if (control.id) lab.setAttribute('for', control.id);
  wrap.appendChild(lab);
  wrap.appendChild(control);
  if (hint) {
    const h = document.createElement('p');
    h.className = 'lra-field__hint';
    h.textContent = hint;
    wrap.appendChild(h);
  }
  return wrap;
}

function textInput(id, value, placeholder) {
  const el = document.createElement('input');
  el.id = id;
  el.type = 'text';
  el.value = value == null ? '' : value;
  el.placeholder = placeholder || '';
  el.addEventListener('input', () => { draft.name = el.value; renderSummary(); });
  return el;
}

function textArea(id, value, placeholder, onInput) {
  const el = document.createElement('textarea');
  el.id = id;
  el.value = value == null ? '' : value;
  el.placeholder = placeholder || '';
  el.addEventListener('input', () => { onInput(el.value); renderSummary(); });
  return el;
}

function select(id, options, value, onChange) {
  const el = document.createElement('select');
  el.id = id;
  for (const opt of options) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === value) option.selected = true;
    el.appendChild(option);
  }
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function chipRow(name, options, value, onPick) {
  const row = document.createElement('div');
  row.className = 'lra-chips';
  row.setAttribute('role', 'group');
  for (const opt of options) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'lra-chip';
    chip.textContent = opt.label;
    chip.setAttribute('aria-pressed', String(opt.value === value));
    chip.addEventListener('click', () => {
      for (const other of row.querySelectorAll('.lra-chip')) other.setAttribute('aria-pressed', 'false');
      chip.setAttribute('aria-pressed', 'true');
      onPick(opt.value);
    });
    row.appendChild(chip);
  }
  return row;
}

function radioChoices(name, options, value, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'lra-choices';
  for (const opt of options) {
    const label = document.createElement('label');
    label.className = 'lra-choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = opt.value;
    if (opt.value === value) input.checked = true;
    input.addEventListener('change', () => onPick(opt.value));
    const text = document.createElement('span');
    text.className = 'lra-choice-text';
    const title = document.createElement('span');
    title.className = 'lra-choice-title';
    title.textContent = opt.label;
    const desc = document.createElement('span');
    desc.className = 'lra-choice-desc';
    desc.textContent = opt.desc;
    text.appendChild(title);
    text.appendChild(desc);
    label.appendChild(input);
    label.appendChild(text);
    wrap.appendChild(label);
  }
  return wrap;
}

function renderDesigner() {
  designerEl.replaceChildren();
  const form = document.createElement('div');
  form.className = 'lra-form';

  const head = document.createElement('div');
  head.className = 'lra-form__head';
  const title = document.createElement('span');
  title.className = 'lra-form__title';
  title.textContent = designerMode === 'create' ? 'New long-running run' : 'Tweak the running agent';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lra-form__close';
  close.textContent = 'Close';
  close.addEventListener('click', closeDesigner);
  head.appendChild(title);
  head.appendChild(close);
  form.appendChild(head);

  const body = document.createElement('div');
  body.className = 'lra-form__body';

  if (designerMode === 'create') {
    body.appendChild(field('Run name', textInput('lra-name', draft.name, 'What this run is called')));
    body.appendChild(field('Goal', textArea('lra-goal', draft.goal, 'What the agent must achieve', value => { draft.goal = value; }),
    'The agent plans its own steps from this goal, then reports each one as it lands.'));

    const presetChips = chipRow('lra-preset', Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })), draft.preset, value => {
      draft.preset = value;
      const preset = PRESETS[value];
      draft.steps = preset.steps.map(step => ({ ...step }));
      draft.budget = preset.budget;
      draft.autonomy = preset.autonomy;
      renderDesigner();
    });
    body.appendChild(field('Plan template', presetChips, 'The starting step list. The agent may add or drop steps as it learns.'));

    const budgetInput = document.createElement('input');
    budgetInput.id = 'lra-budget';
    budgetInput.type = 'number';
    budgetInput.min = '1';
    budgetInput.max = '200';
    budgetInput.value = String(draft.budget);
    budgetInput.addEventListener('input', () => { draft.budget = Number(budgetInput.value) || draft.budget; renderSummary(); });
    body.appendChild(field('Turn budget', budgetInput, 'How many agent turns the run may spend before it stops on its own.'));

    const autonomyField = radioChoices('lra-autonomy', Object.entries(AUTONOMY).map(([value, a]) => ({ value, label: a.label, desc: a.hint })), draft.autonomy, value => {
      draft.autonomy = value;
      renderSummary();
    });
    body.appendChild(field('Autonomy', autonomyField));

    const agentSelect = select('lra-agent', AGENTS.map(a => ({ value: a, label: a })), draft.agent, value => { draft.agent = value; renderSummary(); });
    body.appendChild(field('Agent', agentSelect, 'The stored persona the run delegates to.'));

    const modelSelect = select('lra-model', [
      { value: 'demo-model', label: 'demo-model' },
      { value: 'demo-fast', label: 'demo-fast' },
      { value: 'demo-cheap', label: 'demo-cheap' }
    ], draft.model, value => { draft.model = value; renderSummary(); });
    body.appendChild(field('Model', modelSelect));
  } else {
    // Tweak mode: only the fields that may change on a live run.
    body.appendChild(field('Agent', select('lra-agent', AGENTS.map(a => ({ value: a, label: a })), draft.agent, value => { draft.agent = value; renderSummary(); }),
      'The agent answers the next turn with this persona.'));
    body.appendChild(field('Model', select('lra-model', [
      { value: 'demo-model', label: 'demo-model' },
      { value: 'demo-fast', label: 'demo-fast' },
      { value: 'demo-cheap', label: 'demo-cheap' }
    ], draft.model, value => { draft.model = value; renderSummary(); })));
    const budgetInput = document.createElement('input');
    budgetInput.id = 'lra-budget';
    budgetInput.type = 'number';
    budgetInput.min = '1';
    budgetInput.max = '200';
    budgetInput.value = String(draft.budget);
    budgetInput.addEventListener('input', () => { draft.budget = Number(budgetInput.value) || draft.budget; renderSummary(); });
    body.appendChild(field('Turn budget', budgetInput, 'Raising the budget lets the run keep going; lowering it makes it wrap up.'));
    body.appendChild(field('Instruction', textArea('lra-instruction', draft.instruction, 'e.g. skip the docs step and finish with the test output', value => { draft.instruction = value; }),
    'Delivered to the agent at its next turn boundary — it never interrupts a step in flight.'));
  }

  const summary = document.createElement('div');
  summary.className = 'lra-summary';
  summary.id = 'lra-summary';
  body.appendChild(summary);
  form.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'lra-form__foot';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeDesigner);
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'btn btn--primary';
  go.textContent = designerMode === 'create' ? 'Start the run' : 'Apply the tweak';
  go.addEventListener('click', () => {
    if (designerMode === 'create') startRun();
    else applyTweak();
  });
  foot.appendChild(cancel);
  foot.appendChild(go);
  form.appendChild(foot);

  designerEl.appendChild(form);
  renderSummary();
}

function renderSummary() {
  const el = document.querySelector('#lra-summary');
  if (!el || !draft) return;
  const lines = [
    'agent    ' + draft.agent,
    'model    ' + draft.model,
    'budget   ' + draft.budget + ' turns',
    'autonomy ' + AUTONOMY[draft.autonomy].label,
    'steps    ' + draft.steps.length
  ];
  el.textContent = lines.join('\n');
  el.style.whiteSpace = 'pre';
}

function openDesigner(mode) {
  designerMode = mode;
  if (mode === 'create') draft = newDraft();
  else if (run) draft = { ...run.draft, instruction: '' };
  renderDesigner();
  designerEl.dataset.open = '1';
  designerEl.setAttribute('aria-hidden', 'false');
  openBtn.setAttribute('aria-expanded', 'true');
  scrimEl.hidden = false;
}

function closeDesigner() {
  designerEl.dataset.open = '0';
  designerEl.setAttribute('aria-hidden', 'true');
  openBtn.setAttribute('aria-expanded', 'false');
  scrimEl.hidden = true;
}

// ---- The run ----------------------------------------------------------

let run = null;      // the active run
let timer = null;
let tick = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function statusLabel() {
  if (!run) return '';
  if (run.state === 'paused') return 'paused';
  if (run.state === 'done') return 'done';
  if (run.state === 'failed') return 'failed';
  return 'running';
}

function paint() {
  if (!run || !run.card) return;
  const card = run.card;
  // While the run is live its card stays pinned to the bottom of the
  // transcript, the way a running delegated run does in the app: the plan
  // and the progress stay on screen while the tool cards scroll above it.
  // When the run settles the card returns to the chronological slot it was
  // created in — the same anchor-then-restore contract the production
  // renderer uses for a running subagent card.
  if (run.state === 'running' || run.state === 'paused') {
    if (transcriptEl.lastElementChild !== card) transcriptEl.appendChild(card);
  } else {
    restoreRunCardToSlot();
  }
  card.className = 'lra lra--' + statusLabel();
  card.querySelector('.lra__status').textContent = run.state === 'running'
    ? 'step ' + (Math.min(run.stepIndex + 1, run.draft.steps.length)) + '/' + run.draft.steps.length
    : statusLabel();
  const pct = run.draft.steps.length ? Math.round((run.stepIndex / run.draft.steps.length) * 100) : 0;
  card.querySelector('.lra__fill').style.width = pct + '%';
  card.querySelector('.lra__meta').textContent =
    'turns ' + run.turnsUsed + '/' + run.draft.budget
    + ' · $' + run.cost.toFixed(3)
    + ' · ' + elapsedLabel();
  const list = card.querySelector('.lra__steps');
  list.replaceChildren();
  run.draft.steps.forEach((step, index) => {
    const item = el('li', 'lra__step');
    const state = index < run.stepIndex ? 'done' : index === run.stepIndex ? 'running' : 'pending';
    item.dataset.state = state;
    item.appendChild(el('span', 'lra__step-mark', state === 'done' ? '✓' : state === 'running' ? '▸' : '·'));
    item.appendChild(el('span', 'lra__step-text', step.title));
    list.appendChild(item);
  });
  // The action row changes with the run state: a paused run is resumed, a
  // running one is paused. Both are always reachable by tap.
  const actions = card.querySelector('.lra__actions');
  actions.replaceChildren();
  if (run.state === 'running' || run.state === 'paused') {
    actions.appendChild(actionButton(run.state === 'running' ? 'Pause' : 'Resume', 'lra__action', () => togglePause()));
    actions.appendChild(actionButton('Tweak', 'lra__action', () => openDesigner('tweak')));
    if (run.stepIndex < run.draft.steps.length) {
      actions.appendChild(actionButton('Skip step', 'lra__action', () => skipStep()));
    }
    actions.appendChild(actionButton('Stop', 'lra__action lra__action--danger', () => stopRun()));
  } else {
    actions.appendChild(actionButton('Run again', 'lra__action lra__action--primary', () => startRun()));
    actions.appendChild(actionButton('New run', 'lra__action', () => openDesigner('create')));
  }
}

function actionButton(label, className, onClick) {
  const btn = el('button', className, label);
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

// recordRunCardSlot() — remember where the run card was created, so the
// settled card can go back to that exact place in the conversation.
//
// The anchor is the row above the card at creation time. The production
// renderer uses the same trick for a running subagent card
// (`ensureSubagentSlotMarker` / `restoreSubagentCardToSlot` in
// frontend/src/components/chat/transcript.js).
function recordRunCardSlot(card) {
  const host = transcriptEl;
  let prev = null;
  for (const child of host.children) {
    if (child === card) break;
    if (!child.classList.contains('lra')) prev = child;
  }
  card._slotPrev = prev;
  card._slotRecorded = true;
}

// restoreRunCardToSlot() — move the settled card back after its anchor.
function restoreRunCardToSlot() {
  const card = run && run.card;
  if (!card || !card._slotRecorded) return;
  card._slotRecorded = false;
  const prev = card._slotPrev;
  card._slotPrev = null;
  if (!prev || prev.parentNode !== transcriptEl) return;
  const next = prev.nextElementSibling;
  if (next === card) return;
  transcriptEl.insertBefore(card, next);
}

function buildRunCard() {
  const card = el('div', 'lra lra--running');
  card.dataset.runId = 'run-1';

  const head = el('div', 'lra__head');
  head.appendChild(el('span', 'lra__dot'));
  head.appendChild(el('span', 'lra__name', run.draft.name));
  head.appendChild(el('span', 'lra__status', 'running'));
  card.appendChild(head);

  card.appendChild(el('p', 'lra__goal', run.draft.goal));

  const bar = el('div', 'lra__bar');
  bar.appendChild(el('div', 'lra__fill'));
  card.appendChild(bar);

  card.appendChild(el('div', 'lra__meta', ''));
  card.appendChild(el('ul', 'lra__steps'));
  const note = el('p', 'lra__note');
  note.hidden = true;
  card.appendChild(note);
  card.appendChild(el('div', 'lra__actions'));

  transcriptEl.appendChild(card);
  run.card = card;
  run.noteEl = note;
  run.metaEl = card.querySelector('.lra__meta');
  // The card's home is the slot it was created in; the live pin moves it
  // down, and the settle puts it back.
  recordRunCardSlot(card);
  return card;
}

function note(text) {
  if (!run || !run.noteEl) return;
  run.noteEl.hidden = false;
  run.noteEl.replaceChildren();
  const strong = el('b', null, 'You: ');
  run.noteEl.appendChild(strong);
  run.noteEl.appendChild(document.createTextNode(text));
  paint();
}

function startRun() {
  closeDesigner();
  transcriptEl.replaceChildren();
  // The designer always leaves a draft behind; a direct call (the review
  // harness, the "Run again" button) starts from the defaults.
  if (!draft) draft = newDraft();
  const spec = newDraft();
  spec.name = draft.name;
  spec.goal = draft.goal;
  spec.steps = draft.steps.map(step => ({ ...step }));
  spec.budget = draft.budget;
  spec.autonomy = draft.autonomy;
  spec.agent = draft.agent;
  spec.model = draft.model;
  run = {
    draft: spec,
    state: 'running',
    stepIndex: 0,
    turnsUsed: 0,
    cost: 0,
    startedAt: Date.now(),
    elapsed: 0,
    card: null,
    noteEl: null,
    metaEl: null,
    pending: false,
    // A token identifies the run instance: a step that was in flight when
    // the run was replaced must not land its result on the new run.
    token: {},
    pendingInstruction: ''
  };
  // The user's own message, drawn by the production renderer.
  appendMessageToTranscript({ role: 'user', content: spec.goal }, false, refs, state);
  buildRunCard();
  paint();
  statusEl.textContent = 'running agent ' + spec.agent + '…';
  startTimer();
  // The first step lands after a short beat, so the card is seen in its
  // "just started" state before the first tool call.
  setTimeout(() => { if (run && run.state === 'running') advance(); }, 700);
}

function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!run) return;
    if (run.state === 'running') {
      run.elapsed += 250 * Number(speedEl.value);
      run.turnsUsed += 1;
      run.cost += 0.004 * Number(speedEl.value);
      paint();
      if (run.turnsUsed > run.draft.budget) {
        statusEl.textContent = 'run stopped — the turn budget is spent';
        finish('done');
        return;
      }
      if (run.stepIndex < run.draft.steps.length) advance();
    }
  }, 250);
}

function elapsedLabel() {
  const seconds = Math.round(run.elapsed / 1000);
  return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
}

// advance() runs the current step: it paints the tool call, then its result,
// then moves to the next step. The tool cards come from the production
// renderers, so the mockup shows the same cards the app draws.
//
// One step runs at a time: the clock ticks while a step is in flight, and
// `run.pending` keeps it from starting the same step twice.
function advance() {
  if (!run || run.state !== 'running' || run.pending) return;
  const step = run.draft.steps[run.stepIndex];
  if (!step) { finish('done'); return; }

  if (run.pendingInstruction) {
    note(run.pendingInstruction);
    run.pendingInstruction = '';
  }

  if (!step.tool) {
    // A reasoning step: the agent answers in the chat, then the run moves on.
    appendMessageToTranscript({
      role: 'assistant',
      content: 'Step ' + (run.stepIndex + 1) + ' done — ' + step.title + '.',
      modelId: run.draft.model
    }, false, refs, state);
    run.stepIndex += 1;
    paint();
    if (run.stepIndex >= run.draft.steps.length) finish('done');
    return;
  }

  const id = 'mock-' + run.stepIndex + '-' + (run.cardCount = (run.cardCount || 0) + 1);
  const token = run.token;
  run.pending = true;
  appendToolCallCard({ id, name: step.tool, args: step.args }, refs, false);
  setTimeout(() => {
    if (!run || run.token !== token) return;
    appendToolResultCard({
      id,
      name: step.tool,
      ok: true,
      result: { ok: true, stdout: 'done', exitCode: 0, durationMs: 120 }
    }, refs);
    run.pending = false;
    run.stepIndex += 1;
    paint();
    if (run.stepIndex >= run.draft.steps.length) finish('done');
  }, 500 / Number(speedEl.value));
}

function togglePause() {
  if (!run) return;
  if (run.state === 'running') {
    run.state = 'paused';
    statusEl.textContent = 'paused — the agent holds its place';
  } else if (run.state === 'paused') {
    run.state = 'running';
    statusEl.textContent = 'running agent ' + run.draft.agent + '…';
  }
  paint();
}

function skipStep() {
  if (!run) return;
  run.stepIndex += 1;
  if (run.stepIndex >= run.draft.steps.length) { finish('done'); return; }
  paint();
}

function stopRun() {
  if (!run) return;
  finish('failed');
  statusEl.textContent = 'stopped — the run was cancelled';
}

function finish(stateName) {
  if (!run) return;
  run.state = stateName;
  if (stateName === 'done') statusEl.textContent = 'run finished';
  paint();
}

// applyTweak() — the live-tweak path. The change is queued, never applied to
// the step in flight: the run picks it up at its next turn boundary.
function applyTweak() {
  if (!run) return;
  run.draft.agent = draft.agent;
  run.draft.model = draft.model;
  run.draft.budget = draft.budget;
  run.pendingInstruction = draft.instruction
    ? draft.instruction
    : 'Switched to ' + draft.agent + ' on ' + draft.model + ' with a ' + draft.budget + '-turn budget.';
  closeDesigner();
  paint();
  if (run.state === 'running') {
    setTimeout(() => { if (run && run.state === 'running') advance(); }, 300);
  }
}

// ---- Wiring -----------------------------------------------------------

openBtn.addEventListener('click', () => {
  if (designerEl.dataset.open === '1') closeDesigner();
  else openDesigner('create');
});
scrimEl.addEventListener('click', closeDesigner);
resetBtn.addEventListener('click', () => {
  if (timer) clearInterval(timer);
  timer = null;
  run = null;
  draft = null;
  transcriptEl.replaceChildren();
  statusEl.textContent = '';
  usageContext.textContent = 'Context --';
  usageTotal.textContent = 'Total --';
  closeDesigner();
});

document.querySelector('#composer-send').addEventListener('click', () => {
  const input = document.querySelector('#composer');
  const text = input.value.trim();
  if (!text) return;
  appendMessageToTranscript({ role: 'user', content: text }, false, refs, state);
  input.value = '';
  if (run && run.state === 'running') {
    run.pendingInstruction = text;
    note(text);
  }
});

usageContext.textContent = 'Context 12.4K';
usageTotal.textContent = 'Total $0.21';

window.mockup = {
  ready: true,
  openDesigner,
  closeDesigner,
  startRun,
  applyTweak,
  togglePause,
  skipStep,
  stopRun,
  get run() { return run; },
  get draft() { return draft; }
};
