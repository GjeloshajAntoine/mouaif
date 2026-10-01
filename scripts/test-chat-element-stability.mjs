// Browser regression for progress/error row order and identity, using an
// isolated transcript fixture (no live projects, chats, or app server).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const { findChrome, createCdp, freePort } = require('./lib/capture-fixture.js');

const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
    import * as transcript from './frontend/src/components/chat/transcript.js';
    import { messageKind } from './frontend/src/components/chat/messageKind.js';
    import './frontend/src/style.css';
    const root = document.querySelector('.chat-view__transcript');
    const refs = { transcript: { current: root }, pinnedToBottom: { current: false },
      pendingCount: { current: 0 }, jumpBtn: { current: null }, usageSummary: { current: null },
      _suspendScrollPin: true };
    const user = { role: 'user', seq: 0, content: 'Build this', ts: new Date().toISOString() };
    let retries = 0;
    const state = { chat: {}, messages: [user], _retryFailedTurn: () => { retries++; } };
    const call = (id, name, args, seq) => ({ role: 'tool', phase: 'call', toolCallId: id, name, args, content: JSON.stringify(args), seq });
    const result = (id, name, value, seq) => ({ role: 'tool', phase: 'result', toolCallId: id, name, ok: true, content: JSON.stringify(value), seq });
    function reconcile() { return transcript.reconcileTranscriptRows(state, refs, state.messages.map((_, i) => i)); }
    function reset() { root.replaceChildren(); refs._toolCardIndex = null; refs._insertAnchor = null; state.messages = [user]; reconcile(); }
    window.fixture = { root, refs, state, call, result, reconcile, reset, transcript, messageKind, retryCount: () => retries };
    window.ready = true;
  ` },
  bundle: true, write: false, outdir: '/tmp/mouaif-element-stability-bundle', format: 'esm',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }
});
const files = Object.fromEntries(bundle.outputFiles.map(file => ['/' + path.basename(file.path), file.text]));
const server = http.createServer((req, res) => {
  const file = files[req.url];
  res.writeHead(200, { 'Content-Type': file ? (req.url.endsWith('.css') ? 'text/css' : 'text/javascript') : 'text/html' });
  res.end(file || '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/stdin.css"></head><body><div class="chat-view__transcript" style="width:100%;height:80dvh"></div><script type="module" src="/stdin.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let chrome, cdp, profile;
try {
  const binary = findChrome();
  assert.ok(binary, 'Chrome is required for the transcript regression');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-element-stability-'));
  chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 100; i++) {
    try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(p => p.type === 'page'); } catch {}
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Chrome started');
  cdp = await createCdp(page.webSocketDebuggerUrl);
  const evaluate = async expression => {
    const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result.value;
  };
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  for (let i = 0; i < 100 && !await evaluate('!!window.ready'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate('!!window.ready'), true, 'fixture loaded');

  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
    const live = await evaluate(`(() => {
      const f = fixture; f.reset();
      const data = { title: 'Build a long title that stays readable on a narrow mobile screen', current: 1, total: 4, status: 'running', message: 'Checking source files' };
      const card = f.transcript.appendToolCallCard({ id: 'p1', name: 'report_progress', args: data }, f.refs);
      const head = card.querySelector('.tool-card__head');
      f.transcript.updateProgressCard(f.refs, { ...data, callId: 'p1', current: 2 });
      f.transcript.appendToolResultCard({ id: 'p1', name: 'report_progress', ok: true, result: { ...data, current: 2 } }, f.refs);
      // Later rows already exist when the authoritative call/result sync arrives.
      const answer = { role: 'assistant', seq: 3, content: 'Partial answer', ts: new Date().toISOString() };
      f.state.messages.push(f.call('p1', 'report_progress', data, 1), f.result('p1', 'report_progress', { ...data, current: 2 }, 2), answer);
      f.transcript.appendMessageToTranscript(answer, false, f.refs, f.state);
      f.root.lastElementChild._rowKey = f.transcript.transcriptRowKey(answer);
      f.transcript.appendErrorCard('Provider failed', f.refs, f.state, { clientId: 'e1', onRetry: () => f.state._retryFailedTurn({}) });
      const error = f.root.lastElementChild;
      const retry = error.querySelector('.chat-msg__retry');
      f.reconcile();
      const observer = new MutationObserver(() => {});
      observer.observe(f.root, { childList: true, subtree: true, attributes: true, characterData: true });
      f.reconcile();
      const mutations = observer.takeRecords().length; observer.disconnect();
      retry.click();
      const rect = card.getBoundingClientRect();
      return { order: Array.from(f.root.children).map(n => n.dataset.toolId || n._rowKey),
        progressCount: f.root.querySelectorAll('.tool-card--progress').length,
        sameCard: card === f.root.children[1], sameHead: head === card.querySelector('.tool-card__head'),
        sameError: error === f.root.lastElementChild, sameRetry: retry === error.querySelector('.chat-msg__retry'),
        mutations, retryCount: f.retryCount(), errorKind: f.messageKind(f.state.messages.at(-1)),
        percent: card.querySelector('.tool-card__progress-pct').textContent,
        fits: rect.left >= 0 && rect.right <= innerWidth + 1 };
    })()`);
    assert.deepEqual(live.order, ['seq:0', 'p1', 'seq:3', 'cid:e1'], 'rows keep conversation order at ' + width);
    assert.equal(live.progressCount, 1, 'one progress card per call');
    assert.ok(live.sameCard && live.sameHead && live.sameError && live.sameRetry, 'nodes and Retry stay mounted');
    assert.equal(live.mutations, 0, 'unchanged reconciliation is a DOM no-op');
    assert.equal(live.retryCount, 2 * [360, 390, 430].indexOf(width) + 1, 'Retry remains functional');
    assert.equal(live.errorKind, 'error', 'local error stays classified as an error');
    assert.equal(live.percent, '50%');
    assert.ok(live.fits, 'progress card fits the phone');

    const replay = await evaluate(`(() => {
      const f = fixture;
      // Rebuild a local failure from state: Retry must not become a plain bubble.
      const saved = f.state.messages; f.root.replaceChildren(); f.state.messages = saved;
      f.reconcile();
      const error = f.root.lastElementChild;
      const retry = error.querySelector('.chat-msg__retry');
      const localRetry = !!retry; if (retry) retry.click();
      // Result-first backfill, then replay/reconciliation, must reuse one card.
      f.reset();
      const data = { title: 'Build finished', current: 1, total: 4, status: 'completed', message: 'Done' };
      const anchor = f.root.firstElementChild; f.refs._insertAnchor = anchor;
      f.transcript.appendToolResultCard({ id: 'p2', name: 'report_progress', ok: true, result: data }, f.refs);
      const card = f.root.firstElementChild;
      const usedAnchor = card !== anchor && card.nextElementSibling === anchor;
      f.refs._insertAnchor = null;
      f.state.messages.push(f.call('p2', 'report_progress', data, 1), f.result('p2', 'report_progress', data, 2));
      f.reconcile(); f.reconcile();
      return { localRetry, sameCard: f.root.children[1] === card, usedAnchor,
        progressCount: f.root.querySelectorAll('.tool-card--progress').length,
        percent: card.querySelector('.tool-card__progress-pct').textContent,
        title: card.querySelector('.tool-card__name').textContent,
        warningCount: (error.querySelector('.chat-msg__body').textContent.match(/⚠/g) || []).length };
    })()`);
    assert.equal(replay.warningCount, 1, 'rebuilding does not duplicate the warning marker');
    assert.ok(replay.localRetry, 'rebuilt local error restores Retry');
    assert.ok(replay.sameCard && replay.usedAnchor, 'result-first progress honors backfill anchor and reuses its node');
    assert.equal(replay.progressCount, 1);
    assert.equal(replay.percent, '100%', 'completed uses the same percentage as nested progress');
    assert.equal(replay.title, 'Build finished');
  }

  const task = await evaluate(`(() => {
    const f = fixture; f.reset();
    const args = { action: 'update_progress', taskId: 'task1', current: 2, total: 4 };
    const card = f.transcript.appendToolCallCard({ id: 't1', name: 'task', args }, f.refs);
    f.transcript.updateProgressCard(f.refs, { callId: 't1', title: 'Task', current: 2, total: 4, status: 'running' });
    const result = { action: 'progress_updated', task: { title: 'Task', current: 2, total: 4, status: 'in_progress' } };
    f.transcript.appendToolResultCard({ id: 't1', name: 'task', ok: true, result }, f.refs);
    f.state.messages.push(f.call('t1', 'task', args, 1), f.result('t1', 'task', result, 2));
    f.reconcile(); f.reconcile();
    const inPlace = card === f.root.children[1];
    const count = f.root.querySelectorAll('.tool-card--progress').length;
    f.transcript.updateProgressCard(f.refs, { callId: 't1', title: 'Renamed task', current: 3, total: 4, status: 'failed' });
    return { inPlace, count, title: card.querySelector('.tool-card__name').textContent, status: card.dataset.status,
      percent: card.querySelector('.tool-card__progress-pct').textContent };
  })()`);
  assert.ok(task.inPlace, 'task progress upgrades its call card in place');
  assert.equal(task.count, 1);
  assert.equal(task.title, 'Renamed task');
  assert.equal(task.status, 'failed');
  assert.equal(task.percent, '75%', 'failure keeps actual progress');
  const restoredTask = await evaluate(`(() => {
    const f = fixture;
    const saved = f.state.messages;
    f.root.replaceChildren(); f.state.messages = saved; f.reconcile();
    const card = f.root.children[1];
    return { count: f.root.querySelectorAll('.tool-card--progress').length,
      percent: card.querySelector('.tool-card__progress-pct').textContent,
      name: card.dataset.toolName };
  })()`);
  assert.equal(restoredTask.count, 1, 'task progress is restored from persisted results');
  assert.equal(restoredTask.percent, '50%');
  assert.equal(restoredTask.name, 'task');
  console.log('PASS chat element order, stable progress/error/Retry nodes, replay/backfill, task progress, and 360/390/430px widths');
} finally {
  if (cdp) cdp.close();
  if (chrome) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await exited; }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
}
