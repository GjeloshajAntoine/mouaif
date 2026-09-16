'use strict';

// Provider registry + request builders + event parsers for the AI client.
//
// Implements docs/decisions.md section 10: server-side proxy with SSE
// streaming for the configured providers. The mobile UI never holds an
// API key — it POSTs to /api/ai/chat and reads the SSE stream back.
//
// This module owns the provider definitions (ENDPOINTS), the model-list
// adapters (listModels / listTranscriptionModels / listImageModels), the request builders
// (BUILDERS), and the event parsers (PARSERS). The multi-turn streaming loop
// lives in src/ai-stream.js; the public facade is src/ai.js.
//
// Adding a provider is a localized change: an ENDPOINTS entry here, a
// BUILDERS + PARSERS entry at the bottom, and (if the auth shape
// differs) an entry in src/auth.js.

const { joinUrl, firstStringField } = require('./util.js');

// openAIShapedListModels(def, cred, signal) — shared fetch + error
// mapping for the OpenAI-shaped /models adapters (openai-compatible,
// openrouter, azure, mistral, groq, deepseek), which previously each
// carried an identical copy of this scaffold. `def`:
//   name            provider key (for typed errors)
//   url             the /models endpoint
//   authHeader(cred) header builder (same shape as ENDPOINTS entries)
//   thinkingFor     model -> { kind } mapper for parseOpenAIShapedModels
//   requireCred     true -> 401/403 with no cred is a typed ENO_APIKEY
//                   (openai-compatible, azure, mistral, groq, deepseek);
//                   false -> unauthenticated list works (openrouter)
async function openAIShapedListModels(def, cred, signal) {
  let r;
  try {
    r = await fetch(def.url, { headers: cred ? def.authHeader(cred) : {}, signal });
  } catch (e) { throw unreachableError(def.name, e); }
  if (def.requireCred !== false && (r.status === 401 || r.status === 403)) {
    if (!cred) throw noApiKeyError(def.name);
    throw httpError(r);
  }
  if (!r.ok) throw httpError(r);
  const body = await r.json();
  return parseOpenAIShapedModels(body, def.thinkingFor);
}

// ---- Provider endpoints ------------------------------------------------

