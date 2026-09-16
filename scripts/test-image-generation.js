'use strict';

// Regression test for image generation: the request families, the response
// parser, the project file write, and the subagent/main-agent handoff.
//
// Covers:
//   1. kindForModel / isImageModel routing (openai-image vs inline chat vs
//      Gemini vs Imagen, and OpenRouter never getting a generateContent URL);
//   2. buildImageRequest shapes per family;
//   3. parseImageResponse for each family's response body (b64_json,
//      image_url data URL, inlineData, predictions[].bytesBase64Encoded);
//   4. runImageTool saving a picture into the project and attaching it as an
//      image block, with a path-escape refusal;
//   5. the tool spec advertising the project's image models;
//   6. the model-facing tool feedback not carrying base64.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Isolate the app store: touching the real ~/.mouaif store from a test is
// exactly the kind of side effect this suite must not have.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-image-home-'));
process.env.MOUAIF_HOME = home;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const imagegen = require('../src/imagegen.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

function main() {
  // ---- 1. routing ------------------------------------------------------
  {
    check('gpt-image-1 resolves to /images/generations',
      imagegen.kindForModel({ id: 'gpt-image-1', provider: 'openai-compatible' }) === 'openai-image');
    check('dall-e-3 resolves to /images/generations',
      imagegen.kindForModel({ id: 'dall-e-3', provider: 'openai-compatible' }) === 'openai-image');
    check('an unknown OpenAI-shaped model defaults to the chat route',
      imagegen.kindForModel({ id: 'my-diffusion', provider: 'openai-compatible' }) === 'openai-chat-image');
    check('an OpenRouter image model uses the /images router, never chat',
    imagegen.kindForModel({ id: 'google/gemini-2.5-flash-image', provider: 'openrouter' }) === 'openrouter-image');
    check('an OpenRouter image model with no provider report still uses /images',
    imagegen.kindForModel({ id: 'openai/gpt-image-2', provider: 'openrouter' }) === 'openrouter-image');
    check('a native Gemini image model uses generateContent',
      imagegen.kindForModel({ id: 'gemini-2.5-flash-image', provider: 'gemini' }) === 'gemini');
    check('an imagen model uses :predict',
      imagegen.kindForModel({ id: 'imagen-4.0-generate-001', provider: 'gemini' }) === 'gemini-predict');
    check('an explicit kind wins',
      imagegen.kindForModel({ id: 'x', provider: 'openai-compatible', imageGeneration: { kind: 'openai-image' } }) === 'openai-image');
    check('a provider-reported image modality marks a model',
      imagegen.isImageModel({ id: 'whatever', provider: 'openrouter', outputModalities: ['image', 'text'] }) === true);
    check('a provider-reported text-only modality does not',
      imagegen.isImageModel({ id: 'whatever', provider: 'openrouter', outputModalities: ['text'] }) === false);
    check('an unclassified catalog falls back to everything',
      imagegen.imageCandidates([{ id: 'a' }, { id: 'b' }]).length === 2);
    check('a classified catalog with no image model yields none',
      imagegen.imageCandidates([{ id: 'a', outputModalities: ['text'] }, { id: 'b', outputModalities: ['text'] }]).length === 0);

    // Gemini's model list drops rows that generate nothing the app can use,
    // but an Imagen row answers `predict`, not `generateContent`. Dropping it
    // is what kept every Imagen model out of the picker; pin that it survives
    // and is tagged as an image producer (so the modality filter offers it).
    const aiEndpoints = require('../src/ai-endpoints.js');
    const gem = aiEndpoints.parseGeminiModels({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/imagen-4.0-generate-001', displayName: 'Imagen 4', supportedGenerationMethods: ['predict'] },
        { name: 'models/imagen-3.0-generate-002', displayName: 'Imagen 3', supportedGenerationMethods: ['predictLongRunning'] },
        { name: 'models/embedding-001', displayName: 'Embed', supportedGenerationMethods: ['embedContent'] }
      ]
    });
    const gemIds = gem.map((m) => m.id);
    check('parseGeminiModels keeps an Imagen (predict-only) row',
      gemIds.includes('imagen-4.0-generate-001') && gemIds.includes('imagen-3.0-generate-002'),
      JSON.stringify(gemIds));
    check('parseGeminiModels still drops an embedding-only row',
      !gemIds.includes('embedding-001'), JSON.stringify(gemIds));
    const imagen4 = gem.find((m) => m.id === 'imagen-4.0-generate-001');
    check('an Imagen row is tagged as an image producer',
      imagen4 && Array.isArray(imagen4.outputModalities) && imagen4.outputModalities.includes('image'),
      JSON.stringify(imagen4));
    check('the Imagen rows reach the image picker',
      imagegen.imageCandidates(gem.map((m) => Object.assign({ provider: 'gemini' }, m)))
        .map((m) => m.id).filter((id) => id.startsWith('imagen')).length === 2);
  }

  // ---- 2. request shapes ----------------------------------------------
  {
    const args = { prompt: 'a red fox in snow', n: 2, size: '1024x1024' };
    const openai = JSON.parse(imagegen.buildImageRequest({
      kind: 'openai-image',
      model: { id: 'gpt-image-1', baseUrl: 'https://api.openai.com/v1' },
      apiKey: 'sk-test',
      ...args
    }).body.toString());
    check('openai-image posts model + prompt + n + size',
      openai.model === 'gpt-image-1' && openai.prompt === args.prompt && openai.n === 2 && openai.size === '1024x1024',
      JSON.stringify(openai));
    check('openai-image asks for base64 rather than a URL',
      openai.response_format === 'b64_json');

    const chatReq = imagegen.buildImageRequest({
      kind: 'openai-chat-image',
      model: { id: 'google/gemini-2.5-flash-image', baseUrl: 'https://openrouter.ai/api/v1' },
      apiKey: 'sk-or',
      ...args
    });
    const chatBody = JSON.parse(chatReq.body.toString());
    check('openai-chat-image is a chat completion asking for image output',
      chatBody.modalities.includes('image') && chatBody.messages[0].content === args.prompt,
      JSON.stringify(chatBody));
    check('openai-chat-image resolves the chat/completions URL',
      chatReq.url === 'https://openrouter.ai/api/v1/chat/completions', chatReq.url);
    check('openai-chat-image sends a bearer key', chatReq.headers.Authorization === 'Bearer sk-or');

    const geminiReq = imagegen.buildImageRequest({
      kind: 'gemini',
      model: { id: 'gemini-2.5-flash-image', baseUrl: 'https://generativelanguage.googleapis.com' },
      apiKey: 'gk',
      ...args
    });
    const gemBody = JSON.parse(geminiReq.body.toString());
    check('gemini sets responseModalities TEXT+IMAGE',
      Array.isArray(gemBody.generationConfig.responseModalities)
      && gemBody.generationConfig.responseModalities.includes('IMAGE'),
      JSON.stringify(gemBody.generationConfig));
    check('gemini puts the key on the header, never the URL',
      geminiReq.headers['x-goog-api-key'] === 'gk' && geminiReq.url.indexOf('gk') === -1);
    check('gemini resolves the generateContent URL',
      geminiReq.url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
      geminiReq.url);

    const imagenReq = imagegen.buildImageRequest({
      kind: 'gemini-predict',
      model: { id: 'imagen-4.0-generate-001', baseUrl: 'https://generativelanguage.googleapis.com' },
      apiKey: 'gk',
      prompt: 'a red fox',
      n: 3,
      aspectRatio: '16:9'
    });
    const imagenBody = JSON.parse(imagenReq.body.toString());
    check('imagen posts instances + sampleCount + aspectRatio',
      imagenBody.instances[0].prompt === 'a red fox'
      && imagenBody.parameters.sampleCount === 3
      && imagenBody.parameters.aspectRatio === '16:9',
      JSON.stringify(imagenBody));
    check('imagen resolves the :predict URL', imagenReq.url.endsWith(':predict'), imagenReq.url);

    const orReq = imagegen.buildImageRequest({
      kind: 'openrouter-image',
      model: { id: 'openai/gpt-image-2', baseUrl: 'https://openrouter.ai/api/v1' },
      apiKey: 'sk-or',
      prompt: 'a red fox in snow',
      n: 2,
      size: '1024x1024',
      aspectRatio: '16:9'
    });
    const orBody = JSON.parse(orReq.body.toString());
    check('openrouter-image resolves the /images URL',
      orReq.url === 'https://openrouter.ai/api/v1/images', orReq.url);
    check('openrouter-image posts model + prompt + n + size + aspect_ratio',
      orBody.model === 'openai/gpt-image-2' && orBody.prompt === 'a red fox in snow'
      && orBody.n === 2 && orBody.size === '1024x1024' && orBody.aspect_ratio === '16:9',
      JSON.stringify(orBody));
    check('openrouter-image sends a bearer key and no response_format',
      orReq.headers.Authorization === 'Bearer sk-or' && orBody.response_format === undefined);
    const orBare = imagegen.buildImageRequest({
      kind: 'openrouter-image',
      model: { id: 'x', baseUrl: 'https://openrouter.ai/api/v1/images' },
      prompt: 'a fox'
    });
    check('an /images base URL is kept as-is', orBare.url === 'https://openrouter.ai/api/v1/images', orBare.url);

    check('an empty prompt is refused',
      (() => { try { imagegen.buildImageRequest({ kind: 'openai-image', model: { baseUrl: 'https://x/v1' }, prompt: '' }); return false; } catch (e) { return e.code === 'EEMPTYPROMPT'; } })());
    check('n is clamped to the cap',
      imagegen.clampCount(99) === imagegen.MAX_IMAGES && imagegen.clampCount(0) === 1);
    check('a garbage size is dropped rather than sent',
      imagegen.normalizeSize('big') === '' && imagegen.normalizeSize('512x512') === '512x512');
  }

  // ---- 3. response parsing --------------------------------------------
  {
    const b64 = PNG.toString('base64');
    const cases = [
      ['b64_json', 'openai-image', {
      data: [{ b64_json: b64 }]
      }],
      ['the OpenRouter image router response (b64_json + media_type)', 'openrouter-image', {
      created: 1748372400,
      data: [{ b64_json: b64, media_type: 'image/png' }],
      usage: { prompt_tokens: 0, completion_tokens: 4175, total_tokens: 4175 }
      }],
      ['an OpenRouter image_url data URL', 'openai-chat-image', {
        choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }] } }]
      }],
      ['a native block', 'openai-chat-image', {
        choices: [{ message: { images: [{ type: 'image', data: b64, mimeType: 'image/png' }] } }]
      }],
      ['Gemini inlineData', 'gemini', {
        candidates: [{ content: { parts: [{ text: '' }, { inlineData: { mimeType: 'image/png', data: b64 } }] } }]
      }],
      ['Imagen predictions', 'gemini-predict', {
        predictions: [{ bytesBase64Encoded: b64, mimeType: 'image/png' }]
      }]
    ];
    for (const [label, kind, body] of cases) {
      const out = imagegen.parseImageResponse(kind, 200, JSON.stringify(body));
      check('parses ' + label,
        !out.error && out.images.length === 1 && out.images[0].bytes === PNG.length && out.images[0].data === b64,
        JSON.stringify(out).slice(0, 200));
    }
    const empty = imagegen.parseImageResponse('openai-image', 200, JSON.stringify({ data: [] }));
    check('a response with no picture is a typed ENO_IMAGE', empty.code === 'ENO_IMAGE');
    const upstream = imagegen.parseImageResponse('openai-image', 400, JSON.stringify({ error: { message: 'bad model' } }));
    check('an upstream error carries the provider message',
      upstream.code === 'EUPSTREAM' && /bad model/.test(upstream.error), JSON.stringify(upstream));
    const usage = imagegen.parseImageResponse('gemini', 200, JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }] } }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 }
    }));
    check('a provider usage report is carried through',
      usage.usage && usage.usage.promptTokens === 7 && usage.usage.completionTokens === 3,
      JSON.stringify(usage.usage));
  }

  // ---- 4. the tool run -------------------------------------------------
  return runToolChecks();
}

