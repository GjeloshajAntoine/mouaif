'use strict';
// Regression test: the direct @agent dispatch must fold its result into the
// call card it opened, not strand it.
//
// runAgentCommand() opened the subagent call card with the literal id
// 'pending' but appended the result keyed by the id the SERVER minted
// (`direct_…`). The transcript matches a result to its card by
// `data-tool-id`, so the two never met: the result became a second card and
// the first sat on the busy "running" pill and "Subagent is working…" forever,
// even though the run had finished. registerAnonToolCall() could not rescue it
// either — that path only runs for a FALSY call id, and 'pending' is truthy.
//
// The fix returns the card from appendToolCallCard and re-keys it to the
// server id before the result is appended, so the result updates that card in
// place. When the request fails outright there is no id to adopt, so the card
// is retired rather than left spinning.
//
// The production runAgentCommand source is extracted and executed in a VM with
// stubbed network/UI dependencies, the same technique
// scripts/test-chat-stream-abort.js uses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/stream.js'), 'utf8');
const chunk = source
  .slice(source.indexOf('export async function runAgentCommand('), source.indexOf('export async function runMcpCommand('))
  .replace('export async function runAgentCommand(', 'async function runAgentCommand(');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// A card stand-in that records the mutations runAgentCommand performs.
function makeCard(id) {
  return { dataset: { toolId: id }, isConnected: true, removed: false, remove() { this.removed = true; } };
}

function makeContext(net, effectsOut) {
  const effects = effectsOut;
  const base = {
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout,
    fetchJson: net.fetchJson,
    // The card the call opens. runAgentCommand re-keys it to the server's id.
    appendToolCallCard: (call) => { effects.call = call; effects.card = makeCard(call.id); effects.annotations++; return effects.card; },
    // Re-keying now goes through transcript.js's rekeyToolCard (which updates
    // the card index alongside the attribute), so the stub mirrors its contract:
    // it moves `dataset.toolId` and drops a stale index entry.
    rekeyToolCard: (refs, id, card) => { if (card) card.dataset.toolId = String(id); },
    appendToolResultCard: (result) => { effects.result = result; effects.appended.push(result); },
    setChatStatus: (refs, text, kind) => { refs.status.current.textContent = text; effects.status.push(kind); },
    appendMessageToTranscript: () => {},
    updateUsageSummary: () => {}
  };
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(chunk + '; this.runAgentCommand = runAgentCommand;', context);
  context.effects = effects;
  return context;
}

function makeState() {
  return {
    props: { projectDir: '/project', chatId: 'chat-a' },
    messages: [],
    _setRunningVisible: () => {}
  };
}

function makeRefs() {
  return {
    promptInput: { current: { value: 'do the thing' } },
    sendBtn: { current: { disabled: false } },
    status: { current: { textContent: '', dataset: {} } },
    transcript: { current: { querySelector: () => null, appendChild() {} } },
    _autoresize() {}
  };
}

(async () => {
  // ---- the happy path: the card adopts the server's id --------------
  {
    const effects = { appended: [], status: [] };
    const context = makeContext({
      fetchJson: async () => ({ status: 200, body: { ok: true, id: 'direct_abc123', result: { text: 'done' } } })
    }, effects);
    await context.runAgentCommand('search', 'find things', makeState(), makeRefs());

    check('the call card is opened', !!effects.call);
    check('the card is re-keyed to the server id',
      effects.card.dataset.toolId === 'direct_abc123', effects.card.dataset.toolId);
    check('the card is NOT stranded (not removed) on success', effects.card.removed === false);
    check('the result was appended once', effects.appended.length === 1);
    check('the result carries the SAME id as the card, so it matches in place',
      effects.appended[0].id === effects.card.dataset.toolId,
      'result=' + effects.appended[0].id + ' card=' + effects.card.dataset.toolId);
    check('the placeholder id never survives', effects.card.dataset.toolId !== 'pending');
  }

  // ---- a failed run that still reports an id -----------------------
  {
    const effects = { appended: [], status: [] };
    const context = makeContext({
      fetchJson: async () => ({ status: 200, body: { ok: false, id: 'direct_fail9', result: { error: 'boom' } } })
    }, effects);
    await context.runAgentCommand('search', 'x', makeState(), makeRefs());
    check('a failed run also re-keys the card rather than adding a twin',
      effects.card.dataset.toolId === 'direct_fail9', effects.card.dataset.toolId);
    check('the failed result matches the card id',
      effects.appended[0].id === effects.card.dataset.toolId);
  }

  // ---- the request itself throws: no id exists ---------------------
  {
    const effects = { appended: [], status: [] };
    const context = makeContext({
      fetchJson: async () => { throw new Error('connection refused'); }
    }, effects);
    await context.runAgentCommand('search', 'x', makeState(), makeRefs());
    check('the placeholder card is retired when the request throws',
      effects.card.removed === true);
    check('the error is still reported as a result card', effects.appended.length === 1 && effects.appended[0].ok === false);
    check('the status row says agent error', effects.status.includes('error'));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
  assert.ok(passed > 0);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
