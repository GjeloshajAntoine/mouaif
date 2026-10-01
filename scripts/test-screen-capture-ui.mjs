// Exercise the real Preact sheet in Chrome without the app store or server.
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

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="fixture"></div><script type="module">
import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import { ScreenCapturePanel } from '/frontend/src/components/chat/ScreenCapturePanel.jsx';
import { FileToolbar } from '/frontend/src/components/chat/FileToolbar.jsx';
import '/frontend/src/style.css';
window.attachments = []; window.attempts = 0; window.failSave = false;
function Fixture() {
  const [open, setOpen] = useState(false);
  return h('main', null,
    h('button', { id: 'open', onClick: () => setOpen(true) }, 'Open capture'),
    h(FileToolbar, { projectDir: '', onOpenScreenCapture: () => setOpen(true) }),
    open ? h(ScreenCapturePanel, { availableSlots: 8, onClose: () => setOpen(false), onAttach: async (images) => {
      window.attempts++; if (window.failSave) throw Error('fixture offline'); window.attachments = images;
    } }) : null);
}
render(h(Fixture), document.getElementById('fixture'));
window.ready = true;
</script></body></html>`;

const contents = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replaceAll("from '/frontend/", "from './frontend/").replace("import '/frontend/", "import './frontend/");
const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, outdir: '/tmp/mouaif-capture-bundle', format: 'esm', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' } });
const files = Object.fromEntries(bundle.outputFiles.map((file) => [file.path.endsWith('.css') ? '/app.css' : '/app.js', file.text]));
const server = http.createServer((req, res) => {
  if (req.url === '/sample-video.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(fs.readFileSync(new URL('./fixtures/screen-capture-video.mp4', import.meta.url))); }
  else if (files[req.url]) { res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(files[req.url]); }
  else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html.replace(/<script type="module">[\s\S]*?<\/script>/, '<link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script>')); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/fixture`;
