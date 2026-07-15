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
    // The base URL points at the public Copilot API. Calls require a
    // short-lived Copilot token that is derived per-request from the
    // GitHub OAuth token stored in the keychain. The exchange is
    // performed by oauth-github-copilot.js and the resolved token
    // lands on model.__accessToken (replacing the GitHub token that
    // requireApiKey wrote there). The auth header is identical to
    // the openai-compatible path: a plain Bearer credential.
    baseUrl: 'https://api.githubcopilot.com',
    chatPath: '/chat/completions',
    authHeader: (cred) => ({ 'Authorization': 'Bearer ' + cred }),
    // Copilot requires a handful of editor-identifying headers. The
    // values mirror the public Copilot CLI; they identify this
    // client as a third-party tool without sending PII. Tests can
    // override these by setting model.headers at the call site.
    staticHeaders: {
      'Editor-Version': 'vscode/1.95.0',
      'Editor-Plugin-Version': 'copilot/1.0.0',
      'Editor-Schema-Version': 'v1',
      'User-Agent': 'mouaif/1.0',
      'Copilot-Integration-Id': 'mouaif'
    }
  }
};

function endpointFor(model) {
  const def = ENDPOINTS[model.provider];
  if (!def) {
    const e = new Error('Unknown provider: ' + model.provider);
    e.code = 'EUNKNOWN_PROVIDER';
    throw e;
  }
  return def;
}

// requireApiKey(model, def) — returns true when the model has a usable
// credential (or doesn't need one), throws a typed error otherwise.
// The def is the ENDPOINTS[model.provider] record, passed in by the
// caller so we can branch on the provider's auth shape (e.g. Ollama's
// authHeader: () => ({}) doesn't take a credential at all).
//
// Async because the OAuth path may need to proactively refresh an
// expiring access token (and persist the new blob) before the chat
// hits the wire. The API-key path is sync-fast and does not await.
async function requireApiKey(model, def) {
  if (model.auth === 'oauth') {
    // OAuth path: the access token comes from the OS keychain via
    // src/auth.js. The keychain is keyed by auth provider (openai,
    // anthropic, google, github-copilot), not by AI client provider
    // (openai-compatible, etc). The mapping from the model record's
    // `provider` to the auth provider lives in src/auth.js
    // (AI_TO_AUTH_PROVIDER); the same function (authProviderFor) is
    // what the auth subsystem uses to look up accounts, so adding a
    // new AI client only requires one edit.
    const authMod = require('./auth.js');
    const authProvider = authMod.authProviderFor(model);
    if (!authProvider) {
      const e = new Error('Cannot resolve auth provider for "' + model.provider + '"');
      e.code = 'EUNKNOWN_PROVIDER';
      throw e;
    }
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
    // Proactive refresh. If the stored access_token expires within
    // OAUTH_REFRESH_LEAD_MS (or is already past), and the provider
    // has a registered refresher + we have a refresh_token, swap
    // it for a fresh one and persist the new blob to the keychain.
    // Skipped silently when no refresher is registered yet, or when
    // the user signed in via a flow that did not issue a
    // refresh_token. A failure here is non-fatal: we fall through
    // with the existing token; the upstream will return a clean
    // 401 if the token is actually stale, which the user can
    // recover from by re-signing in.
    const now = Date.now();
    const nearExpiry = typeof parsed.expiresAt === 'number'
      ? (parsed.expiresAt - now) <= OAUTH_REFRESH_LEAD_MS
      : false;
    if (nearExpiry && parsed.refreshToken) {
      const refresher = authMod.getRefresher(authProvider);
      if (refresher) {
        const baseUrl = (model.baseUrl
          || (ENDPOINTS[authProvider] && ENDPOINTS[authProvider].baseUrl)
          || null);
        const account = lookModel.oauthAccount || parsed.account || null;
        try {
          const next = await refresher({
            provider: authProvider,
            account,
            refreshToken: parsed.refreshToken,
            scope: parsed.scope || null,
            baseUrl
          });
          if (next && next.accessToken) {
            parsed = Object.assign({}, parsed, {
              accessToken: next.accessToken,
              refreshToken: next.refreshToken || parsed.refreshToken,
              expiresAt: typeof next.expiresAt === 'number' ? next.expiresAt : parsed.expiresAt,
              scope: next.scope || parsed.scope
            });
            // Persist the new blob. Best-effort: a keyring failure
            // here does not poison the in-memory token we are about
            // to use, and the next chat will re-refresh as needed.
            try {
              await authMod.setToken(authProvider, account || 'default', JSON.stringify(parsed));
            } catch { /* swallow; in-memory token is still valid for this chat */ }
          }
        } catch { /* swallow; fall through to the stored token */ }
      }
    }
    model.__accessToken = parsed.accessToken;
    // Per-request Copilot token exchange. The keychain holds a
    // long-lived GitHub OAuth token; api.githubcopilot.com expects
    // a short-lived Copilot API token in the Authorization header.
    // The exchange is performed on every chat; the resulting token
    // is request-scoped (we never persist it) and a revocation
    // takes effect within minutes rather than at next sign-in.
    // Failure to exchange (no subscription, revoked token, network)
    // is surfaced as a typed error so the UI can prompt the user.
    if (model.provider === 'github-copilot') {
      let copilot;
      try {
        copilot = await exchangeCopilotTokenIfNeeded(model, parsed);
      } catch (e) {
        // Re-throw with the typed code preserved.
        throw e;
      }
      if (copilot) model.__accessToken = copilot;
    }
    return true;
  }
  if (!model.apiKey || typeof model.apiKey !== 'string') {
    // Providers whose authHeader takes no parameters (Ollama today)
    // don't need a credential. We detect that by arity: zero = no
    // credential, one or more = needs a key. Robust to future providers.
    if (def && typeof def.authHeader === 'function' && def.authHeader.length === 0) return true;
    const e = new Error('Model "' + model.id + '" has no apiKey.');
    e.code = 'ENOAPIKEY';
    throw e;
  }
  return true;
}