// stub — a local HTTP server standing in for an OpenAI-shaped image
// provider. It answers /images/generations with a one-pixel PNG and records
// every request, so the tool's real fetch/parse/write path runs in the test.
async function startStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* non-JSON */ }
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    seen,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// runToolChecks() — the file-writing half. Async because it uses the real
// runner against a temp project.
let stub = null;
async function runToolChecks() {
  const imageTool = require('../src/tools/image.js');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-image-proj-'));
  stub = await startStub();

  check('a generated-file stem is filesystem-safe',
    /^[a-z0-9-]+$/.test(imageTool.slugify('A Red Fox, in the Snow!')),
    imageTool.slugify('A Red Fox, in the Snow!'));

  const rel = imageTool.outputPathFor(projectDir, '', 0, 'image/png', 'a red fox');
  check('the default output lands under generated/', rel.startsWith('generated/') && rel.endsWith('.png'), rel);
  const named = imageTool.outputPathFor(projectDir, 'art/fox.png', 0, 'image/png', 'x');
  check('a requested path is honoured', named === 'art/fox.png', named);
  const indexed = imageTool.outputPathFor(projectDir, 'art/fox.png', 2, 'image/png', 'x');
  check('a second picture never overwrites the first', indexed === 'art/fox-3.png', indexed);
  const bare = imageTool.outputPathFor(projectDir, 'art/fox', 0, 'image/jpeg', 'x');
  check('the extension follows the returned MIME type', bare === 'art/fox.jpg', bare);

  // No provider connection exists in the isolated store yet, so a run is
  // expected to refuse with a typed error — that IS the contract (a missing
  // connection must never fall back to a bare URL).
  const refused = await imageTool.runImageTool({
    projectDir,
    args: { prompt: 'a red fox', model: 'gpt-image-1', provider: 'openai-compatible' }
  });
  check('a project with no provider connection is refused with a typed error',
    refused.ok === false && refused.result.error.code === 'EPROVIDER_NOT_FOUND',
    JSON.stringify(refused.result));

  // Register a connection, then point the provider at a local stub so the
  // whole tool run — request, parse, file write, image block — executes.
  const settings = require('../src/settings.js');
  settings.setApp({ providers: [{ id: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'sk-test' }] });
  const generated = await imageTool.runImageTool({
    projectDir,
    args: { prompt: 'a red fox in snow', model: 'gpt-image-1', provider: 'openai-compatible' },
    save: true
  });
  check('a run through the real request path succeeds', generated.ok === true, JSON.stringify(generated.result).slice(0, 200));
  const savedRel = generated.ok ? generated.result.images[0].relPath : '';
  check('the picture is written into the project',
    savedRel && fs.existsSync(path.join(projectDir, savedRel)),
    savedRel);
  check('the written file is byte-identical to what the provider returned',
    savedRel && fs.readFileSync(path.join(projectDir, savedRel)).equals(PNG));
  check('the result carries the picture as an image block',
    generated.ok && Array.isArray(generated.result.content)
    && generated.result.content[0].type === 'image'
    && generated.result.content[0].data === PNG.toString('base64'));
  check('the stub saw an /images/generations call with the prompt',
    stub.seen.length === 1 && stub.seen[0].url.endsWith('/images/generations') && stub.seen[0].body.prompt === 'a red fox in snow',
    JSON.stringify(stub.seen));

  // A requested path outside the project is refused, never written.
  const escape = await imageTool.runImageTool({
    projectDir,
    args: { prompt: 'a fox', model: 'gpt-image-1', provider: 'openai-compatible', path: '../escape.png' },
    save: true
  });
  check('a path escaping the project is refused',
    escape.ok === false && (escape.result.error.code === 'EOUTSIDE_PROJECT' || escape.result.error.code === 'EIMAGE'),
    JSON.stringify(escape.result));

  // `save: false` (the Settings page preview) generates without writing.
  const preview = await imageTool.runImageTool({
    projectDir,
    args: { prompt: 'a preview fox', model: 'gpt-image-1', provider: 'openai-compatible' },
    save: false
  });
  check('a non-saving run returns the picture with no path',
    preview.ok === true && preview.result.images[0].relPath === null && preview.result.content.length === 1,
    JSON.stringify(preview.result).slice(0, 160));

  // The spec advertises the project's image models in the `model` parameter.
  const spec = imageTool.buildSpec([{ id: 'gpt-image-1', provider: 'openai-compatible' }]);
  check('the spec names the available image models',
    /gpt-image-1 \(openai-compatible\)/.test(spec.function.parameters.properties.model.description),
    spec.function.parameters.properties.model.description);
  check('the base spec is untouched with no image models',
    imageTool.buildSpec([]) === imageTool.SPEC);
  check('the spec requires a prompt',
    Array.isArray(spec.function.parameters.required) && spec.function.parameters.required.includes('prompt'));

  // ---- 5. tool feedback keeps the bytes out of the model text ---------
  const toolFeedback = require('../src/toolFeedback.js');
  const result = {
    ok: true,
    kind: 'image',
    model: { id: 'openai-chat-image · gpt-image-1', provider: 'openai-compatible' },
    images: [{ relPath: 'generated/a.png', mimeType: 'image/png', bytes: PNG.length }],
    content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }]
  };
  const compact = toolFeedback.compactToolFeedback({ name: 'image_gen', content: JSON.stringify(result), result });
  check('the model-facing feedback never carries base64',
    compact.indexOf(PNG.toString('base64').slice(0, 24)) === -1, compact.slice(0, 160));
  check('the model-facing feedback names the saved file',
    /generated\/a\.png/.test(compact), compact.slice(0, 200));

  // ---- 6. the REST surface is mounted --------------------------------
  return runHttpChecks(projectDir);
}

