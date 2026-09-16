'use strict';

// providerShapes — which wire protocol a provider *connection* speaks.
//
// This is a leaf module: it requires nothing, so the domain modules that
// need the answer (src/transcribe.js for dictation, src/imagegen.js for
// pictures) can pull from it without dragging in the chat provider
// registry (src/ai-endpoints.js) or creating a require cycle.
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

module.exports = {
  OPENAI_SHAPED_PROVIDERS,
  isOpenAIShaped
};