// Refresh lead window. If a stored access token expires within this
// many ms, we proactively swap it for a fresh one before the chat
// hits the wire. 60s matches the SDK's typical advisory-refresh
// threshold and is short enough that a flaky refresh never holds a
// chat hostage for long.
const OAUTH_REFRESH_LEAD_MS = 60 * 1000;

// Copilot token cache. The exchange is per-request but the result
// is request-scoped — there's no value in caching it across chats
// because it expires in ~30 min and a fresh derivation costs one
// HTTPS round-trip. We keep a small in-process LRU so a chat that
// streams multiple turns does not re-exchange on every turn; each
// entry tracks the GitHub token + the resolved Copilot token + its
// expiry. The cache key includes the GitHub token, so a sign-out /
// sign-in of a different account starts fresh.
const _copilotCache = new Map(); // key: githubToken -> { copilotToken, expiresAt, ts }
const COPILOT_CACHE_TTL_MS = 5 * 60 * 1000; // drop cache entries after 5 min idle

function copilotCacheGet(githubToken) {
  const entry = _copilotCache.get(githubToken);
  if (!entry) return null;
  if (Date.now() - entry.ts > COPILOT_CACHE_TTL_MS) { _copilotCache.delete(githubToken); return null; }
  if (typeof entry.expiresAt === 'number' && entry.expiresAt - Date.now() <= OAUTH_REFRESH_LEAD_MS) {
    _copilotCache.delete(githubToken);
    return null;
  }
  // Touch on read so a streaming chat does not evict its own entry.
  entry.ts = Date.now();
  return entry;
}
function copilotCachePut(githubToken, copilotToken, expiresAt) {
  // Cap the map at 16 entries — should never hit this in practice
  // (one per signed-in account per process), but defensive against
  // memory growth in a long-lived server.
  if (_copilotCache.size >= 16) {
    const first = _copilotCache.keys().next().value;
    if (first !== undefined) _copilotCache.delete(first);
  }
  _copilotCache.set(githubToken, { copilotToken, expiresAt, ts: Date.now() });
}
function copilotCacheClear() { _copilotCache.clear(); }