async function runHttpChecks(projectDir) {
  const { createServer } = require('../src/index.js');
  const server = createServer(0);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  async function req(method, urlPath, body) {
    return await new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(out); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: parsed, raw: out });
        });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  try {
    const models = await req('GET', '/api/ai/image/models?projectDir=' + encodeURIComponent(projectDir));
    check('GET /api/ai/image/models answers 200',
      models.status === 200, models.status + ' ' + models.raw.slice(0, 120));
    check('the models endpoint publishes the family list',
    Array.isArray(models.body && models.body.kinds) && models.body.kinds.length === 5,
    JSON.stringify(models.body && models.body.kinds));
    check('the family list includes the OpenRouter image router',
    Array.isArray(models.body && models.body.kinds)
    && models.body.kinds.some((k) => k && k.id === 'openrouter-image' && /images/.test(k.label)));
    const missingDir = await req('GET', '/api/ai/image/models');
    check('the models endpoint requires projectDir', missingDir.status === 400, missingDir.status);
    const noPrompt = await req('POST', '/api/ai/image', { projectDir });
    check('POST /api/ai/image requires a prompt', noPrompt.status === 400, noPrompt.status);
    const noModel = await req('POST', '/api/ai/image', { projectDir, prompt: 'a fox' });
    check('a project with no image model answers 404 ENO_IMAGE_MODEL',
    noModel.status === 404 && noModel.body && noModel.body.code === 'ENO_IMAGE_MODEL',
    noModel.status + ' ' + noModel.raw.slice(0, 160));

    // ---- 7. the image picker reads the provider's *image* slice ---------
    // OpenRouter files its image catalogue under /images/models, which
    // /models never lists. Two stubs stand in for the two upstream reads so
    // the endpoint's own merge/filter logic runs: the image slice carries a
    // model the chat slice does not have (the whole point) plus one that
    // requires input references (an editor, not a generator), and the chat
    // slice carries the Gemini-shaped chat model that can also return a
    // picture.
    const aiMod = require('../src/ai.js');
    const realListImage = aiMod.listImageModels;
    const realList = aiMod.listModels;
    aiMod.listImageModels = async (provider) => (provider === 'openrouter' ? [
    { id: 'openai/gpt-image-fresh', label: 'GPT Image Fresh', outputModalities: ['image'], supportedParameters: { aspect_ratio: { type: 'enum' } } },
    { id: 'recraft/paint-in', label: 'Paint In', outputModalities: ['image'], supportedParameters: { input_references: { min: 1, max: 1 } } }
    ] : null);
    aiMod.listModels = async (provider, cred, signal) => (provider === 'openrouter'
    ? [
      { id: 'google/gemini-chat-image', label: 'Gemini Chat Image', outputModalities: ['image', 'text'] },
      { id: 'meta/some-text-model', label: 'Text Model', outputModalities: ['text'] }
    ]
    : realList(provider, cred, signal));
    const configured = require('../src/settings.js').getApp().providers || [];
    require('../src/settings.js').setApp({
    providers: configured.concat([{ id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test' }])
    });
    try {
    const orModels = await req('GET', '/api/ai/image/models?projectDir=' + encodeURIComponent(projectDir) + '&provider=openrouter&_bust=1');
    const ids = (orModels.body && orModels.body.models || []).map((m) => m.id);
    check('the image picker offers a model only the image slice has',
      ids.includes('openai/gpt-image-fresh'), JSON.stringify(ids));
    check('the image slice is read, not the chat list alone',
      ids.includes('google/gemini-chat-image'), JSON.stringify(ids));
    check('a model that cannot draw from a prompt alone is not offered',
      !ids.includes('recraft/paint-in'), JSON.stringify(ids));
    check('a text-only chat model is not offered',
      !ids.includes('meta/some-text-model'), JSON.stringify(ids));
    check('an OpenRouter row is labelled with the /images family',
      ((orModels.body && orModels.body.models || []).find((m) => m.id === 'openai/gpt-image-fresh') || {}).kind === 'openrouter-image',
      JSON.stringify(orModels.body && orModels.body.models));
    } finally {
    aiMod.listImageModels = realListImage;
    aiMod.listModels = realList;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (stub) await stub.close();
  }

  finalize();
}

function finalize() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
