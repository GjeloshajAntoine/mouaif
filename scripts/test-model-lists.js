'use strict';

// Smoke test for the per-provider model list adapters in src/ai.js.
// Verifies the public surface (listModels, parseOpenAIShapedModels,
// parseGeminiModels, parseOllamaModels, parseCuratedModels, the
// curated Copilot catalog) and the OpenAI-shaped / Gemini / Ollama
// response parsers — without hitting the network. The live
// /api/ai/models/live route is exercised in scripts/test-model-lists-live.js.

const ai = require('../src/ai.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

function withStubbedFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(() => fn())
    .finally(() => { global.fetch = orig; });
}

function resetStubbed() {
  // Module-scope stubs the test fixtures rely on. Reset between cases
  // so a value captured by an earlier fetch impl does not leak into
  // the next one (e.g. an Authorization header from the cred-bearing
  // case appearing in the no-cred case).
  lastUrl = null;
  lastHeaders = null;
}

async function main() {
  // 1) Module surface.
  check('exports listModels',   typeof ai.listModels === 'function');
  check('exports ENDPOINTS',    typeof ai.ENDPOINTS === 'object');
  for (const p of ['openai-compatible', 'anthropic', 'gemini', 'ollama', 'github-copilot', 'openrouter', 'azure', 'mistral', 'groq', 'deepseek']) {
    check('ENDPOINTS has ' + p, !!ai.ENDPOINTS[p]);
    check('ENDPOINTS[' + p + '] has listModels', typeof ai.ENDPOINTS[p].listModels === 'function');
  }

  // 2) Copilot: curated catalog (no fetch).
  const copilot = await ai.listModels('github-copilot', null);
  check('copilot: returns array', Array.isArray(copilot));
  check('copilot: non-empty', copilot.length > 0);
  check('copilot: gpt-4o present', copilot.some((m) => m.id === 'gpt-4o'));
  check('copilot: gpt-5 present',  copilot.some((m) => m.id === 'gpt-5'));
  check('copilot: all entries have id+label',
    copilot.every((m) => typeof m.id === 'string' && m.id && typeof m.label === 'string' && m.label));
  check('copilot: all entries have contextWindow',
    copilot.every((m) => typeof m.contextWindow === 'number' && m.contextWindow > 0));
  check('copilot: dedupes by id',
    new Set(copilot.map((m) => m.id)).size === copilot.length);
  check('copilot: sorted by id',
    copilot.every((m, i, a) => i === 0 || a[i - 1].id.localeCompare(m.id) <= 0));

  // 3) OpenAI-shaped parser: known shape.
  const oaShape = {
    data: [
      { id: 'gpt-4o', context_window: 128000 },
      { id: 'gpt-5', context_window: 400000 },
      { /* no id — should be dropped */ }
    ]
  };
  let lastUrl = null;
  let lastHeaders = null;
  await withStubbedFetch(async (url, opts) => {
    lastUrl = url; lastHeaders = opts && opts.headers;
    return { ok: true, status: 200, statusText: 'OK', json: async () => oaShape };
  }, async () => {
    const out = await ai.listModels('openai-compatible', 'sk-test-1234');
    check('openai-compatible: ends with /models', /\/models$/.test(lastUrl),
      'lastUrl=' + lastUrl);
    check('openai-compatible: sends Bearer header',
      lastHeaders && lastHeaders.Authorization === 'Bearer sk-test-1234');
    check('openai-compatible: drops entries with no id',
      out.length === 2 && out.every((m) => m.id));
    check('openai-compatible: keeps context_window',
      out.find((m) => m.id === 'gpt-4o').contextWindow === 128000);
  });

  // 4) OpenAI-shaped: no cred -> no Authorization header (open catalog).
  await withStubbedFetch(async (url, opts) => {
    lastUrl = url; lastHeaders = opts && opts.headers;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [{ id: 'public-model' }] }) };
  }, async () => {
    const out = await ai.listModels('openai-compatible', null);
    check('openai-compatible(no cred): no Authorization header',
      !lastHeaders || !lastHeaders.Authorization);
    check('openai-compatible(no cred): returns public models',
      out.length === 1 && out[0].id === 'public-model');
  });

  // 5) OpenAI-shaped: error path -> EUPSTREAM.
  await withStubbedFetch(async () => ({
    ok: false, status: 401, statusText: 'Unauthorized',
    json: async () => ({ error: { message: 'bad key' } })
  }), async () => {
    let caught = null;
    try { await ai.listModels('openai-compatible', 'bad'); }
    catch (e) { caught = e; }
    check('openai-compatible: 401 -> throws',
      caught && caught.code === 'EUPSTREAM' && caught.status === 401);
  });

  // 6) OpenRouter parser: same OpenAI-shaped contract.
  await withStubbedFetch(async (url) => {
    lastUrl = url;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({
      data: [
        { id: 'openai/gpt-5' },
        { id: 'anthropic/claude-sonnet-5',
          pricing: { prompt: '0.000004', completion: '0.000016', image: '0.000008',
                     input_cache_read: '0.0000008', input_cache_write: '0.000005' } }
      ]
    }) };
  }, async () => {
    const out = await ai.listModels('openrouter', null);
    check('openrouter: /api/v1/models URL', /\/api\/v1\/models$/.test(lastUrl));
    check('openrouter: 2 entries', out.length === 2);
    check('openrouter: anthropic/claude-sonnet-5 present',
      out.some((m) => m.id === 'anthropic/claude-sonnet-5'));
    check('openrouter: pricing + cache factors pulled from the API',
      out.some((m) => m.id === 'anthropic/claude-sonnet-5'
        && m.pricing && Math.abs(m.pricing.inputPer1K - 0.004) < 1e-12
        && Math.abs(m.pricing.cacheReadFactor - 0.2) < 1e-12),
      JSON.stringify(out));
  });

  // 7) Gemini parser: { models: [{ name, displayName, inputTokenLimit, supportedGenerationMethods }] }
  await withStubbedFetch(async (url) => {
    lastUrl = url;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({
      models: [
        { name: 'models/gemini-2.5-pro',   displayName: 'Gemini 2.5 Pro',  inputTokenLimit: 1048576,
          supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/text-embedding-004', displayName: 'Text Embedding',
          supportedGenerationMethods: ['embedContent', 'countTokens'] },
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576,
          supportedGenerationMethods: ['generateContent'] }
      ]
    }) };
  }, async () => {
    const out = await ai.listModels('gemini', null);
    check('gemini: drops "models/" prefix',
      out.every((m) => !m.id.startsWith('models/')));
    check('gemini: drops embed-only models',
      !out.some((m) => m.id === 'text-embedding-004'));
    check('gemini: keeps gemini-2.5-pro + flash', out.length === 2);
    check('gemini: contextWindow from inputTokenLimit',
      out.find((m) => m.id === 'gemini-2.5-pro').contextWindow === 1048576);
  });

  // 8) Gemini with key -> ?key= appended.
  await withStubbedFetch(async (url) => {
    lastUrl = url;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ models: [] }) };
  }, async () => {
    await ai.listModels('gemini', 'AIza-test');
    check('gemini: ?key= appended when cred present',
      /key=AIza-test/.test(lastUrl), 'url=' + lastUrl);
  });

  // 9) Ollama: { models: [{ name, ... }] } from /api/tags.
  await withStubbedFetch(async (url) => {
    lastUrl = url;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({
      models: [
        { name: 'llama3.1:8b',  size: 5000000000 },
        { name: 'qwen2.5:7b',   size: 5000000000 },
        { /* no name — should be dropped */ }
      ]
    }) };
  }, async () => {
    const out = await ai.listModels('ollama', null);
    check('ollama: /api/tags URL', /\/api\/tags$/.test(lastUrl));
    check('ollama: drops entries with no name',
      out.length === 2 && out.every((m) => m.id));
    check('ollama: label === id', out.every((m) => m.label === m.id));
  });

  // 10) listModels on an unknown provider -> ENO_LIST.
  let caught = null;
  try { await ai.listModels('not-a-provider', null); }
  catch (e) { caught = e; }
  check('listModels(unknown): ENO_LIST',
    caught && caught.code === 'ENO_LIST');

  // 11) listModels output: always { id, label } shape.
  const sample = await ai.listModels('github-copilot', null);
  check('listModels: every entry has id+label',
    sample.every((m) => typeof m.id === 'string' && m.id && typeof m.label === 'string' && m.label));
  check('listModels: no empty ids',
    !sample.some((m) => !m.id || m.id.trim() === ''));

  // 12) OpenAI-compatible: 401 + no cred -> ENO_APIKEY (so the HTTP
  //     layer can return 400 "add an API key" instead of a generic
  //     502 "upstream misbehaved"). The case the chat UI hits when
  //     the user has not configured a key yet.
  await withStubbedFetch(async () => ({
    ok: false, status: 401, statusText: 'Unauthorized',
    json: async () => ({})
  }), async () => {
    let caught = null;
    try { await ai.listModels('openai-compatible', null); }
    catch (e) { caught = e; }
    check('openai-compatible (no cred, 401): ENO_APIKEY',
      caught && caught.code === 'ENO_APIKEY', 'caught=' + (caught && caught.code));
    check('openai-compatible (no cred, 401): provider echoed',
      caught && caught.provider === 'openai-compatible');
  });

  // 13) OpenAI-compatible: 401 WITH cred -> still EUPSTREAM (the
  //     key is bad; the user already has one, the upstream rejected
  //     it). The chat UI surfaces "returned 401" so the user can
  //     re-check the key.
  await withStubbedFetch(async () => ({
    ok: false, status: 401, statusText: 'Unauthorized',
    json: async () => ({})
  }), async () => {
    let caught = null;
    try { await ai.listModels('openai-compatible', 'sk-stale'); }
    catch (e) { caught = e; }
    check('openai-compatible (with cred, 401): EUPSTREAM + status 401',
      caught && caught.code === 'EUPSTREAM' && caught.status === 401,
      'caught=' + JSON.stringify(caught));
  });

  // 14) Gemini: 403 + no cred -> ENO_APIKEY (the public list used
  //     to be open, now requires a key).
  await withStubbedFetch(async () => ({
    ok: false, status: 403, statusText: 'Forbidden',
    json: async () => ({})
  }), async () => {
    let caught = null;
    try { await ai.listModels('gemini', null); }
    catch (e) { caught = e; }
    check('gemini (no cred, 403): ENO_APIKEY',
      caught && caught.code === 'ENO_APIKEY', 'caught=' + (caught && caught.code));
  });

  // 15) Ollama: fetch() throws -> EUNREACHABLE. Node 18+ collapses
  //     ECONNREFUSED / ENOTFOUND into a generic TypeError("fetch
  //     failed"); the adapter must surface that as a typed code so
  //     the HTTP layer returns 503, not 502.
  await withStubbedFetch(async () => { throw new TypeError('fetch failed'); }, async () => {
    let caught = null;
    try { await ai.listModels('ollama', null); }
    catch (e) { caught = e; }
    check('ollama: fetch throws -> EUNREACHABLE',
      caught && caught.code === 'EUNREACHABLE', 'caught=' + (caught && caught.code));
    check('ollama: provider echoed on EUNREACHABLE',
      caught && caught.provider === 'ollama');
  });

  // 16) OpenAI-compatible: fetch() throws -> EUNREACHABLE too.
  await withStubbedFetch(async () => { throw new TypeError('fetch failed'); }, async () => {
    let caught = null;
    try { await ai.listModels('openai-compatible', 'sk-x'); }
    catch (e) { caught = e; }
    check('openai-compatible: fetch throws -> EUNREACHABLE',
      caught && caught.code === 'EUNREACHABLE', 'caught=' + (caught && caught.code));
  });

  // 17) OpenRouter: fetch() throws -> EUNREACHABLE.
  await withStubbedFetch(async () => { throw new TypeError('fetch failed'); }, async () => {
    let caught = null;
    try { await ai.listModels('openrouter', 'sk-x'); }
    catch (e) { caught = e; }
    check('openrouter: fetch throws -> EUNREACHABLE',
      caught && caught.code === 'EUNREACHABLE', 'caught=' + (caught && caught.code));
  });

  // 18) OpenAI/OpenRouter streaming requests explicitly ask for final usage.
  const openaiReq = ai.BUILDERS['openai-compatible']({
    id: 'gpt-4o-mini', provider: 'openai-compatible', apiKey: 'sk-test'
  }, [{ role: 'user', content: 'hi' }], true);
  check('openai-compatible: stream_options.include_usage is set',
    openaiReq.body && openaiReq.body.stream_options && openaiReq.body.stream_options.include_usage === true);
  const openrouterReq = ai.BUILDERS.openrouter({
    id: 'openai/gpt-5-mini', provider: 'openrouter', apiKey: 'sk-or-test'
  }, [{ role: 'user', content: 'hi' }], true);
  check('openrouter: stream_options.include_usage is set',
    openrouterReq.body && openrouterReq.body.stream_options && openrouterReq.body.stream_options.include_usage === true);
  check('openrouter: usage.include is set for billed cost',
    openrouterReq.body && openrouterReq.body.usage && openrouterReq.body.usage.include === true);

  // 19) Azure: OpenAI-shaped builder, api-key header, api-version on the
  //     deployment URL. Azure is the odd one: the base URL already
  //     includes /openai/deployments/<deploy>, so joinUrl must not
  //     collide, and the api-version must be appended AFTER the joined
  //     /chat/completions path.
  const azureReq = ai.BUILDERS.azure({
    id: 'gpt4-deploy', provider: 'azure', apiKey: 'az-key',
    baseUrl: 'https://myres.openai.azure.com/openai/deployments/gpt4-deploy'
  }, [{ role: 'user', content: 'hi' }], true);
  check('azure: api-key header used, no Authorization Bearer',
    azureReq.headers['api-key'] === 'az-key' && !azureReq.headers.Authorization,
    JSON.stringify(azureReq.headers));
  check('azure: api-version appended after /chat/completions',
    /\/chat\/completions\?api-version=2024-10-21$/.test(azureReq.url),
    'url=' + azureReq.url);
  check('azure: stream_options.include_usage is set',
    azureReq.body && azureReq.body.stream_options && azureReq.body.stream_options.include_usage === true);
  const azureNoKey = ai.BUILDERS.azure({
    id: 'd', provider: 'azure', apiKey: undefined,
    baseUrl: 'https://x.openai.azure.com/openai/deployments/d'
  }, [{ role: 'user', content: 'hi' }], false);
  check('azure: api-version default applied without model.apiVersion',
    /api-version=2024-10-21/.test(azureNoKey.url), 'url=' + azureNoKey.url);

  // 20) Azure listModels: queries the deployment list with api-key.
  await withStubbedFetch(async (url, opts) => {
    lastUrl = url; lastHeaders = opts && opts.headers;
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({
      data: [{ id: 'gpt-4o', context_window: 128000 }]
    }) };
  }, async () => {
    const out = await ai.listModels('azure', 'az-key');
    check('azure listModels: /openai/models URL with api-version',
      /\/openai\/models\?api-version=2024-10-21$/.test(lastUrl), 'url=' + lastUrl);
    check('azure listModels: api-key header',
      lastHeaders && lastHeaders['api-key'] === 'az-key' && !lastHeaders.Authorization);
    check('azure listModels: parses OpenAI-shaped models',
      out.length === 1 && out[0].id === 'gpt-4o');
  });

  // 21) Mistral / Groq / DeepSeek: OpenAI-shaped listModels adapters.
  for (const p of ['mistral', 'groq', 'deepseek']) {
    await withStubbedFetch(async (url, opts) => {
      lastUrl = url; lastHeaders = opts && opts.headers;
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({
        data: [{ id: 'test-model' }]
      }) };
    }, async () => {
      const out = await ai.listModels(p, 'key-' + p);
      check(p + ' listModels: /models URL', /\/models$/.test(lastUrl), 'url=' + lastUrl);
      check(p + ' listModels: Bearer header',
        lastHeaders && lastHeaders.Authorization === 'Bearer key-' + p);
      check(p + ' listModels: parses OpenAI-shaped models',
        out.length === 1 && out[0].id === 'test-model');
    });
    const req = ai.BUILDERS[p]({ id: 'm1', provider: p, apiKey: 'k' }, [{ role: 'user', content: 'hi' }], true);
    check(p + ': Bearer header in builder',
      req.headers && req.headers.Authorization === 'Bearer k');
    check(p + ': stream_options.include_usage is set',
      req.body && req.body.stream_options && req.body.stream_options.include_usage === true);
  }

  // 22) New providers: missing cred + 401 -> ENO_APIKEY.
  for (const p of ['azure', 'mistral', 'groq', 'deepseek']) {
    await withStubbedFetch(async () => ({
      ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({})
    }), async () => {
      let caught = null;
      try { await ai.listModels(p, null); }
      catch (e) { caught = e; }
      check(p + ' (no cred, 401): ENO_APIKEY',
        caught && caught.code === 'ENO_APIKEY', 'caught=' + (caught && caught.code));
    });
  }

  // 23) New providers: fetch() throws -> EUNREACHABLE.
  for (const p of ['azure', 'mistral', 'groq', 'deepseek']) {
    await withStubbedFetch(async () => { throw new TypeError('fetch failed'); }, async () => {
      let caught = null;
      try { await ai.listModels(p, 'k'); }
      catch (e) { caught = e; }
      check(p + ': fetch throws -> EUNREACHABLE',
        caught && caught.code === 'EUNREACHABLE', 'caught=' + (caught && caught.code));
    });
  }

  // Summary.
  console.log('---');
  console.log('passed: ' + passed);
  console.log('failed: ' + failed);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