const ENDPOINTS = {
  'openai-compatible': {
    chatPath: '/chat/completions',
    authHeader: (apiKey) => ({ 'Authorization': 'Bearer ' + apiKey }),
    // GET {baseUrl}/models — OpenAI-shaped. Optional key in practice,
    // but in this env the upstream returns 401 when no Authorization
    // header is sent, so treat "no cred" as a typed ENO_APIKEY error
    // instead of a generic upstream 401.
    listModels: async (cred, signal) => openAIShapedListModels({
      name: 'openai-compatible',
      url: (ENDPOINTS['openai-compatible'].baseUrl || 'https://api.openai.com/v1') + '/models',
      authHeader: ENDPOINTS['openai-compatible'].authHeader,
      thinkingFor: (m) => thinkingForOpenAIModel(m.id)
    }, cred, signal)
  },
  'anthropic': {
    baseUrl: 'https://api.anthropic.com',
    chatPath: '/v1/messages',
    anthropicVersion: '2023-06-01',
    // Anthropic does not expose a public list-models endpoint; the
    // /v1/models beta is OAuth-only and is not reachable with a
    // standard API key. Ship a curated catalog that mirrors the
    // models documented at https://docs.claude.com/en/docs/about-claude/models.
    // Every current Claude model supports extended thinking with a raw
    // token budget, so the descriptor is uniform across the catalog.
    listModels: async () => parseCuratedModels(ANTHROPIC_MODEL_CATALOG, { kind: 'budget' }),
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
    authHeader: (apiKey) => ({ 'x-goog-api-key': apiKey }),
    // GET /v1beta/models?key=<key> — Gemini-shaped (no Bearer header;
    // key is a query param). The unauthenticated call used to be
    // public, but the public list endpoint now returns 403 without
    // a key, so a missing cred is a typed ENO_APIKEY error rather
    // than a generic upstream 403.
    listModels: async (cred, signal) => {
      const url = ENDPOINTS.gemini.baseUrl + '/v1beta/models?pageSize=200'
        + (cred ? '&key=' + encodeURIComponent(cred) : '');
      let r;
      try { r = await fetch(url, { signal }); }
      catch (e) { throw unreachableError('gemini', e); }
      if (r.status === 401 || r.status === 403) {
        if (!cred) throw noApiKeyError('gemini');
        throw httpError(r);
      }
      if (!r.ok) throw httpError(r);
      const body = await r.json();
      return parseGeminiModels(body);
    },
    // The same /v1beta/models response, read through the image slice: it keeps
    // the `predict`-only Imagen rows the chat list drops, so the agent
    // editor's model picker can offer them. There is no separate Gemini image
    // endpoint — the catalogue is one list, filtered by generation method.
    listImageModels: async (cred, signal) => {
      const url = ENDPOINTS.gemini.baseUrl + '/v1beta/models?pageSize=200'
        + (cred ? '&key=' + encodeURIComponent(cred) : '');
      let r;
      try { r = await fetch(url, { signal }); }
      catch (e) { throw unreachableError('gemini', e); }
      if (r.status === 401 || r.status === 403) {
        if (!cred) throw noApiKeyError('gemini');
        throw httpError(r);
      }
      if (!r.ok) throw httpError(r);
      const body = await r.json();
      return parseGeminiModels(body, { slice: 'image' });
    }
  },
  'ollama': {
    baseUrl: 'http://127.0.0.1:11434',
    chatPath: '/api/chat',
    // No auth header. Ollama streams NDJSON, not SSE — we adapt below.
    authHeader: () => ({}),
    streamFormat: 'ndjson',
    // GET /api/tags — Ollama's local catalog (no auth). When the local
    // server is not running, fetch() throws TypeError("fetch failed")
    // (Node 18+ collapses ECONNREFUSED / ENOTFOUND into a generic
    // failure). Surface that as EUNREACHABLE so the HTTP layer can
    // return 503 "service unavailable" instead of a misleading 502
    // "bad gateway".
    listModels: async (cred, signal) => {
      const url = ENDPOINTS.ollama.baseUrl + '/api/tags';
      let r;
      try { r = await fetch(url, { signal }); }
      catch (e) { throw unreachableError('ollama', e); }
      if (!r.ok) throw httpError(r);
      const body = await r.json();
      return parseOllamaModels(body);
    },
    // Ollama exposes reasoning as a boolean `think` flag on the chat
    // request for thinking-capable models (deepseek-r1, qwq, gpt-oss).
    thinkingDescriptor: { kind: 'toggle' }
  },
  'github-copilot': {
    // The base URL points at the Copilot API. Calls require a
    // short-lived Copilot token that is derived per-request from the
    // GitHub OAuth token stored in the keychain. The exchange is
    // performed by oauth-github-copilot.js and the resolved token
    // lands on model.__accessToken (replacing the GitHub token that
    // requireApiKey wrote there). The auth header is identical to
    // the openai-compatible path: a plain Bearer credential.
    baseUrl: 'https://api.githubcopilot.com',
    chatPath: '/chat/completions',
    authHeader: (cred) => ({ 'Authorization': 'Bearer ' + cred }),
    // Copilot does not expose a public list-models endpoint. Return
    // a small curated list of the model ids the Copilot API actually
    // serves today. Kept in sync with the public Copilot docs; the
    // `contextWindow` field is the upstream maximum. Thinking support
    // is inferred per family: OpenAI reasoning models take effort
    // levels, Claude models take a token budget, Gemini 2.5+ takes a
    // thinking budget.
    listModels: async () => parseCuratedModels(COPILOT_MODEL_CATALOG, (m) => {
      const id = String(m.id || '');
      if (/^(gpt-5|o\d)/.test(id)) return { kind: 'levels', levels: OPENAI_THINKING_LEVELS.slice() };
      if (/^claude-/.test(id)) return { kind: 'budget' };
      if (/^gemini-(2\.5|[3-9])/.test(id)) return { kind: 'budget' };
      return undefined;
    }),
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
  },
  // OpenRouter: OpenAI-shaped chat completions at
  // https://openrouter.ai/api/v1/chat/completions. API-key only
  // (OpenRouter does not expose an OAuth flow); the key lives in
  // the standard OpenAI keyring namespace so users do not have to
  // juggle a second credential store. Per OpenRouter's docs, every
  // request should carry an `HTTP-Referer` and `X-OpenRouter-Title`
  // header so the app shows up correctly on the public leaderboard.
  // The X-OpenRouter-Title is resolved at request time from
  // app.openRouter.appName; the shipped defaults are the floor
  // (mouaif is the only client that makes these calls).
  'openrouter': {
    baseUrl: 'https://openrouter.ai/api/v1',
    chatPath: '/chat/completions',
    authHeader: (cred) => ({ 'Authorization': 'Bearer ' + cred }),
    // GET /api/v1/models — OpenAI-shaped. OpenRouter allows the public
    // list unauthenticated, so missing cred is fine here; upstream
    // errors are surfaced as EUPSTREAM with the upstream status, and
    // a network failure is EUNREACHABLE (handled like the others).
    listModels: async (cred, signal) => openAIShapedListModels({
name: 'openrouter',
url: ENDPOINTS.openrouter.baseUrl + '/models',
authHeader: ENDPOINTS.openrouter.authHeader,
thinkingFor: thinkingForOpenRouterModel,
requireCred: false
}, cred, signal),
// POST {baseUrl}/audio/transcriptions takes only the *speech-to-text*
// models, and they are not in the list above. /models is sliced by
// output modality and defaults to `output_modalities=text`, so the 21
// transcription models (`openai/whisper-1`, `openai/gpt-4o-transcribe`,
// `google/chirp-3`, `mistralai/voxtral-mini-transcribe`, …) are absent
// from the chat catalog — asking for one of the chat models it *does*
// carry (an audio-input chat row such as `openai/gpt-audio`) answers
// `400 Model openai/gpt-audio does not exist`. The dictation catalog
// therefore reads this slice instead of filtering the chat one.
listTranscriptionModels: async (cred, signal) => openAIShapedListModels({
name: 'openrouter',
url: ENDPOINTS.openrouter.baseUrl + '/models?output_modalities=transcription',
authHeader: ENDPOINTS.openrouter.authHeader,
thinkingFor: thinkingForOpenRouterModel,
requireCred: false
}, cred, signal),
// GET {baseUrl}/images/models — OpenRouter's *image* catalogue, and the
// same story as the transcription slice above, one product further out:
// /models defaults to `output_modalities=text`, so most of the 52 image
// models are simply not in the chat list at all (`openai/gpt-image-2`,
// `black-forest-labs/flux.2-max`, the whole Recraft/Seedream/Krea families).
// This slice lets the agent editor's model picker offer an image model so a
// subagent can be pinned to one. Unauthenticated like /models (its docs
// call it anonymously too).
listImageModels: async (cred, signal) => openAIShapedListModels({
name: 'openrouter',
url: ENDPOINTS.openrouter.baseUrl + '/images/models',
authHeader: ENDPOINTS.openrouter.authHeader,
thinkingFor: thinkingForOpenRouterModel,
requireCred: false
}, cred, signal),
staticHeaders: {
      'HTTP-Referer': 'https://mouaif.local',
      // The current OpenRouter API uses `X-OpenRouter-Title` as the
      // canonical attribution header. The earlier `X-Title` alias is
      // still accepted for back-compat but is silently dropped on
      // newer versions of the SSO/leaderboard path, so it is no
      // longer the primary signal. We send BOTH names so older and
      // newer OpenRouter releases both attribute the request
      // correctly. The values are placeholders; the real ones are
      // resolved at request time from app.openRouter.appName via
      // resolveOpenRouterStaticHeaders(). The shipped 'mouaif' is
      // the fallback when the user has not configured one.
      'X-OpenRouter-Title': 'mouaif',
      'X-Title': 'mouaif'
    }
  },
  // Azure OpenAI: OpenAI-shaped chat completions at
  // https://<resource>.openai.azure.com/openai/deployments/<deployment>/
  // chat/completions?api-version=<version>. The resource name is the
  // first path segment of the base URL; the deployment name is the
  // model id (a custom deployment, not a raw model name). This is the
  // standard OpenAI SDK request shape with `api-version` as a query
  // parameter — no Azure-specific headers — so the openai-compatible
  // builder and parser apply unchanged. The API key goes in the
  // standard `api-key` header (the SDK does this too; Azure rejects
  // `Authorization: Bearer` unless you use Entra ID instead).
  'azure': {
    baseUrl: '',
    chatPath: '/chat/completions',
    authHeader: (cred) => ({ 'api-key': cred }),
    // GET /openai/models?api-version=<version> — OpenAI-shaped.
    // Azure requires an `api-version` query param on every call and
    // a valid deployment key, so the missing-cred path surfaces as
    // ENO_APIKEY. The api-version is taken from the provider record
    // (model.apiVersion, settable in the provider form) or defaults
    // to a recent GA release (2024-10-21, which supports
    // stream_options.include_usage for chat completions).
    listModels: async (cred, signal, model) => openAIShapedListModels({
      name: 'azure',
      url: joinUrl(ENDPOINTS.azure.baseUrl, '/openai/models?api-version=' + encodeURIComponent((model && model.apiVersion) || '2024-10-21')),
      authHeader: ENDPOINTS.azure.authHeader,
      thinkingFor: (mm) => thinkingForOpenAIModel(mm.id)
    }, cred, signal),
    // Every Azure request must carry an api-version query parameter.
    // model.apiVersion is user-settable (provider form); the builder
    // appends it unless the caller already set one.
    apiVersion: '2024-10-21'
  },
  // Mistral: OpenAI-shaped chat completions at
  // https://api.mistral.ai/v1/chat/completions with a Bearer key.
  // The model catalog (GET /v1/models) is OpenAI-shaped, so the
  // openai-compatible builder and parser apply unchanged.
  'mistral': {
    baseUrl: 'https://api.mistral.ai/v1',
    chatPath: '/chat/completions',
    authHeader: (cred) => ({ 'Authorization': 'Bearer ' + cred }),
    listModels: async (cred, signal) => openAIShapedListModels({
      name: 'mistral',
      url: ENDPOINTS.mistral.baseUrl + '/models',
      authHeader: ENDPOINTS.mistral.authHeader,
      thinkingFor: (mm) => thinkingForOpenAIModel(mm.id)
    }, cred, signal),
  },
  // Groq: OpenAI-shaped chat completions at
  // https://api.groq.com/openai/v1/chat/completions with a Bearer key.
  // The catalog (GET /openai/v1/models) is OpenAI-shaped, so the
  // openai-compatible builder and parser apply unchanged.
  'groq': {
    baseUrl: 'https://api.groq.com/openai/v1',
    chatPath: '/chat/completions',
    authHeader: (cred) => ({ 'Authorization': 'Bearer ' + cred }),
    listModels: async (cred, signal) => openAIShapedListModels({
      name: 'groq',
      url: ENDPOINTS.groq.baseUrl + '/models',
      authHeader: ENDPOINTS.groq.authHeader,
      thinkingFor: (mm) => thinkingForOpenAIModel(mm.id)
    }, cred, signal),
  },
  // DeepSeek: OpenAI-shaped chat completions at
  // https://api.deepseek.com/chat/completions with a Bearer key.
  // The catalog (GET /models) is OpenAI-shaped, so the openai-
  // compatible builder and parser apply unchanged.
  'deepseek': {
    baseUrl: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    authHeader: (cred) => ({ 'Authorization': 'Bearer ' + cred }),
    listModels: async (cred, signal) => openAIShapedListModels({
      name: 'deepseek',
      url: ENDPOINTS.deepseek.baseUrl + '/models',
      authHeader: ENDPOINTS.deepseek.authHeader,
      thinkingFor: (mm) => thinkingForOpenAIModel(mm.id)
    }, cred, signal),
  }
};

// resolveOpenRouterStaticHeaders() — returns the shipped static headers for
// the OpenRouter endpoint verbatim. The per-install app name override was
// removed; only the shipped defaults are used.
//
// Exists as a function so the call site (buildOpenAIRequest) can branch on
// `model.provider === 'openrouter'` without an ENDPOINTS mutation.
function resolveOpenRouterStaticHeaders() {
  return ENDPOINTS.openrouter.staticHeaders;
}

// ---- Model-list adapters ----------------------------------------------
//
// The chat <select> is populated dynamically from the upstream
// /models endpoint. Each ENDPOINTS entry above carries a listModels(cred)
// that returns a normalized [{ id, label, contextWindow? }]. Curated
// catalogs (Copilot) are listed inline so the picker still works when the
// upstream has no public list endpoint.
//
// A provider may also carry an optional listTranscriptionModels(cred): the
// slice of its catalog that can transcribe, when that is not simply "the
// same list, filtered" (OpenRouter slices /models by output modality). The
// dictation catalog prefers it and falls back to listModels + filtering, so
// only a provider that really needs the distinction pays for one.

