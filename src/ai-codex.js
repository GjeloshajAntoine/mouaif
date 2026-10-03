'use strict';

// Codex speaks the Responses API, not Chat Completions. Normalize its
// events to the existing multi-turn loop so authorization/tools stay shared.
const { joinUrl } = require('./util.js');
const { accountIdFor } = require('./oauth-codex.js');
const BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CLIENT_VERSION = '0.99.0';

function headersFor(token, accountId = accountIdFor(token)) {
  return { Authorization: 'Bearer ' + token, ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    originator: 'codex_cli_rs', 'User-Agent': 'mouaif/' + require('../package.json').version };
}

const endpoint = {
  baseUrl: BASE_URL,
  chatPath: '/responses',
  oauthOnly: true,
  authHeader: headersFor,
  async listModels(cred, signal, baseUrl) {
    if (!cred) throw Object.assign(new Error('Sign in with ChatGPT to list Codex models.'), { code: 'ENO_APIKEY' });
    let res;
    try {
      res = await fetch(joinUrl(baseUrl || BASE_URL, '/models') + '?client_version=' + CLIENT_VERSION,
        { headers: headersFor(cred), signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw Object.assign(new Error('Cannot reach the Codex model catalog.'), { code: 'EUNREACHABLE' });
    }
    if (!res.ok) throw Object.assign(new Error('Codex model list failed (HTTP ' + res.status + ').'), { code: 'EUPSTREAM', status: res.status });
    const json = await res.json();
    return (Array.isArray(json.models) ? json.models : []).filter((m) => m && m.slug && m.visibility !== 'hide')
      .map((m) => ({
        id: m.slug, label: m.display_name || m.slug,
        ...(Number(m.context_window) > 0 ? { contextWindow: Number(m.context_window) } : {}),
        inputModalities: Array.isArray(m.input_modalities) ? m.input_modalities : ['text'],
        outputModalities: ['text'],
        thinking: Array.isArray(m.supported_reasoning_levels) && m.supported_reasoning_levels.length
          ? { kind: 'levels', levels: m.supported_reasoning_levels.map((r) => r.effort).filter(Boolean) } : null
      }));
  }
};

function textOf(content) {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n') : '';
}

function buildRequest(model, messages, _stream, specs, requestOpts) {
  const input = [];
  const instructions = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      instructions.push(textOf(message.content));
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: textOf(message.content) });
      continue;
    }
    const assistant = message.role === 'assistant';
    const content = typeof message.content === 'string'
      ? (message.content ? [{ type: assistant ? 'output_text' : 'input_text', text: message.content }] : [])
      : (Array.isArray(message.content) ? message.content.flatMap((p) => {
        if (p?.type === 'text') return [{ type: assistant ? 'output_text' : 'input_text', text: p.text || '' }];
        if (!assistant && p?.type === 'image_url' && p.image_url?.url) return [{ type: 'input_image', image_url: p.image_url.url,
          ...(p.image_url.detail ? { detail: p.image_url.detail } : {}) }];
        return [];
      }) : []);
    if (content.length) input.push({ role: message.role, content });
    for (const call of message.tool_calls || []) {
      input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  const body = { model: model.id, instructions: instructions.filter(Boolean).join('\n\n'), input,
    stream: true, store: false };
  if (Array.isArray(specs) && specs.length) {
    body.tools = specs.filter((s) => s.type === 'function' && s.function).map((s) => ({ type: 'function',
      name: s.function.name, description: s.function.description, parameters: s.function.parameters, strict: false }));
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  }
  if (model.thinkingLevel) body.reasoning = { effort: String(model.thinkingLevel).trim(), summary: 'auto' };
  if (requestOpts?.promptCacheKey) body.prompt_cache_key = String(requestOpts.promptCacheKey);
  // Codex rejects max_output_tokens and temperature. Do not forward the
  // Chat Completions output cap or stream_options to this endpoint.
  return { url: joinUrl(model.baseUrl || BASE_URL, '/responses'),
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream',
      ...headersFor(model.__accessToken, model.__chatgptAccountId), ...(model.headers || {}) }, body };
}

function* parseEvent(eventName, data) {
  if (!data || data.trim() === '[DONE]') return;
  let obj;
  try { obj = JSON.parse(data); }
  catch { yield { name: 'error', data: { code: 'EPARSE', message: 'Invalid Codex stream event.' } }; return; }
  const type = obj.type || eventName;
  if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
    yield { name: 'message', data: { delta: obj.delta || '' } };
  } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    yield { name: 'reasoning', data: { delta: obj.delta || '' } };
  } else if (type === 'response.output_item.done' && obj.item?.type === 'function_call') {
    // The completed item is authoritative. Emitting once avoids duplicate
    // arguments from both argument deltas and the final output item.
    yield { name: 'tool_call_delta', data: { index: obj.output_index || 0, id: obj.item.call_id,
      function: { name: obj.item.name, arguments: obj.item.arguments || '{}' } } };
  } else if (type === 'response.completed') {
    const usage = obj.response?.usage || {};
    yield { name: 'done', data: { usage: { promptTokens: usage.input_tokens || 0,
      completionTokens: usage.output_tokens || 0, cacheReadTokens: usage.input_tokens_details?.cached_tokens || 0 } } };
  } else if (type === 'error' || type === 'response.failed' || type === 'response.incomplete' || obj.error) {
    yield { name: 'error', data: { code: 'EUPSTREAM', message: obj.error?.message || obj.response?.error?.message
      || ('Codex response ' + (obj.response?.status || 'failed') + '.') } };
  }
}

module.exports = { endpoint, buildRequest, parseEvent };
