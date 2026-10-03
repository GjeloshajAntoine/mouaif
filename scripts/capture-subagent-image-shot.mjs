// Reproducible presentation capture using the production transcript renderer
// and styles. Local illustrative pixels only: no provider calls or app store.
// node scripts/capture-subagent-image-shot.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { findChrome, createCdp, waitForFile, freePort } from './lib/capture-fixture.js';

const out = path.resolve('docs/features/images/landing/subagent-images.png');
const chromeBin = findChrome();
if (!chromeBin) throw new Error('Chrome is required; set CHROME_PATH.');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-image-shot-'));
let chrome;
let server;
let cdp;
try {
  const bundle = await build({
    stdin: { contents: `
      import { appendMessageToTranscript, appendToolCallCard, appendToolResultCard } from './frontend/src/components/chat/transcript.js';
      import './frontend/src/style.css';
      const root = document.querySelector('.chat-view__transcript');
      const refs = { transcript: { current: root }, pinnedToBottom: { current: false }, pendingCount: { current: 0 }, _suspendScrollPin: true };
      const state = { chat: { modelId: 'Main model' }, props: {} };
      // Illustrated fixture artwork, drawn locally rather than pretending
      // a paid provider produced it. The UI itself is the real renderer.
      function bird(refined) {
        const canvas = document.createElement('canvas');
        canvas.width = 300; canvas.height = 120;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = refined ? '#eaf4ff' : '#fff'; ctx.fillRect(0, 0, 300, 120);
        ctx.fillStyle = '#4296e5';
        ctx.beginPath(); ctx.ellipse(146, 66, 35, 23, -.15, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(175, 43, 18, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(117, 63); ctx.lineTo(91, 42); ctx.lineTo(101, 75); ctx.fill();
        ctx.fillStyle = '#2467ad'; ctx.beginPath(); ctx.ellipse(138, 65, 21, 12, -.4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fbad48'; ctx.beginPath(); ctx.moveTo(189, 43); ctx.lineTo(209, 48); ctx.lineTo(189, 53); ctx.fill();
        ctx.fillStyle = '#102137'; ctx.beginPath(); ctx.arc(180, 39, 3, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fbad48'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(144, 86); ctx.lineTo(142, 100); ctx.lineTo(153, 100); ctx.stroke();
        if (refined) { ctx.strokeStyle = '#8ec5ed'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(95, 104); ctx.lineTo(212, 104); ctx.stroke(); }
        return canvas.toDataURL('image/png');
      }
      const input = bird(false), output = bird(true);
      appendMessageToTranscript({ role: 'assistant', content: 'I’ll send only blue-bird.png to Artist. The other attachment stays in this chat.' }, false, refs, state);
      const args = { task: 'Refine the selected blue bird icon.', agent: 'Artist', images: ['message:12:0'] };
      appendToolCallCard({ id: 'image-demo', name: 'subagent', args }, refs);
      const image = { type: 'image', mimeType: 'image/png', data: output.split(',')[1] };
      appendToolResultCard({ id: 'image-demo', name: 'subagent', ok: true, result: {
        ok: true, agent: 'Artist', model: { id: 'Image model' }, text: 'Refined the bird with a softer background.', content: [image],
        chat: [
          { role: 'system', content: [{ type: 'text', text: 'Refine only the selected image. Preserve the blue bird.' }] },
          { role: 'user', content: [{ type: 'text', text: 'Refine the selected blue bird icon.' }, { type: 'image_url', image_url: { url: input } }] },
          { role: 'assistant', content: 'Refined the bird with a softer background.', images: [image] }
        ]
      } }, refs);
      // Fold only the system disclosure, like a user tapping its summary,
      // to keep selected input and returned artwork together in the frame.
      const disclosure = root.querySelector('.tool-card__subagent-chat details');
      if (disclosure) disclosure.open = false;
      window.checkCapture = async () => {
        await Promise.all([...root.querySelectorAll('img')].map(img => img.decode()));
        root.scrollTop = 0;
        const card = root.querySelector('.tool-card--subagent');
        const input = card.querySelector('.chat-msg--user .chat-msg__attachment-button');
        const output = card.querySelector('.chat-msg--assistant .tool-card__image-button');
        const answer = card.querySelector('.chat-msg--assistant .chat-msg__answer');
        const visible = el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight; };
        if (!input || !output || !visible(input) || !visible(output)) throw new Error('Image inputs/output must fit capture');
        if (!answer.textContent.includes('Refined the bird')) throw new Error('Artwork erased answer');
        if (root.scrollWidth > root.clientWidth + 1) throw new Error('Horizontal overflow');
        input.click();
        if (!document.querySelector('[role="dialog"]')) throw new Error('Input lightbox missing');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { width: innerWidth, height: innerHeight, input: true, output: true, zoom: true };
      };
    `, resolveDir: process.cwd(), sourcefile: 'subagent-image-presentation.js', loader: 'js' },
    bundle: true, write: false, outdir: tmp, format: 'esm', loader: { '.woff': 'dataurl', '.woff2': 'dataurl' }
  });
  const files = Object.fromEntries(bundle.outputFiles.map(f => [f.path.endsWith('.css') ? '/app.css' : '/app.js', f.text]));
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Selected image → subagent</title><link rel="stylesheet" href="/app.css"></head><body><main class="chat-view" style="height:100dvh"><header style="padding:.75rem 1rem;border-bottom:1px solid var(--border)"><strong>Selected image → subagent</strong><div style="font-size:.8rem;margin-top:.25rem">Only chosen attachments are shared</div></header><div class="chat-view__transcript"></div></main><script type="module" src="/app.js"></script></body></html>';
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': files[req.url] ? (req.url.endsWith('.css') ? 'text/css' : 'text/javascript') : 'text/html' });
    res.end(files[req.url] || html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const logPath = path.join(tmp, 'chrome.log');
  const log = fs.openSync(logPath, 'w');
  chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(tmp, 'profile'), 'about:blank'], { stdio: ['ignore', log, log] });
  fs.closeSync(log);
  await waitForFile(logPath);
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  cdp = await createCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const scriptError = cdp.once('Runtime.exceptionThrown', 10000).catch(() => null);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 700, deviceScaleFactor: 2, mobile: true });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
  await loaded;
  const ready = await cdp.send('Runtime.evaluate', {
    expression: 'new Promise((resolve) => { const start = Date.now(); const poll = () => { if (window.checkCapture) resolve(true); else if (Date.now() - start > 3000) resolve(false); else setTimeout(poll, 50); }; poll(); })',
    awaitPromise: true, returnByValue: true
  });
  if (!ready.result.value) throw new Error('Capture fixture failed to initialize: ' + JSON.stringify(await scriptError));
  const check = async () => {
    const result = await cdp.send('Runtime.evaluate', { expression: 'window.checkCapture()', awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    assert.equal(result.result.value.zoom, true);
    console.log('capture checks: ' + JSON.stringify(result.result.value));
  };
  await check();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const png = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(out, Buffer.from(png.data, 'base64'));
  for (const width of [360, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: true });
    await check();
  }
  console.log('wrote ' + path.relative(process.cwd(), out));
} finally {
  if (cdp) cdp.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (chrome) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill('SIGTERM'); await exited; }
  fs.rmSync(tmp, { recursive: true, force: true });
}
