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

// Family ids — the request shapes dictation can send. Adding one is a builder
// branch, a parser branch, and a label; the picker reads the list, so a new
// shape shows up in the UI without a frontend change.
//
//   openai-compatible  multipart POST /audio/transcriptions (OpenAI, Groq,
//                      Mistral, OpenRouter's speech-to-text slice, LM Studio…)
//   openai-audio       POST /chat/completions with an inline `input_audio`
//                      part. The route for a model that can hear but has no
//                      /audio/transcriptions entry — see audioChatModel.
//   gemini             POST /v1beta/models/{model}:generateContent with the
//                      audio inline as a base64 `inline_data` part.
const TRANSCRIBE_KINDS = Object.freeze([
  { id: 'openai-compatible', label: 'OpenAI-compatible (multipart /audio/transcriptions)' },
  { id: 'openai-audio',      label: 'OpenAI-compatible (inline audio /chat/completions)' },
  { id: 'gemini',            label: 'Gemini (inline audio)' }
]);

const KIND_IDS = TRANSCRIBE_KINDS.map((k) => k.id);
const DEFAULT_KIND = 'openai-compatible';

// Bounds. The composer sends at most ~2 minutes of Opus (~1.5 MB), and the
// HTTP layer caps the JSON body, but the audio itself is validated here too so
// a hand-rolled request cannot hand 100 MB to a provider.
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 1000;

// DEFAULT_TRANSCRIBE_PROMPT — what the inline-audio shapes ask the model to do.
// A multipart /audio/transcriptions call needs no instruction (the endpoint
// exists to transcribe), but an inline-audio call is a *chat* request, so the
// prompt is the difference between a transcript and a remark about the audio:
// with no prompt, OpenRouter's Google models answer "That is a variation of the
// classic English pangram…" instead of the sentence itself.
const DEFAULT_TRANSCRIBE_PROMPT = 'Transcribe this audio recording verbatim. Return only the transcript text, with punctuation, and no commentary.';

// audioFormatFor(mimeType, filename) -> 'wav' | 'mp3' | 'ogg' | 'webm' | 'flac' | 'm4a'
//
// The OpenAI chat API names an inline audio part's container with a bare label,
// not a MIME type. Anything unrecognised falls back to `webm`, which is what
// every Chromium browser's MediaRecorder produces — the only shape this app
// records in practice.
function audioFormatFor(mimeType, filename) {
  const type = String(mimeType || '').toLowerCase() || String(mimeTypeFor(filename) || '').toLowerCase();
  // Container first: `audio/webm;codecs=opus` is a WebM file that happens to
  // carry Opus, and must not be labelled `ogg` just because the codec is named.
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg') || type.includes('oga')) return 'ogg';
  if (type.includes('wav') || type.includes('wave')) return 'wav';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('flac')) return 'flac';
  // A bare Opus stream, with no container named, is served as Ogg by every
  // provider that accepts one.
  if (type.includes('opus')) return 'ogg';
  return 'webm';
}

// MODEL_HINTS — model-id substrings that mean "this is a transcription
// model", used only to decide the default family when the user has not
// declared one. Checked in order; the first hit wins.
const OPENAI_MODEL_HINTS = ['whisper', 'transcribe', 'transcription', 'voxtral', 'parakeet'];

// OPENAI_SHAPED_PROVIDERS — every provider whose base URL speaks the
// OpenAI-shaped multipart form. This is what decides the transport: which API a
// base URL speaks is a property of the *connection*, not of the model id.
//
// The list itself lives in src/providerShapes.js so this module and
// src/imagegen.js cannot drift apart on the answer. It no longer carries
// `anthropic`: that entry, which only this copy had, claimed the Messages API
// speaks OpenAI's multipart form, which it does not — pointing a Claude
// connection at `/audio/transcriptions` is a 404 either way.
const { OPENAI_SHAPED_PROVIDERS } = require('./providerShapes.js');

// kindForModel(model) — the dialect for one model record, in strict precedence:
//
//   1. an explicit `transcription.kind` on the model. This is the escape hatch
//      for an endpoint that is not the convention — a self-hosted server that
//      really does serve Gemma behind a generateContent path, say. It is the
//      only thing that overrides the connection.
//   2. a `kind` the *live catalog* already decided (the dictation catalog
//      stamps one per row; see transcribe.audioChatModel below).
//   3. a model that can *hear* but has no /audio/transcriptions entry: an
//      OpenAI-shaped connection whose capability report names audio input
//      routes through /chat/completions instead. See audioChatModel.
//   4. the *provider connection*: `gemini` speaks Gemini, everything else in
//      the shipped registry speaks the OpenAI shape.
//   5. only when the provider is unknown, the id: `google/…` means Gemini.
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
  if (KIND_IDS.includes(m.kind)) return m.kind;
  if (audioChatModel(m)) return 'openai-audio';
  if (m.provider === 'gemini') return 'gemini';
  if (OPENAI_SHAPED_PROVIDERS.includes(m.provider)) return 'openai-compatible';
  const id = String(m.id || '').toLowerCase();
  if (id.startsWith('google/')) return 'gemini';
  return DEFAULT_KIND;
}

