'use strict';

// Native `group_cli` tool — a group of shell commands in one call, with an
// asynchronous (background) mode.
//
// The assertions mirror scripts/test-grouped-file-tools.js, because the tool
// is the CLI counterpart of `group_read` / `group_edit` and the two must
// agree about the batch contract:
//
//   * `commands` is validated (non-empty, capped) and every entry runs like
//     a single `shell` call — same sandbox, same working folder, same
//     interpreter resolution;
//   * a non-zero exit is per-entry data, never a batch failure, and the
//     batch keeps going after it;
//   * the `mouaif` authorization family covers it (a family Off hides and
//     rejects it, a family Allow runs a batch with no prompt, and an
//     allowlist must match EVERY command in the batch);
//   * `async: true` returns immediately with a log path, the log receives
//     the output and the exit line, and the batch's later entries still run;
//   * the model gets a readable per-entry text result, the card gets the
//     structured one, and the live `shell_output` preview is tagged with the
//     entry it came from.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-group-cli-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
const projectDir = path.join(root, 'project');
fs.mkdirSync(projectDir, { recursive: true });

const settings = require('../src/settings.js');
const authz = require('../src/tools/authorization.js');
const groupCli = require('../src/tools/groupCli.js');
const shell = require('../src/tools/shell.js');

