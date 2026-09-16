'use strict';

// Native `image_gen` tool — generate a picture with an image model and keep
// it on disk in the project.
//
// Implements docs/features/image-generation.md.
//
// Two things happen on every call, in this order:
//
//   1. **The bytes are saved to a file** inside the project (default
//      `generated/<slug>-<timestamp>.png`). That is the durable, inspectable
//      result: the main agent can `read_file` it, `list_files` finds it, git
//      sees it, and the user has a real file instead of a chat attachment
//      that only exists in the transcript.
//   2. **The picture is attached to the tool result** as an `image` content
//      block, so a vision model actually sees what it generated and the chat
//      card paints it. This is the same block shape `read_file`'s image path
//      and MCP image results use (see src/tools/files.js), which is what
//      makes src/ai-stream.js forward it as a native vision part.
//
// A subagent generates pictures through this same tool: it runs inside the
// nested tool loop with the parent's authorization session, so a delegated
// run can produce an image and the main agent receives the file path plus
// the picture in the very tool result the subagent returns. And because a
// subagent normally may not call `write_file` (see below), its run also
// carries the same stream of bytes the parent's results do — the picture is
// genuinely the subagent's output, not a text summary of one.
//
// Public surface:
//   SPEC / buildSpec(imageModels)
//                       — the OpenAI-compatible tool spec. `buildSpec`
//                         lists the project's image-capable models in the
//                         `model` parameter description so the model knows
//                         what it may pass.
//   runImageTool(opts)  — { projectDir, args, settings, appSettings, signal }
//                         -> Promise<{ ok, content, result }>
//   resolveImageModel(projectDir, modelId, providerId)
//                       -> a hydrated model record, or throws a typed error.
//   DEFAULT_OUTPUT_DIR  — `generated`
//   MAX_OUTPUT_BYTES    — hard per-file cap.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const imagegen = require('../imagegen.js');
const { err } = require('../util.js');
const { mimeForExt } = require('../files.js');

// Where generated pictures land when the model does not name a path. A
// project-relative directory so the files are part of the project (and of
// its git history) rather than hidden state.
const DEFAULT_OUTPUT_DIR = 'generated';
// A picture bigger than this is refused: at ~1 byte per base64 char the
// transcript would grow by ~11 MB for one attachment, and `read_file` would
// refuse to re-open it (its own cap is 4 MB) — a generated file the agent
// cannot read back is worse than a typed error.
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
// Extension per MIME type. Image providers return PNG by default; Imagen
// and some Gemini models answer JPEG. Anything unknown is written `.png`
// because that is what the bytes are in practice, and the MIME type is
// reported on the result regardless.
const EXT_FOR_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif'
};

const BASE_DESCRIPTION = 'Generate a picture from a text prompt with an image model, save it as a file inside the project, and return the picture plus its path. The main agent can then read the file, compile it into a page/README, or reuse it; a subagent can generate artwork and hand the path back to the main agent. Off by default; authorization follows the project gate.';

const SPEC = {
  type: 'function',
  function: {
    name: 'image_gen',
    description: BASE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw. Be specific about subject, style, lighting and composition.' },
        model: { type: 'string', description: 'Optional image model id. Defaults to the project\'s configured image model.' },
        provider: { type: 'string', description: 'Optional provider id for `model` (needed only when the model id exists under more than one connection).' },
        path: { type: 'string', description: 'Optional project-relative file to save the picture to (a directory is allowed; the extension follows the returned MIME type). Defaults to `' + DEFAULT_OUTPUT_DIR + '/<slug>-<timestamp>.<ext>`.' },
        size: { type: 'string', description: 'Optional WIDTHxHEIGHT, e.g. "1024x1024". Ignored by providers that do not take one.' },
        aspectRatio: { type: 'string', description: 'Optional aspect ratio for Imagen-style endpoints, e.g. "16:9".' },
        n: { type: 'integer', description: 'How many pictures to generate (1-4). Defaults to 1. Every picture is saved as its own file.' }
      },
      required: ['prompt'],
      additionalProperties: false
    }
  }
};

// buildSpec(imageModels) — the spec with the project's image-capable models
// named in the `model` description, so the model sees exactly what it may
// pass. With nothing configured the base spec is returned unchanged.
function buildSpec(imageModels) {
  const list = Array.isArray(imageModels) ? imageModels.filter((m) => m && m.id) : [];
  if (!list.length) return SPEC;
  const spec = JSON.parse(JSON.stringify(SPEC));
  spec.function.parameters.properties.model.description =
    SPEC.function.parameters.properties.model.description
    + ' Available image models: '
    + list.map((m) => m.provider ? (m.id + ' (' + m.provider + ')') : m.id).join(', ') + '.';
  return spec;
}