const COPILOT_MODEL_CATALOG = [
  { id: 'gpt-4o',           label: 'GPT-4o',                      contextWindow: 128000 },
  { id: 'gpt-4.1',          label: 'GPT-4.1',                     contextWindow: 1047576 },
  { id: 'gpt-5',            label: 'GPT-5',                       contextWindow: 400000 },
  { id: 'gpt-5-mini',       label: 'GPT-5 mini',                  contextWindow: 400000 },
  { id: 'claude-sonnet-4',  label: 'Claude Sonnet 4',             contextWindow: 200000 },
  { id: 'claude-sonnet-4.5',label: 'Claude Sonnet 4.5',           contextWindow: 200000 },
  { id: 'claude-opus-4',    label: 'Claude Opus 4',               contextWindow: 200000 },
  { id: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro',              contextWindow: 1048576 }
];

const ANTHROPIC_MODEL_CATALOG = [
  { id: 'claude-opus-4',    label: 'Claude Opus 4',               contextWindow: 200000 },
  { id: 'claude-opus-4.1',  label: 'Claude Opus 4.1',             contextWindow: 200000 },
  { id: 'claude-opus-4.5',  label: 'Claude Opus 4.5',             contextWindow: 200000 },
  { id: 'claude-sonnet-4',  label: 'Claude Sonnet 4',             contextWindow: 200000 },
  { id: 'claude-sonnet-4.5',label: 'Claude Sonnet 4.5',           contextWindow: 200000 },
  { id: 'claude-sonnet-5',  label: 'Claude Sonnet 5',             contextWindow: 1000000 },
  { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5',            contextWindow: 200000 },
  { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (legacy)', contextWindow: 200000 },
  { id: 'claude-3-5-haiku-20241022',  label: 'Claude 3.5 Haiku (legacy)',  contextWindow: 200000 }
];

function httpError(resp) {
  const e = new Error('upstream ' + resp.status + ' ' + resp.statusText);
  e.code = 'EUPSTREAM';
  e.status = resp.status;
  return e;
}

// noApiKeyError(provider, hint) — typed error thrown by listModels adapters
// when a provider requires a credential but none is configured. Lets the
// HTTP layer distinguish "add a key" (400 ENO_APIKEY) from "upstream
// misbehaved" (502 EUPSTREAM) so the chat UI can show an actionable
// message instead of a generic "model list failed".
function noApiKeyError(provider, hint) {
  const e = new Error('No API key configured for ' + provider + '. ' + (hint || 'Add one in Settings \u2192 Providers.'));
  e.code = 'ENO_APIKEY';
  e.provider = provider;
  return e;
}

// unreachableError(provider, cause) — typed error thrown when the upstream
// is not reachable (ECONNREFUSED, ENOTFOUND, fetch failed). Distinct from
// EUPSTREAM (upstream answered with a non-2xx) so the HTTP layer can
// return 503 "service unavailable" instead of 502 "bad gateway".
function unreachableError(provider, cause) {
  const e = new Error('Cannot reach ' + provider + ' upstream: ' + (cause && cause.message ? cause.message : String(cause || 'unknown')));
  e.code = 'EUNREACHABLE';
  e.provider = provider;
  e.cause = cause;
  return e;
}

// abortedError(provider) — typed error thrown when the upstream call was
// aborted by the per-call AbortController (timeout). Distinct from
// EUNREACHABLE so the HTTP layer can return 504 "gateway timeout" with
// a clear message instead of 503.
function abortedError(provider) {
  const e = new Error('Timed out waiting for ' + provider + ' upstream');
  e.code = 'EABORTED';
  e.provider = provider;
  return e;
}

// ---- Thinking capability descriptors ----------------------------------
//
// Each live model record may carry a `thinking` field describing the
// reasoning controls the provider actually accepts for that model:
//
//   { kind: 'levels', levels: ['low','medium','high'] }  — effort presets
//   { kind: 'budget'  }                                   — raw token budget
//
// The chat UI builds its thinking dropdown from this descriptor when
// present; when absent it falls back to the generic presets. The
// request builders accept any provider-reported level verbatim (they
// no longer whitelist only low/medium/high) so new upstream values
// (e.g. OpenAI's "minimal"/"xhigh") work without a client update.

// Effort levels known to be valid on OpenAI-shaped reasoning endpoints.
// Order matters: the UI shows them in this sequence.
const OPENAI_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// thinkingForOpenAIModel(id) — best-effort static inference for the
// openai-compatible provider, whose /models endpoint does not report
// reasoning support. Returns undefined when the id gives no signal so
// the UI falls back to generic presets.
function thinkingForOpenAIModel(id) {
  const s = String(id || '').toLowerCase();
  // OpenAI reasoning families (o1/o3/o4, gpt-5*), plus common
  // reasoning-flagged models on OpenAI-shaped third-party endpoints.
  // OpenAI reasoning models take effort levels; reasoning models from
  // other vendors behind an OpenAI-shaped gateway (DeepSeek's `deepseek-
  // reasoner`, Qwen's `qwq` / `-thinking` variants, Kimi's `k2-thinking`)
  // also accept `reasoning_effort` levels or a boolean toggle — levels
  // are the safe common denominator for those too.
  const isReasoning = /^(o\d|gpt-5)/.test(s)
    || /reasoning|think|\br1\b|qwq/.test(s)
    || /deepseek-(reasoner|r1)/.test(s)
    || /k2-thinking/.test(s);
  if (!isReasoning) return undefined;
  return { kind: 'levels', levels: OPENAI_THINKING_LEVELS.slice() };
}

// thinkingForOpenRouterModel(m) — OpenRouter reports per-model
// `supported_parameters` (and on some revisions a `reasoning` block)
// on GET /api/v1/models. Map that onto our descriptor.
function thinkingForOpenRouterModel(m) {
  const sp = Array.isArray(m && m.supported_parameters) ? m.supported_parameters : [];
  const supportsReasoning = sp.indexOf('reasoning') >= 0
    || sp.indexOf('reasoning_effort') >= 0
    || sp.indexOf('include_reasoning') >= 0;
  if (!supportsReasoning) return undefined;
  // Anthropic-family models behind OpenRouter take a token budget;
  // everything else takes effort levels. OpenRouter accepts either
  // shape on its /chat/completions, so levels are a safe default.
  if (/^anthropic\//.test(String(m.id || ''))) return { kind: 'budget' };
  return { kind: 'levels', levels: OPENAI_THINKING_LEVELS.slice() };
}

function parseOpenAIShapedModels(body, thinkingFor) {
  const arr = Array.isArray(body && body.data) ? body.data : [];
  const out = [];
  for (const m of arr) {
    if (!m || !m.id) continue;
    const rec = {
      id: String(m.id),
      label: m.id,
      contextWindow: typeof m.context_window === 'number' ? m.context_window : undefined
    };
    // OpenRouter advertises real per-model prices on GET /api/v1/models
    // (`pricing.prompt` / `pricing.completion`, strings in $ per TOKEN)
    // plus cache rates (`pricing.input_cache_read` / `pricing.input_cache_write`,
    // also $ per token). When present, fold them into the record as a
    // `pricing` block so the cost line uses the provider's actual numbers
    // instead of the best-effort built-in table. All values are optional
    // and validated — a missing or malformed field is dropped, never a
    // crash.
    const pricing = openRouterPricingFromModel(m);
    if (pricing) rec.pricing = pricing;
    // OpenRouter advertises each model's input *and* output modalities
    // (`architecture.input_modalities` / `architecture.output_modalities`).
    // Both are carried through because the dictation catalog selects on them:
    //
    //   * `output_modalities: ["transcription"]` is the definitive "this is a
    //     speech-to-text model" — and those rows only exist in a *sliced* view
    //     of /models that the chat list never sees (see the openrouter
    //     `listTranscriptionModels` adapter);
    //   * a reported output list *without* `transcription` is the definitive
    //     "this is not one", however much audio the row accepts
    //     (`openai/gpt-audio`, `google/gemini-2.5-flash`). Sending one of those
    //     to /audio/transcriptions answers `400 Model … does not exist`, which
    //     is exactly what a picker selecting on audio input alone offered;
    //   * `input_modalities` stays as the fallback capability signal for a
    //     provider that reports what goes in but not what comes out.
    const inputs = modalityList(m, 'input_modalities');
    if (inputs) rec.inputModalities = inputs;
    const outputs = modalityList(m, 'output_modalities');
    if (outputs) rec.outputModalities = outputs;
    // `supported_parameters` is carried through for the same reason the
    // modalities are: it is the provider's own report of what each model can
    // be *asked* for, and an image model picker needs it to tell a generator
    // from an editor. OpenRouter is the provider that publishes it; a row that
    // requires `input_references` cannot draw from a prompt alone, and
    // offering it in a picture picker is a menu entry that cannot work.
    // Absent stays absent — unknown is never "no".
    const supported = supportedParameters(m);
    if (supported) rec.supportedParameters = supported;
    const thinking = typeof thinkingFor === 'function' ? thinkingFor(m) : undefined;
    if (thinking) rec.thinking = thinking;
    out.push(rec);
  }
  return out;
}

// supportedParameters(m) — OpenRouter's per-model `supported_parameters` map
// (parameter name -> its descriptor), carried onto the record so a consumer
// can consult one parameter without the whole upstream body. Returns null
// when the provider sent nothing usable.
function supportedParameters(m) {
  const raw = m && m.supported_parameters;
  if (!raw || typeof raw !== 'object') return null;
  // Some OpenAI-shaped servers send an array of names instead of a map; both
  // are accepted, and anything else is treated as "said nothing".
  if (Array.isArray(raw)) {
    const out = {};
    for (const name of raw) if (typeof name === 'string') out[name] = {};
    return Object.keys(out).length ? out : null;
  }
  const out = {};
  for (const key of Object.keys(raw)) {
    if (typeof key === 'string' && key) out[key] = raw[key];
  }
  return Object.keys(out).length ? out : null;
}

// modalityList(m, key) — one of `architecture.input_modalities` /
// `architecture.output_modalities` as a lowercased, validated string list, or
// null when the provider said nothing. Absent is "unknown", never "no": the
// dictation filter treats a report it *did* get as authoritative and falls
// back to name/capability guessing only when there is none.
function modalityList(m, key) {
const arch = m && m.architecture;
const list = arch && arch[key];
if (!Array.isArray(list)) return null;
const out = list
.filter((x) => typeof x === 'string')
.map((x) => x.toLowerCase());
return out.length ? out : null;
}
// openRouterPricingFromModel(m) -> { inputPer1K, outputPer1K, cacheReadFactor?, cacheWriteFactor? } | undefined
//
// OpenRouter's GET /api/v1/models returns, per model:
//   pricing: { prompt: "0.000003", completion: "0.000015",   // $ per TOKEN, strings
//              input_cache_read: "0.0000003",                // $ per TOKEN (prompt cache read)
//              input_cache_write: "0.00000375" }             // $ per TOKEN (prompt cache write)
//   // newer models may instead ship prompt_cache_read_breakpoints /
//   // prompt_cache_write_breakpoints with the same $ per token values
// Values are in dollars per single token, so we multiply by 1000 to get
// the per-1K shape the rest of src/usage.js uses. Cache rates are turned
// into unit-free factors (cache rate ÷ base prompt rate) so the cost
// layer can apply them to any input price.
function openRouterPricingFromModel(m) {
  const p = m && m.pricing;
  const promptStr = p && (p.prompt ?? p.prompt_per_token);
  const completionStr = p && (p.completion ?? p.completion_per_token);
  const inputPer1K = pricePer1K(promptStr);
  const outputPer1K = pricePer1K(completionStr);
  if (inputPer1K == null && outputPer1K == null) return undefined;
  const out = {};
  if (inputPer1K != null) out.inputPer1K = inputPer1K;
  if (outputPer1K != null) out.outputPer1K = outputPer1K;
  // Cache factors, when the provider publishes them: read = input_cache_read /
  // prompt, write = input_cache_write / prompt (both $ per token, so the
  // ratio is unit-free). Fall back to the breakpoint arrays for models
  // that ship those instead.
  const read = cacheFactor(p && (p.input_cache_read ?? p.input_cache_read_per_token), promptStr)
    ?? breakpointFactor(m && m.prompt_cache_read_breakpoints, promptStr);
  const write = cacheFactor(p && (p.input_cache_write ?? p.input_cache_write_per_token), promptStr)
    ?? breakpointFactor(m && m.prompt_cache_write_breakpoints, promptStr);
  if (read != null) out.cacheReadFactor = read;
  if (write != null) out.cacheWriteFactor = write;
  return out;
}

// pricePer1K(v) — OpenRouter prices are in $ per single token
// (strings, e.g. "0.000003" for $3 per 1M). Multiply by 1000 to get
// the per-1K shape the rest of src/usage.js uses. Returns null when
// unusable.
function pricePer1K(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return null;
  return n * 1000;
}

// cacheFactor(cachePriceStr, basePriceStr) -> number | null
// Ratio of a cache rate to the base prompt rate (both $ per token, so
// the ratio is unit-free). Missing or garbage values yield null (the
// caller's default applies).
function cacheFactor(cachePriceStr, basePriceStr) {
  if (cachePriceStr == null || cachePriceStr === '') return null;
  const n = Number(cachePriceStr);
  if (!isFinite(n) || n < 0) return null;
  const base = Number(basePriceStr);
  if (!isFinite(base) || base <= 0) return null;
  const factor = n / base;
  // A factor must be a sane positive ratio (0.01–10); anything else is
  // a malformed provider response and should not distort pricing.
  return (factor > 0.01 && factor < 10) ? factor : null;
}

// breakpointFactor(breakpoints, basePriceStr) -> number | null
// The cache breakpoints carry the cached price at each tier
// (`cost.prompt`, $ per token). The factor is cached price / base
// prompt price. Missing base prompt price or missing/garbage breakpoints
// yield null (the caller's default applies).
function breakpointFactor(breakpoints, basePriceStr) {
  const arr = Array.isArray(breakpoints) ? breakpoints : [];
  for (const b of arr) {
    const cost = b && b.cost;
    const v = cost && (cost.prompt ?? cost.prompt_per_token);
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!isFinite(n) || n < 0) continue;
    const base = Number(basePriceStr);
    if (base == null || base <= 0) return null;
    const factor = n / base;
    // A factor must be a sane positive ratio (0.01–10); anything else is
    // a malformed provider response and should not distort pricing.
    return (factor > 0.01 && factor < 10) ? factor : null;
  }
  return null;
}

function parseGeminiModels(body, opts) {
  // Gemini: { models: [{ name: 'models/<id>', displayName, inputTokenLimit, ... }] }
  // opts.slice — 'chat' (default) keeps only rows the chat route can use;
  // 'image' additionally keeps `predict`-only rows (Imagen), so the image
  // slice can offer them without leaking an unusable chat model into the
  // picker's chat list.
  const slice = opts && opts.slice === 'image' ? 'image' : 'chat';
  const arr = Array.isArray(body && body.models) ? body.models : [];
  const out = [];
  for (const m of arr) {
    if (!m || !m.name) continue;
    const id = String(m.name).replace(/^models\//, '');
    const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
    // Keep a model that can answer a request this slice can send: a text/image
    // chat model answers `generateContent`, and an Imagen model answers
    // `predict` (its `:predict` image API). The chat list drops the
    // `predict`-only rows so it never offers a model that cannot chat; the
    // image slice keeps them so the agent editor's model picker can pin one.
    const methodsOk = slice === 'image'
      ? ['generateContent', 'predict', 'predictLongRunning']
      : ['generateContent'];
    if (methods.length && !methods.some((x) => methodsOk.includes(x))) continue;
    const rec = {
    id,
    label: m.displayName || id,
    contextWindow: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined
    };
    // Carry Gemini's own report of what a model produces so an image picker
    // can tell an Imagen row (produces an image) from a text model without
    // guessing on the id alone. A row that answers only `predict` (Imagen) or
    // names an image product is treated as an image producer.
    if (/imagen/i.test(id) || /(^|-)image($|-)/i.test(id)
      || (methods.length && methods.includes('predict') && !methods.includes('generateContent'))) {
    rec.outputModalities = ['image'];
    }
    // Gemini 2.5+ models accept generationConfig.thinkingConfig with a
    // raw thinkingBudget token count.
    if (/gemini-(2\.5|[3-9])/.test(id)) rec.thinking = { kind: 'budget' };
    out.push(rec);
  }
  return out;
}

function parseOllamaModels(body) {
  const arr = Array.isArray(body && body.models) ? body.models : [];
  const out = [];
  for (const m of arr) {
    if (!m || !m.name) continue;
    out.push({
      id: String(m.name),
      label: m.name,
      contextWindow: undefined  // Ollama doesn't expose context in /api/tags.
    });
  }
  return out;
}

function parseCuratedModels(catalog, thinkingFor) {
  return catalog.map((m) => {
    const rec = {
      id: m.id,
      label: m.label || m.id,
      contextWindow: m.contextWindow
    };
    const thinking = typeof thinkingFor === 'function'
      ? thinkingFor(m)
      : (thinkingFor || m.thinking);
    if (thinking) rec.thinking = thinking;
    return rec;
  });
}

// normalizeModelList(out) — stable, friendly order (by id ascending) and
// deduped. Both model-list entry points go through it so a caller cannot tell
// the chat catalog from the speech-to-text one by shape alone.
function normalizeModelList(out) {
const seen = new Set();
const dedup = [];
for (const m of (Array.isArray(out) ? out : []).sort((a, b) => a.id.localeCompare(b.id))) {
if (!m || !m.id || seen.has(m.id)) continue;
seen.add(m.id);
dedup.push(m);
}
return dedup;
}
// listModels(provider, cred, signal) -> Promise<[{ id, label, contextWindow? }]>
// Returns the live list for a provider; throws on upstream error so the
// caller can surface a typed error to the chat UI.
async function listModels(provider, cred, signal) {
const def = ENDPOINTS[provider];
if (!def || typeof def.listModels !== 'function') {
const e = new Error('no listModels for provider: ' + provider);
e.code = 'ENO_LIST';
throw e;
}
return normalizeModelList(await def.listModels(cred, signal));
}
// listTranscriptionModels(provider, cred, signal)
//   -> Promise<[...] | null>
//
// The slice of a provider's catalog that can transcribe, when that is not
// simply "the chat list, filtered": OpenRouter's /models is sliced by output
// modality and defaults to `text`, so its 21 speech-to-text models are absent
// from the chat list and /audio/transcriptions rejects the audio-input chat
// models that *are* in it. `null` means "this provider has no separate
// speech-to-text catalog" — the caller filters the chat list instead, which is
// what every provider but OpenRouter needs. Throws the same typed errors as
// listModels.
async function listTranscriptionModels(provider, cred, signal) {
const def = ENDPOINTS[provider];
if (!def || typeof def.listTranscriptionModels !== 'function') return null;
return normalizeModelList(await def.listTranscriptionModels(cred, signal));
}

// listImageModels(provider, cred, signal) -> Promise<[...] | null>
//
// The slice of a provider's catalogue that can generate pictures, when that
// is not "the chat list, filtered": OpenRouter's /models defaults to
// `output_modalities=text`, so its image catalogue is a different endpoint
// (`/images/models`) that the chat list never sees; Gemini's catalogue is one
// list where the chat slice drops the `predict`-only Imagen rows. `null` means
// "this provider has no separate image catalogue" — a caller reading this slice
// falls back to the chat list. OpenRouter and Gemini have one; every other
// provider does not.
async function listImageModels(provider, cred, signal) {
const def = ENDPOINTS[provider];
if (!def || typeof def.listImageModels !== 'function') return null;
return normalizeModelList(await def.listImageModels(cred, signal));
}

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
    // Re-throw with the typed code preserved (ESSO_REQUIRED, ENOCOPILOT,
    // EUPSTREAM, EPARSE, ETOKEN).
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

// joinUrl() is shared from src/util.js.

// Returns the effective bearer-style credential: the OAuth access token
// if one was resolved by requireApiKey, otherwise the plain apiKey.
function credential(model) {
  return model.__accessToken || model.apiKey;
}

// Providers whose upstream accepts OpenAI's `prompt_cache_key`. The field
// is OpenAI-specific: OpenAI and Azure OpenAI document it, and OpenRouter
// forwards it to the OpenAI-family upstream it routes to. It is deliberately
// NOT sent to every OpenAI-shaped provider — a strict gateway that rejects
// unknown body fields would turn the optimisation into a 400 — and never to
// Anthropic, which uses explicit `cache_control` breakpoints instead
// (see docs/features/prompt-caching.md).
const PROMPT_CACHE_KEY_PROVIDERS = new Set(['openai-compatible', 'azure', 'openrouter']);

function buildOpenAIRequest(model, messages, stream, specs, requestOpts) {
  const def = ENDPOINTS[model.provider] || ENDPOINTS['openai-compatible'];
  // Fall back to the per-provider defaultBaseUrl when the saved
  // record's baseUrl is empty. Without this, an openai-compatible or
  // openrouter model with baseUrl: '' would collapse the URL to the
  // relative path '/chat/completions' instead of the upstream
  // endpoint. The Settings UI snaps baseUrl to defaultBaseUrl on
  // save, but a hand-edited .mouaif.json or a future provider that
  // forgets to set one would otherwise break.
  const baseUrl = (model && model.baseUrl) || (def && def.baseUrl) || '';
  const headers = { 'Content-Type': 'application/json' };
  // Auth header: a provider with its own authHeader (azure's `api-key`,
  // the Bearer-key providers) uses it; the generic fallback is the
  // OpenAI Bearer header.
  const authFn = (def && typeof def.authHeader === 'function')
    ? def.authHeader
    : ENDPOINTS['openai-compatible'].authHeader;
  Object.assign(headers, authFn(credential(model)));
  // Per-provider static headers. github-copilot requires editor
  // identification headers; openrouter carries the per-install
  // X-OpenRouter-Title (canonical) + X-Title (deprecated alias)
  // + HTTP-Referer, resolved at request time from
  // app.openRouter.appName. The order (auth first,
  // static second) means a caller-supplied model.headers can
  // still override the defaults — useful for tests and for a
  // future per-model override.
  if (def && def.staticHeaders) {
    Object.assign(headers, model.provider === 'openrouter'
      ? resolveOpenRouterStaticHeaders()
      : def.staticHeaders);
  }
  if (model && model.headers && typeof model.headers === 'object') Object.assign(headers, model.headers);
  // Claude routed through OpenRouter supports Anthropic prompt caching,
  // but only when the OpenAI-shaped request carries explicit
  // cache_control breakpoints on message content blocks. The native
  // Anthropic builder adds them; the plain OpenAI body has none, so
  // Claude-via-OpenRouter would get a 0% cache hit on every turn. Inject
  // the same breakpoints (last system message + penultimate message) the
  // native path uses. Other OpenAI-shaped providers are untouched.
  const effectiveMessages = isOpenRouterAnthropicModel(model)
    ? injectOpenRouterAnthropicCache(messages)
    : messages;

  const body = {
    model: model.id,
    messages: effectiveMessages,
    stream: !!stream
  };
  if (stream && (model.provider === 'openai-compatible' || model.provider === 'openrouter'
    || model.provider === 'azure' || model.provider === 'mistral' || model.provider === 'groq' || model.provider === 'deepseek')) {
    // OpenAI-shaped streaming APIs do not include final token usage by
    // default. Request it explicitly so the chat's Context/Cost line is
    // based on upstream counts instead of staying at zero.
    body.stream_options = { include_usage: true };
  }
  if (stream && model.provider === 'openrouter') {
    // OpenRouter only includes its authoritative billed `usage.cost` when
    // asked. Prefer that over local pricing when present.
    body.usage = { include: true };
  }
  // OpenAI-family prompt caching. The upstream caches prompt prefixes
  // automatically, but it can only serve a warm cache when consecutive
  // requests of one conversation land on the same machine. `prompt_cache_key`
  // is the documented routing hint for exactly that: a stable key per
  // conversation raises the hit rate, and the hits are already reported back
  // through `prompt_tokens_details.cached_tokens` (see src/usage.js). The key
  // is supplied by the caller (src/ai-stream.js) because only it knows the
  // chat id; a request with no chat omits the field.
  const cacheKey = requestOpts && requestOpts.promptCacheKey;
  if (cacheKey && PROMPT_CACHE_KEY_PROVIDERS.has(model.provider)) {
    body.prompt_cache_key = String(cacheKey);
  }
  // Azure OpenAI requires an `api-version` query parameter on every
  // request. The provider form lets the user set model.apiVersion
  // (defaults to the ENDPOINTS default below); an explicit query
  // already present in the base URL wins. Azure's URL shape is
  // https://<res>.openai.azure.com/openai/deployments/<deploy>/chat/
  // completions?api-version=<version> — the query goes on the joined
  // deployment URL (after the /chat/completions suffix).
  let effectiveUrl = joinUrl(baseUrl, ENDPOINTS['openai-compatible'].chatPath);
  if (model.provider === 'azure') {
    const apiVersion = (model && model.apiVersion)
      || (def && def.apiVersion)
      || '2024-10-21';
    if (effectiveUrl.indexOf('api-version=') < 0) {
      const separator = effectiveUrl.indexOf('?') >= 0 ? '&' : '?';
      effectiveUrl = effectiveUrl + separator + 'api-version=' + encodeURIComponent(apiVersion);
    }
  }
  // Inject thinking level (reasoning_effort) for OpenAI-compatible
  // providers. Empty string means off/default. Any non-empty value is
  // passed through verbatim — the valid set comes from the provider
  // (surface via the model's `thinking.levels` descriptor) and varies
  // by model ("minimal"/"low"/"medium"/"high"/"xhigh" today), so
  // whitelisting here would just lag the upstream.
  if (model.thinkingLevel) {
    const tl = String(model.thinkingLevel).trim();
    if (tl) body.reasoning_effort = tl;
  }
  // Inject a max output cap for OpenAI-compatible providers. Empty string
  // means upstream default (never set the field); a positive integer sets
  // max_completion_tokens. OpenAI-shaped chat-completions endpoints accept
  // max_completion_tokens on both classic and reasoning models.
  const maxOut = String(model.maxOutputTokens || '').trim();
  if (maxOut && /^\d+$/.test(maxOut) && parseInt(maxOut, 10) > 0) {
    body.max_completion_tokens = parseInt(maxOut, 10);
  }
  return {
    url: effectiveUrl,
    headers,
    body
  };
}

function openAIContentToAnthropic(content) {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') };
    if (part.type === 'text') return { type: 'text', text: part.text || '' };
    if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
      const m = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/);
      if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    }
    return { type: 'text', text: '' };
  }).filter((part) => part.type !== 'text' || part.text);
}