const run = (args, extra = {}) => groupCli.runGroupCli({ projectDir, args, ...extra });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // ---- 1. The spec, the catalog and the cap ------------------------------
  assert.equal(groupCli.SPEC.type, 'function');
  assert.equal(groupCli.SPEC.function.name, 'group_cli');
  assert.ok(groupCli.SPEC.function.description.includes('background'));
  assert.deepEqual(groupCli.SPEC.function.parameters.required, ['commands']);
  const items = groupCli.SPEC.function.parameters.properties.commands.items;
  assert.deepEqual(items.required, ['cmd']);
  assert.ok(items.properties.async, 'an entry can be started in the background');
  assert.equal(groupCli.SPEC.function.parameters.properties.commands.maxItems, groupCli.MAX_BATCH_ENTRIES);
  assert.equal(groupCli.MAX_BATCH_ENTRIES, require('../src/tools/files.js').MAX_BATCH_ENTRIES,
    'the grouped tools share one entry cap');

  const catalog = require('../src/server-handlers-tools.js').listNativeTools();
  const entry = catalog.find((tool) => tool.name === 'group_cli');
  assert.ok(entry, 'group_cli is in the native catalog');
  assert.equal(entry.source, 'mouaif', 'it advertises the family its tree row belongs to');
  assert.ok(entry.parameters && entry.parameters.properties.commands);

  // ---- 2. Input validation ------------------------------------------------
  const rejects = (promise, code) => assert.rejects(() => promise, (e) => e.code === code, 'expected ' + code);
  await rejects(run({}), 'EBADINPUT');
  await rejects(run({ commands: [] }), 'EBADINPUT');
  await rejects(run({ commands: new Array(groupCli.MAX_BATCH_ENTRIES + 1).fill({ cmd: 'true' }) }), 'ETOOL_CAP');
  await assert.rejects(() => groupCli.runGroupCli({
    projectDir: path.join(projectDir, 'missing'), args: { commands: [{ cmd: 'true' }] }
  }), (e) => e.code === 'ENOENT');

  // ---- 3. A batch runs in order and reports every entry ------------------
  const batch = await run({ commands: [
    { cmd: 'echo first', label: 'one' },
    { cmd: 'printf "out\\n"; printf "err\\n" >&2' },
    { cmd: 'exit 3' },
    { cmd: 'echo after-failure' }
  ] });
  assert.equal(batch.results.length, 4, 'no entry is dropped');
  assert.deepEqual(batch.results.map((r) => r.index), [0, 1, 2, 3]);
  assert.equal(batch.results[0].label, 'one');
  assert.equal(batch.results[0].result.stdout.trim(), 'first');
  assert.equal(batch.results[1].result.stdout.trim(), 'out');
  assert.equal(batch.results[1].result.stderr.trim(), 'err');
  assert.equal(batch.results[1].result.identity, shell.shellLabel() ? batch.results[1].result.identity : '');
  assert.ok(batch.results[1].result.identity.startsWith('mouaif shell'));
  assert.equal(batch.succeededCount, 3);
  assert.equal(batch.failedCount, 1);
  assert.equal(batch.runningCount, 0);
  assert.deepEqual(batch.stillRunning, []);
  assert.equal(batch.results[2].ok, false, 'a non-zero exit is visible to the pipeline');
  assert.equal(batch.results[2].result.exitCode, 3);
  assert.equal(batch.results[3].result.stdout.trim(), 'after-failure', 'the batch continued past the failure');

  // A malformed entry fails on its own, with the same typed-error contract
  // the grouped file tools use.
  const mixed = await run({ commands: ['echo not-an-object', { label: 'no cmd' }, { cmd: 'echo fine' }] });
  assert.equal(mixed.results[0].result.error.code, 'EBADINPUT');
  assert.equal(mixed.results[1].result.error.code, 'EBADINPUT');
  assert.equal(mixed.results[2].result.stdout.trim(), 'fine');
  assert.equal(mixed.failedCount, 2);
  // `command` is accepted as a synonym for `cmd` on an entry.
  const synonym = await run({ commands: [{ command: 'echo synonym' }] });
  assert.equal(synonym.results[0].result.stdout.trim(), 'synonym');

  // A per-entry interpreter override goes through the single shell resolver,
  // so an invalid value is the same typed refusal the shell tool gives
  // (`/bin/nope` is a well-formed POSIX path and fails later as ESPAWN).
  const badShell = await run({ commands: [{ cmd: 'echo x', shell: 'cmd.exe' }] });
  assert.equal(badShell.results[0].result.code, 'EBADINPUT');
  assert.equal(badShell.results[0].result.error, 'unsupported shell override: cmd.exe (expected a path to a sh-compatible binary)');

  // ---- 4. Live preview + model-facing text -------------------------------
  const events = [];
  const streamed = await run({ commands: [{ cmd: 'echo live', label: 'live one' }] },
    { onOutput: (stream, delta, entryMeta) => events.push({ stream, delta, entryMeta }) });
  assert.ok(events.length >= 1, 'at least one output chunk');
  assert.equal(events[0].stream, 'stdout');
  assert.ok(events[0].delta.includes('live'));
  assert.equal(events[0].entryMeta.index, 0, 'a chunk names the entry it came from');
  assert.equal(events[0].entryMeta.label, 'live one');
  const text = groupCli.formatGroupCliResult(streamed);
  assert.ok(text.includes('1. live one'));
  assert.ok(text.includes('live'));
  assert.ok(text.includes('1 succeeded · 0 failed'));

  // ---- 5. Timeouts and the batch budget ----------------------------------
  const timedOut = await run({ commands: [{ cmd: 'sleep 5', timeoutMs: 60 }] });
  assert.equal(timedOut.results[0].ok, false);
  assert.equal(timedOut.results[0].result.code, 'ETIMEDOUT');
  // The budget is checked before each entry starts, so a slow first entry
  // is what exhausts it; otherwise a fast batch legitimately fits inside it.
  const budgeted = await groupCli.runGroupCli({
    projectDir, toolTimeoutMs: 100, args: { commands: [{ cmd: 'sleep 0.4' }, { cmd: 'echo two' }] }
  });
  assert.equal(budgeted.results[0].ok, false);
  assert.equal(budgeted.results[1].ok, false);
  assert.equal(budgeted.results[1].result.error.code, 'ETIMEDOUT');
  assert.ok(budgeted.results[1].result.error.message.includes('budget'));
  assert.equal(budgeted.results[1].result.error.message.includes('was not started'), true, 'the skipped entry says so');

  // A batch entry that is started in the background must not count against
  // the synchronous budget.
  const notBudgeted = await groupCli.runGroupCli({
    projectDir, toolTimeoutMs: 1,
    args: { commands: [{ cmd: 'sleep 0.5; echo bg', async: true }] }
  });
  assert.equal(notBudgeted.results[0].ok, true, 'a background entry is exempt from the batch budget');
  assert.equal(notBudgeted.runningCount, 1);

  // ---- 6. Async (background) mode ----------------------------------------
  const bg = await run({ commands: [
    { cmd: 'sleep 0.4; echo background-done', label: 'bg', async: true },
    { cmd: 'echo sync-entry' }
  ] });
  const bgEntry = bg.results[0];
  assert.equal(bgEntry.ok, true);
  assert.equal(bgEntry.result.async, true);
  assert.equal(bgEntry.result.status, 'running');
  assert.ok(bgEntry.result.pid > 0, 'the pid is reported');
  assert.ok(bgEntry.result.logPath.startsWith('.mouaif/logs/'), bgEntry.result.logPath);
  assert.equal(bg.runningCount, 1);
  assert.deepEqual(bg.stillRunning, ['bg']);
  assert.ok(bg.durationMs < 400, 'the call did not wait for the background command (' + bg.durationMs + 'ms)');
  assert.equal(bg.results[1].result.stdout.trim(), 'sync-entry', 'the later entry still ran');
  assert.equal(bgEntry.result.stdout, undefined, 'an async entry has no captured stdout: the log holds it');
  assert.ok(bg.logs.some((log) => log.path === bgEntry.result.logPath && log.running === true));

  // Call-level `async: true` starts every entry in the background.
  const all = await run({ async: true, commands: [{ cmd: 'sleep 0.3; echo all-a' }, { cmd: 'sleep 0.3; echo all-b' }] });
  assert.equal(all.runningCount, 2);
  assert.equal(all.failedCount, 0);

  // The log is written as the command runs and closed with its exit line.
  await sleep(1200);
  const logPath = path.join(projectDir, bgEntry.result.logPath);
  assert.ok(fs.existsSync(logPath), logPath + ' exists');
  const logBody = fs.readFileSync(logPath, 'utf8');
  assert.ok(logBody.includes('background-done'), 'stdout landed in the log');
  assert.ok(/\[mouaif\] exit 0 after \d+ms/.test(logBody), 'the exit line landed in the log');
  for (const other of all.results) {
    assert.ok(fs.existsSync(path.join(projectDir, other.result.logPath)), other.result.logPath + ' exists');
  }

  // ---- 7. Authorization ---------------------------------------------------
  const chatId = 'batch-cli';
  settings.setProject(projectDir, { chats: [{ id: chatId, title: 'batch cli', trace: false }], tools: {} });
  let call = 0;
  const authorize = (args) => authz.authorize({
    projectDir, chatId, callId: 'cli-' + ++call, tool: 'group_cli', args, summary: args && args.commands && args.commands[0] && args.commands[0].cmd
  });
  assert.ok(authz.TOOL_FAMILIES.mouaif.includes('group_cli'), 'group_cli is a mouaif family leaf');
  assert.equal(authz.configToolName('group_cli'), 'mouaif');
  assert.equal(authz.effectiveConfig(projectDir, 'group_cli').mode, 'ask', 'it defaults to ask');
  settings.setProject(projectDir, { tools: { mouaif: { mode: 'off' } } });
  await rejects(authorize({ commands: [{ cmd: 'echo a' }] }), 'ETOOL_DISABLED');
  settings.setProject(projectDir, { tools: { mouaif: { mode: 'allow' }, group_cli: { mode: 'off' } } });
  await rejects(authorize({ commands: [{ cmd: 'echo a' }] }), 'ETOOL_DISABLED');
  settings.setProject(projectDir, { tools: { mouaif: { mode: 'allow' } } });
  assert.equal((await authorize({ commands: [{ cmd: 'echo a' }] })).decision, 'allow');
  settings.setProject(projectDir, { tools: { mouaif: { mode: 'allowlist', allowlist: ['^echo '] } } });
  assert.equal((await authorize({ commands: [{ cmd: 'echo a' }, { cmd: 'echo b' }] })).decision, 'allow');
  const asked = await authorize({ commands: [{ cmd: 'echo a' }, { cmd: 'rm -rf build' }] });
  assert.equal(asked.decision, 'prompt', 'one unlisted command must not approve the whole batch');
  authz.recordDecision(projectDir, chatId, 'cli-' + call, 'allow-once');
  await asked.wait;

  // ---- 8. The multi-turn dispatcher, against a local SSE fixture ---------
  settings.setProject(projectDir, { tools: { mouaif: { mode: 'allow' } } });
  const originalFetch = global.fetch;
  let rounds = 0;
  const sseEvents = [];
  try {
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(body.tools.some((tool) => tool.function.name === 'group_cli'), 'the batch tool is advertised');
      let delta;
      if (rounds++ === 0) {
        delta = { tool_calls: [
          { index: 0, id: 'cli-batch', type: 'function', function: { name: 'group_cli', arguments: JSON.stringify({ commands: [
            { cmd: 'echo from-batch', label: 'echo one' },
            { cmd: 'printf "o\\n"; printf "e\\n" >&2' }
          ] }) } }
        ] };
      } else {
        assert.ok(body.messages.some((message) => message.role === 'tool' && message.name === 'group_cli'),
          'the per-entry result went back to the model as a tool message');
        delta = { content: 'Done' };
      }
      return new Response('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const streamedCall = await require('../src/ai-stream.js').streamChat({
      model: { id: 'fixture', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' },
      projectDir, chatId, promptSize: 'average', messages: [{ role: 'user', content: 'Run the batch' }],
      onEvent: (type, payload) => sseEvents.push({ type, payload })
    });
    assert.equal(streamedCall.ok, true);
    const result = sseEvents.find((event) => event.type === 'tool_result' && event.payload.name === 'group_cli');
    assert.ok(result, 'a tool_result frame was emitted');
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.result.results.length, 2);
    assert.equal(result.payload.result.results[0].result.stdout.trim(), 'from-batch');
    assert.equal(result.payload.result.results[1].result.stderr.trim(), 'e');
    assert.ok(sseEvents.some((event) => event.type === 'shell_output' && event.payload.delta.includes('from-batch')),
      'the live preview streamed while the batch ran');
  } finally { global.fetch = originalFetch; }

  // An `off` family hides the spec from the advertised request entirely.
  settings.setProject(projectDir, { tools: { mouaif: { mode: 'off' } } });
  let sawTools = null;
  rounds = 0;
  try {
    global.fetch = async (_url, init) => {
      sawTools = JSON.parse(init.body).tools || [];
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    };
    await require('../src/ai-stream.js').streamChat({
      model: { id: 'fixture', provider: 'openai-compatible', baseUrl: 'http://fixture/v1' },
      projectDir, chatId, promptSize: 'average', messages: [{ role: 'user', content: 'hi' }], onEvent: () => {}
    });
    assert.ok(!sawTools.some((tool) => tool.function.name === 'group_cli'), 'a mouaif Off hides the batch tool');
  } finally { global.fetch = originalFetch; }

  // ---- 9. Isolation, via an isolated serve smoke test --------------------
  const server = require('../src/index.js').createServer(0);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const response = await fetch(base + '/api/tools/list');
    assert.equal(response.status, 200);
    const tools = (await response.json()).tools;
    assert.ok(tools.some((tool) => tool.name === 'group_cli' && tool.source === 'mouaif'));
  } finally { await new Promise((resolve) => server.close(resolve)); }

  // ---- 10. The tool-group model, the mirror and the preset --------------
  const vmContext = vm.createContext({ Set, console });
  const loadFile = (file) => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', file), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export \{.*?\};$/gms, '').replace(/^export /gm, '');
  vm.runInContext(loadFile('toolGroups.js'), vmContext);
  vmContext.catalog = catalog.map((tool) => ({ name: tool.name, kind: 'native', source: tool.source }));
  vm.runInContext(loadFile('components/ToolTree.jsx'), vmContext);
  const groups = vm.runInContext('buildToolGroups(catalog, [], null)', vmContext);
  const appRow = groups.find((group) => group.id === 'mouaif-settings');
  assert.ok(appRow.tools.some((tool) => tool.id === 'group_cli'), 'the mouaif tree row lists the batch tool');
  assert.ok(groups.every((group) => group.id !== 'group_cli'), 'it has no row of its own');
  assert.equal(vm.runInContext('FAMILY_OF.group_cli', vmContext), 'mouaif');
  const mirror = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'build', 'toolGroups.json'), 'utf8'));
  const model = await import('../frontend/src/toolGroups.js');
  assert.equal(JSON.stringify(mirror), JSON.stringify(JSON.parse(JSON.stringify(model.TOOL_GROUPS))),
    'run: node scripts/build-tool-groups.js');
  const preset = await import('../frontend/src/components/settings/presetTools.js');
  assert.deepEqual([...preset.PRESET_DEFAULT_OFF_TOOLS], ['group_read', 'group_edit', 'group_cli']);
  assert.deepEqual(preset.presetDefaultSelection(['shell', 'read_file', 'group_read', 'group_edit', 'group_cli']),
    ['shell', 'read_file'], 'the baseline leaves the grouped tools off');

  // ---- 11. The card: arguments, summary and per-entry preview ------------
  const cardContext = vm.createContext({ Set, console });
  cardContext.document = { createElement: () => ({
    tag: 'div', children: [], classList: { add() {} }, textContent: '',
    appendChild(child) { this.children.push(child); },
    closest() { return null; }, querySelector() { return null; }
  }) };
  vm.runInContext(loadFile('components/chat/tools.js'), cardContext);
  vm.runInContext(loadFile('components/chat/toolRender.js'), cardContext);
  cardContext.args = { commands: [{ cmd: 'npm test', label: 'tests' }, { cmd: 'npm run build', async: true }] };
  assert.equal(vm.runInContext('formatToolArgs(args, "group_cli")', cardContext), 'tests › npm run build');
  const full = vm.runInContext('formatToolArgsFull(args, "group_cli")', cardContext);
  assert.ok(full.includes('1. tests: npm test'));
  assert.ok(full.includes('2. npm run build  [background]'));
  cardContext.result = { succeededCount: 1, failedCount: 0, runningCount: 1, durationMs: 120, results: [
    { index: 0, label: 'tests', cmd: 'npm test', ok: true, result: { stdout: 'ok 1', stderr: '', exitCode: 0, durationMs: 100 } },
    { index: 1, cmd: 'npm run build', ok: true, result: { async: true, status: 'running', pid: 42, logPath: '.mouaif/logs/build.log' } }
  ] };
  assert.equal(vm.runInContext('formatResultSummary("group_cli", result)', cardContext), '1 ok · 1 running · 120ms');
  cardContext.preview = cardContext.document.createElement();
  vm.runInContext('renderToolResultBody(preview, { name: "group_cli", result, args }, () => false)', cardContext);
  const textOf = (item) => [item.textContent, ...(item.children || []).map(textOf)].join(' ');
  const rendered = textOf(cardContext.preview);
  assert.ok(rendered.includes('1. tests'), 'the entry is named (its label, like the batch arguments block)');
  assert.ok(rendered.includes('ok 1'), 'its output is shown');
  assert.ok(rendered.includes('.mouaif/logs/build.log'), 'a background entry names its log instead of output');
  assert.ok(rendered.includes('exit 0'), 'the exit status is shown per entry');
  assert.ok(rendered.includes('1 succeeded · 0 failed'), 'the batch tally is shown');

  console.log('group_cli: spec, validation, ordering, streaming, background mode, authorization, dispatcher, groups and card checks passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => { try { settings.close(); } catch { /* nothing to close */ } });
