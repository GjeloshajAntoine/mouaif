'use strict';

// Regression test: progress reported INSIDE a subagent run shows its level
// inside the subagent card.
//
// Before: a nested `report_progress` / `task` call rendered in the subagent
// card as a bare row ("report_progress · Building · ok") with no level, and
// its `progress_update` frame drew a detached top-level progress card at the
// bottom of the transcript, far from the card. After the run settled the
// rebuilt card had no level at all.
//
// Covers:
//   1. progressLevelOf() reads report_progress results, task results and raw
//      progress_update frames (frontend/src/components/chat/tools.js).
//   2. A settled nested report_progress row draws its bar + message.
//   3. A live progress_update frame for a nested call id updates the nested
//      row and does NOT append a top-level progress card.
//   4. A top-level progress_update still gets its own progress card.
//   5. The server forwards nested progress with the parent's call id.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- tiny DOM stub ------------------------------------------------------

function classListOf(node) { return String(node.className || '').split(/\s+/).filter(Boolean); }
function matchesSimple(node, sel) {
  const attr = sel.match(/^([\w.-]*)\[data-([\w-]+)="([^"]*)"\]$/);
  if (attr) {
    if (attr[1] && !matchesSimple(node, attr[1])) return false;
    const key = attr[2].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return String(node.dataset[key] == null ? '' : node.dataset[key]) === attr[3];
  }
  if (!sel.includes('.')) return node.tagName === sel.toUpperCase();
  const wanted = sel.split('.').filter(Boolean);
  const have = classListOf(node);
  return wanted.length > 0 && wanted.every((c) => have.includes(c));
}
function matchesOne(node, sel) {
  const parts = String(sel).trim().split(/\s+/);
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  let up = node.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (up && !matchesSimple(up, parts[i])) up = up.parentNode;
    if (!up) return false;
    up = up.parentNode;
  }
  return true;
}
function matches(node, sel) { return String(sel).split(',').some((s) => matchesOne(node, s)); }
function descendants(node, out) {
  out = out || [];
  for (const child of node.children) { out.push(child); descendants(child, out); }
  return out;
}
function createElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), nodeType: 1, children: [], parentNode: null,
    className: '', hidden: false, title: '', dataset: {}, style: {}, attrs: {}, listeners: {},
    isConnected: true, _text: '',
    get textContent() { return node._text; },
    set textContent(v) { node._text = String(v == null ? '' : v); node.children = []; },
    get classList() {
      const list = classListOf(node);
      return {
        add(c) { if (!list.includes(c)) list.push(c); node.className = list.join(' '); },
        remove(c) { const i = list.indexOf(c); if (i >= 0) list.splice(i, 1); node.className = list.join(' '); },
        contains(c) { return list.includes(c); },
        toggle(c) { if (list.includes(c)) list.splice(list.indexOf(c), 1); else list.push(c); node.className = list.join(' '); }
      };
    },
    appendChild(c) { c.parentNode = node; node.children.push(c); return c; },
    insertBefore(c, ref) {
      c.parentNode = node;
      const at = node.children.indexOf(ref);
      if (at === -1) node.children.push(c); else node.children.splice(at, 0, c);
      return c;
    },
    removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    querySelector(sel) { return descendants(node).find((n) => matches(n, sel)) || null; },
    querySelectorAll(sel) { return descendants(node).filter((n) => matches(n, sel)); },
    closest(sel) { let n = node; while (n) { if (matches(n, sel)) return n; n = n.parentNode; } return null; },
    setAttribute(k, v) { node.attrs[k] = String(v); },
    getAttribute(k) { return k in node.attrs ? node.attrs[k] : null; },
    addEventListener(t, fn) { (node.listeners[t] = node.listeners[t] || []).push(fn); },
    removeEventListener() {}
  };
  let html = '';
  Object.defineProperty(node, 'innerHTML', {
    get() { return html; },
    set(v) { html = v == null ? '' : String(v); node.children = []; }
  });
  return node;
}

// ---- module loaders -----------------------------------------------------

function stripModule(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^export /gm, '');
}

function loadTools() {
  const ctx = vm.createContext({ JSON, Math, Number, String, Array, Object, isFinite });
  vm.runInContext(stripModule('frontend/src/components/chat/tools.js')
    + '; this.progressLevelOf = progressLevelOf; this.formatResultSummary = formatResultSummary; this.formatToolArgs = formatToolArgs;', ctx);
  return ctx;
}

