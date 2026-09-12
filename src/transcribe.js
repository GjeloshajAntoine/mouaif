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
//                         — { text, usage } on success, { error, code }
//                           otherwise. `usage` is the provider's own token
//                           report (or null when it reports none), which the
//                           HTTP layer prices with src/usage.js.
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

// OPENAI_SHAPED_PROVIDERS — every provider whose base URL speaks the
// OpenAI-shaped multipart form. This is what decides the transport: which API a
// base URL speaks is a property of the *connection*, not of the model id.
const OPENAI_SHAPED_PROVIDERS = [
  'openai-compatible', 'openrouter', 'azure', 'mistral', 'groq', 'deepseek',
  'ollama', 'github-copilot', 'anthropic'
];

// kindForModel(model) — the dialect for one model record, in strict precedence:
//
//   1. an explicit `transcription.kind` on the model. This is the escape hatch
//      for an endpoint that is not the convention — a self-hosted server that
//      really does serve Gemma behind a generateContent path, say. It is the
//      only thing that overrides the connection.
//   2. the *provider connection*: `gemini` speaks Gemini, everything else in
//      the shipped registry speaks the OpenAI shape.
//   3. only when the provider is unknown, the id: `google/…` means Gemini.
//
// The order matters, and getting it wrong is not cosmetic. An earlier version
// keyed off the id first, so an OpenRouter model called `google/gemini-2.5-flash`
// resolved to the Gemini family and produced
// `https://openrouter.ai/api/v1/v1beta/models/…:generateContent` — a URL that
// cannot exist, because OpenRouter has no generateContent API. The model *name*
// says which Google model it is; the *connection* says how to talk to it.
function kindForModel(model) {
  const m = model || {};
  const explicit = m.transcription && typeof m.transcription.kind === 'string'
    ? m.transcription.kind
    : '';
  if (KIND_IDS.includes(explicit)) return explicit;
  if (m.provider === 'gemini') return 'gemini';
  if (OPENAI_SHAPED_PROVIDERS.includes(m.provider)) return 'openai-compatible';
  const id = String(m.id || '').toLowerCase();
  if (id.startsWith('google/')) return 'gemini';
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

// isTranscriptionModel(model) — this model plausibly transcribes. Five signals,
// most trustworthy first:
//
//   1. the user marked it (`transcription: true|{…}`);
//   2. the provider said what the model *produces* and `transcription` is in
//      that report. This settles the question in both directions: a report
//      that names outputs and not `transcription` is a no, however much audio
//      the row accepts — `openai/gpt-audio` and `google/gemini-2.5-flash` on
//      OpenRouter both take audio input and are both answered by
//      /audio/transcriptions with `400 Model … does not exist`. Only where
//      there is no report at all does the filter guess from names;
//   3. its id looks like a speech-to-text model (whisper, voxtral, …);
//   4. it resolves to the Gemini family — there is no separate Gemini
//      speech-to-text product; audio is an inline part on the general
//      multimodal models, so the whole Gemini catalog counts;
//   5. the provider says the model accepts audio input (`inputModalities` from
//      OpenRouter's `architecture` block) without saying what it produces.
//
// Signal 4 is why the family inference has to be precise (see kindForModel): a
// loose `id.includes('gemini')` test made every Google-ish row on OpenRouter "a
// Gemini model", so a 445-model catalog filtered down to little but Google
// entries — which reads as "there are only Google models".
//
// Signals 3 and 5 are what keep the answer honest where signal 2 cannot help: a
// provider that reports nothing but names (`whisper-1`) or nothing but input
// modalities (`mistralai/voxtral-small-24b-2507`) still gets its rows offered.
//
// This is a *filter*, never a guarantee: the fallback in
// transcriptionCandidates means a project whose models are all unrecognisable
// still gets offered everything, and the user picks.
function isTranscriptionModel(model) {
  if (!model) return false;
  if (markedForTranscription(model)) return true;
  const outputs = reportedOutputModalities(model);
  if (outputs) return outputs.includes('transcription');
  if (hintedById(model) || kindForModel(model) === 'gemini') return true;
  return acceptsAudioInput(model);
}

// reportedOutputModalities(model) — what the provider says this model produces
// (`architecture.output_modalities` upstream, carried onto the record as
// `outputModalities` by src/ai-endpoints.js), lowercased, or null when the
// provider said nothing. Absent is "unknown", never "no".
function reportedOutputModalities(model) {
  const list = model && model.outputModalities;
  if (!Array.isArray(list) || !list.length) return null;
  return list.map((x) => String(x).toLowerCase());
}

// acceptsAudioInput(model) — the provider listed `audio` among the model's
// input modalities. Absent (most providers, and every project model) means
// "unknown", never "no".
function acceptsAudioInput(model) {
  const list = model && model.inputModalities;
  return Array.isArray(list) && list.some((x) => String(x).toLowerCase() === 'audio');
}

// transcriptionCandidates(models) — the models a dictation picker should
// offer, in the order given:
//
//   1. every model that looks like it can transcribe (see
//      isTranscriptionModel) — the union, so marking one model *adds* it
//      rather than hiding the rest;
//   2. otherwise, every model — *unless* the provider reported what each of
//      them produces and none of them transcribes. That is an answer, not a
//      gap: a catalog of chat models that accept audio (`openai/gpt-audio`,
//      `google/gemini-2.5-flash`) is rejected wholesale by
//      /audio/transcriptions, so offering it is the provider error the
//      filter exists to prevent. Only rows the provider left unclassified
//      keep the fallback.
//
// The fallback in step 2 exists because a self-hosted endpoint (`…/v1` with a
// model called `parakeet` or `my-asr`) is perfectly valid and nothing here can
// recognise it — the user picks. Step 1 is deliberately *narrow*: a live
// catalog is hundreds of chat models, and offering all of them would bury the
// handful that transcribe.
function transcriptionCandidates(models) {
const list = (Array.isArray(models) ? models : []).filter((m) => m && m.id);
const recognisable = list.filter(isTranscriptionModel);
if (recognisable.length) return recognisable;
return list.some((m) => !reportedOutputModalities(m)) ? list : [];
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

// usageFromResponse(kind, text) -> { promptTokens, completionTokens } | null
//
// What the provider says the request cost, in the shape src/usage.js
// `computeCost` prices (`promptTokens` / `completionTokens`, i.e. the whole
// input — a transcription has no cache buckets). Two report styles ship today:
//
//   * OpenAI-shaped: `usage: { type: "tokens", input_tokens, output_tokens }`
//     on the models that report it at all (`gpt-4o-transcribe`, `whisper-1`
//     historically answers with the transcript and nothing else);
//   * Gemini: `usageMetadata: { promptTokenCount, candidatesTokenCount }` on
//     generateContent, where the audio rides in the prompt.
//
// `null` means "the provider did not say", which is different from zero: the
// cost line renders `--` rather than a fabricated `$0.00`. That matters here
// more than in chat, because the transcription models that bill by the minute
// (`whisper-1`) report no tokens at all.
function usageFromResponse(kind, text) {
  let parsed;
  try { parsed = JSON.parse(text || '{}'); } catch { return null; }
  const raw = kind === 'gemini' ? parsed.usageMetadata : parsed.usage;
  if (!raw || typeof raw !== 'object') return null;
  const prompt = num(raw.promptTokenCount, raw.input_tokens, raw.prompt_tokens);
  const completion = num(raw.candidatesTokenCount, raw.output_tokens, raw.completion_tokens);
  if (prompt === null && completion === null) return null;
  // A provider that reports one side only still tells us something usable.
  return { promptTokens: prompt || 0, completionTokens: completion || 0 };
}

// num(...values) — the first of these that reads as a non-negative number, else
// null. Absent and zero are different answers here (see usageFromResponse).
function num(...values) {
  for (const v of values) {
    if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) && Number(v) >= 0) return Number(v);
  }
  return null;
}

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
// -> { text, usage }                   on success (`usage` is null when the
//                                      provider reported no token counts)
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
  const usage = usageFromResponse(kind, text);
  if (kind === 'gemini') {
    const transcript = unwrapGeminiText(text);
    if (!transcript) return { error: 'The provider returned no transcript', code: 'EEMPTY' };
    return { text: transcript, usage };
  }
  let parsed;
  try { parsed = JSON.parse(text || '{}'); } catch {
    return { error: 'The provider returned an unreadable response', code: 'EBADUPSTREAM' };
  }
  if (typeof parsed.text === 'string') return { text: parsed.text.trim(), usage };
  // Some self-hosted servers answer with { transcript } or { result }.
  if (typeof parsed.transcript === 'string') return { text: parsed.transcript.trim(), usage };
  if (typeof parsed.result === 'string') return { text: parsed.result.trim(), usage };
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
  reportedOutputModalities,
  acceptsAudioInput,
  mimeTypeFor,
  buildTranscribeRequest,
  parseTranscribeResponse,
  usageFromResponse,
  extensionFor,
  resolveUrl
};
