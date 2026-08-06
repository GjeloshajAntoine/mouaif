'use strict';

// One-shot probe: drive a real streamChat() round-trip and inspect
// the headers that actually go on the wire. Used to confirm whether
// X-Title (and the new X-OpenRouter-Title) reach the upstream.

const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate the app store before requiring src modules (settings.js captures
// MOUAIF_HOME at require time). This probe calls settings.setApp repeatedly;
// without isolation it would mutate the real ~/.mouaif/store.sqlite.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-openrouter-probe-'));
process.env.MOUAIF_HOME = path.join(TMP, 'home');

const ai = require(path.resolve(__dirname, '..', 'src', 'ai.js'));
const settings = require(path.resolve(__dirname, '..', 'src', 'settings.js'));

const realFetch = globalThis.fetch;
let lastHeaders = null;
let lastUrl = null;
globalThis.fetch = async (url, init) => {
  lastHeaders = init && init.headers;
  lastUrl = url;
  return {
    status: 200, ok: true,
    body: new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
      c.close();
    }}),
    text: async () => 'data: [DONE]\n\n',
    json: async () => ({})
  };
};

(async () => {
  const s0 = settings.getApp();
  // 1) default — clear any leftover openRouter block so the shipped
  //    defaults are the only values
  s0.openRouter = {};
  settings.setApp(s0);
  const r1 = await ai.streamChat({
    model: { id: 'anthropic/claude-3.5-sonnet', provider: 'openrouter', baseUrl: '', apiKey: 'sk-test' },
    messages: [{ role: 'user', content: 'hi' }],
    onEvent: () => {}
  });
  console.log('--- default app name ---');
  console.log('url:', lastUrl);
  console.log('headers:', JSON.stringify(lastHeaders, null, 2));
  console.log('result.ok:', r1.ok, 'error:', r1.error);

  // 2) set app.openRouter.appName
  s0.openRouter = { appName: 'My Mouaif' };
  settings.setApp(s0);
  const r2 = await ai.streamChat({
    model: { id: 'anthropic/claude-3.5-sonnet', provider: 'openrouter', baseUrl: '', apiKey: 'sk-test' },
    messages: [{ role: 'user', content: 'hi' }],
    onEvent: () => {}
  });
  console.log('--- with appName=My Mouaif ---');
  console.log('url:', lastUrl);
  console.log('headers:', JSON.stringify(lastHeaders, null, 2));
  console.log('result.ok:', r2.ok, 'error:', r2.error);

  // 3) HTTP-Referer override
  s0.openRouter = { appName: 'My Mouaif', httpReferer: 'https://example.com' };
  settings.setApp(s0);
  const r3 = await ai.streamChat({
    model: { id: 'anthropic/claude-3.5-sonnet', provider: 'openrouter', baseUrl: '', apiKey: 'sk-test' },
    messages: [{ role: 'user', content: 'hi' }],
    onEvent: () => {}
  });
  console.log('--- with httpReferer=https://example.com ---');
  console.log('headers:', JSON.stringify(lastHeaders, null, 2));
  console.log('result.ok:', r3.ok, 'error:', r3.error);

  // 4) Bad URL falls back to default
  s0.openRouter = { appName: 'My Mouaif', httpReferer: 'not-a-url' };
  settings.setApp(s0);
  const r4 = await ai.streamChat({
    model: { id: 'anthropic/claude-3.5-sonnet', provider: 'openrouter', baseUrl: '', apiKey: 'sk-test' },
    messages: [{ role: 'user', content: 'hi' }],
    onEvent: () => {}
  });
  console.log('--- with httpReferer=not-a-url (should fall back) ---');
  console.log('headers:', JSON.stringify(lastHeaders, null, 2));
  console.log('result.ok:', r4.ok, 'error:', r4.error);

  globalThis.fetch = realFetch;
})().catch(e => { console.error('probe failed:', e); process.exit(1); });
