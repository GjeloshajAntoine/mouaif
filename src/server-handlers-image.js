'use strict';

// Image generation REST handlers.
//
//   GET  /api/ai/image/models?projectDir=<abs>&provider=<id>&_bust=1
//        -> { models: [{ id, provider, label, kind }], kinds: [...],
//             configured: { modelId, providerId } | null }
//        The models this project can draw with, each with the request
//        family it will use, plus the family list the UI renders and the
//        project's configured image model (if any).
//
//   POST /api/ai/image
//        body: { projectDir, modelId?, providerId?, prompt, n?, size?,
//                aspectRatio?, path?, save?: boolean }
//        -> { ok, images: [{ relPath|null, mimeType, bytes, dataUrl }],
//             model: { id, provider }, kind, usage, cost }
//
// Both are proxies, for the same reason the chat endpoint is one
// (docs/decisions.md §10): the browser holds no provider credential. The
// prompt is posted as JSON and the picture comes back as a data URL, so one
// code path handles the body, its size cap, and its error shape.
//
// The request/response *shapes* per provider family live in src/imagegen.js;
// the file-writing half lives in src/tools/image.js (the same runner the
// `image_gen` tool uses), so the REST route and the model-driven call cannot
// drift apart.

const {
  sendJSON,
  readJsonOr400,
  settings,
  ai
} = require('./server-shared.js');

const imagegen = require('./imagegen.js');
const imageTool = require('./tools/image.js');
const modelList = require('./modelList.js');
const usageMetrics = require('./usage.js');

// UNKNOWN_COST — a run with no usage report, or a model with no pricing.
// `known: false` is the app's existing "render `--`" convention
// (docs/decisions.md §14): a `$0.00` would claim the run was free.
const UNKNOWN_COST = Object.freeze({ input: 0, output: 0, total: 0, currency: 'USD', known: false });

// statusFor(code) — the typed codes this feature can produce, as HTTP
// statuses a user can act on.
function statusFor(code) {
  switch (code) {
    case 'EMODEL_NOT_FOUND':
    case 'EPROVIDER_NOT_FOUND':
    case 'ENO_IMAGE_MODEL':
      return 404;
    case 'ENOBASEURL':
    case 'EBADINPUT':
    case 'EEMPTYPROMPT':
      return 400;
    case 'ETOOLARGE':
    case 'ETOOL_CAP':
      return 413;
    case 'ENOAUTH':
    case 'ENOAPIKEY':
      return 401;
    case 'EUNREACHABLE':
      return 502;
    case 'ETIMEOUT':
      return 504;
    case 'ENO_IMAGE':
      return 422;
    default:
      return 502;
  }
}

// resolveForRequest(projectDir, modelId, providerId) — the model a request
// runs on, in strict precedence: an explicit body pair, then the project's
// configured image model, then the project's own image-capable model records
// so a project whose only configured model *is* an image model still works
// with no extra setup.
function resolveForRequest(projectDir, modelId, providerId) {
  if (modelId) return imageTool.resolveImageModel(projectDir, modelId, providerId);
  const configured = imageTool.configuredImageModel(projectDir);
  if (configured) return configured;
  const resolved = settings.getResolved(projectDir || null);
  const candidates = imagegen.imageCandidates(Array.isArray(resolved.models) ? resolved.models : []);
  if (!candidates.length) return null;
  // Prefer a model that already declares an image family; otherwise the
  // first candidate, which the user chose when they opened the page.
  const first = candidates[0];
  try { return imageTool.resolveImageModel(projectDir, first.id, first.provider); }
  catch { return null; }
}