const probe = await fetch(url);
assert.match(probe.headers.get('content-type'), /text\/html/);
assert.match(await probe.text(), /fixture/);
if (process.argv.includes('--serve')) {
  console.log(url);
  setTimeout(() => { server.closeAllConnections(); server.close(); }, 10 * 60 * 1000);
} else {
  let chrome, cdp, profile;
  try {
    const binary = findChrome();
    assert.ok(binary, 'Chrome is required for this browser regression');
    const port = await freePort();
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-capture-ui-'));
    chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    let pages;
    for (let i = 0; i < 100; i++) {
      try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (pages.some((page) => page.type === 'page')) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(pages?.length, 'Chrome started');
    cdp = await createCdp(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
      return result.result.value;
    };
    const wait = async (expression) => {
      for (let i = 0; i < 100; i++) { if (await evaluate('!!(' + expression + ')')) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
      throw Error('Timed out: ' + expression + ' · ' + JSON.stringify(await evaluate('({text:document.body.innerText, html:document.body.innerHTML.slice(0,2000)})')));
    };
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.enable');
    const navigation = await cdp.send('Page.navigate', { url });
    assert.equal(navigation.errorText, undefined, 'fixture navigation succeeds');
    await wait('window.ready && document.querySelector(".file-toolbar__trigger")');
    await evaluate(`document.querySelector('.file-toolbar__trigger').click()`);
    await wait('document.querySelector(".file-toolbar__menu")');
    assert.equal(await evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(b => b.textContent === 'Screen capture');
    return !!item && !item.disabled && item.getBoundingClientRect().height >= 44;
    })()`), true, 'capture is an enabled, tap-sized menu item');
    await evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(b => b.textContent === 'Screen capture').click()`);
    await wait('document.querySelector(".capture__sheet") && !document.querySelector(".file-toolbar__menu")');
    for (const width of [360, 390, 430]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth && document.querySelector(".capture__sheet").scrollWidth <= innerWidth'), true, `no horizontal overflow at ${width}px`);
      assert.equal(await evaluate('Array.from(document.querySelectorAll(".capture__sheet button")).filter(b => b.getClientRects().length).every(b => b.getBoundingClientRect().height >= 44)'), true, 'buttons have 44px targets');
    }
    // Import baseline, status-only change, then a body change. Status-only
    // frame must be skipped once the ignore preset has been selected.
    await evaluate(`document.querySelectorAll('.capture__actions')[3].querySelector('button').click()`);
    await evaluate(`(async () => {
      const files = [];
      for (let i = 0; i < 3; i++) {
        const c = document.createElement('canvas'); c.width = 200; c.height = 400;
        const ctx = c.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 200, 400);
        if (i > 0) { ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 200, 20); }
        if (i === 2) { ctx.fillStyle = 'blue'; ctx.fillRect(40, 80, 20, 30); }
        const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
        files.push(new File([blob], 'frame-' + i + '.png', { type: 'image/png' }));
      }
      const transfer = new DataTransfer(); files.forEach(file => transfer.items.add(file));
      const input = document.querySelector('input[type=file]'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await wait('document.querySelectorAll(".capture__frame").length === 2 && !document.querySelector("input[type=file]").disabled');
    assert.match(await evaluate('document.querySelectorAll(".capture__frame")[1].textContent'), /Crop at 40, 80 · 20 × 30/);
    assert.equal(await evaluate('window.attachments.length'), 0, 'no attachment before confirmation');
    assert.deepEqual(await evaluate(`(() => {
      const image = document.querySelector('.capture__frame img'); const c = document.createElement('canvas');
      c.width = image.naturalWidth; c.height = image.naturalHeight;
      const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0); return Array.from(ctx.getImageData(1, 1, 1, 1).data);
    })()`), [0, 0, 0, 255], 'ignored zone is actually black in the exported full PNG');
    // Draw a second ignored rectangle using touch-compatible pointer events.
    await evaluate(`(() => {
      const buttons = document.querySelectorAll('.capture__actions')[3].querySelectorAll('button'); buttons[1].click();
    })()`);
    await wait('document.querySelector(".capture__zone-preview--drawing")');
    await evaluate(`document.querySelector('.capture__zone-preview').scrollIntoView({block:'center'})`);
    const rect = await evaluate(`(() => { const r = document.querySelector('.capture__zone-preview').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x + rect.width * 0.6, y: rect.y + rect.height * 0.6, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + rect.width * 0.8, y: rect.y + rect.height * 0.8, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + rect.width * 0.8, y: rect.y + rect.height * 0.8, button: 'left', clickCount: 1 });
    await wait('document.querySelectorAll(".capture__zones li").length === 2');
    // Choose only the difference image and test a failed save + retry.
    await evaluate(`document.querySelector('.capture__frame input').click(); window.failSave = true; document.querySelector('.capture__footer button').click()`);
    await wait('document.querySelector(".capture__error")?.textContent.includes("fixture offline")');
    assert.equal(await evaluate('window.attachments.length'), 0);
    await evaluate(`window.failSave = false; document.querySelector('.capture__footer button').click()`);
    await wait('!document.querySelector(".capture__sheet")');
    const result = await evaluate(`(async () => {
      const a = window.attachments[0], image = new Image(); image.src = a.dataUrl; await image.decode();
      return { count: window.attachments.length, attempts: window.attempts, width: image.width, height: image.height, name: a.name };
    })()`);
    assert.equal(result.count, 1); assert.equal(result.attempts, 2);
    assert.equal(result.width, 20); assert.equal(result.height, 30);
    assert.match(result.name, /changes-x40-y80-20x30/);
    // Real MP4 decode, local timeline capture, interval differences, masks,
    // failure/retry and object-URL cleanup. No native sharing API needed.
    await evaluate(`document.querySelector('#open').click()`);
    await wait('document.querySelector(".capture__sheet")');
    await evaluate(`(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    window.videoUrls = []; window.revokedVideoUrls = [];
    URL.createObjectURL = blob => { const url = create(blob); window.videoUrls.push(url); return url; };
    URL.revokeObjectURL = url => { window.revokedVideoUrls.push(url); revoke(url); };
    })()`);
    const importVideo = `(async () => {
    const blob = await (await fetch('/sample-video.mp4')).blob();
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'phone-recording.mp4', {type:'video/mp4'}));
    const input = document.querySelector('input[aria-label="Import video"]'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
    })()`;
    await evaluate(importVideo);
    await wait(`!document.querySelector('.capture__video-source').hidden && !document.querySelector('input[aria-label="Import video"]').disabled`);
    assert.match(await evaluate('document.querySelector(".capture__video-source").textContent'), /phone-recording\.mp4/);
    for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.querySelector(".capture__sheet").scrollWidth <= innerWidth'), true, 'video controls fit the phone');
    }
    await evaluate(`document.querySelectorAll('.capture__actions')[3].querySelector('button').click(); document.querySelector('.capture__video-source button:nth-child(2)').click()`);
    await wait(`document.querySelectorAll('.capture__frame').length === 2 && !document.querySelector('input[aria-label="Import video"]').disabled`);
    assert.match(await evaluate('document.querySelectorAll(".capture__frame")[1].textContent'), /Video 0:06\.0/);
    assert.match(await evaluate('document.querySelectorAll(".capture__frame")[1].textContent'), /Crop at 40, 80 · 20 × 30/);
    // Manual capture follows the selected timeline moment, not wall time.
    await evaluate(`document.querySelector('.capture__review-head button').click(); document.querySelector('.capture__segments button:nth-child(2)').click(); document.querySelector('.capture__video-source video').currentTime = 4`);
    await wait('document.querySelector(".capture__video-source video").currentTime === 4 && !document.querySelector(".capture__video-source video").seeking');
    await evaluate(`document.querySelector('.capture__video-source button').click()`);
    await wait(`document.querySelectorAll('.capture__frame').length === 1 && !document.querySelector('input[aria-label="Import video"]').disabled`);
    assert.match(await evaluate('document.querySelector(".capture__frame").textContent'), /Video 0:04\.0/);
    await evaluate(`document.querySelector('.capture__video-source button:nth-child(3)').click()`);
    await wait('document.querySelector(".capture__video-source").hidden');
    assert.equal(await evaluate('window.revokedVideoUrls.includes(window.videoUrls[0])'), true, 'Remove video revokes source URL');
    assert.equal(await evaluate('document.querySelectorAll(".capture__frame").length'), 1, 'removing video preserves extracted frames');
    // A bad codec/file reports an error and releases the URL; import can retry.
    await evaluate(`(() => {
    const t = new DataTransfer(); t.items.add(new File(['invalid'], 'broken.mp4', {type:'video/mp4'}));
    const input = document.querySelector('input[aria-label="Import video"]'); input.files = t.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await wait('document.querySelector(".capture__error")?.textContent.includes("cannot decode")');
    assert.equal(await evaluate('window.videoUrls.every(url => window.revokedVideoUrls.includes(url))'), true);
    await evaluate(importVideo);
    await wait('!document.querySelector(".capture__video-source").hidden');
    await evaluate(`document.querySelector('.capture__footer button').click()`);
    await wait('!document.querySelector(".capture__sheet") && window.videoUrls.every(url => window.revokedVideoUrls.includes(url))');
    assert.equal(await evaluate('window.attachments.every(a => a.type === "image" && a.mimeType === "image/png" && a.dataUrl.startsWith("data:image/png;base64,"))'), true, 'video import attaches only confirmed PNGs');
    assert.equal(await evaluate('window.attachments.length'), 1);
    // Sharing cleanup, including an in-flight browser permission request.
    await evaluate(`document.querySelector('#open').click()`);
    await wait('document.querySelector(".capture__sheet")');
    await evaluate(`Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, writable: true, value: async () => {
      const c = document.createElement('canvas'); c.width = 200; c.height = 400;
      const stream = c.captureStream(1); c.getContext('2d').fillRect(0, 0, 200, 400);
      stream.getVideoTracks()[0].requestFrame(); window.testStream = stream; window.testCanvas = c; return stream;
    } }); document.querySelector('.capture__actions button').click()`);
    await wait('document.querySelector(".capture__actions button").textContent === "Stop sharing"');
    await evaluate(`document.querySelector('.capture__close').click()`);
    await wait('window.testStream.getTracks().every(track => track.readyState === "ended")');
    await evaluate(`document.querySelector('#open').click()`);
    await wait('document.querySelector(".capture__sheet")');
    await evaluate(`navigator.mediaDevices.getDisplayMedia = () => new Promise(resolve => window.permissionResolve = resolve); document.querySelector('.capture__actions button').click()`);
    await evaluate(`document.querySelector('.capture__close').click(); const c = document.createElement('canvas'); window.lateStream = c.captureStream(1); window.permissionResolve(window.lateStream)`);
    await wait('window.lateStream.getTracks().every(track => track.readyState === "ended")');
    console.log('screen capture browser: phone layouts, screenshot/video import, timeline/interval extraction, ignored zones, selection, save retry and source cleanup passed');
  } finally {
    if (cdp) cdp.close();
    if (chrome) { chrome.kill(); await new Promise((resolve) => { chrome.once('exit', resolve); setTimeout(resolve, 2000); }); }
    await new Promise((resolve) => server.close(resolve));
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
  }
}