// exchangeCopilotTokenIfNeeded(model, parsedBlob) — derives a
// short-lived Copilot API token from the GitHub OAuth token stored
// in the keychain. Returns the token string, or throws a typed
// error. Caches per-GitHub-token to avoid re-deriving within a
// streaming chat.
async function exchangeCopilotTokenIfNeeded(model, parsedBlob) {
  const githubToken = (parsedBlob && parsedBlob.accessToken) || model.__accessToken;
  if (!githubToken) {
    const e = new Error('GitHub Copilot: no GitHub access token on the stored blob');
    e.code = 'EOAUTH_BLOB';
    throw e;
  }
  const cached = copilotCacheGet(githubToken);
  if (cached) return cached.copilotToken;
  let oauthCopilot;
  try {
    oauthCopilot = require('./oauth-github-copilot.js');
  } catch {
    const e = new Error('GitHub Copilot OAuth module is not available in this build');
    e.code = 'EMODULE';
    throw e;
  }
  let out;
  try {
    out = await oauthCopilot.exchangeCopilotToken({ githubToken });
  } catch (e) {
    // Re-throw with the typed code preserved (ENOCOPILOT, EUPSTREAM, EPARSE, ETOKEN).
    throw e;
  }
  if (!out || !out.token) {
    const e = new Error('GitHub Copilot: token exchange returned no token');
    e.code = 'ETOKEN';
    throw e;
  }
  copilotCachePut(githubToken, out.token, out.expiresAt);
  return out.token;
}

// ---- Request builders --------------------------------------------------

// Returns the effective bearer-style credential: the OAuth access token
// if one was resolved by requireApiKey, otherwise the plain apiKey.
function credential(model) {
  return model.__accessToken || model.apiKey;
}

