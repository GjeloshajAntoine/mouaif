'use strict';

// Dictation — speech-to-text request shapes, one per provider family.
//
// Dictation is deliberately NOT part of the chat provider registry
// (src/ai-endpoints.js): a chat model and a transcription model are
// different products with different endpoints, different payloads and
// different credentials. Instead this module exposes exactly what
// src/server-handlers-transcribe.js needs:
//
//   TRANSCRIBE_KINDS      — the family ids the UI offers (<select>).
//   kindForModel(model)   — model record -> family id. An explicit
//                           `transcription.kind` on the model wins; otherwise
//                           the family is inferred from the provider id and
//                           the model id, so a plain OpenAI model record such
//                           as `whisper-1` just works with no extra setup.
//   buildTranscribeRequest({ kind, model, apiKey, audio, mimeType, ... })
//                         — { url, method, headers, body } where `body` is a
//                           Uint8Array: multipart/form-data for the OpenAI
//                           family (which covers Groq, Mistral, OpenRouter and
//                           any OpenAI-shaped endpoint), raw bytes for Gemini.
//   parseTranscribeResponse(kind, status, text)
//                         — { text } on success, { error, code } otherwise.
//
// The audio never leaves the machine except in this one proxied request, and
// the key stays server-side: the browser POSTs base64 to /api/ai/transcribe
// and never sees the credential (docs/decisions.md section 10).

// Family ids. `openai` is the default because it is the most widely
// implemented shape (OpenAI, Groq, Mistral, OpenRouter, LM Studio, ...).
const TRANSCRIBE_KINDS = Object.freeze([
  { id: 'openai-compatible', label: 'OpenAI-compatible (multipart /audio/transcriptions)' },
  { id: 'gemini',            label: 'Gemini (inline audio)' }
]);

const KIND_IDS = TRANSCRIBE_KINDS.map((k) => k.id);
const DEFAULT_KIND = 'openai-compatible';

// Bounds. The composer sends at most ~2 minutes of Opus (~1.5 MB), and the
// HTTP layer caps the JSON body, but the audio itself is validated here too so
// a hand-rolled request cannot hand 100 MB to a provider.
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 1000;

// MODEL_HINTS — model-id substrings that mean "this is a transcription
// model", used only to decide the default family when the user has not
// declared one. Checked in order; the first hit wins.
const OPENAI_MODEL_HINTS = ['whisper', 'transcribe', 'transcription', 'voxtral', 'parakeet'];

// kindForModel(model) — the dialect for one project model record. Explicit
// configuration always wins over inference:
//
//   model.transcription = { kind: 'gemini', language: 'fr', prompt: '…' }
function kindForModel(model) {
  const m = model || {};
  const explicit = m.transcription && typeof m.transcription.kind === 'string'
    ? m.transcription.kind
    : '';
  if (KIND_IDS.includes(explicit)) return explicit;
  // Inference: Gemini's inline-audio form is only ever the Gemini API, so a
  // gemini provider/model means that family unless the user said otherwise.
  if (m.provider === 'gemini') return 'gemini';
  const id = String(m.id || '').toLowerCase();
  if (id.includes('gemini')) return 'gemini';
  if (OPENAI_MODEL_HINTS.some((hint) => id.includes(hint))) return 'openai-compatible';
  // Fall back to the OpenAI shape: it is what a self-hosted or
  // OpenAI-compatible endpoint implements, and it is the only shape that
  // works against an arbitrary baseUrl.
  return DEFAULT_KIND;
}

// markedForTranscription(model) — the user said so, either with the short form
// (`transcription: true`) or the long form (`transcription: { kind, … }`).
function markedForTranscription(model) {
  const t = model && model.transcription;
  if (t === true) return true;
  if (t && typeof t === 'object' && Object.keys(t).length) return true;
  return false;
}

// hintedById(model) — the model id looks like a speech-to-text model. This is
// only ever used to *narrow* a candidate list; it never changes the request
// shape on its own.
function hintedById(model) {
  const id = String((model && model.id) || '').toLowerCase();
  return OPENAI_MODEL_HINTS.some((hint) => id.includes(hint));
}

// isTranscriptionModel(model) — this model plausibly transcribes. Three signals:
//
//   1. it is explicitly marked (`transcription: true|{…}`);
//   2. its id looks like a speech-to-text model (whisper, voxtral, …);
//   3. it resolves to the Gemini family — there is no separate Gemini
//      speech-to-text product; audio is an inline part on the general
//      multimodal models, so any Gemini model is a candidate.
//
// This is a *filter*, never a guarantee: the fallback in
// transcriptionCandidates means a project whose models are all unrecognisable
// still gets offered everything, and the user picks.
function isTranscriptionModel(model) {
  if (!model) return false;
  return markedForTranscription(model) || hintedById(model) || kindForModel(model) === 'gemini';
}