// ---- model resolution ---------------------------------------------------

// imageModelRecords(projectDir) — every image-capable model this project
// can use, project records first and then the live catalogs already in
// memory (an OpenRouter image model the user has not pinned into the
// project yet is still selectable by id + provider).
function imageModelRecords(projectDir) {
  const settingsMod = require('../settings.js');
  const serverShared = require('../server-shared.js');
  const resolved = settingsMod.getResolved(projectDir || null);
  const out = [];
  const seen = new Set();
  const push = (rec, provider) => {
    if (!rec || !rec.id) return;
    const key = String(provider || rec.provider || '') + '\u0000' + rec.id;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: rec.id, provider: provider || rec.provider || '', label: rec.label || '' });
  };
  const projectModels = Array.isArray(resolved.models) ? resolved.models : [];
  for (const m of projectModels) {
    if (imagegen.isImageModel(m)) push(m);
  }
  // Live catalogs: the chat slice is where OpenRouter files its image
  // models, so a project with no pinned image model still offers them. Only
  // providers with a connection are consulted — an unreachable catalog is
  // simply not in the cache.
  try {
    const app = settingsMod.getApp();
    const providers = Array.isArray(app.providers) ? app.providers : [];
    for (const p of providers) {
      if (!p || !p.id) continue;
      const entry = serverShared.MODEL_LIST_CACHE.get(
        serverShared.modelListCacheKey(p.id, serverShared.credHashFor(p.id), 'chat')
      );
      if (!entry || !Array.isArray(entry.models)) continue;
      for (const m of entry.models) {
        if (imagegen.isImageModel(m)) push(m, p.id);
      }
    }
  } catch { /* no live catalog yet: project models only */ }
  return out;
}

// resolveImageModel(projectDir, modelId, providerId) — hydrate a model
// record with its provider connection, the way resolveModel does for chat.
// Prefers a project model record, then any live-catalog entry, and always
// takes transport + credential from the app-level connection (a committed
// project JSON must never redirect a global credential — decisions §3).
function resolveImageModel(projectDir, modelId, providerId) {
  const settingsMod = require('../settings.js');
  const { projectModelRecord } = require('../util.js');
  const app = settingsMod.getApp();
  const providers = Array.isArray(app.providers) ? app.providers : [];
  const resolved = settingsMod.getResolved(projectDir || null);
  const models = Array.isArray(resolved.models) ? resolved.models : [];
  const wanted = typeof providerId === 'string' ? providerId.trim() : '';
  let rec = models.find((m) => m && m.id === modelId && (!wanted || m.provider === wanted)) || null;
  if (!rec && wanted) rec = { id: modelId, provider: wanted };
  if (!rec) {
    throw err('EMODEL_NOT_FOUND', 'Image model not found: ' + modelId
      + ' (set one in Settings → Project → Image generation, or pass provider)');
  }
  const connection = providers.find((p) => p && p.id === rec.provider) || null;
  if (!connection) {
    throw err('EPROVIDER_NOT_FOUND', 'No provider connection for "' + rec.provider + '"');
  }
  return Object.assign({}, connection, projectModelRecord(rec), {
    provider: rec.provider,
    auth: connection.auth || 'apikey'
  });
}

// configuredImageModel(projectDir) — the project's own image model, if the
// user pinned one (Settings → Project → Image generation). It mirrors what
// the chat model does for the chat toplevel: a project setting, not an
// app-level one, because a picture is project content.
function configuredImageModel(projectDir) {
  const settingsMod = require('../settings.js');
  let project = null;
  try { project = settingsMod.getProject(projectDir || null); } catch { project = null; }
  const cfg = project && project.imageGeneration;
  const id = cfg && typeof cfg.modelId === 'string' ? cfg.modelId.trim() : '';
  if (!id) return null;
  const provider = cfg && typeof cfg.providerId === 'string' ? cfg.providerId.trim() : '';
  try {
    return resolveImageModel(projectDir, id, provider);
  } catch {
    return null;
  }
}

// ---- file writing -------------------------------------------------------