function openAIContentToGeminiParts(content) {
  if (!Array.isArray(content)) return [{ text: content == null ? '' : String(content) }];
  return content.map((part) => {
    if (!part || typeof part !== 'object') return { text: String(part || '') };
    if (part.type === 'text') return { text: part.text || '' };
    if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
      const m = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/);
      if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
    }
    return { text: '' };
  }).filter((part) => part.text || part.inlineData);
}

function systemContentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part == null) return '';
      if (typeof part === 'string') return part;
      if (typeof part === 'object' && part.type === 'text') return part.text || '';
      return '';
    }).filter(Boolean).join('\n');
  }
  return String(content);
}

// openAIToolsToAnthropic(specs) -> [{ name, description, input_schema }]
// Converts the OpenAI-shaped tool specs ({ type:'function',
// function:{ name, description, parameters } }) into Anthropic's native
// tool form. The `parameters` block is already JSON Schema, which is
// exactly what Anthropic's input_schema expects.
function openAIToolsToAnthropic(specs) {
  return (Array.isArray(specs) ? specs : [])
    .map((s) => {
      const fn = s && s.function;
      if (!fn || typeof fn.name !== 'string' || !fn.name) return null;
      return {
        name: fn.name,
        description: typeof fn.description === 'string' ? fn.description : '',
        input_schema: fn.parameters || { type: 'object', properties: {} }
      };
    })
    .filter(Boolean);
}

