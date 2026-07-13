'use strict';

// AI client core.
//
// Implements docs/decisions.md section 10: server-side proxy with SSE
// streaming for five providers (openai-compatible, anthropic, gemini,
// ollama, github-copilot). The mobile UI never holds an API key — it
// POSTs to /api/ai/chat and reads the SSE stream back.
//
// Per-model auth (decision 11) is wired but only 'apikey' is honored in
// this commit. 'oauth' is recognized and produces a typed ENOAUTH error;
// the OAuth commits land separately.
//
// Public surface:
//
//   streamChat({ model, messages, signal, onEvent }) -> Promise<{ ok, usage, error? }>
//
// `model` is the resolved model record (id, provider, baseUrl, apiKey,
// contextWindow, ...). `messages` is the OpenAI-style array:
//   [{ role: 'system'|'user'|'assistant', content: '...' }, ...]
// `signal` is an AbortSignal so the HTTP layer can cancel mid-stream.
// `onEvent(eventName, data)` is called for every SSE event as it
// arrives. The function returns once the upstream has finished (or
// failed). Usage is reported in `{ promptTokens, completionTokens }`.
//
// Each provider has a `buildRequest(model, messages)` and a
// `parseEvent(eventName, data)` so adding a new provider is a localized
// change.

// ---- Provider endpoints ------------------------------------------------

const ENDPOINTS = {
  'openai-compatible': {
    chatPath: '/chat/completions',
    authHeader: (apiKey) => ({ 'Authorization': 'Bearer ' + apiKey })
  },
  'anthropic': {
    baseUrl: 'https://api.anthropic.com',
    chatPath: '/v1/messages',
    anthropicVersion: '2023-06-01',
    // Per the official `ant` CLI source and the platform.claude.com
    // docs: API-key auth uses the `x-api-key` header; OAuth user_oauth
    // tokens use `Authorization: Bearer ...` and require the
    // `anthropic-beta: oauth-2025-04-20` header. The header is decided
    // at request time from model.auth so the same provider can serve
    // both flows.
    authHeader: (cred, model) => {
      if (model && model.auth === 'oauth') {
        return {
          'Authorization': 'Bearer ' + cred,
          'anthropic-beta': 'oauth-2025-04-20'
        };
      }
      return { 'x-api-key': cred, 'anthropic-version': '2023-06-01' };
    }
  },
  'gemini': {
    // Gemini uses a per-model action path; see buildRequest.
    baseUrl: 'https://generativelanguage.googleapis.com',
    authHeader: (apiKey) => ({ 'x-goog-api-key': apiKey })
  },
  'ollama': {
    baseUrl: 'http://127.0.0.1:11434',
    chatPath: '/api/chat',
    // No auth header. Ollama streams NDJSON, not SSE — we adapt below.
    authHeader: () => ({}),
    streamFormat: 'ndjson'
  },
  'github-copilot': {
    // Documented here so the model picker can list it. The OAuth flow
    // is in a later commit; calls in this commit will fail with ENOAUTH
    // because Copilot requires a device-code / OAuth token, not an
    // apiKey. The shape is reserved so the model record stays stable.
    baseUrl: 'https://api.githubcopilot.com',
    chatPath: '/chat/completions',
    authHeader: (apiKey) => ({ 'Authorization': 'Bearer ' + apiKey }),
    reserved: true
  }
};

function endpointFor(model) {
  const def = ENDPOINTS[model.provider];
  if (!def) {
    const e = new Error('Unknown provider: ' + model.provider);
    e.code = 'EUNKNOWN_PROVIDER';
    throw e;
  }
  if (def.reserved) {
    const e = new Error('Provider "' + model.provider + '" is reserved; its auth flow is not yet implemented.');
    e.code = 'ENOAUTH';
    throw e;
  }
  return def;
}