// transcriptionCandidates(models) — the models a dictation picker should
// offer, in the order given:
//
//   1. every model that looks like it can transcribe (see
//      isTranscriptionModel) — the union, so marking one model *adds* it
//      rather than hiding the rest;
//   2. otherwise, every model.
//
// The fallback in step 2 exists because a self-hosted endpoint (`…/v1` with a
// model called `parakeet` or `my-asr`) is perfectly valid and nothing here can
// recognise it — the user picks. Step 1 exists so a project that also has chat
// models does not get a list where almost nothing can transcribe.
function transcriptionCandidates(models) {
  const list = (Array.isArray(models) ? models : []).filter((m) => m && m.id);
  const recognisable = list.filter(isTranscriptionModel);
  return recognisable.length ? recognisable : list;
}

// mimeTypeFor(filename) — best-effort content type from the recorder's file
// name. Containers we do not know are sent as application/octet-stream: every
// provider we support sniffs the bytes anyway, and guessing a wrong type is
// worse than saying nothing.
function mimeTypeFor(filename) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.webm')) return 'audio/webm';
  if (name.endsWith('.ogg') || name.endsWith('.oga')) return 'audio/ogg';
  if (name.endsWith('.mp4') || name.endsWith('.m4a')) return 'audio/mp4';
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  if (name.endsWith('.wav')) return 'audio/wav';
  if (name.endsWith('.flac')) return 'audio/flac';
  return 'application/octet-stream';
}

// joinUrl() comes from src/util.js so the trailing-slash handling matches the
// chat client's (a baseUrl with a trailing slash does not double it).
const { joinUrl } = require('./util.js');

// defaultPathFor(kind) — the conventional endpoint appended to a baseUrl when
// the model record does not carry one.
function defaultPathFor(kind) {
  return kind === 'gemini' ? '/v1beta/models/{model}:generateContent' : '/audio/transcriptions';
}

// resolveUrl(kind, model) — the upstream URL. A model record may carry
// `transcription.path` for providers whose endpoint is not the convention
// (Azure's deployment URL, a self-hosted whisper.cpp server, ...). `{model}`
// is substituted for Gemini's per-model action path.
function resolveUrl(kind, model) {
  const baseUrl = String(model.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    const e = new Error('No base URL for this model — configure the provider connection first');
    e.code = 'ENOBASEURL';
    throw e;
  }
  const path = model.transcription && typeof model.transcription.path === 'string' && model.transcription.path
    ? model.transcription.path
    : defaultPathFor(kind);
  return joinUrl(baseUrl, path.replace('{model}', encodeURIComponent(model.id || '')));
}

// ---- multipart/form-data ------------------------------------------------
//
// Built by hand rather than with FormData + fetch: the server-side `fetch` in
// this Node version happily takes a FormData, but hand-building keeps the
// request shape identical to the documented OpenAI curl form, keeps the byte
// count exact for the error messages, and makes the request builder a pure
// function a test can assert on.
function buildMultipartBody(parts) {
  const boundary = '----mouaif' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const chunks = [];
  for (const part of parts) {
    if (part.filename !== undefined) {
      chunks.push(Buffer.from(
        '--' + boundary + '\r\n'
        + 'Content-Disposition: form-data; name="' + part.name + '"; filename="' + part.filename + '"\r\n'
        + 'Content-Type: ' + (part.contentType || 'application/octet-stream') + '\r\n\r\n'
      ));
      chunks.push(Buffer.from(part.data));
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(
        '--' + boundary + '\r\n'
        + 'Content-Disposition: form-data; name="' + part.name + '"\r\n\r\n'
        + part.value + '\r\n'
      ));
    }
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return { boundary, body: Buffer.concat(chunks) };
}