// openAIMessageToAnthropic(m) -> Anthropic message | null
// Converts one OpenAI-shaped conversation message to the Anthropic shape:
//   - assistant + tool_calls -> text block (when present) + tool_use blocks
//   - role 'tool'            -> user message with a tool_result block
//   - everything else        -> role + content converted via
//                               openAIContentToAnthropic (images etc.)
// Returns null for a message with no representable content.
function openAIMessageToAnthropic(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.role === 'tool') {
    // OpenAI tool-result -> Anthropic tool_result block inside a user
    // message. tool_use_id must reference a prior tool_use block's id
    // in the same conversation; the tool loop preserves the upstream id
    // across the assistant(tool_use) -> tool_result round trip.
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: m.tool_call_id || m.toolCallId || '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content)
      }]
    };
  }
  if (m.role === 'assistant') {
    const blocks = [];
    if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content });
    else if (Array.isArray(m.content)) blocks.push(...openAIContentToAnthropic(m.content));
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc.function || {};
        let input = {};
        if (typeof fn.arguments === 'string') {
          try { input = JSON.parse(fn.arguments); } catch { input = {}; }
        } else if (fn.arguments && typeof fn.arguments === 'object') {
          input = fn.arguments;
        }
        blocks.push({ type: 'tool_use', id: tc.id || undefined, name: fn.name || 'tool', input });
      }
    }
    if (!blocks.length) return null;
    return { role: 'assistant', content: blocks };
  }
  const content = openAIContentToAnthropic(m.content);
  if (content == null || content === '') return null;
  return { role: m.role || 'user', content };
}

