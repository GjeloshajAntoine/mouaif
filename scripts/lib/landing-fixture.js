'use strict';
// Fixture for scripts/capture-landing-shots.js.
//
// Everything the landing-page captures need to look like a real working
// session — one fixed chat id, a transcript that is a genuine agentic run,
// seven connected providers, two project models and the Inspector's preview
// page. Kept in its own module because the capture script is plumbing; this is
// the content, and it is easier to keep honest when it lives in one place.

const fs = require('fs');
const path = require('path');

// Fixed so a re-capture writes the same deep link into the shot.
const CHAT_ID = '1f7c2a90';
const CHAT_TITLE = 'Fix task ordering after restart';

const PROVIDERS = [
  { id: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-demo-not-a-real-key', auth: 'apikey' },
  { id: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-demo-not-a-real-key', auth: 'apikey' },
  { id: 'ollama', baseUrl: 'http://127.0.0.1:11434', auth: 'apikey' },
  { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-demo-not-a-real-key', auth: 'apikey' },
  { id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'demo-not-a-real-key', auth: 'apikey' },
  { id: 'mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'demo-not-a-real-key', auth: 'apikey' },
  { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk-demo-not-a-real-key', auth: 'apikey' }
];

const MODELS = [
  { id: 'claude-sonnet-4-6', provider: 'anthropic', label: 'Claude Sonnet 4.6', contextWindow: 200000 },
  { id: 'gpt-5.4-mini', provider: 'openai-compatible', label: 'GPT-5.4 mini', contextWindow: 128000 }
];

function installProviders(settings) {
  settings.setApp({ providers: PROVIDERS });
}

// Chats the project card shows alongside the seeded one. Titles and drafts
// only: the card is a list, and the costs come from the seeded transcript.
const EXTRA_CHATS = [
  { title: 'Add a done toggle to the board', draft: '' },
  { title: 'Review the restart fix', draft: '' },
  { title: 'Cache the task list for one request', draft: 'Reuse the loaded rows instead of re-querying per task.' },
  { title: 'Explain the store module', draft: '' },
  { title: 'Add a test for empty boards', draft: '' },
  { title: 'Tidy the board styles on mobile', draft: '' },
  { title: 'Bump dependencies', draft: '' }
];

// The second project on the Chats tab: a couple of plain chats, no transcript.
function seedSecondProject(projectDir, chats) {
  for (const title of ['Add rate limiting to /login', 'Document the REST endpoints']) {
    chats.createChat(projectDir, { title });
  }
}

function installProjectModels(projectDir) {
  const settings = require('../../src/settings.js');
  settings.setProject(projectDir, { models: MODELS });
}

// seedSubagentAuthorization(projectDir, chatId) -> { callId }
//
// Park a `subagent` call on the authorization gate and mark the chat as
// running, so the chat view's pending-auth poll mounts the approval card —
// with its per-run model + thinking pickers — on the next open. This is the
// state a real run pauses in while it waits for the user, produced through
// the same gate a live call uses rather than a hand-built DOM fixture.
//
// `subagent` defaults to `ask`, so `authorize` parks the call and returns a
// pending wait. The wait is left unsettled and rejected on cleanup; nothing
// in the capture process needs it to resolve.
function seedSubagentAuthorization(projectDir, chatId) {
  const authz = require('../../src/tools/authorization.js');
  const core = require('../../src/server-shared.js');
  const callId = 'call_demo_subagent';
  authz.authorize({
    projectDir,
    chatId,
    callId,
    tool: 'subagent',
    summary: 'Audit src/store.js for the restart-ordering bug',
    args: {
      task: 'Audit src/store.js for the restart-ordering bug',
      context: 'The task board loses its ordering after a restart.'
    }
  }).then((r) => {
    // A prompt is what this fixture wants. A resolved decision would mean a
    // stale grant leaked in, but the capture must not fail over it.
    if (r && r.wait && typeof r.wait.catch === 'function') r.wait.catch(() => {});
  }).catch(() => { /* capture must not fail if the gate refuses to prompt */ });
  core.runningChats.add(core.runningKey(projectDir, chatId));
  return { callId };
}

// clearSubagentAuthorization(projectDir, chatId, callId)
//
// Undo seedSubagentAuthorization so a later shot of the same chat (the
// transcript capture) sees it as an ordinary settled run again: the parked
// wait is answered with a deny and the chat stops reporting as running.
function clearSubagentAuthorization(projectDir, chatId, callId) {
  const authz = require('../../src/tools/authorization.js');
  const core = require('../../src/server-shared.js');
  try { authz.recordDecision(projectDir, chatId, callId, 'deny'); } catch { /* already settled */ }
  core.runningChats.delete(core.runningKey(projectDir, chatId));
}

// seedChats(projectDir, chats, messages) -> { chatId, emptyChatId }
//
// `chatId` carries the transcript, `emptyChatId` is the brand-new chat the
// tools capture opens: no messages at all, so the transcript renders its
// header block (setup control, system prompt, the tools card) on its own —
// which is the whole point of that shot.
function seedChats(projectDir, chats, messages) {
  for (const extra of EXTRA_CHATS) {
    const chat = chats.createChat(projectDir, { title: extra.title });
    if (extra.draft) chats.updateChat(projectDir, chat.id, { draft: extra.draft });
  }
  const main = chats.createChat(projectDir, { title: CHAT_TITLE });
  for (const row of transcript()) messages.appendMessage(projectDir, main.id, row);
  chats.updateChat(projectDir, main.id, {
    modelId: 'claude-sonnet-4-6',
    providerId: 'anthropic',
    draft: 'Now add a done toggle to the board view.'
  });
  const empty = chats.createChat(projectDir, { title: 'New chat' });
  chats.updateChat(projectDir, empty.id, {
    modelId: 'claude-sonnet-4-6',
    providerId: 'anthropic'
  });
  chats.recomputeProjectTotalCost(projectDir);
  return { chatId: main.id, emptyChatId: empty.id };
}

// ---- transcript ---------------------------------------------------------

const SRC_TASKS = [
  "'use strict';",
  '',
  'const tasks = new Map();',
  '',
  'function addTask(title) {',
  '  const id = String(tasks.size + 1);',
  '  tasks.set(id, { id, title, done: false });',
  '  return tasks.get(id);',
  '}',
  '',
  'module.exports = { addTask, tasks };'
].join('\n');

const TEST_OUT = [
  '> demo-app@1.0.0 test',
  '> node --test',
  '',
  '✔ addTask keeps insertion order (2.1ms)',
  '✔ tasks survive a restart (11.4ms)',
  '✔ ordering after restart matches insertion order (3.2ms)',
  '',
  'tests 3',
  'pass 3',
  'fail 0'
].join('\n');

let clock = 14 * 3600 + 2 * 60 + 11;
function ts(step = 5) {
  clock += step;
  const pad = (v) => String(v).padStart(2, '0');
  return `2026-09-17T${pad(Math.floor(clock / 3600))}:${pad(Math.floor((clock % 3600) / 60))}:${pad(clock % 60)}.000Z`;
}

const usage = (p, c) => ({ promptTokens: p, completionTokens: c, cacheReadTokens: 0, cacheCreationTokens: 0 });
const cost = (i, o) => ({ known: true, input: i, output: o, total: +(i + o).toFixed(6), currency: 'USD' });
const j = (o) => JSON.stringify(o);

// transcript() -> message rows, in order.
//
// The tool rows carry the JSON shape the matching tool actually returns
// (`read_file` / `search_files` / `write_file` / `shell`), because the
// transcript renders each card from that payload — a paraphrased result would
// paint a different card than a live run does.
function transcript() {
  clock = 14 * 3600 + 2 * 60 + 11;
  const rows = [
    { role: 'user', content: 'The task board loses its ordering after a restart. Find out why and fix it.' },
    {
      role: 'assistant',
      content: "I'll read the store first, then check what happens to the order on load.",
      reasoning: 'Two places can reorder: the in-memory Map, and whatever rebuilds it on load. Read the store before changing anything.',
      usage: usage(3140, 96), cost: cost(0.01571, 0.00288), modelId: 'claude-sonnet-4-6', streamingMs: 1840
    },
    {
      role: 'tool', phase: 'call', toolCallId: 'call_demo_read', name: 'read_file',
      args: { path: 'src/tasks.js' }, ok: true, content: j({ path: 'src/tasks.js' })
    },
    {
      role: 'tool', phase: 'result', toolCallId: 'call_demo_read', name: 'read_file', ok: true,
      content: j({
        path: 'src/tasks.js', relPath: 'src/tasks.js', startLine: 1, endLine: 12,
        totalLines: 12, lines: 12, chars: SRC_TASKS.length, body: SRC_TASKS
      })
    },
    {
      role: 'assistant',
      content: 'Tasks live in a `Map`, so the order in memory is insertion order. Something rebuilding that map on load must sort it. Let me find the query.',
      usage: usage(3412, 88), cost: cost(0.01706, 0.00264), modelId: 'claude-sonnet-4-6', streamingMs: 1520
    },
    {
      role: 'tool', phase: 'call', toolCallId: 'call_demo_search', name: 'search_files',
      args: { query: 'SELECT id, title', path: 'src' }, ok: true,
      content: j({ query: 'SELECT id, title', path: 'src' })
    },
    {
      role: 'tool', phase: 'result', toolCallId: 'call_demo_search', name: 'search_files', ok: true,
      content: j({
        query: 'SELECT id, title', path: 'src', matchCount: 2, filesScanned: 6, truncated: false,
        matches: [
          { path: 'src/store.js', line: 7, text: "    'SELECT id, title, done FROM tasks ORDER BY id'" },
          { path: 'src/store.test.js', line: 5, text: "test('ordering after restart matches insertion order', () => {" }
        ]
      })
    },
    {
      role: 'assistant',
      content: 'Found it: `src/store.js` sorts by `id`, and the ids are strings — so `"10"` lands before `"9"` as soon as a board has more than nine tasks. I\'ll read that file before changing it.',
      usage: usage(3624, 104), cost: cost(0.01812, 0.00312), modelId: 'claude-sonnet-4-6', streamingMs: 1990
    },
    {
      role: 'tool', phase: 'call', toolCallId: 'call_demo_read2', name: 'read_file',
      args: { path: 'src/store.js', startLine: 1, endLine: 12 }, ok: true,
      content: j({ path: 'src/store.js' })
    },
    {
      role: 'tool', phase: 'result', toolCallId: 'call_demo_read2', name: 'read_file', ok: true,
      content: j({
        path: 'src/store.js', relPath: 'src/store.js', startLine: 1, endLine: 12, totalLines: 15,
        lines: 12, chars: 412,
        body: [
          "'use strict';",
          '',
          "const { addTask, tasks } = require('./tasks.js');",
          '',
          'function load(db) {',
          '  const rows = db.prepare(',
          "    'SELECT id, title, done FROM tasks ORDER BY id'",
          '  ).all();',
          '  for (const row of rows) tasks.set(row.id, row);',
          '  return rows;',
          '}'
        ].join('\n')
      })
    },
    {
      role: 'tool', phase: 'call', toolCallId: 'call_demo_write', name: 'write_file',
      args: { path: 'src/store.js', content: "    'SELECT id, title, done FROM tasks ORDER BY position'" },
      ok: true, content: j({ path: 'src/store.js' })
    },
    {
      role: 'tool', phase: 'result', toolCallId: 'call_demo_write', name: 'write_file', ok: true,
      content: j({ path: 'src/store.js', relPath: 'src/store.js', chars: 51, bytesWritten: 51, lines: 1, kind: 'text' })
    },
    {
      role: 'tool', phase: 'call', toolCallId: 'call_demo_shell', name: 'shell',
      args: { cmd: 'npm test' }, ok: true, content: j({ cmd: 'npm test' })
    },
    {
      role: 'tool', phase: 'result', toolCallId: 'call_demo_shell', name: 'shell', ok: true,
      content: j({ identity: 'npm test', exitCode: 0, durationMs: 2410, stdout: TEST_OUT, stderr: '' })
    },
    {
      role: 'assistant',
      content: 'All three tests pass, including the restart-ordering case. The board keeps insertion order now; the fix is one line in `src/store.js`.',
      usage: usage(3980, 121), cost: cost(0.01990, 0.00363), modelId: 'claude-sonnet-4-6', streamingMs: 2410
    }
  ];
  return rows.map((row) => ({ ...row, ts: ts() }));
}

// ---- the Inspector's target page ---------------------------------------

const PREVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>demo-app — task board</title>
  <style>
    :root { color-scheme: light; font: 16px/1.45 system-ui, -apple-system, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f6f7fb; color: #1c1f26; }
    header { padding: 20px 18px 10px; }
    h1 { margin: 0 0 4px; font-size: 1.35rem; letter-spacing: -0.01em; }
    .meta { margin: 0; color: #667085; font-size: 0.85rem; }
    main { padding: 0 18px 28px; display: grid; gap: 10px; }
    .card { display: flex; align-items: center; gap: 12px; padding: 14px; border-radius: 12px; background: #fff; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.08); }
    .card--done .title { text-decoration: line-through; color: #98a2b3; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #eab308; flex: none; }
    .card--done .dot { background: #22c55e; }
    .title { margin: 0; font-weight: 600; }
    .id { margin-left: auto; color: #98a2b3; font-variant-numeric: tabular-nums; }
    footer { padding: 0 18px 28px; color: #98a2b3; font-size: 0.8rem; }
  </style>
</head>
<body>
  <header>
    <h1>Task board</h1>
    <p class="meta">demo-app · 5 tasks · insertion order</p>
  </header>
  <main>
    <article class="card card--done"><span class="dot"></span><p class="title">Wire up the SQLite store</p><span class="id">#1</span></article>
    <article class="card card--done"><span class="dot"></span><p class="title">Add the restart path</p><span class="id">#2</span></article>
    <article class="card"><span class="dot"></span><p class="title">Order tasks by position</p><span class="id">#3</span></article>
    <article class="card"><span class="dot"></span><p class="title">Add a done toggle to the board</p><span class="id">#4</span></article>
    <article class="card"><span class="dot"></span><p class="title">Cover ordering with a test</p><span class="id">#5</span></article>
  </main>
  <footer>Rendered from src/store.js — one row per task.</footer>
</body>
</html>
`;

function writePreviewPage(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), PREVIEW_HTML);
}

module.exports = {
  CHAT_ID,
  CHAT_TITLE,
  PROVIDERS,
  MODELS,
  installProviders,
  seedChats,
  seedSecondProject,
  installProjectModels,
  seedSubagentAuthorization,
  clearSubagentAuthorization,
  transcript,
  writePreviewPage
};