function loadTranscript(tools) {
  const base = {
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, WeakMap, Promise, Error,
    isFinite, setTimeout, clearTimeout,
    document: { createElement, createTextNode: (t) => { const n = createElement('#text'); n.nodeType = 3; n._text = String(t); return n; }, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    renderMarkdown: (s) => String(s || ''),
    coerceToolResult: (raw) => { if (typeof raw !== 'string') return raw; try { return JSON.parse(raw); } catch { return raw; } },
    normalizeToolName: (n) => String(n || '').replace(/^functions\./, ''),
    isSubagentTool: (n) => n === 'subagent',
    formatToolArgs: tools.formatToolArgs,
    formatResultSummary: tools.formatResultSummary,
    progressLevelOf: tools.progressLevelOf,
    TOOL_ARGS_PREVIEW_CHARS: 220,
    isExpectedToolFailure: () => false,
    formatReadableToolResult: (r) => JSON.stringify(r),
    cssEscape: (s) => String(s == null ? '' : s).replace(/["\\]/g, '\\$&'),
    afterTranscriptAppend() {},
    scrollToolBodyToBottomSoon() {},
    cancelToolBodyScroll() {}
  };
  const ctx = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (t, k) => (k in t ? t[k] : () => undefined)
  }));
  vm.runInContext(stripModule('frontend/src/components/chat/transcript.js')
    + '; this.renderSubagentChat = renderSubagentChat; this.handleSubagentStreamEvent = handleSubagentStreamEvent; this.updateProgressCard = updateProgressCard;', ctx);
  return ctx;
}

function makeRefs() {
  const transcript = createElement('div');
  const card = createElement('div');
  card.className = 'tool-card tool-card--call tool-card--subagent is-expanded';
  card.dataset.toolId = 'call_parent';
  const body = createElement('div');
  body.className = 'tool-card__body';
  const live = createElement('div');
  live.className = 'tool-card__subagent-live';
  body.appendChild(live);
  card.appendChild(body);
  transcript.appendChild(card);
  return { refs: { transcript: { current: transcript } }, card, transcript };
}

async function serverForwardsParentCallId() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-nestprog-'));
  process.env.MOUAIF_HOME = path.join(tmp, 'home');
  const ai = require('../src/ai.js');
  const settings = require('../src/settings.js');
  const projectDir = path.join(tmp, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  settings.setProject(projectDir, { tools: { subagent: { enabled: true, mode: 'allow' } } });
  const tc = (id, name, a) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(a) } }] }, index: 0 }] });
  const scripts = [
    [tc('call_parent', 'subagent', { task: 'work' }), { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] }],
    [tc('call_nested', 'report_progress', { title: 'Build', current: 4, total: 8 }), { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] }],
    [{ choices: [{ delta: { content: 'ok' }, index: 0 }] }, { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }],
    [{ choices: [{ delta: { content: 'done' }, index: 0 }] }, { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }]
  ];
  let count = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const s = scripts[Math.min(count++, scripts.length - 1)];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const p of s) res.write('data: ' + JSON.stringify(p) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const events = [];
  await ai.streamChat({
    model: { id: 'mock', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + server.address().port, apiKey: 'k', auth: 'apikey' },
    messages: [{ role: 'user', content: 'go' }],
    projectDir,
    chatId: 'nestprog',
    onEvent: (name, data) => events.push({ name, data })
  });
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  const p = events.find((e) => e.name === 'progress_update');
  check('server: nested progress_update carries the parent subagent call id',
    !!p && p.data.parentCallId === 'call_parent' && p.data.callId === 'call_nested',
    JSON.stringify(p && p.data));
}