async function handleImage(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // GET /api/ai/image/models?projectDir=<abs>[&provider=<id>][&_bust=1]
  if (urlPath === '/api/ai/image/models' && method === 'GET') {
    const projectDir = typeof q.projectDir === 'string' ? q.projectDir : '';
    const provider = typeof q.provider === 'string' ? q.provider : '';
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    // Project records first: they are the ones the user pinned.
    const rows = [];
    const seen = new Set();
    const push = (id, providerId, label) => {
      if (!id) return;
      const key = String(providerId || '') + '\u0000' + id;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ id, provider: providerId || '', label: label || '', kind: imagegen.kindForModel({ id, provider: providerId }) });
    };
    const resolved = settings.getResolved(projectDir || null);
    for (const m of (Array.isArray(resolved.models) ? resolved.models : [])) {
      if (imagegen.isImageModel(m)) push(m.id, m.provider, m.label);
    }
    // Live catalogs, when a provider was named or the project has none.
    const providers = provider
      ? [provider]
      : Array.from(new Set((Array.isArray(settings.getApp().providers) ? settings.getApp().providers : []).map((p) => p && p.id).filter(Boolean)));
    const failures = [];
    for (const p of providers) {
      if (!ai.ENDPOINTS[p]) continue;
      try {
        const result = await modelList.liveModelsFor(p, { force: !!q._bust });
        for (const m of imagegen.imageCandidates(result.models || [])) push(m.id, p, m.label);
      } catch (e) {
        failures.push({ provider: p, code: e.code || 'EUPSTREAM', error: e.message || String(e) });
      }
    }
    let configured = null;
    try {
      const project = settings.getProject(projectDir);
      const cfg = project && project.imageGeneration;
      if (cfg && typeof cfg.modelId === 'string' && cfg.modelId) {
        configured = { modelId: cfg.modelId, providerId: typeof cfg.providerId === 'string' ? cfg.providerId : '' };
      }
    } catch { /* no project record */ }
    return sendJSON(res, 200, {
      models: rows,
      kinds: imagegen.IMAGE_KINDS,
      configured,
      failures
    });
  }

  // POST /api/ai/image
  if (urlPath === '/api/ai/image' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const projectDir = typeof body.projectDir === 'string' ? body.projectDir : '';
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return sendJSON(res, 400, { error: 'prompt is required', code: 'EBADINPUT' });
    const requested = typeof body.modelId === 'string' ? body.modelId.trim() : '';
    const requestedProvider = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    let model;
    try {
      model = resolveForRequest(projectDir, requested, requestedProvider);
    } catch (e) {
      return sendJSON(res, statusFor(e.code), { ok: false, error: e.message, code: e.code || 'EBADMODEL' });
    }
    if (!model) {
      return sendJSON(res, 404, {
        ok: false,
        error: 'No image model configured for this project',
        code: 'ENO_IMAGE_MODEL'
      });
    }
    const args = {
      prompt,
      n: body.n,
      size: body.size,
      aspectRatio: body.aspectRatio
    };
    // A REST run saves only when asked. The dedicated page renders the
    // picture in the viewer; a `save: true` call writes it into the project
    // exactly like the tool does (path honoured), which is what "insert into
    // the project" means on that page.
    if (body.save === true) args.path = typeof body.path === 'string' ? body.path : '';
    else args.path = null;
    let out;
    try {
      out = await runOnModel(projectDir, model, args, body);
    } catch (e) {
      return sendJSON(res, statusFor(e.code), { ok: false, error: e.message || String(e), code: e.code || 'EIMAGE' });
    }
    if (!out || out.ok === false) {
      const code = (out && out.error && out.error.code) || 'EIMAGE';
      return sendJSON(res, statusFor(code), {
        ok: false,
        error: (out && out.error && out.error.message) || 'Image generation failed',
        code
      });
    }
    const r = out.result;
    return sendJSON(res, 200, {
      ok: true,
      model: r.model,
      kind: imagegen.kindForModel(model),
      images: (r.images || []).map((img, i) => Object.assign({}, img, {
        dataUrl: 'data:' + img.mimeType + ';base64,' + r.content[i].data
      })),
      usage: r.usage || null,
      cost: costFor(model, r.usage)
    });
  }

  return sendJSON(res, 404, { error: 'Not found', path: urlPath });
}

// runOnModel(projectDir, model, args, opts) — run the shared tool runner.
// `save` is honored by the runner (a REST call saves only when the user
// asked; the model tool always saves).
async function runOnModel(projectDir, model, args, opts) {
  return await imageTool.runImageTool({
    projectDir,
    args: Object.assign({}, args, { model: model.id, provider: model.provider }),
    save: !!(opts && opts.save === true),
    buildResult: true
  });
}

// costFor(model, usage) — price the run with the same usage module the chat
// uses. No usage report, or no pricing for the model, is `known: false`.
function costFor(model, usage) {
  if (!usage) return UNKNOWN_COST;
  try {
    const app = settings.getApp();
    const estimate = usageMetrics.computeCost({ model, usage, app });
    if (estimate && estimate.known) {
      return {
        input: estimate.input || 0,
        output: estimate.output || 0,
        total: estimate.total || 0,
        currency: 'USD',
        known: true
      };
    }
  } catch { /* fall through to unknown */ }
  return UNKNOWN_COST;
}

module.exports = { handleImage };
