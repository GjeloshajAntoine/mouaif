'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

(async () => {
  const { costSnapshot, summarizeChatUsage: summarize, attributedCostAfter } = await import('../frontend/src/components/chat/costSummary.js');
  const { mergeServerRows, nextServerMessageIndex, tailSyncDomAction } = await import('../frontend/src/components/chat/msgMerge.js');
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
  // An attributed non-turn run (dictation) rides on top of the snapshot, since
  // it writes no message row the snapshot could cover…
  assert.equal(summarize(page, baseline, null, 0.5).totalCost, 10.5);
  assert.equal(summarize(page, baseline, null, 0.5).hasKnownCost, true);
  assert.equal(summarize([], costSnapshot({ nextSeq: 0, totalCost: { total: 0, known: false } }), null, 0.5).hasKnownCost, true);
  // …and nothing else moves when there is none.
  assert.equal(summarize(page, baseline, null, 0).totalCost, 10);
  assert.equal(summarize(page, baseline, null, undefined).totalCost, 10);
  // The accumulator keys on the snapshot object, so runs pile up while one
  // snapshot is authoritative and restart once a rebase installs a fresh one
  // (which already covers them — the number is never added twice).
  {
    const first = attributedCostAfter(null, baseline, 0.5);
    assert.deepEqual(first, { snapshot: baseline, total: 0.5 });
    const second = attributedCostAfter(first, baseline, 0.25);
    assert.deepEqual(second, { snapshot: baseline, total: 0.75 });
    const rebased = attributedCostAfter(second, costSnapshot({ nextSeq: 201, totalCost: cost(11) }), 0.25);
    assert.equal(rebased.total, 0.25, 'a new snapshot starts the accumulator over');
    assert.equal(attributedCostAfter(null, baseline, 0), null);
    assert.equal(attributedCostAfter(null, baseline, 'lots'), null);
  }
  console.log('PASS paginated totals, live segments, subagent costs, unknown/zero costs and fallback');

  // A summary rebuild that passes no live info (tail sync, reconcile,
  // backfill) must still count the running turn's in-flight subagent cost,
  // or the head Total dips mid-turn and jumps back on the next usage_update.
  {
    const { resolveLiveInfo } = await import('../frontend/src/components/chat/costSummary.js');
    const running = { _liveUsageInfo: () => ({ liveCost: cost(3) }) };
    assert.equal(summarize(page, baseline, resolveLiveInfo(running, null)).totalCost, 13);
    const explicit = { cost: cost(2) };
    assert.equal(resolveLiveInfo(running, explicit), explicit, 'explicit live info wins');
    assert.equal(resolveLiveInfo({}, null), null);
    assert.equal(resolveLiveInfo({ _liveUsageInfo: () => null }, null), null);
    assert.equal(resolveLiveInfo({ _liveUsageInfo: () => { throw new Error('x'); } }, null), null);
    assert.equal(summarize(page, baseline, resolveLiveInfo({ _liveUsageInfo: () => null }, null)).totalCost, 10);
  }
  console.log('PASS summary rebuilds without live info keep the in-flight subagent cost');

  // Run actual tail-sync code: replacement-only merges must rebase and repaint.
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/stream.js'), 'utf8');
  const syncSource = source.slice(source.indexOf('function applyTailSync('), source.indexOf('// startStreamRecovery / stopStreamRecovery'));
  let painted;
  let reconciled;
  const context = vm.createContext({
    mergeServerRows, nextServerMessageIndex, costSnapshot,
    // applyTailSync routes a moved prefix to a full reconcile render, so the
    // slice needs the same helpers the module imports. `_renderTranscript`
    // stands in for that render: this case only asserts the cost lines.
    // `syncTranscriptAppend` covers the cheap append path.
    tailSyncDomAction,
    fetchMessagesFromSeq: async () => ({ messages: [row(200, 2)], nextSeq: 201, totalCost: cost(12) }),
    syncTranscriptAppend() {},
    updateUsageSummary: (state) => { painted = summarize(state.messages, state.costSnapshot, null, state.attributedCost).totalCost; }
  });
  vm.runInContext(syncSource + ';this.sync = syncToNextSeq;', context);
  const state = { props: { projectDir: '/test', chatId: 'test' }, messages: [...page, row(undefined, 2)], seenSeqs: new Set([198, 199]), transcriptNextSeq: 200, costSnapshot: baseline, attributedCost: 0.5, _renderTranscript() { reconciled = true; } };
  await context.sync(state, {}, 201);
  assert.equal(painted, 12);
  assert.equal(state.messages.length, 3);
  assert.equal(state.costSnapshot.nextSeq, 201);
  // The refreshed snapshot already covers the attributed run, so the session
  // delta is rebased away in the same step — the 12 above is not 12.5.
  assert.equal(state.attributedCost, 0);
  // The merge replaced the seq-less optimistic twin in place, so the prefix
  // moved and applyTailSync must take the reconcile render, not the cheap
  // tail append that would repaint the on-screen row (see msgMerge.js).
  assert.equal(reconciled, true, 'a replaced optimistic twin routes to the reconcile render');
  console.log('PASS reconciliation replaces optimistic cost without double counting');

  // And the cheap path is kept for a genuine append: nothing on screen moves,
  // so re-rendering the transcript would be a needless repaint.
  {
    const u = { role: 'user', content: 'hi', ts: 'S', seq: 210 };
    const appendRefs = {};
    let appended = false;
    const ctx = vm.createContext({
      mergeServerRows, nextServerMessageIndex, costSnapshot, tailSyncDomAction,
      fetchMessagesFromSeq: async () => ({ messages: [{ role: 'assistant', content: 'a', ts: 'S', seq: 211, cost: cost(0) }], nextSeq: 212, totalCost: cost(12) }),
      syncTranscriptAppend() { appended = true; },
      updateUsageSummary() {}
    });
    vm.runInContext(syncSource + ';this.sync = syncToNextSeq;', ctx);
    const appendState = { props: { projectDir: '/test', chatId: 'test' }, messages: [u], seenSeqs: new Set([210]), transcriptNextSeq: 211, costSnapshot: baseline, attributedCost: 0, _renderTranscript() { throw new Error('a pure append must not re-render the transcript'); } };
    await ctx.sync(appendState, appendRefs, 212);
    assert.equal(appended, true, 'a pure append uses the cheap tail append');
    assert.equal(appendState.messages.length, 2);
  }
  console.log('PASS a pure append still uses the cheap tail render');

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
