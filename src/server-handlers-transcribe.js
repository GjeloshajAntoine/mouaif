'use strict';

// Dictation REST handlers.
//
//   GET  /api/ai/transcribe/models?projectDir=<abs>
//        -> { models: [{ id, provider, label, kind, auth }], kinds: [...] }
//        The models this project can dictate with, each with the request
//        family it will use, plus the family list the UI's <select> renders.
//
//   POST /api/ai/transcribe
//        body: { projectDir, modelId, providerId?, audioBase64, mimeType?,
//                filename?, language?, prompt? }
//        -> { text, model: { id, provider }, kind, bytes, durationMs }
//
// Both are proxies, for the same reason the chat endpoint is one
// (docs/decisions.md section 10): the browser holds no provider credential.
// The recording is posted as base64 JSON, never as multipart from the client,
// so one code path handles the body, its size cap, and its error shape.
//
// The request/response *shapes* per provider family live in src/transcribe.js;
// this file only resolves the model, reads the body, performs the fetch, and
// maps typed errors onto HTTP status codes.

const {
  sendJSON,
  readJsonOr400,
  resolveModel,
  credentialForProvider,
  settings
} = require('./server-shared.js');

const transcribe = require('./transcribe.js');
const modelList = require('./modelList.js');
const usageMetrics = require('./usage.js');

// UNKNOWN_COST — what a run with no usage report, or a model with no pricing,
// returns. `known: false` is the app's existing convention for "render `--`"
// (docs/decisions.md §14); a `$0.00` here would claim the run was free, which
// is exactly the lie the convention exists to avoid. A transcription is often
// unpriced for a real reason: `whisper-1` bills per minute of audio and
// reports no tokens at all.
const UNKNOWN_COST = Object.freeze({ input: 0, output: 0, total: 0, currency: 'USD', known: false });

// AUDIO_BASE64_MAX — the JSON body cap. base64 inflates by ~4/3, so this is
// the HTTP-layer twin of transcribe.MAX_AUDIO_BYTES (20 MB of audio).
const AUDIO_BASE64_MAX = Math.ceil(transcribe.MAX_AUDIO_BYTES * 4 / 3) + 1024;

// audioBufferFrom(base64) — decode, with the two failures that actually
// happen: a body that is not valid base64 at all, and a body that decodes to
// nothing (an empty recorder blob is the common one).
function audioBufferFrom(base64) {
  if (typeof base64 !== 'string' || !base64.trim()) {
    return { error: 'audioBase64 is required', code: 'EBADINPUT' };
  }
  const cleaned = base64.replace(/^data:[^;,]*;base64,/, '').trim();
  if (cleaned.length > AUDIO_BASE64_MAX) {
    return {
      error: 'Recording is too large to transcribe (' + cleaned.length + ' base64 chars, max ' + AUDIO_BASE64_MAX + ')',
      code: 'ETOOLARGE'
    };
  }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(cleaned)) {
    return { error: 'audioBase64 is not valid base64', code: 'EBADINPUT' };
  }
  const audio = Buffer.from(cleaned, 'base64');
  if (!audio.length) return { error: 'The recording is empty', code: 'EEMPTYAUDIO' };
  return { audio };
}

// statusFor(code) — the typed codes this feature can produce, as HTTP statuses
// a user can act on: 404/400 for a wrong model, 413 for a long recording, 401
// when the credential is missing or rejected, 502/504 for an upstream problem.
function statusFor(code) {
  switch (code) {
    case 'EMODEL_NOT_FOUND':
    case 'EPROVIDER_NOT_FOUND':
      return 404;
    case 'ENOBASEURL':
    case 'EBADINPUT':
    case 'EEMPTYAUDIO':
    case 'EEMPTY':
      return 400;
    case 'ETOOLARGE':
      return 413;
    case 'ENOAUTH':
      return 401;
    case 'EUNREACHABLE':
      return 502;
    case 'ETIMEOUT':
      return 504;
    default:
      return 502;
  }
}