function requireApiKey(model) {
  if (model.auth === 'oauth') {
    // OAuth path: the access token comes from the OS keychain via
    // src/auth.js. The keychain is keyed by auth provider (openai,
    // anthropic, google, github-copilot), not by AI client provider
    // (openai-compatible, etc). The model record carries the auth
    // provider name in `authProvider`; if absent, we fall back to
    // `model.provider`.
    const authMod = require('./auth.js');
    const authProvider = model.authProvider || model.provider;
    const lookModel = Object.assign({}, model, { provider: authProvider });
    const token = authMod.tokenForModel(lookModel);
    if (!token) {
      const e = new Error(
        'No OAuth account is signed in for provider "' + authProvider + '"' +
        (model.oauthAccount ? '' : ' (no oauthAccount on model, no signed-in account found)') +
        '. Sign in via the loopback callback.'
      );
      e.code = 'ENOAUTH';
      throw e;
    }
    let parsed;
    try { parsed = JSON.parse(token); }
    catch {
      const e = new Error('Stored OAuth token for "' + authProvider + '" is not valid JSON');
      e.code = 'EOAUTH_BLOB';
      throw e;
    }
    if (!parsed.accessToken) {
      const e = new Error('Stored OAuth token for "' + authProvider + '" has no accessToken');
      e.code = 'EOAUTH_BLOB';
      throw e;
    }
    model.__accessToken = parsed.accessToken;
    return;
  }
  if (!model.apiKey || typeof model.apiKey !== 'string') {
    const e = new Error('Model "' + model.id + '" has no apiKey.');
    e.code = 'ENOAPIKEY';
    throw e;
  }
}

// ---- Request builders --------------------------------------------------

// Returns the effective bearer-style credential: the OAuth access token
// if one was resolved by requireApiKey, otherwise the plain apiKey.
function credential(model) {
  return model.__accessToken || model.apiKey;
}

function buildOpenAIRequest(model, messages, stream) {
  return {
    url: joinUrl(model.baseUrl, ENDPOINTS['openai-compatible'].chatPath),
    headers: { 'Content-Type': 'application/json', ...ENDPOINTS['openai-compatible'].authHeader(credential(model)) },
    body: {
      model: model.id,
      messages,
      stream: !!stream
    }
  };
}

function buildAnthropicRequest(model, messages, stream) {
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system');
  return {
    // model.baseUrl wins when set, so test mocks and Anthropic-compatible
    // proxies (Bedrock, Vertex, Foundry) can route the call. Production
    // Anthropic usage leaves baseUrl unset, in which case the
    // per-provider default applies.
    url: joinUrl(model.baseUrl || ENDPOINTS.anthropic.baseUrl, ENDPOINTS.anthropic.chatPath),
    headers: {
      'Content-Type': 'application/json',
      ...ENDPOINTS.anthropic.authHeader(credential(model), model)
    },
    body: {
      model: model.id,
      max_tokens: model.maxTokens || 1024,
      system: systemMsg ? systemMsg.content : undefined,
      messages: chatMessages.map(m => ({ role: m.role, content: m.content })),
      stream: !!stream
    }
  };
}

function buildGeminiRequest(model, messages, stream) {
  // Gemini uses ?alt=sse for streaming responses.
  const url = joinUrl(ENDPOINTS.gemini.baseUrl, '/v1beta/models/' + encodeURIComponent(model.id) + ':' + (stream ? 'streamGenerateContent?alt=sse' : 'generateContent'));
  const systemMsg = messages.find(m => m.role === 'system');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents };
  if (systemMsg) body.systemInstruction = { role: 'system', parts: [{ text: systemMsg.content }] };
  return {
    url,
    headers: { 'Content-Type': 'application/json', ...ENDPOINTS.gemini.authHeader(credential(model)) },
    body
  };
}

function buildOllamaRequest(model, messages, stream) {
  return {
    url: joinUrl(model.baseUrl || ENDPOINTS.ollama.baseUrl, ENDPOINTS.ollama.chatPath),
    headers: { 'Content-Type': 'application/json' },
    body: { model: model.id, messages, stream: !!stream }
  };
}

const BUILDERS = {
  'openai-compatible': buildOpenAIRequest,
  'anthropic': buildAnthropicRequest,
  'gemini': buildGeminiRequest,
  'ollama': buildOllamaRequest,
  'github-copilot': buildOpenAIRequest // same shape; ENOAUTH gate above
};

// ---- Event parsers -----------------------------------------------------
// Each parser reads one event from the upstream and emits zero or more
// normalized events. The normalized event names are:
//   message   -> { delta: 'text' }
//   done      -> { usage: { promptTokens, completionTokens } }
//   error     -> { code, message }
// Anything else from the upstream is passed through as `passthrough` so
// the UI can render it for debugging.

const PARSERS = {
  'openai-compatible': parseOpenAISSE,
  'github-copilot':   parseOpenAISSE,
  'anthropic':        parseAnthropicSSE,
  'gemini':           parseGeminiSSE,
  'ollama':           parseOllamaNDJSON
};