// markPenultimateMessage(messages) — add a cache_control breakpoint to the
// second-to-last converted message. The penultimate message is the deepest
// point of the stable, replayed prefix: everything before the current turn
// (system, tools, and the full history) is re-sent byte-identically on every
// request — each tool round and every follow-up user turn — so the next
// request reads it from cache at the discounted rate. The FINAL message is
// never marked: a breakpoint on the current turn is ignored by the API and
// its content is not part of the stable prefix anyway. Plain-text messages
// are wrapped in a text block because cache_control is only honored on
// object blocks.
function markPenultimateMessage(messages) {
  const target = messages[messages.length - 2];
  if (!target || !target.content) return;
  if (!Array.isArray(target.content)) {
    target.content = [{ type: 'text', text: String(target.content), cache_control: { type: 'ephemeral' } }];
    return;
  }
  const last = target.content[target.content.length - 1];
  if (last && typeof last === 'object' && !last.cache_control) {
    last.cache_control = { type: 'ephemeral' };
  }
}

// isOpenRouterAnthropicModel(model) — true for a Claude model routed
// through OpenRouter. OpenRouter forwards Anthropic prompt caching but
// only when the OpenAI-shaped request carries explicit `cache_control`
// breakpoints on message content blocks; the vanilla OpenAI body has
// none, so Claude-via-OpenRouter never gets a cache hit without this.
// The slug is vendor-prefixed (`anthropic/claude-...`); we match the
// vendor prefix so every current and future Claude slug is covered.
function isOpenRouterAnthropicModel(model) {
  return !!(model && model.provider === 'openrouter'
    && typeof model.id === 'string'
    && /^anthropic\//i.test(model.id));
}

// markOpenAIMessageCache(message) — add a cache_control breakpoint to an
// OpenAI-shaped message by wrapping/annotating its content parts. Mirrors
// markPenultimateMessage but for the OpenAI content shape OpenRouter
// consumes: a plain string is wrapped in a single text part, and the last
// part of an existing array gets the marker. Returns a NEW message object
// so the caller never mutates the shared conversation array.
function markOpenAIMessageCache(message) {
  if (!message || message.content == null) return message;
  if (typeof message.content === 'string') {
    if (!message.content) return message;
    return Object.assign({}, message, {
      content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }]
    });
  }
  if (Array.isArray(message.content) && message.content.length) {
    const parts = message.content.map((p) => (p && typeof p === 'object') ? Object.assign({}, p) : p);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] && typeof parts[i] === 'object') {
        if (!parts[i].cache_control) parts[i].cache_control = { type: 'ephemeral' };
        break;
      }
    }
    return Object.assign({}, message, { content: parts });
  }
  return message;
}

// injectOpenRouterAnthropicCache(messages) — return a copy of the
// conversation with cache_control breakpoints placed the same way
// buildAnthropicRequest places them on the native path: the LAST system
// message (the stable profile + agent files + custom prompt block) and
// the penultimate message (the deepest point of the replayed prefix:
// system + history). The final message is never marked — a breakpoint on
// the current turn is ignored and its content is not part of the stable
// prefix. The input array is never mutated.
function injectOpenRouterAnthropicCache(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = messages.slice();
  // Last system message → cache the stable system prefix.
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] && out[i].role === 'system') { out[i] = markOpenAIMessageCache(out[i]); break; }
  }
  // Penultimate breakpoint → cache system + tools + history once there is
  // any history to replay (caching engages from the second request).
  // Walk back from the penultimate message to the deepest one that can
  // actually carry a breakpoint. In the agentic tool loop the penultimate
  // message is often an assistant tool-call message with `content: null`
  // (the OpenAI shape keeps tool calls in `tool_calls`, not in content),
  // and cache_control is only honored on a content block. Marking that
  // message is a no-op, which on the native path is harmless (the system
  // block still clears the minimum) but here would leave ONLY the small
  // system block marked — usually below Claude's minimum cacheable length,
  // so every tool round got a 0% cache hit. Skip content-less messages so
  // a real breakpoint always lands.
  for (let i = out.length - 2; i >= 0; i--) {
    const m = out[i];
    if (!m || m.role === 'system' || m.content == null || m.content === '') continue;
    out[i] = markOpenAIMessageCache(out[i]);
    break;
  }
  return out;
}