// slugify(prompt) — a short, filesystem-safe stem from the prompt, so a
// generated file is recognisable in a listing ("a-red-fox-in-snow.png")
// instead of "img-1.png". Bounded to 40 chars.
function slugify(prompt) {
  const s = String(prompt || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'image';
}

// outputPathFor(projectDir, requested, index, mimeType, prompt) — the
// project-relative destination. A requested path may be a directory, a
// file with an extension, or a bare name; the MIME-derived extension is
// appended when the name has none, and a multi-picture call disambiguates
// with `-2`, `-3`, … so no call ever overwrites its own earlier output.
function outputPathFor(projectDir, requested, index, mimeType, prompt) {
  const files = require('./files.js');
  const root = files.resolveSandbox(projectDir);
  const ext = EXT_FOR_MIME[String(mimeType || '').toLowerCase()] || '.png';
  let rel = typeof requested === 'string' && requested.trim() ? requested.trim() : '';
  if (!rel) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    rel = DEFAULT_OUTPUT_DIR + '/' + slugify(prompt) + '-' + stamp + ext;
  } else {
    const abs = path.resolve(root, rel);
    let isDir = false;
    try { isDir = fs.statSync(abs).isDirectory(); } catch { isDir = /[\\/]$/.test(rel); }
    if (isDir) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      rel = rel.replace(/[\\/]+$/, '') + '/' + slugify(prompt) + '-' + stamp + ext;
    } else if (!path.extname(rel)) {
      rel = rel + ext;
    }
  }
  if (index > 0) {
    const parsed = path.parse(rel);
    rel = (parsed.dir ? parsed.dir + '/' : '') + parsed.name + '-' + (index + 1) + (parsed.ext || ext);
  }
  return rel.split(path.sep).join('/');
}

// saveImage(projectDir, rel, buffer) -> { relPath, bytes }
async function saveImage(projectDir, rel, buffer) {
  const files = require('./files.js');
  const root = files.resolveSandbox(projectDir);
  // Reuse the file tools' containment check (symlinks and `..` included) so
  // an image write can never land outside the project root.
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw err('EOUTSIDE_PROJECT', 'Path escapes the project root', { path: rel });
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, buffer);
  return { relPath: rel.split(path.sep).join('/'), bytes: buffer.length };
}

// ---- the run ------------------------------------------------------------

// generateOnce(model, opts) -> { images, usage } | throws
async function generateOnce(model, opts) {
  const kind = imagegen.kindForModel(model);
  const apiKey = await credentialFor(model);
  const req = imagegen.buildImageRequest({
    kind,
    model,
    apiKey,
    prompt: opts.prompt,
    n: opts.n,
    size: opts.size,
    aspectRatio: opts.aspectRatio
  });
  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch { /* settled */ } }, imagegen.DEFAULT_TIMEOUT_MS);
  const ac = opts.signal ? opts.signal : null;
  if (ac && typeof ac.addEventListener === 'function') {
    if (ac.aborted) controller.abort();
    else ac.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let upstream;
  try {
    upstream = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') {
      if (ac && ac.aborted) throw err('EABORTED', 'aborted');
      throw err('ETIMEOUT', 'Image provider sent nothing for ' + Math.round(imagegen.DEFAULT_TIMEOUT_MS / 1000) + 's');
    }
    throw err('EUNREACHABLE', 'Image provider unreachable: ' + (e && e.message ? e.message : String(e)));
  }
  clearTimeout(timer);
  let text = '';
  try { text = await upstream.text(); } catch { text = ''; }
  return imagegen.parseImageResponse(kind, upstream.status, text);
}

// credentialFor(model) — the provider's credential, resolved through the
// chat registry so the OAuth paths (refresh, Copilot token exchange) work
// exactly as they do for a chat request. A provider that needs no key
// (Ollama) returns ''.
async function credentialFor(model) {
  const { requireApiKey, endpointFor } = require('../ai-endpoints.js');
  let def = null;
  try { def = endpointFor(model); } catch { def = null; }
  await requireApiKey(model, def);
  return model.__accessToken || model.apiKey || '';
}