// buildTranscribeRequest(options)
//
// options:
//   kind      family id (kindForModel)
//   model     the resolved model record ({ id, provider, baseUrl, auth, ... })
//   apiKey    the credential for that provider (app-level connection)
//   audio     Buffer/Uint8Array of the recording
//   mimeType  content type of `audio` (mimeTypeFor)
//   language  optional BCP-47 / ISO-639-1 hint ('en', 'fr')
//   prompt    optional vocabulary or context hint the provider may use
//
// Returns { url, method, headers, body }.
function buildTranscribeRequest(options) {
  const opts = options || {};
  const kind = KIND_IDS.includes(opts.kind) ? opts.kind : DEFAULT_KIND;
  const model = opts.model || {};
  const audio = opts.audio;
  if (!audio || !audio.length) {
    const e = new Error('No audio to transcribe');
    e.code = 'EEMPTYAUDIO';
    throw e;
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    const e = new Error('Recording is too large to transcribe (' + audio.length + ' bytes, max ' + MAX_AUDIO_BYTES + ')');
    e.code = 'ETOOLARGE';
    throw e;
  }
  const language = typeof opts.language === 'string' ? opts.language.trim() : '';
  const prompt = typeof opts.prompt === 'string' ? opts.prompt : '';
  const url = resolveUrl(kind, model);

  if (kind === 'gemini') {
    // Gemini takes the audio inline as a base64 data part. No key is put on
    // the URL — the header form keeps the credential out of logs.
    const body = {
      contents: [{
        role: 'user',
        parts: [
          { text: prompt || 'Transcribe this audio recording verbatim. Return only the transcript text, with punctuation, and no commentary.' },
          { inline_data: { mime_type: opts.mimeType || 'audio/webm', data: Buffer.from(audio).toString('base64') } }
        ]
      }],
      generationConfig: { temperature: 0 }
    };
    if (language) {
      body.contents[0].parts.push({ text: 'The recording is in the language with code "' + language + '". Transcribe it in that language.' });
    }
    const headers = { 'Content-Type': 'application/json' };
    if (opts.apiKey) headers['x-goog-api-key'] = opts.apiKey;
    return { url, method: 'POST', headers, body: Buffer.from(JSON.stringify(body)) };
  }

  // OpenAI-shaped: multipart/form-data with `file` + `model`, optional
  // `language` and `prompt`. The field is named `file` (not `audio`) as the
  // OpenAI media API documents; some self-hosted servers also accept `audio`,
  // but `file` is the interoperable spelling.
  const filename = typeof opts.filename === 'string' && opts.filename ? opts.filename : ('dictation' + extensionFor(opts.mimeType));
  const fields = [
    { name: 'file', filename, contentType: opts.mimeType || mimeTypeFor(filename), data: audio },
    { name: 'model', value: model.id || '' }
  ];
  if (language) fields.push({ name: 'language', value: language });
  if (prompt) fields.push({ name: 'prompt', value: prompt });
  const { boundary, body } = buildMultipartBody(fields);
  const headers = { 'Content-Type': 'multipart/form-data; boundary=' + boundary };
  if (opts.apiKey) headers['Authorization'] = 'Bearer ' + opts.apiKey;
  return { url, method: 'POST', headers, body };
}

// extensionFor(mimeType) — the file name extension providers see. Only used
// for the multipart filename; content sniffing is the provider's job.
function extensionFor(mimeType) {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('webm')) return '.webm';
  if (type.includes('ogg')) return '.ogg';
  if (type.includes('mp4') || type.includes('m4a')) return '.m4a';
  if (type.includes('mpeg')) return '.mp3';
  if (type.includes('wav')) return '.wav';
  if (type.includes('flac')) return '.flac';
  return '.webm';
}

// ---- Response parsing ---------------------------------------------------

// unwrapGeminiText(text) — concatenate the text parts of a generateContent
// response, skipping the safety/usage noise.
function unwrapGeminiText(text) {
  let parsed;
  try { parsed = JSON.parse(text || '{}'); } catch { return ''; }
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const out = [];
  for (const candidate of candidates) {
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];
    for (const part of parts) {
      if (part && typeof part.text === 'string') out.push(part.text);
    }
  }
  return out.join('').trim();
}

// upstreamErrorMessage(kind, text) — the provider's own words, falling back to
// a truncated body. A silent failure here is worse than a long message: this
// is the only diagnostic the user gets for a misconfigured endpoint.
function upstreamErrorMessage(kind, text) {
  const raw = String(text || '').trim();
  try {
    const parsed = JSON.parse(raw || '{}');
    const message = (parsed.error && (parsed.error.message || parsed.error.status))
      || parsed.message
      || parsed.detail;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch { /* not JSON: fall through to the raw body */ }
  return raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
}

// parseTranscribeResponse(kind, status, text)
//
// -> { text }                          on success
// -> { error, code }                   on failure (the HTTP layer maps this
//                                      to a status it can explain)
function parseTranscribeResponse(kind, status, text) {
  const ok = typeof status === 'number' && status >= 200 && status < 300;
  if (!ok) {
    return {
      error: upstreamErrorMessage(kind, text) || ('Transcription failed with HTTP ' + status),
      code: status === 401 || status === 403 ? 'ENOAUTH' : 'EUPSTREAM',
      status
    };
  }
  if (kind === 'gemini') {
    const transcript = unwrapGeminiText(text);
    if (!transcript) return { error: 'The provider returned no transcript', code: 'EEMPTY' };
    return { text: transcript };
  }
  let parsed;
  try { parsed = JSON.parse(text || '{}'); } catch {
    return { error: 'The provider returned an unreadable response', code: 'EBADUPSTREAM' };
  }
  if (typeof parsed.text === 'string') return { text: parsed.text.trim() };
  // Some self-hosted servers answer with { transcript } or { result }.
  if (typeof parsed.transcript === 'string') return { text: parsed.transcript.trim() };
  if (typeof parsed.result === 'string') return { text: parsed.result.trim() };
  if (parsed.error) return { error: upstreamErrorMessage(kind, text), code: 'EUPSTREAM' };
  return { error: 'The provider returned no transcript', code: 'EEMPTY' };
}

module.exports = {
  TRANSCRIBE_KINDS,
  KIND_IDS,
  DEFAULT_KIND,
  MAX_AUDIO_BYTES,
  DEFAULT_TIMEOUT_MS,
  kindForModel,
  transcriptionCandidates,
  isTranscriptionModel,
  mimeTypeFor,
  buildTranscribeRequest,
  parseTranscribeResponse,
  extensionFor,
  resolveUrl
};
