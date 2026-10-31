// mouaif web — Settings → Hooks (docs/features/hooks.md)
//
// Commands that run when a prompt is sent, around each tool call, when a turn
// starts, ends or fails, and before a notification. A hook can block, ask for
// approval, rewrite a tool's arguments, add context for the model, start one
// follow-up turn or silence a notification; it can never approve anything.
// The list is saved as one JSON config through /api/hooks, and the server
// validates every save. Recent runs come from /api/hooks/runs.
import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson, activeProject } from '../api.js';
import './settings/hooks.css';
import { ProjectHooksReview, useProjectHooks, trustLabel } from './settings/ProjectHooksReview.jsx';
import { EVENT_LABELS, TOOL_EVENTS, BLOCKING_EVENTS, ORIGIN_LABELS, FAMILY_LABELS, matchSummary, handlerSummary, RunRow } from './settings/hookText.js';


// Starting points for "New hook". Each is a complete, working hook.
const EXAMPLES = [
  {
    key: 'force-push', label: 'Block force pushes',
    hook: {
      id: 'no-force-push', name: 'Block force pushes', event: 'tool.before',
      match: { tool: ['shell', 'group_cli'], argText: 'git\\s+push\\b.*(--force|\\s-f\\b)' },
      handler: { kind: 'command', shell: 'bash', script: 'echo "Force-pushing is not allowed here. Push without --force." >&2\nexit 2\n' }
    }
  },
  {
    key: 'ask-rm', label: 'Ask before rm -rf',
    hook: {
      id: 'ask-rm-rf', name: 'Ask before rm -rf', event: 'tool.before',
      match: { tool: ['shell', 'group_cli'], argText: 'rm\\s+-[a-z]*r[a-z]*f' },
      handler: { kind: 'command', shell: 'bash', script: 'echo \'{"decision":"ask","reason":"This deletes files recursively."}\'\n' }
    }
  },
  {
    key: 'branch', label: 'Add the git branch to prompts',
    hook: {
      id: 'git-branch', name: 'Git branch', event: 'prompt.submit',
      handler: { kind: 'command', shell: 'bash', script: 'branch=$(git branch --show-current 2>/dev/null) || exit 0\n[ -n "$branch" ] && echo "Current git branch: $branch"\n' }
    }
  },
  {
    key: 'tests', label: 'Keep going until the tests pass',
    hook: {
      id: 'tests-pass', name: 'Tests must pass', event: 'turn.end', timeoutMs: 60000,
      handler: { kind: 'command', shell: 'bash', script: 'npm test --silent >/dev/null 2>&1 && exit 0\necho \'{"followUp":"npm test fails. Fix it before finishing."}\'\n' }
    }
  },
  {
    key: 'night', label: 'No notifications at night',
    hook: {
      id: 'quiet-night', name: 'Quiet at night', event: 'attention',
      handler: { kind: 'command', shell: 'bash', script: 'hour=$(date +%H)\nif [ "$hour" -ge 22 ] || [ "$hour" -lt 7 ]; then echo \'{"suppress":true}\'; fi\n' }
    }
  },
  {
    key: 'log', label: 'Log every tool call',
    hook: {
      id: 'tool-log', name: 'Tool log', event: 'tool.after',
      handler: { kind: 'command', shell: 'node', script: "let s = '';\nprocess.stdin.on('data', (d) => { s += d; }).on('end', () => {\n  const e = JSON.parse(s);\n  require('fs').appendFileSync(require('os').homedir() + '/.mouaif/tool-log.jsonl',\n    JSON.stringify({ at: new Date().toISOString(), chat: e.chatId, tool: e.tool, ok: e.ok }) + '\\n');\n});\n" }
    }
  }
];

const BLANK = { id: '', name: '', event: 'tool.before', handler: { kind: 'command', command: '' } };
const MODULE_TEMPLATE = 'export default async (event, ctx) => {\n  // ctx.log(...) and ctx.match(regex, text) are available; nothing else.\n  // Return nothing to carry on, a string to add context,\n  // or { decision: "block", reason: "…" }.\n};\n';
const SEND_LABELS = { args: 'Tool arguments', result: 'Tool results', content: 'Prompts', text: 'Answers' };

function uniqueId(base, list) {
  const ids = new Set(list.map((x) => x.id));
  if (!ids.has(base)) return base;
  for (let i = 2; ; i++) if (!ids.has(base + '-' + i)) return base + '-' + i;
}