// runImageTool(opts) -> Promise<{ ok, content, result }>
//
// opts.save — when `false`, the picture is generated and returned but not
// written into the project. The `image_gen` tool always saves (that is the
// point of the durable result); a REST call saves only when the user asked,
// because a picture rendered in the viewer is not yet project content.
// opts.buildResult — internal: keep the `content` image blocks on the
// result even for a non-saving run (the REST handler renders them).
async function runImageTool(opts) {
  const options = opts || {};
  const projectDir = options.projectDir;
  const args = options.args || {};
  try {
    if (!projectDir || typeof projectDir !== 'string') throw err('EBADINPUT', 'projectDir is required');
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) throw err('EBADINPUT', 'prompt is required');
    const requestedModel = typeof args.model === 'string' ? args.model.trim() : '';
    const requestedProvider = typeof args.provider === 'string' ? args.provider.trim() : '';
    const model = requestedModel
      ? resolveImageModel(projectDir, requestedModel, requestedProvider)
      : configuredImageModel(projectDir);
    if (!model) {
      throw err('ENO_IMAGE_MODEL', 'No image model configured. Pick one in Settings → Project → Image generation, or pass `model` (and `provider`).');
    }
    const n = imagegen.clampCount(args.n == null ? 1 : args.n);
    // Model-level defaults ride on the record; an explicit call argument wins.
    const defaults = (model.imageGeneration && typeof model.imageGeneration === 'object') ? model.imageGeneration : {};
    const gen = await generateOnce(model, {
      prompt,
      n,
      size: args.size || defaults.size || '',
      aspectRatio: args.aspectRatio || defaults.aspectRatio || '',
      signal: options.signal
    });
    if (gen.error) {
      const r = { error: { code: gen.code || 'EIMAGE', message: gen.error } };
      return { ok: false, content: JSON.stringify(r), result: r };
    }
    const saved = [];
    const shouldSave = options.save !== false;
    for (let i = 0; i < gen.images.length; i++) {
    const img = gen.images[i];
    if (img.bytes > MAX_OUTPUT_BYTES) {
      throw err('ETOOL_CAP', 'Generated image is ' + img.bytes + ' bytes, exceeds cap ' + MAX_OUTPUT_BYTES);
    }
    if (!shouldSave) {
      saved.push({ relPath: null, bytes: img.bytes, mimeType: img.mimeType, data: img.data });
      continue;
    }
    const rel = outputPathFor(projectDir, args.path, i, img.mimeType, prompt);
    const written = await saveImage(projectDir, rel, Buffer.from(img.data, 'base64'));
    saved.push({ relPath: written.relPath, bytes: written.bytes, mimeType: img.mimeType, data: img.data });
    }
    // The model-facing header is small: paths, sizes, the model that ran.
    // The pixels ride in `content` and reach the model as vision parts
    // attached after this tool result (never as base64 inside the text).
    const rest = {
      ok: true,
      model: { id: imagegen.kindForModel(model) + ' · ' + model.id, provider: model.provider },
      prompt,
      images: saved.map((s) => ({ relPath: s.relPath, mimeType: s.mimeType, bytes: s.bytes }))
    };
    const header = [
      '# Generated ' + saved.length + (saved.length === 1 ? ' image' : ' images') + ' with ' + model.id + ' (' + model.provider + ')',
      ...saved.map((s) => '# File: ' + s.relPath + ' (' + s.mimeType + ', ' + s.bytes + ' bytes)'),
      '# The picture' + (saved.length === 1 ? ' is' : 's are') + ' attached to this tool result as image parts.'
    ].join('\n');
    const result = Object.assign({}, rest, {
    relPath: saved.length === 1 ? saved[0].relPath : null,
    kind: 'image',
    note: 'The generated picture is attached to this tool result as an image part.',
    // One image block per saved picture, in the same shape read_file uses
    // for an opened image.
    content: saved.map((s) => ({ type: 'image', data: s.data, mimeType: s.mimeType, relPath: s.relPath }))
    });
    // `content` holds the picture blocks. A tool call reaches them through
    // `result.content` (see toolResultImageParts in src/ai-stream.js) and a
    // REST call reads them off this same object.
    if (gen.usage) result.usage = gen.usage;
    return { ok: true, content: header + '\n\n' + JSON.stringify(result), result };
  } catch (e) {
    const r = { error: { code: e.code || 'EIMAGE', message: e.message || String(e) } };
    if (e.path) r.error.path = e.path;
    return { ok: false, content: JSON.stringify(r), result: r };
  }
}

module.exports = {
  SPEC,
  buildSpec,
  runImageTool,
  resolveImageModel,
  configuredImageModel,
  imageModelRecords,
  DEFAULT_OUTPUT_DIR,
  MAX_OUTPUT_BYTES,
  // exposed for tests
  slugify,
  outputPathFor
};
