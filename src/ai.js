'use strict';

// AI client core — facade.
//
// This module is the public entry point for the AI client. The actual
// implementation lives in focused sub-modules so the largest file in the
// repo stays under ~2 000 lines each:
//
//   src/ai-endpoints.js  — provider endpoints (ENDPOINTS), model-list
//                          adapters (listModels), request builders
//                          (BUILDERS), event parsers (PARSERS), and the
//                          shared helpers they use.
//   src/ai-stream.js     — the multi-turn streaming loop (streamChat,
//                          runSingleToolCall, runUpstreamTurn).
//   src/ai-chat.js       — non-streaming convenience wrapper (chat).
//
// The public surface is unchanged: streamChat, chat, runSingleToolCall,
// ENDPOINTS, listModels, plus the test-facing helpers parseSSEFrame /
// readSSE / readNDJSON / BUILDERS / PARSERS / copilotCacheClear. See the
// module-level comment below for the request/response contract.
//
// Implements docs/decisions.md section 10: server-side proxy with SSE
// streaming for the configured providers. The mobile UI never holds an
// API key — it POSTs to /api/ai/chat and reads the SSE stream back.
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

const {
  ENDPOINTS,
  listModels,
  BUILDERS,
  PARSERS,
  copilotCacheClear
} = require('./ai-endpoints.js');
const { streamChat, runSingleToolCall, parseSSEFrame, readSSE, readNDJSON } = require('./ai-stream.js');
const { chat } = require('./ai-chat.js');

module.exports = {
  // public
  streamChat,
  chat,
  runSingleToolCall,
  ENDPOINTS,
  listModels,
  // exposed for tests
  parseSSEFrame,
  readSSE,
  readNDJSON,
  BUILDERS,
  PARSERS,
  // exposed for tests + the OAuth module's refresher path
  copilotCacheClear
};