// The editor works on flat text fields; these convert to and from a hook.
function toForm(hook) {
  const m = hook.match || {};
  const handler = hook.handler || {};
  return {
    id: hook.id || '',
    name: hook.name || '',
    event: hook.event || 'tool.before',
    enabled: hook.enabled !== false,
    tools: (m.tool || []).join(', '),
    family: m.family || [],
    argText: m.argText || '',
    origin: m.origin || [],
    mode: handler.kind === 'http' ? 'http' : handler.kind === 'module' ? 'module' : handler.script ? 'script' : 'command',
    command: handler.command || '',
    shell: handler.shell || 'bash',
    script: handler.script || '',
    url: handler.url || '',
    secret: handler.secret || '',
    send: handler.send || [],
    source: handler.source || MODULE_TEMPLATE,
    timeoutMs: String(hook.timeoutMs || 5000),
    failClosed: !!hook.failClosed,
    subagents: !!hook.subagents,
    // Not edited here, but kept on save.
    createdBy: hook.createdBy || '',
    note: hook.note || ''
  };
}

function fromForm(f) {
  const hook = { id: f.id.trim(), event: f.event, enabled: f.enabled };
  if (f.name.trim()) hook.name = f.name.trim();
  const match = {};
  const tools = f.tools.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  if (TOOL_EVENTS.includes(f.event)) {
    if (tools.length) match.tool = tools;
    if (f.family.length) match.family = f.family;
    if (f.argText.trim()) match.argText = f.argText.trim();
  }
  if (f.origin.length) match.origin = f.origin;
  if (Object.keys(match).length) hook.match = match;
  if (f.mode === 'http') {
    hook.handler = { kind: 'http', url: f.url.trim() };
    if (f.secret) hook.handler.secret = f.secret;
    if (f.send.length) hook.handler.send = f.send;
  } else if (f.mode === 'module') {
    hook.handler = { kind: 'module', source: f.source };
  } else {
    hook.handler = f.mode === 'script'
      ? { kind: 'command', shell: f.shell, script: f.script }
      : { kind: 'command', command: f.command };
  }
  const timeout = Number(f.timeoutMs);
  if (Number.isFinite(timeout) && timeout > 0) hook.timeoutMs = timeout;
  if (f.failClosed && BLOCKING_EVENTS.includes(f.event)) hook.failClosed = true;
  if (f.subagents && TOOL_EVENTS.includes(f.event)) hook.subagents = true;
  if (f.createdBy === 'model') hook.createdBy = 'model';
  if (f.note) hook.note = f.note;
  return hook;
}

function Switch({ id, checked, onChange, label }) {
  return h('label', { class: 'switch', title: label },
    h('input', { id, type: 'checkbox', role: 'switch', 'aria-checked': String(checked), 'aria-label': label, checked, onChange: (e) => onChange(e.currentTarget.checked) }),
    h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' }))
  );
}

