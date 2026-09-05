'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

(async () => {
  const { costSnapshot, summarizeChatUsage: summarize } = await import('../frontend/src/components/chat/costSummary.js');
  const { mergeServerRows, nextServerMessageIndex } = await import('../frontend/src/components/chat/msgMerge.js');
  const cost = (total) => ({ total, known: true });
  const row = (seq, total) => ({ role: 'assistant', content: String(total), seq, cost: cost(total) });
  const baseline = costSnapshot({ nextSeq: 200, totalCost: cost(10) });
  const page = [row(198, 1), row(199, 1)];
  assert.equal(summarize(page, baseline).totalCost, 10);
  assert.equal(summarize([row(0, 8), ...page], baseline).totalCost, 10);
  assert.equal(summarize([...page, row(undefined, 2)], baseline).totalCost, 12);
  assert.equal(summarize([...page, row(200, 2)], baseline).totalCost, 12);
  assert.equal(summarize(page, baseline, { cost: cost(2), liveCost: cost(3) }).totalCost, 15);
  assert.equal(summarize([...page, row(undefined, 5)], baseline).totalCost, 15);
  assert.equal(summarize([...page, row(200, 5)], costSnapshot({ nextSeq: 201, totalCost: cost(15) })).totalCost, 15);
  assert.equal(summarize([], costSnapshot({ nextSeq: 0, totalCost: { total: 0, known: false } })).hasKnownCost, false);
  assert.equal(summarize([], costSnapshot({ nextSeq: 1, totalCost: cost(0) })).hasKnownCost, true);
  assert.equal(summarize([row(0, 2)], null).totalCost, 2); // older-server fallback
  assert.equal(costSnapshot({ totalCost: cost(10) }), null);
  assert.equal(summarize([{ ...row(199, 1), usage: { promptTokens: 50 } }], baseline).latestContext, 50);
  console.log('PASS paginated totals, live segments, subagent costs, unknown/zero costs and fallback');

  // Run actual tail-sync code: replacement-only merges must rebase and repaint.
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/stream.js'), 'utf8');
  const syncSource = source.slice(source.indexOf('function applyTailSync('), source.indexOf('// startStreamRecovery / stopStreamRecovery'));
  let painted;
  const context = vm.createContext({
    mergeServerRows, nextServerMessageIndex, costSnapshot,
    fetchMessagesFromSeq: async () => ({ messages: [row(200, 2)], nextSeq: 201, totalCost: cost(12) }),
    syncTranscriptAppend() {},
    updateUsageSummary: (state) => { painted = summarize(state.messages, state.costSnapshot).totalCost; }
  });
  vm.runInContext(syncSource + ';this.sync = syncToNextSeq;', context);
  const state = { props: { projectDir: '/test', chatId: 'test' }, messages: [...page, row(undefined, 2)], seenSeqs: new Set([198, 199]), transcriptNextSeq: 200, costSnapshot: baseline };
  await context.sync(state, {}, 201);
  assert.equal(painted, 12);
  assert.equal(state.messages.length, 3);
  assert.equal(state.costSnapshot.nextSeq, 201);
  console.log('PASS reconciliation replaces optimistic cost without double counting');

  // Exercise the real HTTP handler and SQLite totals, not a CLI/server restart.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-cost-summary-'));
  process.env.MOUAIF_HOME = home;
  process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
  const projectDir = path.join(home, 'project');
  fs.mkdirSync(projectDir);
  const chats = require('../src/chats.js');
  const messages = require('../src/messages.js');
  const { createServer } = require('../src/index.js');
  const chat = chats.createChat(projectDir, { title: 'cost summary test' });
  for (let i = 0; i < 120; i++) messages.appendMessage(projectDir, chat.id, row(undefined, 1));
  const server = createServer(0);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port + '/api/chats/' + chat.id + '/messages?projectDir=' + encodeURIComponent(projectDir);
    for (const suffix of ['&limit=100', '&limit=20&beforeSeq=20', '&fromSeq=119', '']) {
      const response = await fetch(base + suffix);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.totalCost.total, 120);
      assert.equal(body.nextSeq, 120);
      assert.equal(summarize(body.messages, costSnapshot(body)).totalCost, 120);
      if (suffix === '&limit=100') assert.equal(body.messages.length, 100);
    }
    messages.appendMessage(projectDir, chat.id, row(undefined, 3));
    const tail = await fetch(base + '&fromSeq=120').then((r) => r.json());
    assert.equal(tail.totalCost.total, 123);
    assert.equal(tail.nextSeq, 121);
    assert.equal(tail.messages.length, 1);
    assert.equal(summarize(tail.messages, costSnapshot(tail)).totalCost, 123);
    console.log('PASS window, older page, tail and legacy HTTP responses carry cursor-aligned totals');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
