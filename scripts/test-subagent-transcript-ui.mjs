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
    `,
    resolveDir: process.cwd(), sourcefile: 'subagent-transcript-fixture.js', loader: 'js'
  },
  bundle: true, write: false, outdir: '/tmp/mouaif-subagent-transcript', format: 'esm',
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl' }
});
const files = Object.fromEntries(bundle.outputFiles.map((f) => [f.path.endsWith('.css') ? '/app.css' : '/app.js', f.text]));
const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div class="chat-view__transcript" style="padding:1rem;width:100%;box-sizing:border-box"></div><button onclick="window.__settle()" style="min-height:2.75rem">Settle fixture</button><script type="module" src="/app.js"></script></body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': files[req.url] ? (req.url.endsWith('.css') ? 'text/css' : 'text/javascript') : 'text/html' });
  res.end(files[req.url] || page);
});
server.listen(0, '127.0.0.1', () => console.log('subagent transcript fixture: http://127.0.0.1:' + server.address().port));
setTimeout(() => { server.closeAllConnections(); server.close(); }, 5 * 60 * 1000).unref();