// fetchUpstream(url, init, timeoutMs) — one fetch with a hard deadline. The
// provider is a third party: without a timeout a stalled connection would hold
// the request (and the user's spinner) open indefinitely.
async function fetchUpstream(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } catch (e) {
    if (controller.signal.aborted) {
      const err = new Error('The provider did not respond within ' + Math.round(timeoutMs / 1000) + 's');
      err.code = 'ETIMEOUT';
      throw err;
    }
    const err = new Error('Could not reach the provider: ' + (e && e.message ? e.message : e));
    err.code = 'EUNREACHABLE';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function handleTranscribe(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;

  // GET /api/ai/transcribe/models?projectDir=<abs>
  //
  // The dictation catalog: project models plus whatever the connected
  // providers currently offer. Both are needed because the app has no model
  // editor — a project model is the *only* way to describe a model the live
  // list cannot (a self-hosted endpoint, a per-model language default), while
  // the live list is what makes a fresh install usable without hand-editing
  // `.mouaif.json`.
  //
  // `?live=0` serves the project models alone: the catalog read is on the
  // critical path of the page's first paint, and the live lists cost one
  // upstream round trip per connected provider (cached for an hour
  // afterwards). `?refresh=1` forces that work even when it is cached.
  if (urlPath === '/api/ai/transcribe/models' && method === 'GET') {
    const projectDir = typeof parsed.query.projectDir === 'string' ? parsed.query.projectDir : '';
    const wantLive = parsed.query.live !== '0';
    const force = parsed.query.refresh === '1';
    let resolved;
    try {
      resolved = settings.getResolved(projectDir || null);
    } catch (e) {
      return sendJSON(res, 422, { error: e.message, code: e.code || 'EBADPROJECT' });
    }
    const all = Array.isArray(resolved.models) ? resolved.models : [];
    const projectModels = transcribe.transcriptionCandidates(all);

    const app = settings.getApp();
    const connections = Array.isArray(app.providers) ? app.providers : [];
    const connectedIds = connections.map((p) => p && p.id).filter(Boolean);

    // Project models always come first: they are the user's own records, they
    // carry their descriptor, and a hand-configured model must win over the
    // upstream's entry for the same id (see the merge below).
    const rows = projectModels.map((m) => ({
      id: m.id,
      provider: m.provider || '',
      label: m.label || '',
      kind: transcribe.kindForModel(m),
      auth: m.auth || 'apikey',
      source: 'project',
      connected: connectedIds.includes(m.provider)
    }));

    const liveFailures = [];
    if (wantLive && connectedIds.length) {
      const { list, failures } = await modelList.liveModelsForMany(connectedIds, { force });
      liveFailures.push(...failures);
      const seen = new Set(rows.map((r) => r.provider + '\u0000' + r.id));
      for (const m of list) {
      if (!transcribe.isTranscriptionModel(m)) continue;
      const key = (m.provider || '') + '\u0000' + m.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = {
      id: m.id,
      provider: m.provider || '',
      label: m.label || '',
      kind: transcribe.kindForModel(m),
      auth: 'apikey',
      source: 'live',
      connected: true
      };
      // Carry the capability report through, so the picker can say *why* a
      // model is on the list when its name does not (audio input).
      if (Array.isArray(m.inputModalities)) row.inputModalities = m.inputModalities;
      rows.push(row);
      }
    }

    return sendJSON(res, 200, {
      models: rows,
      kinds: transcribe.TRANSCRIBE_KINDS,
      // `total` stays the project model count: it is what the picker's empty
      // state reports as "filtered out", and it must not change meaning
      // because a provider happened to be reachable.
      total: all.length,
      providers: connectedIds,
      // One unreachable provider must not empty the picker, so its failure is
      // reported here instead of being turned into a request-level error.
      liveFailures
    });
  }

  // POST /api/ai/transcribe
  if (urlPath === '/api/ai/transcribe' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    const projectDir = typeof body.projectDir === 'string' ? body.projectDir : '';
    if (!modelId) return sendJSON(res, 400, { error: 'modelId is required', code: 'EBADINPUT' });

    const decoded = audioBufferFrom(body.audioBase64);
    if (decoded.error) return sendJSON(res, statusFor(decoded.code), { error: decoded.error, code: decoded.code });

    let model;
    try {
      model = resolveModel(modelId, projectDir, providerId);
    } catch (e) {
      return sendJSON(res, statusFor(e.code), { error: e.message, code: e.code || 'EBADMODEL' });
    }

    const kind = transcribe.kindForModel(model);
    const descriptor = model.transcription && typeof model.transcription === 'object' ? model.transcription : {};
    let request;
    try {
      request = transcribe.buildTranscribeRequest({
        kind,
        model,
        apiKey: credentialForProvider(model.provider),
        audio: decoded.audio,
        mimeType: body.mimeType || transcribe.mimeTypeFor(body.filename),
        filename: body.filename,
        // A per-model default may be *overridden* per utterance (the page's
        // language field), but an explicit body value always wins.
        language: typeof body.language === 'string' && body.language
          ? body.language
          : (descriptor.language || ''),
        prompt: typeof body.prompt === 'string' && body.prompt
          ? body.prompt
          : (descriptor.prompt || '')
      });
    } catch (e) {
      return sendJSON(res, statusFor(e.code), { error: e.message, code: e.code || 'EBADREQUEST' });
    }

    const startedAt = Date.now();
    let upstream;
    let text;
    try {
      upstream = await fetchUpstream(
        request.url,
        { method: request.method, headers: request.headers, body: request.body },
        transcribe.DEFAULT_TIMEOUT_MS
      );
      text = await upstream.text();
    } catch (e) {
      return sendJSON(res, statusFor(e.code), { error: e.message, code: e.code || 'EUPSTREAM' });
    }

    const parsedUpstream = transcribe.parseTranscribeResponse(kind, upstream.status, text);
    if (parsedUpstream.error) {
    return sendJSON(res, statusFor(parsedUpstream.code), {
      error: parsedUpstream.error,
      code: parsedUpstream.code,
      upstreamStatus: upstream.status,
      model: { id: model.id, provider: model.provider },
      kind
    });
    }
    // What the run cost, priced at the same rates the chat uses: the model's
    // own `pricing` block, the app-level table, then the built-in defaults
    // (docs/decisions.md §14). Everything needed is already resolved — the model
    // record comes from resolveModel, which folds a live catalog entry's
    // provider pricing in. A provider that reports no tokens costs nothing to
    // guess at, so it stays unknown rather than zero.
    const cost = parsedUpstream.usage
    ? usageMetrics.computeCost({ model, usage: parsedUpstream.usage, app: settings.getApp() })
    : UNKNOWN_COST;
    return sendJSON(res, 200, {
    text: parsedUpstream.text,
    model: { id: model.id, provider: model.provider },
    kind,
    bytes: decoded.audio.length,
    durationMs: Date.now() - startedAt,
    // null (not {}) when the provider said nothing, so the client can tell
    // "no report" from "zero tokens".
    usage: parsedUpstream.usage || null,
    cost
    });
  }

  return false;
}

module.exports = { handleTranscribe };