function buildAnthropicRequest(model, messages, stream, specs) {
  const systemMsgs = messages.filter(m => m.role === 'system');
  const systemContent = systemMsgs.map(m => systemContentText(m.content)).filter(Boolean).join('\n\n');
  const chatMessages = messages.filter(m => m.role !== 'system');
  const maxOutput = String(model.maxOutputTokens || '').trim();
  const maxOutputNum = (maxOutput && /^\d+$/.test(maxOutput) && parseInt(maxOutput, 10) > 0)
    ? parseInt(maxOutput, 10)
    : 0;
  // Prompt caching is generally available on the Messages API, so cache
  // markers work with both API-key and OAuth authentication. OAuth keeps its
  // required oauth-2025-04-20 beta header; API-key requests need no beta.
  // Convert the conversation to Anthropic's native shape: assistant
  // tool_calls become tool_use blocks, `tool` role messages become
  // tool_result user messages. Without this conversion the multi-turn
  // tool loop could never run against Claude. Conversion happens first
  // because empty segments drop out — the penultimate breakpoint below
  // must target the array actually sent upstream.
  const convertedMessages = chatMessages.map(openAIMessageToAnthropic).filter(Boolean);
  // Cache breakpoint on the penultimate message. Anthropic only honors a
  // cache_control marker when the prompt prefix before it exceeds the
  // per-model minimum cacheable length (1024 tokens for Sonnet 3.5/3.7,
  // 4096 for Sonnet 4 / Opus 4 / Haiku 4.5). The system block alone — and
  // even the system block plus a small tool set — is usually below that,
  // so a system-only breakpoint is silently ignored and caching never
  // happens. The penultimate-message breakpoint guarantees the cached
  // prefix (system + tools + history) clears the minimum whenever there
  // is any history to replay: caching engages from the second request of
  // a conversation, even with every tool switched off.
  if (convertedMessages.length >= 2) markPenultimateMessage(convertedMessages);
  const body = {
    model: model.id,
    max_tokens: maxOutputNum || 1024,
    // Anthropic prompt caching: the system message (profile + agent files +
    // custom prompt + feature summary) is stable across every turn of a
    // multi-tool conversation, so marking it with cache_control means the
    // second and subsequent turns read it from cache (~90% discount).
    // The system block is sent as an array so the cache_control field is
    // accepted; a plain string would silently ignore it.
    system: systemContent
      ? [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } }]
      : undefined,
    messages: convertedMessages,
    stream: !!stream
  };
  // Native Anthropic tools, converted from the same OpenAI-shaped specs
  // the other providers advertise. Marking the LAST tool definition with
  // cache_control extends the cached prefix far past the system block, so
  // the tool marker alone usually clears the minimum cacheable length.
  // The penultimate-message breakpoint above still applies for requests
  // whose prefix is short (no tools, or a small tool set).
  const tools = openAIToolsToAnthropic(specs);
  if (tools.length) {
    body.tools = tools;
    body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
  }
  // Inject thinking budget for Anthropic. The thinking level maps to
  // a budget_tokens value. When the level is a plain number string, use
  // it directly as budget_tokens. Known presets: "low"=2048, "medium"=8192, "high"=16384.
  // An empty string means no thinking block (default).
  if (model.thinkingLevel) {
    const tl = String(model.thinkingLevel).trim();
    let budget = 0;
    if (tl === 'low') budget = 2048;
    else if (tl === 'medium') budget = 8192;
    else if (tl === 'high') budget = 16384;
    else {
      const n = parseInt(tl, 10);
      if (isFinite(n) && n > 0) budget = n;
    }
    if (budget > 0) {
    // The budget is capped so a bogus "999999" from a project file cannot
    // ask for an absurd thinking window. max_tokens must clear the
    // thinking budget (Anthropic rejects the request otherwise), so it is
    // derived from the same capped value — computing it from the
    // uncapped `budget` produced `budget_tokens: 100000` next to
    // `max_tokens: 200256` for a 200000-token request.
    const capped = Math.min(budget, 100000);
    body.thinking = { type: 'enabled', budget_tokens: capped };
    if (body.max_tokens < capped + 256) body.max_tokens = capped + 256;
    }
  }
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
    body
  };
}

function buildGeminiRequest(model, messages, stream) {
  // Gemini uses ?alt=sse for streaming responses.
  const url = joinUrl(ENDPOINTS.gemini.baseUrl, '/v1beta/models/' + encodeURIComponent(model.id) + ':' + (stream ? 'streamGenerateContent?alt=sse' : 'generateContent'));
  const systemMsgs = messages.filter(m => m.role === 'system');
  // systemContentText handles both shapes a system message can take: a
  // plain string, and the block array the subagent runner pushes
  // (`[{ type: 'text', text }]`). Joining `m.content` directly sent
  // "[object Object]" as the entire system instruction.
  const systemContent = systemMsgs.map(m => systemContentText(m.content)).filter(Boolean).join('\n\n');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: openAIContentToGeminiParts(m.content) }));
  const body = { contents };
  if (systemContent) body.systemInstruction = { role: 'system', parts: [{ text: systemContent }] };
  // Inject thinking budget for Gemini 2.5+ models. The thinking level
  // maps to generationConfig.thinkingConfig.thinkingBudget. Known
  // presets: "low"=2048, "medium"=8192, "high"=16384; a plain number
  // string is used directly. Empty string leaves thinking at the
  // upstream default (dynamic).
  if (model.thinkingLevel) {
    const tl = String(model.thinkingLevel).trim();
    let budget = 0;
    if (tl === 'low') budget = 2048;
    else if (tl === 'medium') budget = 8192;
    else if (tl === 'high') budget = 16384;
    else {
      const n = parseInt(tl, 10);
      if (isFinite(n) && n > 0) budget = n;
    }
    if (budget > 0) {
      body.generationConfig = Object.assign({}, body.generationConfig, {
        thinkingConfig: { thinkingBudget: budget }
      });
    }
  }
  return {
    url,
    headers: { 'Content-Type': 'application/json', ...ENDPOINTS.gemini.authHeader(credential(model)) },
    body
  };
}

function buildOllamaRequest(model, messages, stream) {
  // Ollama's /api/chat takes OpenAI-shaped messages but expects `content`
  // to be a string: a block array (the subagent runner's system message)
  // is rejected or mis-parsed upstream. Flatten the same way the Anthropic
  // and Gemini builders do.
  const normalized = messages.map((m) => (
    m && Array.isArray(m.content)
      ? Object.assign({}, m, { content: systemContentText(m.content) })
      : m
  ));
  const body = { model: model.id, messages: normalized, stream: !!stream };
  // Ollama's reasoning switch is a boolean `think` flag. Any non-empty
  // thinking level means "on"; empty means upstream default (off for
  // most models).
  if (model.thinkingLevel && String(model.thinkingLevel).trim()) body.think = true;
  return {
    url: joinUrl(model.baseUrl || ENDPOINTS.ollama.baseUrl, ENDPOINTS.ollama.chatPath),
    headers: { 'Content-Type': 'application/json' },
    body
  };
}

const BUILDERS = {
  'openai-compatible': buildOpenAIRequest,
  'anthropic': buildAnthropicRequest,
  'gemini': buildGeminiRequest,
  'ollama': buildOllamaRequest,
  'github-copilot': buildOpenAIRequest, // same shape; ENOAUTH gate above
  'openrouter':       buildOpenAIRequest,  // same shape; apikey-only, reuses staticHeaders
  'azure':            buildOpenAIRequest,  // OpenAI-shaped; api-version appended below
  'mistral':          buildOpenAIRequest,
  'groq':             buildOpenAIRequest,
  'deepseek':         buildOpenAIRequest
};

// ---- Event parsers -----------------------------------------------------
// Each parser reads one event from the upstream and emits zero or more
// normalized events. The normalized event names are:
//   message   -> { delta: 'text' }
//   reasoning -> { delta: 'thinking/reasoning text' }
//   done      -> { usage: { promptTokens, completionTokens } }
//   error     -> { code, message }
// Anything else from the upstream is passed through as `passthrough` so
// the UI can render it for debugging.

const PARSERS = {
  'openai-compatible': parseOpenAISSE,
  'github-copilot':   parseOpenAISSE,
  'openrouter':       parseOpenAISSE,     // OpenAI-shaped SSE; [DONE] sentinel suppressed
  'azure':            parseOpenAISSE,
  'mistral':          parseOpenAISSE,
  'groq':             parseOpenAISSE,
  'deepseek':         parseOpenAISSE,
  'anthropic':        parseAnthropicSSE,
  'gemini':           parseGeminiSSE,
  'ollama':           parseOllamaNDJSON
};

function firstFiniteNumber(...values) {
  const n = firstFiniteNumberOrNull(...values);
  return n == null ? 0 : n;
}

function firstFiniteNumberOrNull(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (isFinite(n) && n >= 0) return n;
  }
  return null;
}