function* parseOpenAISSE(eventName, data) {
  if (!data) return;
  // OpenAI uses the literal "[DONE]" as a stream terminator. Suppress it.
  if (data.trim() === '[DONE]') return;
  let obj;
  try { obj = JSON.parse(data); } catch { yield { name: 'passthrough', data: { raw: data } }; return; }
  if (obj.error) {
    yield { name: 'error', data: { code: 'EUPSTREAM', message: obj.error.message || String(obj.error) } };
    return;
  }
  const choice = obj.choices && obj.choices[0];
  if (choice && choice.delta && typeof choice.delta.content === 'string') {
    yield { name: 'message', data: { delta: choice.delta.content } };
  }
  if (choice && choice.finish_reason) {
    yield { name: 'finish', data: { reason: choice.finish_reason } };
  }
  if (obj.usage) {
    yield { name: 'done', data: { usage: { promptTokens: obj.usage.prompt_tokens || 0, completionTokens: obj.usage.completion_tokens || 0 } } };
  }
}

function* parseAnthropicSSE(eventName, data) {
  if (!data) return;
  let obj;
  try { obj = JSON.parse(data); } catch { yield { name: 'passthrough', data: { raw: data } }; return; }
  switch (obj.type) {
    case 'message_start':
      // usage is reported here for input tokens.
      if (obj.message && obj.message.usage) {
        yield { name: 'usage_input', data: { promptTokens: obj.message.usage.input_tokens || 0 } };
      }
      break;
    case 'content_block_start':
      break;
    case 'content_block_delta':
      if (obj.delta && obj.delta.type === 'text_delta' && typeof obj.delta.text === 'string') {
        yield { name: 'message', data: { delta: obj.delta.text } };
      }
      break;
    case 'content_block_stop':
      break;
    case 'message_delta':
      if (obj.usage && typeof obj.usage.output_tokens === 'number') {
        yield { name: 'usage_output', data: { completionTokens: obj.usage.output_tokens } };
      }
      break;
    case 'message_stop':
      yield { name: 'done', data: {} };
      break;
    case 'error':
      yield { name: 'error', data: { code: 'EUPSTREAM', message: obj.error && obj.error.message || 'anthropic error' } };
      break;
  }
}

function* parseGeminiSSE(eventName, data) {
  if (!data) return;
  let obj;
  try { obj = JSON.parse(data); } catch { yield { name: 'passthrough', data: { raw: data } }; return; }
  const cand = obj.candidates && obj.candidates[0];
  if (cand && cand.content && cand.content.parts) {
    for (const part of cand.content.parts) {
      if (typeof part.text === 'string') yield { name: 'message', data: { delta: part.text } };
    }
  }
  if (cand && cand.finishReason) yield { name: 'finish', data: { reason: cand.finishReason } };
  if (obj.usageMetadata) {
    yield {
      name: 'done',
      data: { usage: { promptTokens: obj.usageMetadata.promptTokenCount || 0, completionTokens: obj.usageMetadata.candidatesTokenCount || 0 } }
    };
  }
  if (obj.error) {
    yield { name: 'error', data: { code: 'EUPSTREAM', message: obj.error.message || 'gemini error' } };
  }
}

function* parseOllamaNDJSON(_eventName, data) {
  if (!data) return;
  let obj;
  try { obj = JSON.parse(data); } catch { yield { name: 'passthrough', data: { raw: data } }; return; }
  if (obj.message && typeof obj.message.content === 'string') {
    yield { name: 'message', data: { delta: obj.message.content } };
  }
  if (obj.done) {
    yield {
      name: 'done',
      data: {
        usage: {
          promptTokens: obj.prompt_eval_count || 0,
          completionTokens: obj.eval_count || 0
        }
      }
    };
  }
  if (obj.error) {
    yield { name: 'error', data: { code: 'EUPSTREAM', message: obj.error } };
  }
}

// ---- Streaming core ----------------------------------------------------

function joinUrl(base, path) {
  if (!base) return path;
  if (base.endsWith('/') && path.startsWith('/')) return base + path.slice(1);
  if (!base.endsWith('/') && !path.startsWith('/')) return base + '/' + path;
  return base + path;
}

// Walks an SSE byte stream and yields {eventName, data} pairs.
// `stream` is a ReadableStream<Uint8Array> from fetch().
async function* readSSE(stream) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSSEFrame(frame);
      if (ev) yield ev;
    }
  }
  // Tail without trailing blank line.
  if (buf.trim()) {
    const ev = parseSSEFrame(buf);
    if (ev) yield ev;
  }
}

function parseSSEFrame(frame) {
  let eventName = 'message';
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment / heartbeat
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  // No data lines -> comment-only / heartbeat / empty frame; skip.
  if (!dataLines.length) return null;
  return { eventName, data: dataLines.join('\n') };
}

