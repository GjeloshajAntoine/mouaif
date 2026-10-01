// Real renderer/mobile fixture. Open the printed URL with Chrome debug.
// Serves an isolated fixture, never starts or restarts the mouaif server.
import http from 'node:http';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      import { appendToolCallCard, appendToolResultCard, handleSubagentStreamEvent } from './frontend/src/components/chat/transcript.js';
      import './frontend/src/style.css';
      const root = document.querySelector('.chat-view__transcript');
      const refs = { transcript: { current: root }, pinnedToBottom: { current: false }, pendingCount: { current: 0 }, _suspendScrollPin: true };
      const task = 'Read the complete delegated conversation and keep all intermediate replies, reasoning and tool results visible. '.repeat(4);
      const args = { task, agent: 'Very-long-reviewer-name-that-must-wrap-instead-of-hiding-the-cost' };
      appendToolCallCard({ id: 'mobile', name: 'subagent', args }, refs);
      const prompt = 'You are the reviewer. Read the source carefully and report evidence. '.repeat(6);
      handleSubagentStreamEvent({ eventName: 'start' }, { parentCallId: 'mobile', agent: args.agent, model: { id: 'mock' }, chat: [
        { role: 'system', content: [{ type: 'text', text: prompt }] },
        { role: 'user', content: task }
      ] }, refs);
      handleSubagentStreamEvent({ eventName: 'usage_update' }, { parentCallId: 'mobile', totalCost: 0.0123 }, refs);
      handleSubagentStreamEvent({ eventName: 'reasoning' }, { parentCallId: 'mobile', delta: 'Inspecting the source.' }, refs);
      handleSubagentStreamEvent({ eventName: 'message' }, { parentCallId: 'mobile', delta: 'Starting the review.' }, refs);
      handleSubagentStreamEvent({ eventName: 'assistant_turn_end' }, { parentCallId: 'mobile' }, refs);
      handleSubagentStreamEvent({ eventName: 'tool_call' }, { parentCallId: 'mobile', id: 'read', name: 'read_file', args: { path: 'src/index.js' } }, refs);
      handleSubagentStreamEvent({ eventName: 'tool_result' }, { parentCallId: 'mobile', id: 'read', name: 'read_file', ok: true, result: { relPath: 'src/index.js', body: 'Evidence', startLine: 1, endLine: 1, totalLines: 1 } }, refs);
      handleSubagentStreamEvent({ eventName: 'message' }, { parentCallId: 'mobile', delta: 'Final answer.' }, refs);
      window.__settle = () => appendToolResultCard({ id: 'mobile', name: 'subagent', ok: true, result: {
        totalCost: 0.0123, model: { id: 'mock' }, agent: args.agent,
        chat: [
        { role: 'system', content: [{ type: 'text', text: prompt }] },
        { role: 'user', content: task },
          { role: 'assistant', content: 'Starting the review.', reasoning: 'Inspecting the source.', tool_calls: [{ id: 'read', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/index.js' }) } }] },
          { role: 'tool', name: 'read_file', tool_call_id: 'read', content: JSON.stringify({ relPath: 'src/index.js', body: 'Evidence', startLine: 1, endLine: 1, totalLines: 1 }) },
          { role: 'assistant', content: null, reasoning: 'Reasoning-only turn.' },
          { role: 'assistant', content: 'Final answer.' }
        ]
      } }, refs);
      window.__task = task;
      // Assert browser geometry with the production stylesheet, not mockup
      // overrides. The visible result makes the fixture usable without CDP
      // script evaluation (and catches live-to-settled layout regressions).
      window.__checkLayout = (phase) => {
        const failures = [];
        const check = (ok, label) => { if (!ok) failures.push(label); };
        const card = root.querySelector('.tool-card--subagent');
        const head = card.querySelector(':scope > .tool-card__head');
        const body = card.querySelector(':scope > .tool-card__body');
        const rect = head.getBoundingClientRect();
        check(getComputedStyle(head).display === 'flex' && rect.height >= 44, 'inline touch-safe header');
        for (const selector of ['.tool-card__cost', '.tool-card__pill']) {
        const child = head.querySelector(selector).getBoundingClientRect();
        check(child.left >= rect.left && child.right <= rect.right + 1, 'visible ' + selector);
        }
        check(getComputedStyle(body).maxHeight === 'none', 'unclipped panel');
        check(getComputedStyle(body).overflowY === 'visible', 'no inner scroll box');
        check(body.scrollHeight <= body.clientHeight + 1, 'all conversation turns fit the panel');
        check(root.scrollWidth <= root.clientWidth + 1, 'no horizontal overflow');
        for (const row of card.querySelectorAll('.tool-card__subagent-msg')) {
        const parent = row.parentElement.getBoundingClientRect();
        check(Math.abs(row.getBoundingClientRect().width - parent.width) <= 1, 'full-width message row');
        }
        const final = [...card.querySelectorAll('.chat-msg__answer')].find((e) => e.textContent === 'Final answer.');
        check(!!final && final.getBoundingClientRect().height < 30, 'short answer stays on one line');
        check(card.querySelector('.chat-msg__system-body')?.textContent === prompt, 'complete prompt');
        check(card.querySelector('.chat-msg--user .chat-msg__body')?.textContent === task, 'complete task');
        head.click();
        check(getComputedStyle(body).display === 'none', 'collapse hides panel');
        head.click();
        check(getComputedStyle(body).display !== 'none', 'expand restores panel');
        const output = document.getElementById('layout-check');
        output.textContent = failures.length ? 'FAIL ' + phase + ': ' + failures.join(', ') : 'PASS ' + phase + ' layout at ' + window.innerWidth + 'px';
        output.dataset.status = failures.length ? 'failed' : 'passed';
        if (failures.length) console.error(output.textContent);
      };
      const settle = window.__settle;
      const cardIsSettled = () => root.querySelector('.tool-card--result') != null;
      window.__settle = () => { settle(); requestAnimationFrame(() => window.__checkLayout('settled')); };
      window.addEventListener('resize', () => requestAnimationFrame(() => window.__checkLayout(cardIsSettled() ? 'settled' : 'live')));
      requestAnimationFrame(() => window.__checkLayout('live'));
    `,
    resolveDir: process.cwd(), sourcefile: 'subagent-transcript-fixture.js', loader: 'js'
  },
  bundle: true, write: false, outdir: '/tmp/mouaif-subagent-transcript', format: 'esm',
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl' }
});
const files = Object.fromEntries(bundle.outputFiles.map((f) => [f.path.endsWith('.css') ? '/app.css' : '/app.js', f.text]));
const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><main class="chat-view" style="height:100dvh"><output id="layout-check" aria-live="polite"></output><div class="chat-view__transcript" style="padding:1rem;width:100%;box-sizing:border-box"></div><button onclick="window.__settle()" style="min-height:2.75rem;flex-shrink:0">Settle fixture</button></main><script type="module" src="/app.js"></script></body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': files[req.url] ? (req.url.endsWith('.css') ? 'text/css' : 'text/javascript') : 'text/html' });
  res.end(files[req.url] || page);
});
server.listen(0, '127.0.0.1', () => console.log('subagent transcript fixture: http://127.0.0.1:' + server.address().port));
setTimeout(() => { server.closeAllConnections(); server.close(); }, 5 * 60 * 1000).unref();