// audioChatModel(model) -> boolean
//
// Does this model have to be transcribed through /chat/completions with an
// inline audio part, rather than through /audio/transcriptions?
//
// OpenRouter is the reason this exists, and the reason is structural rather
// than cosmetic. Its /models catalog is sliced by output modality, and a Google
// chat model is filed under `output_modalities: ["text"]` — the transcription
// slice does not list it. So `google/gemini-3.5-flash` is offered by the chat
// picker, reports `audio` among its input modalities, answers a transcription
// with a perfect transcript through /chat/completions… and is answered by
// /audio/transcriptions with `400 Model … does not exist`, because that
// endpoint serves only the 21 rows of the transcription slice (`google/chirp-3`
// among them). "Google models are not available on OpenRouter" for dictation is
// exactly this: the Google models that can hear are all on the chat route.
//
// The signal is the provider's own capability report — audio in, and not
// already a declared transcriber (those go to the multipart route, which is
// what the speech-to-text slice is for):
//
//   * `outputModalities` naming `transcription` -> not this: it has a real
//     /audio/transcriptions entry, and that is the cheaper, purpose-built call;
//   * `inputModalities` naming `audio` -> this, when the connection is
//     OpenAI-shaped. A provider whose report we do have said the words, so it
//     is an answer rather than a guess;
//   * an id the hint list recognises (`…-transcribe`, `whisper-…`) -> not
//     this: the name says where it belongs, and the name predates the report.
//
// Nothing here decides what is *offered* — that is isTranscriptionModel — only
// which of the two OpenAI-shaped routes the offered row is sent down.
//
// One id shape is refused outright: OpenRouter's `:batch` rows (`google/gemini-3.8-flash:batch`,
// and 76 like it). They are in the chat catalog with the same capability report
// as their interactive twins, and every one of them answers
// `404 This model is only available through the Batch API. Use the
// /api/beta/batches endpoint instead.` — the *endpoint* is a different product,
// reachable by submitting a job file and polling it, which is not something a
// microphone tap can do. Suffix-matching here (never on the vendor prefix) is
// the provider's own naming, so it is a report rather than a guess.
function audioChatModel(model) {
  const m = model || {};
  if (!OPENAI_SHAPED_PROVIDERS.includes(m.provider)) return false;
  if (/:batch$/.test(String(m.id || '').toLowerCase())) return false;
  if (hintedById(m)) return false;
  const outputs = reportedOutputModalities(m);
  if (outputs && outputs.includes('transcription')) return false;
  return acceptsAudioInput(m);
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
  if (outputs) return outputs.includes('transcription') || audioChatModel(model);
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
// `openai/gpt-audio` and `google/gemini-2.5-flash` are the two rows that used
// to sit on the wrong side of both halves and therefore read as "Google models
// are not available on OpenRouter": reported as producing `text`, so not
// transcription models, and offered by nobody. They are *not* rejected by the
// provider — only by /audio/transcriptions, the endpoint they were never
// supposed to take. Their report says `audio` goes in, which is enough to route
// them through /chat/completions instead (see audioChatModel), so isTranscriptionModel
// accepting them is the fix rather than a regression.
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
  if (kind === 'gemini') return '/v1beta/models/{model}:generateContent';
  if (kind === 'openai-audio') return '/chat/completions';
  return '/audio/transcriptions';
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
          { text: prompt || DEFAULT_TRANSCRIBE_PROMPT },
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

  // OpenAI-shaped inline audio: an ordinary chat completion whose user message
  // carries the recording as an `input_audio` part. This is the route for a
  // model that can hear but has no /audio/transcriptions entry — on OpenRouter
  // that is every Google chat model (`google/gemini-3.5-flash`, `~google/…`),
  // which that endpoint rejects with `400 Model … does not exist`.
  //
  // The audio rides base64 in a JSON body (that is the only shape the OpenAI
  // chat API defines for it), and the format is named by label rather than by
  // MIME type: the field accepts `wav`/`mp3`/`ogg`/`webm`/`flac`/`m4a`, not
  // `audio/webm;codecs=opus`. `audioFormatFor` does that mapping, and the bytes
  // themselves are sniffed upstream, so a label that disagrees with the
  // container is tolerated (verified against OpenRouter: `webm` bytes labelled
  // `mp3` still transcribe).
  if (kind === 'openai-audio') {
    const body = {
      model: model.id || '',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt || DEFAULT_TRANSCRIBE_PROMPT },
          {
            type: 'input_audio',
            input_audio: {
              data: Buffer.from(audio).toString('base64'),
              format: audioFormatFor(opts.mimeType, opts.filename)
            }
          }
        ]
      }]
    };
    if (language) {
      // No `language` field exists on this shape, so the instruction is part of
      // the prompt instead — the model is a language model, and it obeys.
      body.messages[0].content.push({
        type: 'text',
        text: 'The recording is in the language with code "' + language + '". Transcribe it in that language.'
      });
    }
    const headers = { 'Content-Type': 'application/json' };
    if (opts.apiKey) headers['Authorization'] = 'Bearer ' + opts.apiKey;
    return { url, method: 'POST', headers, body: Buffer.from(JSON.stringify(body)) };
  }

  // OpenAI-shaped multipart: multipart/form-data with `file` + `model`,
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
  // An inline-audio chat completion reports its own `cost` alongside the token
  // counts (OpenRouter's authoritative billed figure). It cannot ride in the
  // `{ promptTokens, completionTokens }` shape the cost layer prices, so it is
  // dropped here and the built-in table prices the run instead — the number is
  // still on the response if a caller ever wants to prefer it.
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