function buildOpenAIRequest(model, messages, stream) {
  const def = ENDPOINTS[model.provider] || ENDPOINTS['openai-compatible'];
  const headers = { 'Content-Type': 'application/json', ...ENDPOINTS['openai-compatible'].authHeader(credential(model)) };
  // Per-provider static headers. github-copilot requires editor
  // identification headers; the order (auth first, static second)
  // means a caller-supplied model.headers can still override the
  // defaults — useful for tests and for a future per-model override.
  if (def && def.staticHeaders) Object.assign(headers, def.staticHeaders);
  if (model && model.headers && typeof model.headers === 'object') Object.assign(headers, model.headers);
  return {
    url: joinUrl(model.baseUrl, ENDPOINTS['openai-compatible'].chatPath),
    headers,
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
  // OpenAI tool calls stream as a `delta.tool_calls` array. The id
  // appears on the first delta for a given index; subsequent deltas
  // fill in `function.name` and the streamed `function.arguments`
  // string. We accumulate by index and emit a `tool_call` event when
  // we see a `finish_reason === 'tool_calls'`.
  if (choice && Array.isArray(choice.delta && choice.delta.tool_calls)) {
    for (const tc of choice.delta.tool_calls) {
      yield { name: 'tool_call_delta', data: tc };
    }
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
    // requireApiKey is async on the OAuth path (proactive refresh);
    // sync-fast on the API-key path. We always `await` it here.
    await requireApiKey(model, def);
    build = BUILDERS[model.provider];
    parse = PARSERS[model.provider];
  } catch (e) {
    return { ok: false, error: { code: e.code || 'EBADMODEL', message: e.message } };
  }
  if (!build || !parse) {
    return { ok: false, error: { code: 'EUNKNOWN_PROVIDER', message: 'No builder/parser for ' + model.provider } };
  }

  const req = build(model, messages, true);
  // Merge MCP-discovered tool specs into the outgoing request when
  // the caller supplied a project context (decision §18). The
  // mcp.listComposedToolSpecs() call is a no-op when no servers are
  // running for the project, so the openai-compatible / anthropic /
  // gemini / ollama / github-copilot happy path is unchanged.
  let mcpSpec = null;
  try {
    if (opts && opts.projectDir) {
      const mcpMod = require('./mcp.js');
      const specs = mcpMod.listComposedToolSpecs(opts.projectDir);
      if (specs && specs.length) {
        // The MCP tool spec is the standard OpenAI shape with the
        // mcp__<serverSlug>__<toolName> name convention so the
        // upstream's tool_call event carries a parseable name.
        mcpSpec = specs.map(s => ({
          type: 'function',
          function: {
            name: s.name,
            description: s.description,
            parameters: s.parameters
          }
        }));
        // Attach serverSlug + toolName for the dispatcher to pick up
        // without re-parsing. We hang it off the message shape the
        // builder/parser will see. Builders are free to ignore it;
        // only OpenAI-compatible providers carry a `tools` field on
        // the body today.
        const builderBody = req.body;
        if (builderBody && typeof builderBody === 'object') {
          builderBody.tools = mcpSpec;
        }
      }
    }
  } catch { /* mcp module not loaded or project dir invalid; fall through without tools */ }
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
    if (e && e.name === 'AbortError') {
      return { ok: false, error: { code: 'EABORTED', message: 'aborted' } };
    }
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
  // OpenAI tool-call accumulator. Deltas arrive split across frames;
  // we assemble by `index` and flush when the upstream signals
  // `finish_reason === 'tool_calls'`. The accumulator lives only
  // for the duration of one stream — there is no reuse across calls.
  const toolAcc = new Map(); // index -> { id, name, arguments }
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

  // Tool-call dispatch (decision §18). After the upstream finishes
  // emitting, if any tool_calls were assembled, dispatch them through
  // the in-process MCP module. Each call yields a `tool_result` event
  // the chat UI can render. The dispatch path is sync-fast for
  // in-process tool execution; an MCP call is async and awaited.
  // The upstream does not see this round-trip — tool results are
  // surfaced to the chat as `tool_result` events, not fed back into
  // the same stream. A future revision can wire a multi-turn loop;
  // for this commit, a single pass is enough to keep the wire simple.
  if (toolAcc.size > 0 && opts && opts.projectDir) {
    let mcpMod;
    try { mcpMod = require('./mcp.js'); }
    catch (e) {
      onEvent('error', { code: 'EMODULE', message: 'MCP module unavailable: ' + (e.message || e) });
    }
    if (mcpMod) {
      for (const tc of toolAcc.values()) {
        const composed = tc.name;
        const parsed = mcpMod.parseServerSlugAndToolName(composed);
        if (!parsed) {
          onEvent('tool_result', {
            id: tc.id || null,
            name: composed,
            ok: false,
            result: { error: { code: 'EMCP_NOTFOUND', message: 'Not an MCP tool name: ' + composed } }
          });
          continue;
        }
        let args = {};
        if (tc.arguments) {
          try { args = JSON.parse(tc.arguments); }
          catch (e) {
            onEvent('tool_result', {
              id: tc.id || null,
              name: composed,
              ok: false,
              result: { error: { code: 'EBADINPUT', message: 'tool arguments not valid JSON: ' + e.message } }
            });
            continue;
          }
        }
        let out;
        try {
          out = await mcpMod.callTool(opts.projectDir, parsed.serverSlug, parsed.toolName, args);
        } catch (e) {
          out = { ok: false, content: [{ type: 'text', text: 'MCP error: ' + (e.message || e) }], isError: true };
        }
        onEvent('tool_result', {
          id: tc.id || null,
          name: composed,
          ok: out.ok,
          result: { content: out.content, isError: !!out.isError }
        });
      }
    }
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
      // When the upstream signals `finish_reason === 'tool_calls'`
      // (OpenAI / GitHub Copilot), emit a `tool_call` event per
      // accumulated entry. The dispatcher in the stream post-pass
      // takes over from there. Other finish reasons are passed
      // through as `finish` so the UI can show them.
      if (ev.data && ev.data.reason === 'tool_calls' && toolAcc.size > 0) {
        for (const tc of toolAcc.values()) {
          let args = tc.arguments;
          if (typeof args === 'string' && args.length) {
            try { args = JSON.parse(args); } catch { args = { __raw: args }; }
          }
          onEvent('tool_call', {
            id: tc.id || null,
            name: tc.name,
            args: args || {}
          });
        }
      }
      onEvent('finish', ev.data);
    } else if (ev.name === 'tool_call_delta') {
      // OpenAI streams tool calls as a list of deltas. Accumulate
      // by `index`. The first delta carries the `id`; subsequent
      // deltas fill in `function.name` (sometimes) and
      // `function.arguments` (a JSON string we concatenate).
      const d = ev.data;
      const idx = (typeof d.index === 'number') ? d.index : 0;
      let cur = toolAcc.get(idx);
      if (!cur) { cur = { id: null, name: '', arguments: '' }; toolAcc.set(idx, cur); }
      if (d.id) cur.id = d.id;
      if (d.function) {
        if (typeof d.function.name === 'string' && d.function.name) cur.name = d.function.name;
        if (typeof d.function.arguments === 'string') cur.arguments += d.function.arguments;
      }
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
  PARSERS,
  // exposed for tests + the OAuth module's refresher path
  copilotCacheClear
};
