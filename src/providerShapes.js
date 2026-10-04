'use strict';

// providerShapes — which wire protocol a provider *connection* speaks.
//
// This is a leaf module: it requires nothing, so the domain modules that
// need the answer (src/transcribe.js for dictation, and any future
// non-chat model product) can pull from it without dragging in the chat
// provider registry (src/ai-endpoints.js) or creating a require cycle.
//
// The list used to be copy-pasted into each of those two modules, which
// made adding a provider a three-place edit and let the two copies drift:
// transcribe's copy had grown an extra `anthropic` entry that the wire
// claim does not hold for — Anthropic serves its own Messages API shape,
// not the OpenAI-shaped multipart or `/chat/completions` surface.
//
// The *shipped* OpenAI-shaped providers are exactly the entries in
// src/ai-endpoints.js `ENDPOINTS` whose base URL speaks `/chat/completions`
// and `/models`: the openai-compatible family, OpenRouter, Azure, Mistral,
// Groq, DeepSeek, Ollama, and GitHub Copilot. Gemini is absent because it
// speaks its own per-model `generateContent` action path, and Anthropic is
// absent because it speaks the Messages API — both are addressed by their
// own request builders, never by an OpenAI-shaped one.
//
// Adding a provider: an `ENDPOINTS` row and a builder in src/ai-endpoints.js
// is the substantive change; add its id here too if its base URL really is
// OpenAI-shaped.
const OPENAI_SHAPED_PROVIDERS = Object.freeze([
  'openai-compatible', 'openrouter', 'azure', 'mistral', 'groq', 'deepseek',
  'ollama', 'github-copilot'
]);

// isOpenAIShaped(providerId) — does this connection speak the OpenAI shape?
// Absent or unknown providers are "no": a shape we cannot vouch for is not
// a shape, and every caller that asks this question has a conservative
// default (the conventional endpoint, or "not a candidate") to fall back on.
function isOpenAIShaped(provider) {
  const id = typeof provider === 'string' ? provider : '';
  return id !== '' && OPENAI_SHAPED_PROVIDERS.includes(id);
}

// OPENAI_CHAT_TOOL_PROVIDERS — connections whose *chat* endpoint is OpenAI's
// `/chat/completions`, so it carries the OpenAI `tools` / `tool_calls`
// contract verbatim and can be handed the native tool specs.
//
// This is exactly the subset of OPENAI_SHAPED_PROVIDERS that chats at
// `/chat/completions` — checked against the ENDPOINTS table, which is the
// authority on the wire shape:
//
//   openai-compatible /chat/completions   github-copilot /chat/completions
//   openrouter        /chat/completions   azure          /chat/completions
//   mistral           /chat/completions   groq           /chat/completions
//   deepseek          /chat/completions
//
//   (ollama           /api/chat           — a different contract, see below)
//
// It is deliberately narrower than OPENAI_SHAPED_PROVIDERS, and the two are
// not interchangeable:
//
//   - The four cloud providers (azure, mistral, groq, deepseek) are the gap
//     this list closes. They already shared the OpenAI builder, the SSE
//     parser, and the usage accounting, but the tool loop's ad-hoc provider
//     check did not name them, so a chat on any of them advertised no tools
//     at all. They belong here for the same reason openrouter does.
//   - `ollama` is *absent on purpose*, even though it is OpenAI-shaped for the
//     dictation route. Ollama's native `/api/chat` is not the
//     `/chat/completions` contract: function results go back as
//     `{ role: 'tool', tool_name, content }` — keyed by name, with no call id
//     to echo — while the loop appends OpenAI's
//     `{ role: 'tool', tool_call_id, name, content }`. Pointing the loop at
//     Ollama without teaching `buildOllamaRequest` its shape would send a
//     request the server mis-reads. Ollama's OpenAI surface at `/v1` is
//     reachable through the openai-compatible provider, which is what the docs
//     recommend (see docs/features/local-openai-servers.md).
//   - `gemini` speaks a per-model `generateContent` action path.
//   - `codex` (Responses) and `anthropic` (Messages) speak their own tool
//     shapes, which their own builders convert. They are named explicitly at
//     the two call sites below rather than listed here, because each needs a
//     different `specs` hand-off (Codex gets them from its builder).
const OPENAI_CHAT_TOOL_PROVIDERS = Object.freeze([
  'openai-compatible', 'openrouter', 'github-copilot',
  'azure', 'mistral', 'groq', 'deepseek'
]);

// supportsOpenAIToolLoop(providerId) — does this connection chat at OpenAI's
// `/chat/completions`, so the standard `tools` field may be attached and
// `tool_calls` + `tool` history replayed? Absent or unknown providers are
// "no", the conservative default every caller can fall back on.
function supportsOpenAIToolLoop(provider) {
  const id = typeof provider === 'string' ? provider : '';
  return id !== '' && OPENAI_CHAT_TOOL_PROVIDERS.includes(id);
}

module.exports = {
  OPENAI_SHAPED_PROVIDERS,
  OPENAI_CHAT_TOOL_PROVIDERS,
  isOpenAIShaped,
  supportsOpenAIToolLoop
};