// unwrapGeminiText(text) — concatenate the transcript out of a generateContent
// response, skipping the safety/usage noise.
//
// Two response shapes carry a transcript, and a model uses one or the other:
//
//   * a general model (`gemini-3.8-flash`) answers in `part.text` — the audio
//     is just another input and the transcript is just another reply;
//   * a purpose-built transcription model (`gemini-3.5-transcribe`) answers in
//     `part.audioTranscription.text`, with `part.text` present but **empty**.
//
// Reading only `part.text` made the second shape look like a provider failure:
// HTTP 200, a real transcript in the body, and `EEMPTY` — "the provider
// returned no transcript" — for the user. Both fields are read here, in
// candidate order, so either shape parses. A part may carry both (a model that
// both answers and labels its audio); `text` wins for that part so one sentence
// is never emitted twice.
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
      if (!part) continue;
      if (typeof part.text === 'string' && part.text) { out.push(part.text); continue; }
      const spoken = part.audioTranscription && part.audioTranscription.text;
      if (typeof spoken === 'string' && spoken) out.push(spoken);
    }
  }
  return out.join('').trim();
}

// unwrapOpenAIChatText(text) -> string | null
//
// The transcript out of an OpenAI-shaped chat completion. `content` may be a
// plain string or the newer array-of-parts form (`[{ type: 'text', text }]`),
// and models that think put the transcript in `content` with the reasoning
// beside it — so only `content` is read, never `reasoning`.
//
// `null` means the body was not a chat completion at all (the caller reports
// it as unreadable); `''` means a completion with nothing in it (no
// transcript). The two are different failures and the messages differ.
function unwrapOpenAIChatText(text) {
  let parsed;
  try { parsed = JSON.parse(text || '{}'); } catch { return null; }
  const choices = Array.isArray(parsed.choices) ? parsed.choices : null;
  if (!choices || !choices.length) return null;
  const message = (choices[0] && choices[0].message) || null;
  if (!message) return null;
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
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
  // The inline-audio chat shape answers with a completion, not a transcript
  // object: `choices[0].message.content`. Read before the multipart branch,
  // which expects `{ text }` and would call this response unreadable.
  if (kind === 'openai-audio') {
    const content = unwrapOpenAIChatText(text);
    if (content === null) return { error: 'The provider returned an unreadable response', code: 'EBADUPSTREAM' };
    if (!content) return { error: 'The provider returned no transcript', code: 'EEMPTY' };
    return { text: content, usage };
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
  DEFAULT_TRANSCRIBE_PROMPT,
  kindForModel,
  audioChatModel,
  transcriptionCandidates,
  isTranscriptionModel,
  reportedOutputModalities,
  acceptsAudioInput,
  mimeTypeFor,
  audioFormatFor,
  buildTranscribeRequest,
  parseTranscribeResponse,
  usageFromResponse,
  extensionFor,
  resolveUrl
};
