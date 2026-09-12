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
  if (urlPath === '/api/ai/transcribe/models' && method === 'GET') {
    const projectDir = typeof parsed.query.projectDir === 'string' ? parsed.query.projectDir : '';
    let resolved;
    try {
      resolved = settings.getResolved(projectDir || null);
    } catch (e) {
      return sendJSON(res, 422, { error: e.message, code: e.code || 'EBADPROJECT' });
    }
    const all = Array.isArray(resolved.models) ? resolved.models : [];
    const candidates = transcribe.transcriptionCandidates(all);
    const models = candidates.map((m) => ({
      id: m.id,
      provider: m.provider || '',
      label: m.label || '',
      kind: transcribe.kindForModel(m),
      auth: m.auth || 'apikey'
    }));
    const app = settings.getApp();
    const connections = Array.isArray(app.providers) ? app.providers : [];
    // `connected` lets the mobile UI say "no provider connection yet" instead
    // of offering a model whose request is guaranteed to 404 on the server.
    for (const model of models) {
      model.connected = connections.some((p) => p && p.id === model.provider);
    }
    return sendJSON(res, 200, { models, kinds: transcribe.TRANSCRIBE_KINDS, total: all.length });
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
    return sendJSON(res, 200, {
      text: parsedUpstream.text,
      model: { id: model.id, provider: model.provider },
      kind,
      bytes: decoded.audio.length,
      durationMs: Date.now() - startedAt
    });
  }

  return false;
}

module.exports = { handleTranscribe };