async function api(method, url, body) {
  const r = await fetchJson(url, body === undefined ? { method } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (r.status !== 200) throw new Error((r.body && r.body.error) || 'HTTP ' + r.status);
  return r.body;
}

// The sample event Test sends, shaped like the real one for each event.
function samplePayload(hook) {
  switch (hook.event) {
    case 'prompt.submit': return { content: 'Test prompt from Settings', attachments: 0 };
    case 'turn.start': return { model: 'test-model', provider: 'test', thinkingLevel: '' };
    case 'turn.end': return { text: 'Test answer from Settings.', usage: null, cost: null, toolCount: 1, followUpDepth: 0 };
    case 'turn.error': return { code: 'EUPSTREAM', message: 'Test error from Settings', stopped: false };
    case 'attention': return { kind: 'tool_authorization', tool: 'shell' };
    default: {
      const tool = (hook.match && hook.match.tool && hook.match.tool[0] && !hook.match.tool[0].includes('*')) ? hook.match.tool[0] : 'shell';
      return { tool, args: { cmd: 'echo test' }, ...(hook.event === 'tool.after' ? { ok: true, result: { stdout: 'test\n', exitCode: 0 } } : {}) };
    }
  }
}

export function HookEditor({ initial, isNew, onSave, onCancel, onDelete, projectDir }) {
  const [f, setF] = useState(() => toForm(initial));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (patch) => setF((prev) => Object.assign({}, prev, patch));
  const idBase = 'hook-edit-' + (initial.id || 'new');

  async function save() {
    setBusy(true); setError('');
    try { await onSave(fromForm(f)); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function runTest() {
    setBusy(true); setTest(null); setError('');
    const hook = fromForm(f);
    if (!hook.id) hook.id = 'test';
    const payload = samplePayload(hook);
    try { setTest(await api('POST', '/api/hooks/test', { hook, payload, projectDir })); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  return h('div', { class: 'hook-edit' },
    h('div', { class: 'row' },
      h('label', { class: 'label', for: idBase + '-name' }, 'Name'),
      h('input', { id: idBase + '-name', class: 'input', value: f.name, maxLength: 80, placeholder: 'Block force pushes', onInput: (e) => set({ name: e.currentTarget.value }) })
    ),
    h('div', { class: 'row' },
      h('label', { class: 'label', for: idBase + '-id' }, 'ID'),
      h('input', { id: idBase + '-id', class: 'input', value: f.id, maxLength: 40, autocapitalize: 'off', spellcheck: false, placeholder: 'no-force-push', onInput: (e) => set({ id: e.currentTarget.value }) }),
      h('p', { class: 'hint hint--compact' }, 'Lowercase letters, digits, - and _. Shown on tool cards.')
    ),
    h('div', { class: 'row' },
      h('label', { class: 'label', for: idBase + '-event' }, 'When'),
      h('select', { id: idBase + '-event', class: 'input', value: f.event, onChange: (e) => set({ event: e.currentTarget.value }) },
        Object.entries(EVENT_LABELS).map(([key, text]) => h('option', { key, value: key }, text + ' (' + key + ')')))
    ),
    TOOL_EVENTS.includes(f.event) ? h(Fragment, null,
      h('div', { class: 'row' },
        h('label', { class: 'label', for: idBase + '-tools' }, 'Tools'),
        h('input', { id: idBase + '-tools', class: 'input', value: f.tools, autocapitalize: 'off', spellcheck: false, placeholder: 'shell, group_cli, mcp__github__*', onInput: (e) => set({ tools: e.currentTarget.value }) }),
        h('p', { class: 'hint hint--compact' }, 'Comma-separated; * matches anything. Empty = every tool.')
      ),
      h('div', { class: 'row' },
        h('span', { class: 'label' }, 'Tool groups'),
        h('div', { class: 'hook-checks' },
          Object.entries(FAMILY_LABELS).map(([key, text]) => h('label', { key, class: 'hook-check' },
            h('input', { type: 'checkbox', checked: f.family.includes(key), onChange: (e) => set({ family: e.currentTarget.checked ? f.family.concat(key) : f.family.filter((x) => x !== key) }) }),
            h('span', null, text)))),
        h('p', { class: 'hint hint--compact' }, 'The groups of Settings → Project → Tools. None ticked = every group. With tool names too, a call must match both.')
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: idBase + '-arg' }, 'Arguments match'),
        h('input', { id: idBase + '-arg', class: 'input hook-mono', value: f.argText, autocapitalize: 'off', spellcheck: false, placeholder: 'git\\s+push.*--force', onInput: (e) => set({ argText: e.currentTarget.value }) }),
        h('p', { class: 'hint hint--compact' }, 'A regular expression searched in the call\'s arguments as JSON. Empty = any arguments.')
      )
    ) : null,
    h('div', { class: 'row' },
      h('span', { class: 'label' }, 'Sent by'),
      h('div', { class: 'hook-checks' },
        Object.entries(ORIGIN_LABELS).map(([key, text]) => h('label', { key, class: 'hook-check' },
          h('input', { type: 'checkbox', checked: f.origin.includes(key), onChange: (e) => set({ origin: e.currentTarget.checked ? f.origin.concat(key) : f.origin.filter((o) => o !== key) }) }),
          h('span', null, text)))),
      h('p', { class: 'hint hint--compact' }, 'Who sent the prompt of the turn. Hook follow-up = a turn a "Turn finished" hook started. None ticked = everyone.')
    ),
    h('div', { class: 'row' },
      h('span', { class: 'label' }, 'Runs'),
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Handler' },
        [['command', 'Command'], ['script', 'Script'], ['http', 'URL'], ['module', 'Module']].map(([key, text]) => h('label', { key, class: 'seg__item' + (f.mode === key ? ' seg__item--on' : '') },
          h('input', { type: 'radio', name: idBase + '-mode', value: key, checked: f.mode === key, onChange: () => set({ mode: key }) }),
          h('span', { class: 'seg__pill' }, text))))
    ),
    f.mode === 'http'
      ? h('div', { class: 'row' },
          h('input', { class: 'input hook-mono', 'aria-label': 'URL', type: 'url', value: f.url, autocapitalize: 'off', spellcheck: false, placeholder: 'https://example.com/mouaif-hook', onInput: (e) => set({ url: e.currentTarget.value }) }),
          h('input', { class: 'input hook-mono', 'aria-label': 'Signing secret (optional)', type: 'password', autocomplete: 'off', value: f.secret, placeholder: 'Signing secret (optional)', onInput: (e) => set({ secret: e.currentTarget.value }) }),
          h('span', { class: 'label' }, 'Also send'),
          h('div', { class: 'hook-checks' },
            Object.entries(SEND_LABELS).map(([key, text]) => h('label', { key, class: 'hook-check' },
              h('input', { type: 'checkbox', checked: f.send.includes(key), onChange: (e) => set({ send: e.currentTarget.checked ? f.send.concat(key) : f.send.filter((x) => x !== key) }) }),
              h('span', null, text)))),
          h('p', { class: 'hint hint--compact' }, 'mouaif POSTs the event as JSON and reads the decision from the reply. Arguments, results, prompts and answers stay on this computer unless ticked. With a secret, the body is signed in X-Mouaif-Signature (sha256 HMAC).')
        )
      : f.mode === 'module'
      ? h('div', { class: 'row' },
          h('textarea', { class: 'input hook-mono hook-script', rows: 10, 'aria-label': 'Module source', value: f.source, spellcheck: false, autocapitalize: 'off', onInput: (e) => set({ source: e.currentTarget.value }) }),
          h('p', { class: 'hint hint--compact' }, 'Runs inside mouaif in a worker, without starting a process: good for a check on every tool call. It gets the event and ctx.log / ctx.match only (no require, files or network).')
        )
      : f.mode === 'command'
      ? h('div', { class: 'row' },
          h('input', { class: 'input hook-mono', 'aria-label': 'Command', value: f.command, autocapitalize: 'off', spellcheck: false, placeholder: './scripts/check-tool.sh', onInput: (e) => set({ command: e.currentTarget.value }) }),
          h('p', { class: 'hint hint--compact' }, 'Runs in the chat\'s working folder with the event as JSON on stdin.')
        )
      : h('div', { class: 'row' },
          h('select', { class: 'input', 'aria-label': 'Interpreter', value: f.shell, onChange: (e) => set({ shell: e.currentTarget.value }) },
            ['bash', 'sh', 'node', 'python3'].map((s) => h('option', { key: s, value: s }, s))),
          h('textarea', { class: 'input hook-mono hook-script', rows: 8, 'aria-label': 'Script', value: f.script, spellcheck: false, autocapitalize: 'off', onInput: (e) => set({ script: e.currentTarget.value }) })
        ),
    h('div', { class: 'row' },
      h('label', { class: 'label', for: idBase + '-timeout' }, 'Timeout (ms)'),
      h('input', { id: idBase + '-timeout', class: 'input', type: 'number', inputMode: 'numeric', min: 500, max: 60000, step: 500, value: f.timeoutMs, onInput: (e) => set({ timeoutMs: e.currentTarget.value }) })
    ),
    BLOCKING_EVENTS.includes(f.event) ? h('label', { class: 'hook-check hook-check--row' },
      h('input', { type: 'checkbox', checked: f.failClosed, onChange: (e) => set({ failClosed: e.currentTarget.checked }) }),
      h('span', null, 'Block when the hook fails or times out (otherwise the turn goes on)')) : null,
    TOOL_EVENTS.includes(f.event) ? h('label', { class: 'hook-check hook-check--row' },
      h('input', { type: 'checkbox', checked: f.subagents, onChange: (e) => set({ subagents: e.currentTarget.checked }) }),
      h('span', null, 'Also run for subagents\' tool calls')) : null,
    error ? h('p', { class: 'status', 'data-state': 'error', role: 'alert' }, error) : null,
    test ? h('div', { class: 'hook-test', role: 'status' },
      h('div', { class: 'hook-test__head' },
        h('strong', null, 'Test: ' + test.parsed.decision),
        h('span', null, ' · exit ' + test.code + ' · ' + test.ms + ' ms' + (test.timedOut ? ' · timed out' : ''))),
      test.parsed.reason ? h('p', null, 'Reason: ' + test.parsed.reason) : null,
      test.parsed.error ? h('p', null, 'Error: ' + test.parsed.error) : null,
      test.parsed.context ? h('pre', { class: 'hook-mono' }, 'Context: ' + test.parsed.context) : null,
      test.parsed.updatedArgs ? h('pre', { class: 'hook-mono' }, 'New arguments: ' + JSON.stringify(test.parsed.updatedArgs)) : null,
      test.parsed.followUp ? h('pre', { class: 'hook-mono' }, 'Follow-up turn: ' + test.parsed.followUp) : null,
      test.parsed.suppress ? h('p', null, 'Would silence the notification.') : null,
      test.stderr ? h('pre', { class: 'hook-mono' }, 'stderr: ' + test.stderr) : null
    ) : null,
    h('div', { class: 'hook-edit__bar' },
      h('button', { type: 'button', class: 'btn btn--primary', disabled: busy, onClick: save }, isNew ? 'Add hook' : 'Save'),
      h('button', { type: 'button', class: 'btn', disabled: busy, onClick: runTest }, 'Test'),
      h('button', { type: 'button', class: 'btn', disabled: busy, onClick: onCancel }, 'Cancel'),
      !isNew ? h('button', {
        type: 'button', class: 'btn btn--danger', disabled: busy,
        onClick: () => { if (confirmDelete) onDelete(); else setConfirmDelete(true); }
      }, confirmDelete ? 'Tap again to delete' : 'Delete') : null
    ),
    h('p', { class: 'hint hint--compact' }, 'Test runs the hook once with a sample event. Nothing in a chat changes.')
  );
}

export function SettingsHooksView() {
  const [config, setConfig] = useState(null);
  const [editing, setEditing] = useState(null); // { id, hook, isNew }
  const [status, setStatus] = useState({ text: '', kind: '' });
  const [json, setJson] = useState(null);
  const [runs, setRuns] = useState(null);
  const projectDir = (activeProject.value && activeProject.value.dir) || '';
  const projectName = (activeProject.value && activeProject.value.name) || '';
  const [projectHooks, setProjectHooks] = useProjectHooks(projectDir);

  useEffect(() => {
    api('GET', '/api/hooks').then(setConfig, (e) => setStatus({ text: 'Could not load hooks: ' + e.message, kind: 'error' }));
  }, []);

  function loadRuns() {
    api('GET', '/api/hooks/runs?limit=50').then((r) => setRuns(r.runs || []), () => setRuns([]));
  }
  useEffect(loadRuns, []);

  async function save(next, message) {
    const saved = await api('PUT', '/api/hooks', { enabled: next.enabled, list: next.list });
    setConfig(saved);
    setStatus({ text: message || 'Saved', kind: 'ok' });
    return saved;
  }

  async function quiet(next, message) {
    try { await save(next, message); }
    catch (e) { setStatus({ text: e.message, kind: 'error' }); }
  }

  function startNew(example) {
    const list = config ? config.list : [];
    const base = example ? JSON.parse(JSON.stringify(example.hook)) : JSON.parse(JSON.stringify(BLANK));
    if (base.id) base.id = uniqueId(base.id, list);
    setEditing({ id: '', hook: base, isNew: true });
  }

  async function saveHook(hook) {
    const list = config.list.slice();
    const at = editing.isNew ? -1 : list.findIndex((x) => x.id === editing.id);
    if (at >= 0) list[at] = hook; else list.push(hook);
    await save({ enabled: config.enabled, list }, editing.isNew ? 'Hook added' : 'Hook saved');
    setEditing(null);
  }

  async function removeHook(id) {
    await quiet({ enabled: config.enabled, list: config.list.filter((x) => x.id !== id) }, 'Hook deleted');
    setEditing(null);
  }

  function move(index, delta) {
    const list = config.list.slice();
    const [item] = list.splice(index, 1);
    list.splice(index + delta, 0, item);
    quiet({ enabled: config.enabled, list }, 'Order saved');
  }

  async function applyJson() {
    let parsed;
    try { parsed = JSON.parse(json); } catch (e) { setStatus({ text: 'Not valid JSON: ' + e.message, kind: 'error' }); return; }
    const next = Array.isArray(parsed) ? { enabled: config.enabled, list: parsed } : parsed;
    try { await save(next, 'Hooks replaced from JSON'); setJson(null); }
    catch (e) { setStatus({ text: e.message, kind: 'error' }); }
  }

  function download() {
    const body = JSON.stringify({ mouaifHooks: 1, enabled: config.enabled, list: config.list }, null, 2) + '\n';
    const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'mouaif-hooks.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const list = config ? config.list : [];

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Hooks')
    ),
    h('section', { class: 'settings-hooks' },
      h('p', { class: 'hint settings-hooks__intro' },
        'Hooks are commands mouaif runs when you send a prompt, before and after each tool call, when a turn starts, finishes or fails, and before a notification. A hook can block a call, ask you to approve it, change its arguments, add context for the model, start one more turn or silence a notification. A hook can never approve a call. They run on this computer with your permissions.'),
      config && config.disabledByEnv ? h('div', { class: 'settings-hooks__notice', role: 'status' },
        h('strong', null, 'Hooks are off'), ' — mouaif was started with MOUAIF_NO_HOOKS=1.') : null,

      h('div', { class: 'group' },
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-hooks__master' },
            h('div', { class: 'settings-hooks__master-main' },
              h('label', { class: 'settings-hooks__title', for: 'hooks-enabled' }, 'Run hooks'),
              h('div', { class: 'settings-hooks__note' }, 'Turn off to pause every hook without deleting them.')),
            config ? h(Switch, { id: 'hooks-enabled', label: 'Run hooks', checked: config.enabled, onChange: (on) => quiet({ enabled: on, list }, on ? 'Hooks on' : 'Hooks paused') }) : null
          )
        )
      ),

      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Hooks', h('span', { class: 'group__title-note' }, 'run in this order')),
        !config ? h('p', { class: 'hint hint--compact' }, 'Loading…') : null,
        config && !list.length && !(editing && editing.isNew) ? h('p', { class: 'hint hint--compact' }, 'No hooks yet. Start from an example below.') : null,
        list.length ? h('ul', { class: 'hook-list' },
          list.map((hook, index) => h('li', { key: hook.id, class: 'hook-card' + (hook.enabled ? '' : ' hook-card--off') },
            h('div', { class: 'hook-card__row' },
              h('div', { class: 'hook-card__main' },
                h('div', { class: 'hook-card__title' }, hook.name || hook.id),
                h('div', { class: 'hook-card__meta' },
                  h('span', { class: 'hook-chip' }, EVENT_LABELS[hook.event] || hook.event),
                  h('span', null, matchSummary(hook)),
                  hook.failClosed ? h('span', { class: 'hook-chip hook-chip--warn' }, 'blocks on failure') : null,
                  hook.createdBy === 'model' ? h('span', { class: 'hook-chip' }, 'added by the model') : null),
                hook.note ? h('div', { class: 'hook-card__note' }, hook.note) : null,
                h('code', { class: 'hook-card__cmd' }, handlerSummary(hook))
              ),
              h(Switch, { id: 'hook-on-' + hook.id, label: (hook.enabled ? 'Turn off ' : 'Turn on ') + (hook.name || hook.id), checked: hook.enabled,
                onChange: (on) => quiet({ enabled: config.enabled, list: list.map((x) => (x.id === hook.id ? Object.assign({}, x, { enabled: on }) : x)) }, on ? 'Hook on' : 'Hook off') })
            ),
            editing && !editing.isNew && editing.id === hook.id
              ? h(HookEditor, { key: 'edit-' + hook.id, initial: hook, isNew: false, projectDir, onSave: saveHook, onCancel: () => setEditing(null), onDelete: () => removeHook(hook.id) })
              : h('div', { class: 'hook-card__actions' },
                  h('button', { type: 'button', class: 'btn', onClick: () => setEditing({ id: hook.id, hook, isNew: false }) }, 'Edit'),
                  h('button', { type: 'button', class: 'btn', disabled: index === 0, 'aria-label': 'Move up', onClick: () => move(index, -1) }, '↑'),
                  h('button', { type: 'button', class: 'btn', disabled: index === list.length - 1, 'aria-label': 'Move down', onClick: () => move(index, 1) }, '↓'))
          ))
        ) : null,
        editing && editing.isNew ? h('div', { class: 'hook-card hook-card--new' },
          h('div', { class: 'hook-card__title' }, 'New hook'),
          h(HookEditor, { key: 'new-' + editing.hook.id, initial: editing.hook, isNew: true, projectDir, onSave: saveHook, onCancel: () => setEditing(null) })
        ) : null,
        config && !editing ? h('div', { class: 'settings-hooks__actions' },
          h('button', { type: 'button', class: 'btn btn--primary', onClick: () => startNew(null) }, 'New hook'),
          h('select', { class: 'input settings-hooks__examples', 'aria-label': 'Start from an example', value: '',
            onChange: (e) => { const ex = EXAMPLES.find((x) => x.key === e.currentTarget.value); e.currentTarget.value = ''; if (ex) startNew(ex); } },
            h('option', { value: '' }, 'Start from an example…'),
            EXAMPLES.map((ex) => h('option', { key: ex.key, value: ex.key }, ex.label)))
        ) : null
      ),

      config ? h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'JSON', h('span', { class: 'group__title-note' }, 'export, import, edit all')),
        json === null
          ? h('div', { class: 'settings-hooks__actions' },
              h('button', { type: 'button', class: 'btn', onClick: () => setJson(JSON.stringify(list, null, 2)) }, 'Edit as JSON'),
              h('button', { type: 'button', class: 'btn', onClick: download, disabled: !list.length }, 'Download'))
          : h('div', { class: 'row' },
              h('textarea', { class: 'input hook-mono hook-script', rows: 14, 'aria-label': 'Hooks JSON', value: json, spellcheck: false, autocapitalize: 'off', onInput: (e) => setJson(e.currentTarget.value) }),
              h('p', { class: 'hint hint--compact' }, 'A list of hooks, or a downloaded hooks file. Apply replaces every hook.'),
              h('div', { class: 'settings-hooks__actions settings-hooks__actions--flush' },
                h('button', { type: 'button', class: 'btn btn--primary', onClick: applyJson }, 'Apply'),
                h('button', { type: 'button', class: 'btn', onClick: () => setJson(null) }, 'Cancel')))
      ) : null,

      h('p', { class: 'status', 'data-state': status.kind, 'aria-live': 'polite' }, status.text),

      projectDir ? h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'This project', h('span', { class: 'group__title-note' },
          (projectName || projectDir) + (projectHooks && projectHooks.hash ? ' · ' + trustLabel(projectHooks) : ''))),
        h(ProjectHooksReview, { projectDir, state: projectHooks, onState: setProjectHooks })) : null,

      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Recent runs', h('span', { class: 'group__title-note' }, 'last 50, newest first')),
        runs === null ? h('p', { class: 'hint hint--compact' }, 'Loading…') : null,
        runs && !runs.length ? h('p', { class: 'hint hint--compact' }, 'No hook has run yet.') : null,
        runs && runs.length ? h('ul', { class: 'hook-runs' },
          runs.map((run) => h(RunRow, { key: run.id, run }))) : null,
        h('div', { class: 'settings-hooks__actions' },
          h('button', { type: 'button', class: 'btn', onClick: loadRuns }, 'Refresh'))
      ),

      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'How a hook answers'),
        h('ul', { class: 'settings-hooks__help' },
          h('li', null, h('strong', null, 'Exit 0, no output'), ': carry on.'),
          h('li', null, h('strong', null, 'Exit 0, plain text'), ': the text goes to the model as context.'),
          h('li', null, h('strong', null, 'Exit 2'), ': block. stderr is the reason the model sees.'),
          h('li', null, h('strong', null, 'Exit 0, JSON'), ': ', h('code', null, '{"decision":"block"|"ask"|"continue","reason","updatedArgs","context"}'), '.'),
          h('li', null, h('strong', null, 'Turn finished'), ': ', h('code', null, '{"followUp":"…"}'), ' starts one more turn with that prompt, at most 3 in a row.'),
          h('li', null, h('strong', null, 'Before a notification'), ': ', h('code', null, '{"suppress":true}'), ' sends no notification.'),
          h('li', null, h('strong', null, 'After a tool ran'), ': ', h('code', null, '{"redact":[{"pattern":"AKIA[0-9A-Z]{16}","with":"[aws key]"}]}'), ' hides matches from the model; the card keeps the original.'),
          h('li', null, h('strong', null, 'URL hooks'), ' answer with the same JSON in the reply body; ', h('strong', null, 'module hooks'), ' return it (or a string for context).'),
          h('li', null, h('strong', null, 'Anything else'), ': an error. The turn goes on unless the hook blocks on failure.')
        )
      )
    )
  );
}