// firstStringField() is shared from src/util.js.

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
  const delta = choice && choice.delta;
  const reasoning = firstStringField(delta, [
    'reasoning',
    'reasoning_content',
    'reasoningContent',
    'thinking',
    'thought',
    'chain_of_thought'
  ]);
  if (reasoning) {
    yield { name: 'reasoning', data: { delta: reasoning } };
  }
  if (choice && choice.message) {
    const messageReasoning = firstStringField(choice.message, [
      'reasoning',
      'reasoning_content',
      'reasoningContent',
      'thinking',
      'thought',
      'chain_of_thought'
    ]);
    if (messageReasoning) yield { name: 'reasoning', data: { delta: messageReasoning } };
  }
  if (delta && typeof delta.content === 'string') {
    yield { name: 'message', data: { delta: delta.content } };
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
    const promptTokens = firstFiniteNumber(
      obj.usage.prompt_tokens,
      obj.usage.input_tokens,
      obj.usage.promptTokens,
      obj.usage.inputTokens
    );
    const completionTokens = firstFiniteNumber(
      obj.usage.completion_tokens,
      obj.usage.output_tokens,
      obj.usage.completionTokens,
      obj.usage.outputTokens
    );
    // OpenAI and OpenAI-shaped providers report cache hits as a subset
    // of prompt_tokens. Accept snake_case, camelCase, DeepSeek's
    // prompt_cache_hit_tokens, and nested variants; OpenRouter and
    // compatible gateways may preserve any of these shapes.
    const promptDetails = obj.usage.prompt_tokens_details || obj.usage.promptTokensDetails || {};
    const cacheReadTokens = firstFiniteNumber(
      promptDetails.cached_tokens,
      promptDetails.cachedTokens,
      obj.usage.cached_tokens,
      obj.usage.cachedTokens,
      obj.usage.prompt_cache_hit_tokens,
      obj.usage.promptCacheHitTokens
    );
    const providerCost = firstFiniteNumberOrNull(
      obj.usage.cost,
      obj.usage.total_cost,
      obj.usage.totalCost
    );
    // OpenRouter additionally reports a cost split under cost_details
    // (docs: usage.cost_details.upstream_inference_prompt_cost /
    // completions_cost). Capture it so persisted segments can show a
    // real input/output cost breakdown instead of a bare total. Missing
    // cost fields stay null; otherwise an absent field would look like a
    // provider-authoritative $0.00 and suppress local pricing fallback.
    const cd = (obj.usage && obj.usage.cost_details) || {};
    const providerCostInput = firstFiniteNumberOrNull(
      cd.upstream_inference_prompt_cost,
      cd.prompt_cost,
      cd.input_cost
    );
    const providerCostOutput = firstFiniteNumberOrNull(
      cd.upstream_inference_completions_cost,
      cd.completion_cost,
      cd.completions_cost,
      cd.output_cost
    );
    yield {
      name: 'done',
      data: {
        usage: { promptTokens, completionTokens, cacheReadTokens },
        providerCost,
        providerCostInput,
        providerCostOutput
      }
    };
  }
}

// Some models routed through OpenRouter (notably MiniMax) occasionally put
// their private tool-call serialization in `delta.content` instead of using
// the OpenAI `delta.tool_calls` field. OpenRouter forwards that text verbatim:
//
//   ]<]minimax[>[<tool_call> ... <invoke name="search_files"> ...
//
// Parse that compatibility form only after a complete upstream turn. Keeping
// it out of parseOpenAISSE avoids interpreting ordinary XML/code examples as
// calls, and the MiniMax sentinel makes the fallback deliberately narrow.
function parseMiniMaxTextToolCalls(text) {
  const source = String(text || '');
  if (source.indexOf(']<]minimax[>[') < 0 || source.indexOf('<tool_call>') < 0) {
    return { text: source, calls: [] };
  }

  const calls = [];
  const blockRe = /\]<\]minimax\[>\[<tool_call>[\s\S]*?\]<\]minimax\[>\[<\/tool_call>/g;
  let match;
  while ((match = blockRe.exec(source))) {
    const block = match[0];
    const invoke = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/.exec(block);
    if (!invoke) continue;
    const args = {};
    const argRe = /<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/g;
    let arg;
    while ((arg = argRe.exec(invoke[2]))) {
      const value = arg[2].trim();
      try { args[arg[1]] = JSON.parse(value); }
      catch { args[arg[1]] = value; }
    }
    calls.push({
      id: 'call_minimax_' + (calls.length + 1),
      name: invoke[1],
      arguments: JSON.stringify(args)
    });
  }

  if (!calls.length) return { text: source, calls: [] };
  return { text: source.replace(blockRe, '').trim(), calls };
}

// parseAnthropicSSE(eventName, data, toolAcc) — Anthropic stream parser.
//
// The third argument is a shared per-turn accumulator for tool_use
// blocks. Anthropic streams a tool call as three separate frames:
//   content_block_start  (type: 'tool_use', id, name, input: {})
//   content_block_delta  (type: 'input_json_delta', partial_json: '...')
//   content_block_stop   (index of the finished block)
// The caller in src/ai-stream.js re-creates the generator for every SSE
// frame, so the accumulator must live outside the generator (one per
// upstream turn); a per-generator map is used for direct one-shot usage
// (tests). Each finished block is emitted as a `tool_call_delta` shaped
// like the OpenAI accumulator expects: { index, id, function: { name,
// arguments } }.
function* parseAnthropicSSE(eventName, data, toolAcc) {
  const acc = toolAcc || new Map();
  if (!data) return;
  let obj;
  try { obj = JSON.parse(data); } catch { yield { name: 'passthrough', data: { raw: data } }; return; }
  switch (obj.type) {
    case 'message_start':
      // usage is reported here for input tokens.
      if (obj.message && obj.message.usage) {
        const usage = obj.message.usage;
        const uncachedInputTokens = Number(usage.input_tokens) || 0;
        const cacheReadTokens = Number(usage.cache_read_input_tokens) || 0;
        const cacheCreationTokens = Number(usage.cache_creation_input_tokens) || 0;
        yield { name: 'usage_input', data: {
          // Anthropic reports three disjoint input buckets. Normalize them
          // to the provider-neutral contract where promptTokens is the full
          // prompt total; computeCost subtracts the cache buckets to recover
          // the full-rate, uncached portion.
          promptTokens: uncachedInputTokens + cacheReadTokens + cacheCreationTokens,
          cacheReadTokens,
          cacheCreationTokens
        } };
      }
      break;
    case 'content_block_start':
      if (obj.content_block && obj.content_block.type === 'tool_use') {
        const block = obj.content_block;
        acc.set(obj.index, { id: block.id, name: block.name, partial: '' });
      }
      break;
    case 'content_block_delta':
      if (obj.delta && obj.delta.type === 'text_delta' && typeof obj.delta.text === 'string') {
        yield { name: 'message', data: { delta: obj.delta.text } };
      } else if (obj.delta && obj.delta.type === 'thinking_delta' && typeof obj.delta.thinking === 'string') {
        yield { name: 'reasoning', data: { delta: obj.delta.thinking } };
      } else if (obj.delta && obj.delta.type === 'signature_delta') {
        // Anthropic signs extended-thinking blocks; the signature is not user-facing.
      } else if (obj.delta && obj.delta.type === 'input_json_delta' && typeof obj.delta.partial_json === 'string') {
        const entry = acc.get(obj.index);
        if (entry) entry.partial += obj.delta.partial_json;
      }
      break;
    case 'content_block_stop': {
      const entry = acc.get(obj.index);
      if (entry && entry.name) {
        acc.delete(obj.index);
        yield {
          name: 'tool_call_delta',
          data: {
            index: obj.index,
            id: entry.id || undefined,
            function: { name: entry.name, arguments: entry.partial || '{}' }
          }
        };
      }
      break;
    }
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
      if (typeof part.thought === 'string') yield { name: 'reasoning', data: { delta: part.thought } };
      else if (part.thought === true && typeof part.text === 'string') yield { name: 'reasoning', data: { delta: part.text } };
      else if (typeof part.text === 'string') yield { name: 'message', data: { delta: part.text } };
    }
  }
  if (cand && cand.finishReason) yield { name: 'finish', data: { reason: cand.finishReason } };
  if (obj.usageMetadata) {
    const metadata = obj.usageMetadata;
    yield {
      name: 'done',
      data: { usage: {
        // Gemini includes cachedContentTokenCount in promptTokenCount, so
        // it maps directly to the provider-neutral cache-read subset.
        promptTokens: metadata.promptTokenCount || 0,
        completionTokens: metadata.candidatesTokenCount || 0,
        cacheReadTokens: metadata.cachedContentTokenCount || 0
      } }
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
  if (obj.message) {
    const reasoning = firstStringField(obj.message, [
      'thinking',
      'reasoning',
      'reasoning_content',
      'reasoningContent',
      'thought'
    ]);
    if (reasoning) yield { name: 'reasoning', data: { delta: reasoning } };
  }
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

module.exports = {
ENDPOINTS,
listModels,
listTranscriptionModels,
listImageModels,
endpointFor,
  requireApiKey,
  BUILDERS,
  PARSERS,
  parseMiniMaxTextToolCalls,
  // Exported so scripts/test-model-lists.js can pin the Gemini catalog
  // parser.
  parseGeminiModels,
  // Curated catalogs, exported so scripts/test-model-pricing-coverage.js can
  // assert that every model id we *offer* also has a built-in price.
  ANTHROPIC_MODEL_CATALOG,
  COPILOT_MODEL_CATALOG,
  // Copilot token cache clear (OAuth refresher + tests)
  copilotCacheClear
};