// mouaif web — what you can pick when adding a provider, and the plain rules
// the form applies to it. No DOM and no imports, so scripts/test-provider-choices.mjs
// can run it directly.
//
// A choice is one way to connect, not one provider type. Anthropic appears twice
// (a Claude plan, an API key), and OpenAI, LM Studio and llama.cpp are presets of
// the `openai-compatible` type. `type` must be a SETTINGS_PROVIDERS id.
//
//   key        the route segment: #/settings/providers/new/<key>
//   auth       how this choice connects: 'apikey' or 'oauth'
//   baseUrl    the URL to start from, when it isn't the type's default
//   urlFirst   the URL is yours to give, so it comes before everything else
//   urlRequired  saving without a URL is refused
//   local      a server you run yourself: its key is optional and tucked away
//   presetName the saved name when you don't give one, for a preset whose type
//              label wouldn't identify it
export const PROVIDER_CHOICE_GROUPS = [
  {
    title: 'Sign in with an account',
    choices: [
      { key: 'claude-plan', type: 'anthropic', auth: 'oauth', label: 'Claude Pro or Max', detail: 'Use your Claude plan', hint: 'Sign in with your Claude Pro or Max account.' },
      { key: 'codex', type: 'codex', auth: 'oauth', label: 'ChatGPT (Codex)', detail: 'Use your ChatGPT plan' },
      { key: 'github-copilot', type: 'github-copilot', auth: 'oauth', label: 'GitHub Copilot', detail: 'Use your Copilot plan' },
      { key: 'openrouter-sign-in', type: 'openrouter', auth: 'oauth', label: 'OpenRouter', detail: 'One account, many models', hint: 'Sign in with OpenRouter. It creates a key for mouaif, so there is nothing to paste.' }
    ]
  },
  {
    title: 'Paste an API key',
    choices: [
      { key: 'openai', type: 'openai-compatible', auth: 'apikey', label: 'OpenAI', detail: 'GPT models', presetName: 'OpenAI', baseUrl: 'https://api.openai.com/v1', hint: 'Paste an API key from platform.openai.com.' },
      { key: 'anthropic', type: 'anthropic', auth: 'apikey', label: 'Anthropic', detail: 'Claude models, billed per use', hint: 'Paste an API key from console.anthropic.com.' },
      { key: 'gemini', type: 'gemini', auth: 'apikey', label: 'Google Gemini', detail: 'Gemini models' },
      { key: 'openrouter', type: 'openrouter', auth: 'apikey', label: 'OpenRouter', detail: 'One key, many models', hint: 'Paste an API key from openrouter.ai.' },
      { key: 'mistral', type: 'mistral', auth: 'apikey', label: 'Mistral', detail: 'Mistral models' },
      { key: 'groq', type: 'groq', auth: 'apikey', label: 'Groq', detail: 'Fast open models' },
      { key: 'deepseek', type: 'deepseek', auth: 'apikey', label: 'DeepSeek', detail: 'DeepSeek models' },
      { key: 'azure', type: 'azure', auth: 'apikey', label: 'Azure OpenAI', detail: 'Your own Azure deployment', urlFirst: true, urlRequired: true },
      { key: 'openai-compatible', type: 'openai-compatible', auth: 'apikey', label: 'Another OpenAI-compatible service', detail: 'Together, or any OpenAI-shaped API', baseUrl: '', urlFirst: true, urlRequired: true, hint: 'Enter the service\'s API address and its key.' }
    ]
  },
  {
    title: 'Run on your own server',
    choices: [
      { key: 'ollama', type: 'ollama', auth: 'apikey', label: 'Ollama', detail: 'No key needed', urlFirst: true, urlRequired: true, local: true },
      { key: 'lm-studio', type: 'openai-compatible', auth: 'apikey', label: 'LM Studio', detail: 'No key needed', presetName: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', urlFirst: true, urlRequired: true, local: true },
      { key: 'llama-cpp', type: 'openai-compatible', auth: 'apikey', label: 'llama.cpp', detail: 'No key needed', presetName: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1', urlFirst: true, urlRequired: true, local: true }
    ]
  }
];

const LOCAL_HINT = 'Start the server first. Use its address as seen from the computer running mouaif.';

export function providerChoice(key) {
  for (const group of PROVIDER_CHOICE_GROUPS) {
    const found = group.choices.find((choice) => choice.key === key);
    if (found) return found.local && !found.hint ? { ...found, hint: LOCAL_HINT } : found;
  }
  return null;
}

// keyIsRequired(type, baseUrl) — must this connection have an API key? An
// OpenAI-compatible connection only needs one for OpenAI itself: another address
// may be a local server, and if it does want a key the connection check says so.
export function keyIsRequired(type, baseUrl) {
  if (type === 'ollama') return false;
  if (type !== 'openai-compatible') return true;
  try { return new URL(baseUrl).hostname === 'api.openai.com'; } catch { return false; }
}

// baseUrlProblem(value, { required }) — what's wrong with a base URL, or '' when
// nothing is. `new URL()` accepts some template text, so placeholders are caught
// first: a saved `https://<resource>…` can never connect.
export function baseUrlProblem(value, { required = false } = {}) {
  const url = String(value || '').trim();
  if (!url) return required ? 'Enter the API address.' : '';
  if (/[<>]/.test(url)) return 'Replace the parts in <angle brackets> with your own names.';
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') return '';
  } catch { /* falls through to the message below */ }
  return 'Enter a full address starting with http:// or https://.';
}

// healthWithoutAsking(connection) — the answer when asking the server wouldn't
// tell us anything, or null. Listing models is how a connection gets tested, but
// Anthropic's list is built in, OpenRouter's is public, and Copilot's falls back to
// a built-in list when its token fails, so all three come back fine with any
// credential or none. They must never read as connected.
const LIST_IGNORES_THE_KEY = new Set(['anthropic', 'openrouter', 'github-copilot']);

export function healthWithoutAsking(connection) {
  const type = connection.type || connection.id;
  const usesKey = connection.auth !== 'oauth';
  if (usesKey && !connection.hasApiKey && keyIsRequired(type, connection.baseUrl)) {
    return { state: 'error', text: 'Needs an API key', detail: 'Paste a key to use this provider.' };
  }
  if (LIST_IGNORES_THE_KEY.has(type)) {
    return { state: 'unknown', text: 'Saved · can\'t be tested', detail: 'This provider can\'t be tested from here. Send a message to confirm it works.' };
  }
  return null;
}

// connectionHealth(status, body, connection) — reads one answer from
// GET /api/ai/models/live as { state, text, detail }.
//   state  'ok', 'unknown' (couldn't tell, not a failure) or 'error'
//   text   a few words for the provider list
//   detail what the server said, for the form
export function connectionHealth(status, body, { auth = 'apikey', hasApiKey = false } = {}) {
  if (status === 200) {
    const count = Array.isArray(body && body.models) ? body.models.length : 0;
    return { state: 'ok', text: 'Connected · ' + count + (count === 1 ? ' model' : ' models'), detail: '' };
  }
  const code = body && body.code;
  const detail = (body && body.error) || '';
  const fail = (text) => ({ state: 'error', text, detail });
  const missing = auth === 'oauth' ? 'Needs sign-in' : 'Needs an API key';
  if (code === 'ENO_LIST') return { state: 'unknown', text: 'Saved · can\'t be tested', detail: 'This provider can\'t be tested from here. Send a message to confirm it works.' };
  if (code === 'ENO_APIKEY') return { state: 'error', text: missing, detail: '' };
  if (code === 'EUNREACHABLE') return fail('Can\'t reach the server');
  if (code === 'ETIMEOUT') return fail('No answer from the server');
  const upstream = body && body.upstreamStatus;
  if (upstream === 401 || upstream === 403) {
    if (auth === 'oauth') return fail('Sign-in rejected');
    return fail(hasApiKey ? 'API key rejected' : 'Needs an API key');
  }
  if (upstream === 404) return fail('Nothing found at this address');
  return fail('Provider error' + (upstream || status ? ' (HTTP ' + (upstream || status) + ')' : ''));
}

// uniqueName(name, taken) — `name`, or `name 2`, `name 3`… when it's in use, so a
// second LM Studio doesn't read the same as the first in every model picker.
export function uniqueName(name, taken) {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  let n = 2;
  while (used.has(name + ' ' + n)) n += 1;
  return name + ' ' + n;
}
