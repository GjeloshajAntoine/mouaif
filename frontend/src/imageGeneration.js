// mouaif web — image generation client helpers
//
// A pure module (no DOM, no Preact) that the chat card and the project
// settings page share:
//
//   * loadImageModels(projectDir, opts)
//        GET /api/ai/image/models -> { models, kinds, configured }
//        The image models this project can draw with, each carrying the
//        request family (`kind`) it will send, so a picker's "Sends as"
//        read-out is what the request actually does.
//
//   * generateImage({ projectDir, modelId, providerId, prompt, ... })
//        POST /api/ai/image -> { images: [{ dataUrl, ... }], model, cost }
//        The provider credential never reaches the browser: the page posts a
//        prompt and gets a data URL back.
//
//   * firstImageBlock(result), resultImageUrls(result)
//        Read the generated pictures out of an `image_gen` tool result, so
//        the chat card paints exactly what the model received.
//
// The bytes are never re-encoded here: a generated data URL is passed
// straight to an <img>, so a 4 MB picture costs one decode in the browser
// rather than a base64 round trip through JS.

import { fetchJson } from './api.js';

// loadImageModels(projectDir, opts) -> { models, kinds, configured }
//
// A failure resolves to an empty list instead of throwing: the settings
// page's first paint must not depend on a settings read.
export async function loadImageModels(projectDir, opts) {
  const options = opts || {};
  const query = new URLSearchParams({ projectDir: projectDir || '' });
  if (options.provider) query.set('provider', options.provider);
  if (options.refresh) query.set('_bust', '1');
  const r = await fetchJson('/api/ai/image/models?' + query.toString());
  if (r.status !== 200) return { models: [], kinds: [], configured: null, failures: [], error: r.body };
  return {
    models: Array.isArray(r.body && r.body.models) ? r.body.models : [],
    kinds: Array.isArray(r.body && r.body.kinds) ? r.body.kinds : [],
    configured: (r.body && r.body.configured) || null,
    failures: Array.isArray(r.body && r.body.failures) ? r.body.failures : []
  };
}

// generateImage(opts) -> { images, model, kind, usage, cost }
//
// opts: { projectDir, prompt, modelId?, providerId?, n?, size?,
//         aspectRatio?, save?, path? }
// Throws a typed error ({ code, status }) on a non-2xx response, so the
// caller can show the provider's own message instead of a bare status.
export async function generateImage(opts) {
  const options = opts || {};
  const body = {
    projectDir: options.projectDir || '',
    prompt: options.prompt || ''
  };
  if (options.modelId) body.modelId = options.modelId;
  if (options.providerId) body.providerId = options.providerId;
  if (options.n != null) body.n = options.n;
  if (options.size) body.size = options.size;
  if (options.aspectRatio) body.aspectRatio = options.aspectRatio;
  if (options.save === true) {
    body.save = true;
    if (options.path) body.path = options.path;
  }
  const r = await fetchJson('/api/ai/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status !== 200) {
    const e = new Error((r.body && r.body.error) || ('HTTP ' + r.status));
    e.code = (r.body && r.body.code) || 'EHTTP';
    e.status = r.status;
    throw e;
  }
  return r.body || {};
}

// imageBlocksFromResult(result) -> Array<{ data, mimeType, relPath }>
//
// The generated pictures live in the result's `content` array, in the same
// block shape `read_file`'s image path uses. A result that reached the UI as
// plain text (a replayed transcript row, a nested subagent row) has no bytes
// left, which the card reports instead of painting an empty frame.
export function imageBlocksFromResult(result) {
  if (!result || !Array.isArray(result.content)) return [];
  return result.content.filter((c) => c && c.type === 'image' && (c.data || c.base64));
}

// dataUrlFor(block) -> string
export function dataUrlFor(block) {
  if (!block) return '';
  const data = block.data || block.base64 || '';
  if (!data) return '';
  if (data.startsWith('data:')) return data;
  return 'data:' + (block.mimeType || 'image/png') + ';base64,' + data;
}

// kindLabel(kinds, id) — the human label for a family id. Unknown ids are
// shown as-is rather than hidden, so a hand-written `kind` in project
// settings still reads as something.
export function kindLabel(kinds, id) {
  const found = (kinds || []).find((k) => k && k.id === id);
  return (found && found.label) || id || '';
}