async function main() {
  const tools = loadTools();

  // ---- 1. progressLevelOf ------------------------------------------------
  const lvl = tools.progressLevelOf('report_progress', { title: 'B', current: 3, total: 10, status: 'running', message: 'm' });
  check('progressLevelOf reads a report_progress result', lvl && lvl.percent === 30 && lvl.status === 'running' && lvl.message === 'm', JSON.stringify(lvl));
  const done = tools.progressLevelOf('report_progress', { title: 'B', current: 2, total: 10, status: 'completed' });
  check('a completed report is 100%', done && done.percent === 100 && done.status === 'completed', JSON.stringify(done));
  const task = tools.progressLevelOf('task', { action: 'progress_updated', task: { title: 'T', current: 1, total: 4, status: 'in_progress' } });
  check('progressLevelOf reads a task result', task && task.percent === 25 && task.status === 'running', JSON.stringify(task));
  check('progressLevelOf ignores other tools', tools.progressLevelOf('read_file', { current: 1, total: 2 }) === null);
  check('progressLevelOf reads a raw progress_update frame', (tools.progressLevelOf(null, { current: 5, total: 5 }) || {}).percent === 100);
  check('report_progress summary shows the level', tools.formatResultSummary('report_progress', { current: 3, total: 10 }) === '30%');
  check('report_progress args show the title', tools.formatToolArgs({ title: 'Build', current: 1, total: 2 }, 'report_progress') === 'Build');

  const mod = loadTranscript(tools);

  // ---- 2. settled render -------------------------------------------------
  {
    const { card } = makeRefs();
    mod.renderSubagentChat(card, { name: 'subagent', result: { ok: true, text: 'done', chat: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'report_progress', arguments: '{"title":"Build","current":6,"total":8,"message":"linking"}' } }] },
      { role: 'tool', tool_call_id: 'p1', name: 'report_progress', content: '{"title":"Build","current":6,"total":8,"status":"running","message":"linking"}' },
      { role: 'assistant', content: 'done' }
    ] } });
    const row = card.querySelector('.tool-card__subagent-chat [data-nested-tool-id="p1"]');
    const prog = row && row.querySelector('.tool-card__subagent-progress');
    check('settled nested report_progress row draws a progress bar', !!prog);
    check('the bar width is the level', prog && prog.querySelector('.tool-card__progress-bar').style.width === '75%',
      prog && prog.querySelector('.tool-card__progress-bar').style.width);
    check('the percentage and message are shown', prog && prog.querySelector('.tool-card__progress-pct').textContent === '75%'
      && prog.querySelector('.tool-card__progress-msg').textContent === 'linking');
    check('the bar is outside the folded preview', prog && prog.parentNode === row);
  }

  // ---- 3. live frame routed into the nested row --------------------------
  {
    const { refs, card, transcript } = makeRefs();
    mod.handleSubagentStreamEvent({ eventName: 'tool_call' }, { parentCallId: 'call_parent', id: 'p2', name: 'report_progress', args: { title: 'Build', current: 1, total: 4 } }, refs);
    mod.updateProgressCard(refs, { parentCallId: 'call_parent', callId: 'p2', title: 'Build', current: 1, total: 4, status: 'running', message: 'start' });
    const row = card.querySelector('[data-nested-tool-id="p2"]');
    const prog = row && row.querySelector('.tool-card__subagent-progress');
    check('a live nested progress_update draws on the nested row', !!prog && prog.querySelector('.tool-card__progress-pct').textContent === '25%');
    check('no detached top-level progress card is appended', transcript.querySelectorAll('.tool-card--progress').length === 0);
    mod.updateProgressCard(refs, { parentCallId: 'call_parent', callId: 'p2', title: 'Build', current: 4, total: 4, status: 'completed' });
    check('a later frame updates the same bar', row.querySelectorAll('.tool-card__subagent-progress').length === 1
      && prog.dataset.status === 'completed' && prog.querySelector('.tool-card__progress-bar').style.width === '100%');
    mod.handleSubagentStreamEvent({ eventName: 'tool_result' }, { parentCallId: 'call_parent', id: 'p2', name: 'report_progress', ok: true, result: { title: 'Build', current: 4, total: 4, status: 'completed' } }, refs);
    check('the result keeps a single bar on the row', row.querySelectorAll('.tool-card__subagent-progress').length === 1);
  }

  // ---- 4. top-level progress still gets its own card ---------------------
  {
    const { refs, transcript } = makeRefs();
    mod.updateProgressCard(refs, { callId: 'top1', title: 'Top', current: 1, total: 2, status: 'running' });
    check('a top-level progress_update still appends a progress card', transcript.querySelectorAll('.tool-card--progress').length === 1);
  }

  // ---- 5. server tags nested progress ------------------------------------
  await serverForwardsParentCallId();

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