// Walks an NDJSON byte stream and yields one parsed object per line.
async function* readNDJSON(stream) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { yield JSON.parse(line); }
      catch { /* ignore malformed line, upstream is responsible */ }
    }
  }
  if (buf.trim()) {
    try { yield JSON.parse(buf); } catch { /* ignore */ }
  }
}

async function streamChat(opts) {
  const { model, messages, signal, onEvent } = opts || {};
  if (!model || !model.provider) {
    return { ok: false, error: { code: 'EBADMODEL', message: 'Missing model.provider' } };
  }
  if (!Array.isArray(messages) || !messages.length) {
    return { ok: false, error: { code: 'EBADINPUT', message: 'messages must be a non-empty array' } };
  }
  if (typeof onEvent !== 'function') {
    return { ok: false, error: { code: 'EBADINPUT', message: 'onEvent must be a function' } };
  }

  let def, build, parse;
  try {
    def = endpointFor(model);
    requireApiKey(model);
    build = BUILDERS[model.provider];
    parse = PARSERS[model.provider];
  } catch (e) {
    return { ok: false, error: { code: e.code || 'EBADMODEL', message: e.message } };
  }
  if (!build || !parse) {
    return { ok: false, error: { code: 'EUNKNOWN_PROVIDER', message: 'No builder/parser for ' + model.provider } };
  }

  const req = build(model, messages, true);
  const upstream = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal
  }).catch((e) => {
    return { __networkError: e };
  });

  if (upstream && upstream.__networkError) {
    const e = upstream.__networkError;
    return { ok: false, error: { code: 'ENETWORK', message: e.message || 'network error' } };
  }
  if (!upstream.ok) {
    let detail = '';
    try { detail = await upstream.text(); } catch { /* ignore */ }
    return {
      ok: false,
      error: {
        code: 'EUPSTREAM',
        message: 'Upstream ' + upstream.status + ' ' + upstream.statusText,
        detail: detail.slice(0, 2000)
      }
    };
  }

  // Stream -> normalize -> onEvent.
  const usage = { promptTokens: 0, completionTokens: 0 };
  let sawError = null;
  const stream = upstream.body;
  const isNDJSON = def.streamFormat === 'ndjson';
  try {
    if (isNDJSON) {
      for await (const obj of readNDJSON(stream)) {
        for (const ev of parse('', JSON.stringify(obj))) {
          apply(ev);
        }
      }
    } else {
      for await (const ev of readSSE(stream)) {
        for (const out of parse(ev.eventName, ev.data)) {
          apply(out);
        }
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      onEvent('error', { code: 'EABORTED', message: 'aborted' });
      return { ok: false, error: { code: 'EABORTED', message: 'aborted' } };
    }
    onEvent('error', { code: 'EUPSTREAM', message: e.message || 'stream error' });
    return { ok: false, error: { code: 'EUPSTREAM', message: e.message || 'stream error' } };
  }

  if (sawError) return { ok: false, error: sawError, usage };
  return { ok: true, usage };

  function apply(ev) {
    if (ev.name === 'message') onEvent('message', ev.data);
    else if (ev.name === 'done') {
      if (ev.data && ev.data.usage) {
        usage.promptTokens = ev.data.usage.promptTokens || usage.promptTokens;
        usage.completionTokens = ev.data.usage.completionTokens || usage.completionTokens;
      }
      onEvent('done', { usage });
    } else if (ev.name === 'usage_input') {
      usage.promptTokens = ev.data.promptTokens || usage.promptTokens;
      onEvent('usage_input', ev.data);
    } else if (ev.name === 'usage_output') {
      usage.completionTokens = ev.data.completionTokens || usage.completionTokens;
      onEvent('usage_output', ev.data);
    } else if (ev.name === 'finish') {
      onEvent('finish', ev.data);
    } else if (ev.name === 'error') {
      sawError = { code: ev.data.code || 'EUPSTREAM', message: ev.data.message || 'upstream error' };
      onEvent('error', ev.data);
    } else if (ev.name === 'passthrough') {
      onEvent('passthrough', ev.data);
    }
  }
}

// Non-streaming variant for tests and one-shot calls.
async function chat(model, messages, opts) {
  const events = [];
  const r = await streamChat({
    model, messages,
    signal: opts && opts.signal,
    onEvent: (name, data) => events.push({ name, data })
  });
  let text = '';
  for (const e of events) if (e.name === 'message' && e.data && typeof e.data.delta === 'string') text += e.data.delta;
  return Object.assign({ text }, r);
}

module.exports = {
  // public
  streamChat,
  chat,
  ENDPOINTS,
  // exposed for tests
  parseSSEFrame,
  readSSE,
  readNDJSON,
  BUILDERS,
  PARSERS
};
