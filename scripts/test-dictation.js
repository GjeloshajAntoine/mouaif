'use strict';

// Dictation unit tests — the parts that are pure.
//
// Two halves, matching the split of the feature:
//
//   1. src/transcribe.js — the request/response shapes per provider family.
//      The multipart boundary and the Gemini body are the two things that are
//      easy to get subtly wrong and impossible to see in the UI (a wrong field
//      name comes back as a provider 400 with a paragraph of prose), so they
//      are asserted byte-for-byte here.
//   2. frontend/src/dictation.js — the browser-side helpers: which
//      MediaRecorder container is usable, the recording clock, the base64
//      encoding, the family picker, and the transcript action set.
//
// The DOM wiring (getUserMedia, MediaRecorder events, the page's rendering) is
// exercised through the HTTP test in scripts/test-dictation-http.mjs and at
// 360 px in the browser; anything that can be decided from values alone is
// decided here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const transcribe = require('../src/transcribe.js');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    const maybe = fn();
    if (maybe && typeof maybe.then === 'function') throw new Error('check() is synchronous — use checkAsync() for a promise');
    pass++;
    console.log('  ok   - ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]);
  }
}

// checkAsync(name, fn) — the same contract for a test that awaits (the base64
// encoder is asynchronous in both of its branches).
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   - ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]);
  }
}

async function loadFrontendModule(rel) {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  // `frontend/src/usage.js` is import-free, so it is inlined ahead of the
  // module under test: `dictation.js` imports `formatCost` from it, and
  // stripping the import lines would otherwise leave that name undefined (the
  // module would still load, and only fail when a cost is formatted).
  const usage = read('frontend/src/usage.js').replace(/^export /gm, '');
  const source = (usage + '\n' + read(rel)).replace(/^import .*;$/gm, '');
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

// ---- 1. Request families ------------------------------------------------

check('kindForModel infers the family from the provider, then the id', () => {
  assert.equal(transcribe.kindForModel({ id: 'whisper-1', provider: 'openai-compatible' }), 'openai-compatible');
  assert.equal(transcribe.kindForModel({ id: 'gemini-2.5-flash', provider: 'gemini' }), 'gemini');
  assert.equal(transcribe.kindForModel({ id: 'voxtral-mini', provider: 'mistral' }), 'openai-compatible');
  // An opaque id on an unknown provider falls back to the OpenAI shape: it is
  // the only shape that works against an arbitrary baseUrl.
  assert.equal(transcribe.kindForModel({ id: 'my-local-asr', provider: 'openai-compatible' }), 'openai-compatible');
  assert.equal(transcribe.kindForModel({}), 'openai-compatible');
});

check('an explicit transcription.kind always wins over inference', () => {
  assert.equal(transcribe.kindForModel({
    id: 'gemini-2.5-flash', provider: 'gemini', transcription: { kind: 'openai-compatible' }
  }), 'openai-compatible');
  assert.equal(transcribe.kindForModel({
    id: 'whisper-1', provider: 'openai-compatible', transcription: { kind: 'gemini' }
  }), 'gemini');
  // An unknown kind is ignored rather than trusted.
  assert.equal(transcribe.kindForModel({
    id: 'whisper-1', provider: 'openai-compatible', transcription: { kind: 'nonsense' }
  }), 'openai-compatible');
});

check('isTranscriptionModel recognises the five signals', () => {
// 1. explicitly marked
assert.equal(transcribe.isTranscriptionModel({ id: 'my-asr', transcription: true }), true);
// 2. the provider says what the model produces. `transcription` output is
//    the definitive yes; a report *without* it is a yes only when the model
//    can be sent audio over the chat route (see audioChatModel). This is the
//    rule that keeps the models OpenRouter *does* carry out of the chat
//    catalog while the ones /audio/transcriptions accepts stay in — and the
//    rule that lets an audio-input Google chat model be dictated with at all,
//    since OpenRouter files it under `output_modalities: ["text"]` and so
//    keeps it out of the transcription slice entirely.
assert.equal(transcribe.isTranscriptionModel({
id: 'openai/whisper-1', provider: 'openrouter', outputModalities: ['transcription']
}), true);
assert.equal(transcribe.isTranscriptionModel({
id: 'openai/gpt-audio', provider: 'openrouter', inputModalities: ['text', 'audio'], outputModalities: ['text', 'audio']
}), true, 'reported as audio in: dictated through /chat/completions, not /audio/transcriptions');
assert.equal(transcribe.isTranscriptionModel({
id: 'google/gemini-2.5-flash', provider: 'openrouter', inputModalities: ['text', 'audio'], outputModalities: ['text']
}), true, 'the Google row the user could not dictate with: audio in, /audio/transcriptions rejects it, chat route accepts it');
assert.equal(transcribe.isTranscriptionModel({
id: 'mistralai/voxtral-small-24b-2507', provider: 'openrouter', outputModalities: ['text']
}), false, 'a name hint does not outvote the provider — the STT sibling has its own id');
assert.equal(transcribe.isTranscriptionModel({
id: 'anthropic/claude-opus-4.8', provider: 'openrouter', inputModalities: ['text', 'audio'], outputModalities: ['text']
}), true, 'audio in is the rule on any OpenAI-shaped connection, not a Google special case');
// 3. the id looks like speech-to-text — only where nothing reported outputs
assert.equal(transcribe.isTranscriptionModel({ id: 'whisper-1', provider: 'openai-compatible' }), true);
assert.equal(transcribe.isTranscriptionModel({ id: 'openai/whisper-large-v3', provider: 'openrouter' }), true);
// 4. the Gemini family: audio is an inline part on the general models, so
//    there is no separate Gemini speech-to-text product to match on.
assert.equal(transcribe.isTranscriptionModel({ id: 'gemini-2.5-flash', provider: 'gemini' }), true);
// 5. the provider reports audio input without reporting outputs. This is the
//    signal that catches the models whose names say nothing when the provider
//    has no output report to trust.
assert.equal(transcribe.isTranscriptionModel({
id: 'openai/gpt-audio', provider: 'openrouter', inputModalities: ['text', 'audio']
}), true);
assert.equal(transcribe.isTranscriptionModel({
id: 'meta/muse-spark-1.3', provider: 'openrouter', inputModalities: ['text', 'audio', 'image']
}), true);
assert.equal(transcribe.isTranscriptionModel({ id: 'meta/muse-spark-1.3', provider: 'openrouter' }), false,
'without a modality report the name is all we have');
// A plain chat model on a non-Gemini provider is not a candidate.
assert.equal(transcribe.isTranscriptionModel({ id: 'gpt-5', provider: 'openai-compatible' }), false);
assert.equal(transcribe.isTranscriptionModel({ id: 'claude-sonnet-4', provider: 'anthropic' }), false);
assert.equal(transcribe.isTranscriptionModel(null), false);
assert.equal(transcribe.acceptsAudioInput({ inputModalities: ['TEXT', 'Audio'] }), true, 'case-insensitive');
assert.equal(transcribe.acceptsAudioInput({ inputModalities: 'audio' }), false, 'a string is not a list');
// reportedOutputModalities: absent (and malformed) is "unknown", never "no".
assert.deepEqual(transcribe.reportedOutputModalities({ outputModalities: ['Text', 'TRANSCRIPTION'] }),
['text', 'transcription']);
assert.equal(transcribe.reportedOutputModalities({ outputModalities: [] }), null);
assert.equal(transcribe.reportedOutputModalities({ outputModalities: 'transcription' }), null);
assert.equal(transcribe.reportedOutputModalities({}), null);
});

check('kindForModel only calls a model Gemini when it really is one', () => {
  // The provider decides.
  assert.equal(transcribe.kindForModel({ id: 'x', provider: 'gemini' }), 'gemini');
  // …and the *connection* decides when the provider is one we know: an
  // OpenRouter slug for a Google model still goes to OpenRouter, which has no
  // generateContent API. Reading `google/` as "Gemini" here produced
  // `openrouter.ai/api/v1/v1beta/models/…:generateContent` — a URL that cannot
  // exist. The `google/` prefix only decides for a provider we do not know.
  assert.equal(transcribe.kindForModel({ id: 'google/gemini-2.5-flash', provider: 'openrouter' }), 'openai-compatible');
  assert.equal(transcribe.kindForModel({ id: 'google/gemini-2.5-flash', provider: 'custom-gateway' }), 'gemini');
  // Regression: an id that merely *contains* "gemini" is not a Gemini model.
  // A substring test here classified dozens of OpenRouter rows (Fireworks'
  // naruto-…-gemini-…, gemini-flash-lite-latest, …) as Gemini, which both sent
  // them to the wrong endpoint and — because the Gemini family is on the
  // candidate list by definition — filtered everything else out of the
  // dictation catalog, so the list looked Google-only.
  assert.equal(transcribe.kindForModel({ id: 'fireworks/naruto-x-gemini-y', provider: 'openrouter' }), 'openai-compatible');
  assert.equal(transcribe.kindForModel({ id: 'gemini-flash-lite-latest', provider: 'openrouter' }), 'openai-compatible');
  // …but the names that *are* our hints still resolve.
  assert.equal(transcribe.kindForModel({ id: 'mistralai/voxtral-small-24b-2507', provider: 'openrouter' }), 'openai-compatible');
});

check('transcriptionCandidates unions marked models with id hints, else offers everything', () => {
  // A marked model and a hinted model both count; marking one must not hide
  // the other.
  const both = transcribe.transcriptionCandidates([
    { id: 'gpt-5', provider: 'openai-compatible' },
    { id: 'whisper-1', provider: 'openai-compatible' },
    { id: 'my-asr', provider: 'openai-compatible', transcription: { language: 'fr' } }
  ]);
  assert.deepEqual(both.map((m) => m.id), ['whisper-1', 'my-asr']);

  const hinted = transcribe.transcriptionCandidates([
    { id: 'gpt-5', provider: 'openai-compatible' },
    { id: 'whisper-large-v3', provider: 'groq' },
    // A provider-qualified OpenRouter slug: the hint has to match a substring,
    // because the id carries the vendor prefix.
    { id: 'openai/whisper-large-v3', provider: 'openrouter' }
  ]);
  assert.deepEqual(hinted.map((m) => m.id), ['whisper-large-v3', 'openai/whisper-large-v3']);

  // Nothing recognisable -> offer everything, because a self-hosted endpoint
// is unidentifiable by name and the user still has to be able to pick it.
const all = transcribe.transcriptionCandidates([{ id: 'a' }, { id: 'b' }]);
assert.deepEqual(all.map((m) => m.id), ['a', 'b']);
assert.deepEqual(transcribe.transcriptionCandidates(null), []);
// The classified catalog: every row reports `text` output and one of them has
// no audio input at all. The audio rows *are* offered now — through the chat
// route — and the one that cannot hear is not.
const classified = transcribe.transcriptionCandidates([
{ id: 'openai/gpt-audio', provider: 'openrouter', inputModalities: ['text', 'audio'], outputModalities: ['text', 'audio'] },
{ id: 'google/gemini-2.5-flash', provider: 'openrouter', inputModalities: ['text', 'audio'], outputModalities: ['text'] },
{ id: 'deepseek/deepseek-v4-flash', provider: 'openrouter', inputModalities: ['text'], outputModalities: ['text'] }
]);
assert.deepEqual(classified.map((m) => m.id), ['openai/gpt-audio', 'google/gemini-2.5-flash'],
'a classified audio row is offered on the chat route; a classified text-only row is not');
// A single unclassified row keeps the fallback alive for the rest: the
// self-hosted model the user wrote by hand must not be hidden by the rows a
// provider happened to describe.
const mixed = transcribe.transcriptionCandidates([
{ id: 'openai/gpt-audio', provider: 'openrouter', outputModalities: ['text'] },
{ id: 'my-asr', provider: 'openai-compatible' }
]);
assert.deepEqual(mixed.map((m) => m.id), ['openai/gpt-audio', 'my-asr']);

});

check('the OpenAI-shaped request is multipart with file + model', () => {
  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const built = transcribe.buildTranscribeRequest({
    kind: 'openai-compatible',
    model: { id: 'whisper-1', provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1' },
    apiKey: 'sk-test',
    audio,
    mimeType: 'audio/webm',
    filename: 'take.webm',
    language: 'fr',
    prompt: 'mouaif'
  });
  assert.equal(built.method, 'POST');
  assert.equal(built.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(built.headers.Authorization, 'Bearer sk-test');
  const boundary = /boundary=(.+)$/.exec(built.headers['Content-Type'])[1];
  assert.ok(boundary.startsWith('----mouaif'), 'boundary is namespaced');
  const body = built.body.toString('binary');
  assert.ok(body.includes('name="file"; filename="take.webm"'));
  assert.ok(body.includes('Content-Type: audio/webm'));
  assert.ok(body.includes('name="model"\r\n\r\nwhisper-1\r\n'));
  assert.ok(body.includes('name="language"\r\n\r\nfr\r\n'));
  assert.ok(body.includes('name="prompt"\r\n\r\nmouaif\r\n'));
  assert.ok(body.endsWith('--' + boundary + '--\r\n'), 'body is terminated');
  // The audio bytes survive the encode/decode round trip.
  assert.ok(built.body.includes(audio), 'audio bytes are present verbatim');
});

check('the inline-audio chat request carries the recording as an input_audio part', () => {
  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const built = transcribe.buildTranscribeRequest({
    kind: 'openai-audio',
    model: { id: 'google/gemini-3.5-flash', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
    apiKey: 'sk-or-test',
    audio,
    mimeType: 'audio/webm',
    filename: 'take.webm',
    language: 'fr',
    prompt: 'mouaif'
  });
  assert.equal(built.method, 'POST');
  // /chat/completions, never /audio/transcriptions: that endpoint answers
  // `400 Model … does not exist` for every one of these models.
  assert.equal(built.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(built.headers.Authorization, 'Bearer sk-or-test');
  assert.equal(built.headers['Content-Type'], 'application/json');
  const body = JSON.parse(built.body.toString('utf8'));
  assert.equal(body.model, 'google/gemini-3.5-flash');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  const [text, part, language] = body.messages[0].content;
  assert.equal(text.type, 'text');
  assert.equal(text.text, 'mouaif', 'an explicit prompt is sent verbatim');
  // The container is named by label, not by MIME type: `audio/webm;codecs=opus`
  // is not a value this field accepts.
  assert.deepEqual(part, { type: 'input_audio', input_audio: { data: audio.toString('base64'), format: 'webm' } });
  assert.equal(language.type, 'text', 'the language hint is a third part, not a field');
  assert.equal(language.text.includes('"fr"'), true, 'no language field exists, so the hint rides the prompt');
  // A bare recording still gets the instruction — with no prompt these models
  // answer "that is a pangram" instead of the sentence.
  const bare = JSON.parse(transcribe.buildTranscribeRequest({
    kind: 'openai-audio',
    model: { id: 'x', baseUrl: 'https://example.test/v1' },
    audio
  }).body.toString('utf8'));
  assert.equal(bare.messages[0].content[0].text, transcribe.DEFAULT_TRANSCRIBE_PROMPT);
  assert.equal(bare.messages[0].content.length, 2, 'no language part unless asked');
});

check('audioFormatFor names the container the way the field wants it', () => {
  assert.equal(transcribe.audioFormatFor('audio/webm;codecs=opus'), 'webm');
  assert.equal(transcribe.audioFormatFor('audio/ogg;codecs=opus'), 'ogg');
  assert.equal(transcribe.audioFormatFor('audio/mp4'), 'm4a');
  assert.equal(transcribe.audioFormatFor('audio/mpeg'), 'mp3');
  assert.equal(transcribe.audioFormatFor('audio/wav'), 'wav');
  assert.equal(transcribe.audioFormatFor('audio/flac'), 'flac');
  // Unknown falls back to what every Chromium MediaRecorder produces, and a
  // missing type is decided by the file name rather than guessed at.
  assert.equal(transcribe.audioFormatFor(''), 'webm');
  assert.equal(transcribe.audioFormatFor('', 'take.mp3'), 'mp3');
});

check('audioChatModel routes an audio-input chat row to the chat endpoint', () => {
  // The Google rows this whole change is about: reported as producing `text`,
  // so not transcription models, and rejected by /audio/transcriptions.
  assert.equal(transcribe.audioChatModel({
    id: 'google/gemini-3.5-flash', provider: 'openrouter', inputModalities: ['text', 'audio', 'image'], outputModalities: ['text']
  }), true);
  assert.equal(transcribe.kindForModel({
    id: 'google/gemini-3.5-flash', provider: 'openrouter', kind: 'openai-audio'
  }), 'openai-audio', 'the kind the catalog decided wins over the connection default');
  // A row with a real /audio/transcriptions entry keeps the multipart route,
  // which is cheaper and purpose-built.
  assert.equal(transcribe.audioChatModel({
    id: 'google/chirp-3', provider: 'openrouter', inputModalities: ['audio'], outputModalities: ['transcription']
  }), false);
  // A name that says where it belongs is not second-guessed.
  assert.equal(transcribe.audioChatModel({
    id: 'openai/whisper-large-v3', provider: 'openrouter', inputModalities: ['audio']
  }), false);
  // No report, no reroute: the multipart default is unchanged for everything
  // the provider did not describe.
  assert.equal(transcribe.audioChatModel({ id: 'my-asr', provider: 'openai-compatible' }), false);
  assert.equal(transcribe.audioChatModel({ id: 'gemini-2.5-flash', provider: 'gemini', inputModalities: ['audio'] }), false,
    'Gemini has its own inline shape and is not OpenAI-shaped');
});

check('a baseUrl with a trailing slash does not double it, and path is overridable', () => {
  const built = transcribe.buildTranscribeRequest({
    kind: 'openai-compatible',
    model: {
      id: 'whisper-1',
      baseUrl: 'https://example.test/v1/',
      transcription: { path: '/openai/deployments/asr/audio/transcriptions?api-version=2024-06-01' }
    },
    audio: Buffer.from('abc')
  });
  assert.equal(built.url, 'https://example.test/v1/openai/deployments/asr/audio/transcriptions?api-version=2024-06-01');
  assert.equal(built.headers.Authorization, undefined, 'no key -> no auth header');
  assert.equal(built.body.includes('name="language"'), false, 'optional fields are omitted');
});

check('a missing base URL is a typed error, not a request to nowhere', () => {
  assert.throws(() => transcribe.buildTranscribeRequest({
    kind: 'openai-compatible', model: { id: 'whisper-1' }, audio: Buffer.from('x')
  }), (e) => e.code === 'ENOBASEURL');
});

check('empty and oversized audio are refused with their own codes', () => {
  assert.throws(() => transcribe.buildTranscribeRequest({
    kind: 'openai-compatible', model: { id: 'w', baseUrl: 'https://x.test' }, audio: Buffer.alloc(0)
  }), (e) => e.code === 'EEMPTYAUDIO');
  assert.throws(() => transcribe.buildTranscribeRequest({
    kind: 'openai-compatible',
    model: { id: 'w', baseUrl: 'https://x.test' },
    audio: Buffer.alloc(transcribe.MAX_AUDIO_BYTES + 1)
  }), (e) => e.code === 'ETOOLARGE');
});

check('the Gemini request is inline JSON on the per-model action path', () => {
  const built = transcribe.buildTranscribeRequest({
    kind: 'gemini',
    model: { id: 'gemini-2.5-flash', provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
    apiKey: 'AIza-test',
    audio: Buffer.from('audio-bytes'),
    mimeType: 'audio/webm',
    language: 'en'
  });
  assert.equal(built.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(built.headers['x-goog-api-key'], 'AIza-test');
  assert.equal(built.headers.Authorization, undefined, 'the Gemini key is a header, never a query param');
  const body = JSON.parse(built.body.toString('utf8'));
  const parts = body.contents[0].parts;
  assert.equal(parts[1].inline_data.mime_type, 'audio/webm');
  assert.equal(parts[1].inline_data.data, Buffer.from('audio-bytes').toString('base64'));
  assert.equal(body.generationConfig.temperature, 0);
  assert.ok(parts.some((p) => typeof p.text === 'string' && p.text.includes('"en"')));
});

check('parseTranscribeResponse reads both families, including self-hosted spellings', () => {
  // `usage: null` is part of the contract now (the cost line reads it), so the
  // cases that carry no report assert the whole object.
  assert.deepEqual(
    transcribe.parseTranscribeResponse('openai-compatible', 200, JSON.stringify({ text: ' hello ' })),
    { text: 'hello', usage: null }
  );
  assert.deepEqual(
    transcribe.parseTranscribeResponse('openai-compatible', 200, JSON.stringify({ transcript: 'local server' })),
    { text: 'local server', usage: null }
  );
  const gemini = transcribe.parseTranscribeResponse('gemini', 200, JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'first ' }, { text: 'second' }] } }]
  }));
  assert.deepEqual(gemini, { text: 'first second', usage: null });
  // The 2026 Gemini transcription models answer in `audioTranscription.text`
  // with `part.text` present but EMPTY. Reading only `part.text` turned a
  // successful transcription into `EEMPTY` — "the provider returned no
  // transcript" — for a body that contained one.
  const geminiTranscribe = transcribe.parseTranscribeResponse('gemini', 200, JSON.stringify({
    candidates: [{ content: { parts: [{ text: '', audioTranscription: { text: 'spoken words' } }] } }]
  }));
  assert.deepEqual(geminiTranscribe, { text: 'spoken words', usage: null },
    'the dedicated transcription shape parses');
  // A part carrying both is emitted once, not twice.
  assert.equal(transcribe.parseTranscribeResponse('gemini', 200, JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'once', audioTranscription: { text: 'once' } }] } }]
  })).text, 'once');
  // The inline-audio chat shape answers with a completion.
  const chat = transcribe.parseTranscribeResponse('openai-audio', 200, JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '  a transcript  ', reasoning: 'thinking…' } }],
    usage: { prompt_tokens: 162, completion_tokens: 63 }
  }));
  assert.deepEqual(chat, { text: 'a transcript', usage: { promptTokens: 162, completionTokens: 63 } });
  assert.equal(transcribe.parseTranscribeResponse('openai-audio', 200, JSON.stringify({
    choices: [{ message: { content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] } }]
  })).text, 'part one part two', 'the array-of-parts content form parses');
  // Reasoning is never the transcript, and an empty completion is EEMPTY
  // rather than a crash.
  assert.equal(transcribe.parseTranscribeResponse('openai-audio', 200, JSON.stringify({
    choices: [{ message: { content: '', reasoning: 'I cannot hear this' } }]
  })).code, 'EEMPTY');
  assert.equal(transcribe.parseTranscribeResponse('openai-audio', 200, '<html>nope</html>').code, 'EBADUPSTREAM');
  // An HTTP failure surfaces the provider's own words, which is the only
  // diagnostic the user gets for a misconfigured endpoint.
  const unauthorised = transcribe.parseTranscribeResponse('openai-compatible', 401, JSON.stringify({
    error: { message: 'Incorrect API key provided' }
  }));
  assert.equal(unauthorised.code, 'ENOAUTH');
  assert.equal(unauthorised.error, 'Incorrect API key provided');
  const empty = transcribe.parseTranscribeResponse('gemini', 200, JSON.stringify({ candidates: [] }));
  assert.equal(empty.code, 'EEMPTY');
  const unreadable = transcribe.parseTranscribeResponse('openai-compatible', 200, '<html>nope</html>');
  assert.equal(unreadable.code, 'EBADUPSTREAM');
});

check('a no-project catalog offers nothing but still names the shapes', () => {
  // Covered by the http test's project-less case; here the pure part: an
  // empty model list must not lose the family list, which is what the
  // read-out under the picker names.
  assert.deepEqual(transcribe.transcriptionCandidates([]), []);
  assert.deepEqual(transcribe.transcriptionCandidates(null), []);
  assert.equal(transcribe.TRANSCRIBE_KINDS.length, 3, 'multipart, inline-audio chat, and Gemini');
});

check('usageFromResponse reads both families and never invents a zero', () => {
  // OpenAI-shaped, which reports tokens on the models that report anything
  // at all (the gpt-4o transcribe family).
  assert.deepEqual(
    transcribe.usageFromResponse('openai-compatible', JSON.stringify({
      text: 'hi', usage: { type: 'tokens', input_tokens: 210, output_tokens: 12, total_tokens: 222 }
    })),
    { promptTokens: 210, completionTokens: 12 },
    'the type:"tokens" spelling is the one the newer transcription models use'
  );
  assert.deepEqual(
    transcribe.usageFromResponse('openai-compatible', JSON.stringify({
      text: 'hi', usage: { prompt_tokens: '30', completion_tokens: '4' }
    })),
    { promptTokens: 30, completionTokens: 4 },
    'the classic completions spelling works too, including as strings'
  );
  // Gemini reports the audio in the prompt.
  assert.deepEqual(
    transcribe.usageFromResponse('gemini', JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'bonjour' }] } }],
      usageMetadata: { promptTokenCount: 480, candidatesTokenCount: 6 }
    })),
    { promptTokens: 480, completionTokens: 6 }
  );
  // Absent means unknown, not zero — `whisper-1` bills per minute and answers
  // with the transcript alone, and a zero here would price it as free.
  assert.equal(transcribe.usageFromResponse('openai-compatible', JSON.stringify({ text: 'hi' })), null);
  assert.equal(transcribe.usageFromResponse('gemini', JSON.stringify({ candidates: [] })), null);
  // A duration report is not a token report either.
  assert.equal(transcribe.usageFromResponse('openai-compatible', JSON.stringify({
    text: 'hi', usage: { type: 'duration', seconds: 8 }
  })), null);
  assert.equal(transcribe.usageFromResponse('openai-compatible', '<html>nope</html>'), null);
});

check('parseTranscribeResponse carries the usage through both families', () => {
  const openai = transcribe.parseTranscribeResponse('openai-compatible', 200, JSON.stringify({
    text: ' hello ', usage: { input_tokens: 10, output_tokens: 2 }
  }));
  assert.equal(openai.text, 'hello');
  assert.deepEqual(openai.usage, { promptTokens: 10, completionTokens: 2 });
  assert.equal(
    transcribe.parseTranscribeResponse('openai-compatible', 200, JSON.stringify({ text: 'hi' })).usage,
    null,
    'no report stays null so the cost line can say --'
  );
  const gemini = transcribe.parseTranscribeResponse('gemini', 200, JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'bonjour' }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 }
  }));
  assert.deepEqual(gemini.usage, { promptTokens: 5, completionTokens: 1 });
});

check('mimeTypeFor maps the containers a MediaRecorder produces', () => {
  assert.equal(transcribe.mimeTypeFor('dictation-1.webm'), 'audio/webm');
  assert.equal(transcribe.mimeTypeFor('x.m4a'), 'audio/mp4');
  assert.equal(transcribe.mimeTypeFor('x.ogg'), 'audio/ogg');
  assert.equal(transcribe.mimeTypeFor('x.wav'), 'audio/wav');
  assert.equal(transcribe.mimeTypeFor('x.unknown'), 'application/octet-stream');
  assert.equal(transcribe.mimeTypeFor(''), 'application/octet-stream');
});

// ---- 2. App settings plumbing -------------------------------------------
//
// The remembered dictation model is app-level state, so it travels through
// two allowlists on the server before any surface can read it: the client
// snapshot (`settingsForClient`, which drops every key it does not know) and
// the reset endpoint's key set. A key that is stored but stripped is
// indistinguishable from a key that was never saved — the picker came up on
// "Pick a model" on every visit and the composer microphone answered "No
// dictation model yet" however often a model had been chosen. Both halves are
// pinned here, the second one by exercising the real modules against a
// throwaway store rather than pattern matching.

check('the dictation choice is allowlisted for the client', () => {
const shared = fs.readFileSync(path.join(__dirname, '..', 'src/server-shared.js'), 'utf8');
const listStart = shared.indexOf('const CLIENT_SETTINGS_KEYS = Object.freeze([');
assert.ok(listStart > -1, 'CLIENT_SETTINGS_KEYS block found');
const listEnd = shared.indexOf(']);', listStart);
assert.match(
shared.slice(listStart, listEnd),
/'dictation'/,
'a stored-but-stripped key is a key the UI never reads back'
);
});

check('the running server hands the remembered model back', () => {
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-dictation-'));
const priorHome = process.env.MOUAIF_HOME;
process.env.MOUAIF_HOME = home;
try {
// Fresh module registry so settings.js captures the temp home.
const settings = require(path.join(__dirname, '..', 'src/settings.js'));
const { settingsForClient, RESETTABLE_APP_KEYS } = require(path.join(__dirname, '..', 'src/server-shared.js'));
const choice = { modelId: 'whisper-1', providerId: 'openai-compatible' };
settings.setApp({ dictation: choice });
assert.deepEqual(settings.getApp().dictation, choice, 'the app store keeps the pair');
assert.deepEqual(
settingsForClient(settings.getApp()).dictation,
choice,
'GET /api/settings must carry it, or the pick is invisible to the page and the microphone'
);
// Reset is the other side of the same coin: an app key the UI can never
// clear outlives the settings it belongs to.
assert.ok(RESETTABLE_APP_KEYS.has('dictation'), 'reset must be able to drop the key');
// A store that has never dictated resolves to nothing rather than to a
// stale model, and the page treats that as "no choice yet".
assert.equal(settingsForClient({}).dictation, undefined);
} finally {
if (priorHome === undefined) delete process.env.MOUAIF_HOME;
else process.env.MOUAIF_HOME = priorHome;
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}
});

// ---- 3. Browser helpers -------------------------------------------------

(async () => {
  const dictation = await loadFrontendModule('frontend/src/dictation.js');

  check('recorderSupported needs both MediaRecorder and getUserMedia', () => {
    assert.equal(dictation.recorderSupported(null), false);
    assert.equal(dictation.recorderSupported({}), false);
    assert.equal(dictation.recorderSupported({
      MediaRecorder: function () {}, navigator: {}
    }), false);
    assert.equal(dictation.recorderSupported({
      MediaRecorder: function () {}, navigator: { mediaDevices: { getUserMedia() {} } }
    }), true);
  });

  check('pickRecorderMime returns the first supported container, else empty', () => {
    assert.equal(dictation.pickRecorderMime({
      isTypeSupported: (t) => t === 'audio/ogg;codecs=opus'
    }), 'audio/ogg;codecs=opus');
    assert.equal(dictation.pickRecorderMime({ isTypeSupported: () => false }), '');
    // A recorder with no isTypeSupported lets the browser choose its default.
    assert.equal(dictation.pickRecorderMime(function () {}), '');
    // Preference order: Opus-in-WebM wins when everything claims support.
    assert.equal(dictation.pickRecorderMime({ isTypeSupported: () => true }), 'audio/webm;codecs=opus');
    assert.equal(dictation.pickRecorderMime({ isTypeSupported: () => { throw new Error('nope'); } }), '');
  });

  check('extensionForMime and dictationFilename agree with the container', () => {
    assert.equal(dictation.extensionForMime('audio/webm;codecs=opus'), '.webm');
    assert.equal(dictation.extensionForMime('audio/mp4'), '.m4a');
    assert.equal(dictation.extensionForMime(''), '.webm');
    assert.equal(dictation.dictationFilename('audio/webm', Date.UTC(2026, 0, 2, 3, 4, 5)), 'dictation-2026-01-02T03-04-05.webm');
  });

  check('formatDuration is m:ss and only grows an hours field when earned', () => {
    assert.equal(dictation.formatDuration(0), '0:00');
    assert.equal(dictation.formatDuration(2000), '0:02');
    assert.equal(dictation.formatDuration(65000), '1:05');
    assert.equal(dictation.formatDuration(3600000), '1:00:00');
    assert.equal(dictation.formatDuration(-5), '0:00');
    assert.equal(dictation.formatDuration('nonsense'), '0:00');
  });

  // ---- Live (as-you-speak) transcription --------------------------------
  //
  // The live path sends a *segment* of the take per chunk, so the transcript is
  // the concatenation of the segments. The three things that can go wrong are
  // all decided from values alone, which is why they are tested here rather
  // than through a fake recorder: results arriving out of order, the seam
  // between two segments being said twice, and a chunk that recognised nothing.
  check('liveDictationEnabled defaults on and only an explicit false turns it off', () => {
    assert.equal(dictation.liveDictationEnabled({}), true, 'a fresh install dictates live');
    assert.equal(dictation.liveDictationEnabled({ modelId: 'whisper-1' }), true);
    assert.equal(dictation.liveDictationEnabled({ live: true }), true);
    assert.equal(dictation.liveDictationEnabled({ live: false }), false);
    assert.equal(dictation.liveDictationEnabled(null), true);
    // Anything that is not `false` reads as on: a value the page wrote as a
    // string ("off") must not silently disable the feature.
    assert.equal(dictation.liveDictationEnabled({ live: 'off' }), true);
  });

  check('joinTranscript concatenates segments in order', () => {
    assert.equal(dictation.joinTranscript(['one two', 'three four']), 'one two three four');
    assert.equal(dictation.joinTranscript(['  one  ', 'two ']), 'one two');
    assert.equal(dictation.joinTranscript([]), '');
    assert.equal(dictation.joinTranscript(null), '');
    assert.equal(dictation.joinTranscript(['', '   ']), '', 'silent segments contribute nothing');
    assert.equal(dictation.joinTranscript(['one', '', 'two']), 'one two');
    assert.equal(dictation.joinTranscript(['one']), 'one');
  });

  check('joinTranscript drops a seam the two segments both heard', () => {
    // The provider restarts its context at every chunk, so the words at the
    // boundary are commonly transcribed twice. Longest run first: `the note` is
    // dropped whole rather than leaving `the the note`.
    assert.equal(
      dictation.joinTranscript(['please save the note', 'the note is saved']),
      'please save the note is saved'
    );
    assert.equal(
      dictation.joinTranscript(['we should schedule the deployment', 'the deployment tomorrow morning']),
      'we should schedule the deployment tomorrow morning'
    );
    // A single repeated word at the boundary is the commonest chunk artifact
    // ("… the note" / "note is saved"), so it is dropped: without that, every
    // live take grows a stutter wherever the timeslice fell.
    assert.equal(dictation.joinTranscript(['that is fine', 'fine by me']), 'that is fine by me');
    assert.equal(dictation.joinTranscript(['save the note', 'note is saved']), 'save the note is saved');
    // A two-word run is dropped whole, not just its last word.
    assert.equal(dictation.joinTranscript(['is this the note', 'the note that matters']), 'is this the note that matters');
    // No repeat at all: the two halves are simply joined.
    assert.equal(dictation.joinTranscript(['hello there', 'how are you']), 'hello there how are you');
    // A repeat that is not a real seam (a coincidental run of letters) must not
    // eat the start of a word.
    assert.equal(dictation.joinTranscript(['within', 'income for the year']), 'within income for the year');
  });

  check('seamOverlap returns a character offset into the next segment', () => {
    assert.equal(dictation.seamOverlap('save the note', 'the note is saved'), 'the note'.length);
    assert.equal(dictation.seamOverlap('hello', 'world'), 0);
    assert.equal(dictation.seamOverlap('', 'anything'), 0);
    assert.equal(dictation.seamOverlap('anything', ''), 0);
    // Case and punctuation do not count against a match, and the offset covers
    // the whole repeated run rather than just the last word.
    assert.equal(dictation.seamOverlap('Save The Note', 'the note is saved'), 'the note'.length);
  });

  check('createLiveSegments keeps speaking order when answers arrive out of order', () => {
    const take = dictation.createLiveSegments();
    take.set(0, 'first words');
    take.set(2, 'third words');           // chunk 1 is still in flight
    assert.equal(take.text(), 'first words third words', 'a missing chunk is simply absent');
    assert.equal(take.pending(3), 1, 'one answer still outstanding');
    take.set(1, 'second words');
    assert.equal(take.text(), 'first words second words third words');
    assert.equal(take.pending(3), 0);
    assert.equal(take.answered(), 3);
    // Re-setting an index (a retry of the same chunk) replaces it rather than
    // appending a second copy.
    take.set(1, 'second words again');
    assert.equal(take.text(), 'first words second words again third words');
    assert.equal(take.answered(), 3);
    // `pending` never goes negative when a chunk is answered without being
    // counted (an event from a recorder that restarted its numbering).
    assert.equal(take.pending(1), 0);
  });

  check('createLiveSegments applies the seam rule across arriving chunks', () => {
    const take = dictation.createLiveSegments();
    take.set(0, 'the build is red');
    take.set(2, 'on the note');
    take.set(1, 'red again');
    assert.equal(take.text(), 'the build is red again on the note', 'the word said twice at the seam is dropped');

    const seam = dictation.createLiveSegments();
    seam.set(0, 'please read the note');
    seam.set(1, 'the note that matters');
    assert.equal(seam.text(), 'please read the note that matters', 'longest run first');
  });

  await checkAsync('blobToBase64 uses FileReader when present and arrayBuffer otherwise', async () => {
    const bytes = Buffer.from([1, 2, 3, 250]);
    const expected = bytes.toString('base64');
    const blob = { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
    assert.equal(await dictation.blobToBase64(blob), expected);

    const original = globalThis.FileReader;
    globalThis.FileReader = function FileReaderStub() {
      this.readAsDataURL = () => { this.result = 'data:audio/webm;base64,' + expected; this.onload(); };
    };
    try {
      assert.equal(await dictation.blobToBase64(blob), expected, 'the data: prefix is stripped');
    } finally {
      if (original === undefined) delete globalThis.FileReader;
      else globalThis.FileReader = original;
    }
    await assert.rejects(() => dictation.blobToBase64(null), /Nothing recorded/);
  });

  check('dictationRank weighs a row by how much its name says', () => {
  // The provider reporting `transcription` output is the strongest signal
  // there is — stronger than a name, because it cannot be a coincidence.
  assert.equal(dictation.dictationRank({ id: 'google/chirp-3', provider: 'openrouter', outputModalities: ['transcription'] }), 3);
  // A name that says "transcribe" is next.
  assert.equal(dictation.dictationRank({ id: 'whisper-large-v3', provider: 'groq' }), 3);
  assert.equal(dictation.dictationRank({ id: 'mistralai/voxtral-small-24b-2507', provider: 'openrouter' }), 3);
  assert.equal(dictation.dictationRank({ id: 'parakeet-tdt-0.6b', provider: 'openai-compatible' }), 3);
  // Audio input, or a Gemini model, is capable but says nothing about being
  // a transcriber — `openai/gpt-audio` chats about audio.
  assert.equal(dictation.dictationRank({
  id: 'openai/gpt-audio', provider: 'openrouter', inputModalities: ['text', 'audio']
  }), 2);
  assert.equal(dictation.dictationRank({ id: 'gemini-2.5-flash', provider: 'gemini', kind: 'gemini' }), 2);
  // The user's own record ranks below both, but above a row that is only
  // here because nothing could be recognised.
  assert.equal(dictation.dictationRank({ id: 'my-self-hosted-asr', source: 'project' }), 1);
  assert.equal(dictation.dictationRank({ id: 'gpt-5', provider: 'openai-compatible', source: 'live' }), 0);
  assert.equal(dictation.dictationRank(null), 0);
  assert.equal(dictation.acceptsAudioInput({ inputModalities: ['TEXT', 'Audio'] }), true, 'case-insensitive');
  assert.equal(dictation.acceptsAudioInput({ inputModalities: 'audio' }), false, 'a string is not a list');
  assert.equal(dictation.reportsTranscription({ outputModalities: ['Transcription'] }), true, 'case-insensitive');
  assert.equal(dictation.reportsTranscription({ outputModalities: ['text'] }), false);
  assert.equal(dictation.reportsTranscription({}), false, 'absent is not a no');
  // The badge: a reported transcriber needs no explaining; an audio-input chat
  // row does.
  assert.equal(dictation.modelBadge({
  id: 'openai/whisper-1', source: 'live', inputModalities: ['audio'], outputModalities: ['transcription']
  }), 'from provider');
  assert.equal(dictation.modelBadge({
  id: 'meta/muse-spark-1.3', source: 'live', inputModalities: ['text', 'audio'], outputModalities: ['text']
  }), 'from provider · audio in');
  });

  check('recommendedModels puts the named transcribers first, then what can take audio', () => {
    const rows = [
      { id: 'gpt-5', provider: 'openai-compatible' },
      { id: 'whisper-large-v3', provider: 'groq' },
      { id: 'openai/gpt-audio', provider: 'openrouter', inputModalities: ['text', 'audio'] },
      { id: 'whisper-1', provider: 'openai-compatible' },
      { id: 'my-self-hosted-asr', source: 'project' }
    ];
    assert.deepEqual(dictation.recommendedModels(rows).map((m) => m.id), ['whisper-large-v3', 'whisper-1'],
      'a named transcriber beats an audio-capable chat model, in catalog order');
    assert.deepEqual(
      dictation.recommendedModels([{ id: 'gemini-2.5-flash', kind: 'gemini' }, { id: 'gemini-2.5-pro', kind: 'gemini' }]).map((m) => m.id),
      ['gemini-2.5-flash', 'gemini-2.5-pro'],
      'with no named transcriber the audio-capable rows are the best signal left'
    );
    assert.deepEqual(dictation.recommendedModels(rows, 1).map((m) => m.id), ['whisper-large-v3'], 'the cap holds');
    assert.deepEqual(dictation.recommendedModels([{ id: 'gpt-5' }]), [], 'nothing worth recommending stays empty');
    assert.deepEqual(dictation.recommendedModels(null), []);
  });

  check('transcribeCost renders -- for every unknown, never a fake $0.00', () => {
    // The known case: the server priced the run.
    assert.deepEqual(
      dictation.transcribeCost({ cost: { known: true, total: 0.00055, input: 0.0003, output: 0.00025, currency: 'USD' } }),
      { known: true, total: 0.00055, label: '$0.00055' }
    );
    // A per-minute model reports no tokens, so the server sends known:false.
    assert.deepEqual(dictation.transcribeCost({ usage: null, cost: { known: false, total: 0, currency: 'USD' } }),
      { known: false, total: 0, label: '--' });
    // An old server (or a non-JSON body) sends no cost at all.
    assert.deepEqual(dictation.transcribeCost({ text: 'hi' }), { known: false, total: 0, label: '--' });
    assert.deepEqual(dictation.transcribeCost(null), { known: false, total: 0, label: '--' });
    // A known-but-nonsensical total is unknown, not a wrong number.
    assert.equal(dictation.transcribeCost({ cost: { known: true, total: 'lots' } }).label, '--');
    // Definitely-priced zero stays a real zero (`formatCost` renders $0.00).
    assert.equal(dictation.transcribeCost({ cost: { known: true, total: 0 } }).label, '$0.00');
  });

  check('lastRunLine reports the run and its cost in one line', () => {
    assert.equal(
      dictation.lastRunLine({
        model: { id: 'gemini-2.5-flash' }, kind: 'gemini', bytes: 4096, durationMs: 812,
        costLabel: '$0.00055'
      }),
      'Last run: gemini-2.5-flash · Gemini · 4 kB · 0.8s · cost $0.00055'
    );
    // An unpriced run still reports the run — with `--`, so the number is
    // visibly missing rather than silently absent.
    assert.equal(
      dictation.lastRunLine({ model: { id: 'whisper-1' }, kind: 'openai-compatible', bytes: 0, durationMs: 0, costLabel: '--' }),
      'Last run: whisper-1 · OpenAI-shaped · 0 kB · 0s · cost --'
    );
    assert.equal(
      dictation.lastRunLine({}).startsWith('Last run: unknown model'),
      true,
      'a run with no model record still says something rather than crashing'
    );
  });

  check('pickerModels reshapes rows for the shared model picker', () => {
    assert.deepEqual(dictation.pickerModels([{ id: 'whisper-1', provider: 'groq', label: 'Whisper', kind: 'x' }]),
      [{ id: 'whisper-1', provider: 'groq', label: 'Whisper' }]);
    assert.deepEqual(dictation.pickerModels(null), []);
  });

  check('transcriptActions gates each action on what exists', () => {
    const none = dictation.transcriptActions({});
    assert.deepEqual(none.map((a) => a.id), ['copy', 'insert', 'send', 'clear']);
    assert.ok(none.every((a) => a.disabled), 'an empty page offers nothing');
    const withText = dictation.transcriptActions({ text: '  hi  ' });
    assert.equal(withText.find((a) => a.id === 'copy').disabled, false);
    assert.equal(withText.find((a) => a.id === 'insert').disabled, true, 'no chat to insert into');
    const full = dictation.transcriptActions({ text: 'hi', chatId: '/p', hasRecording: false });
    assert.ok(full.every((a) => a.disabled === false));
    assert.equal(dictation.transcriptActions({ hasRecording: true }).find((a) => a.id === 'clear').disabled, false);
  });

  check('kindShortLabel stays one word wide for the segmented control', () => {
    assert.equal(dictation.kindShortLabel('openai-compatible'), 'OpenAI-shaped');
    assert.equal(dictation.kindShortLabel('gemini'), 'Gemini');
    assert.equal(dictation.kindShortLabel('custom'), 'custom');
  });

  check('kindLabel falls back to the id when the catalog does not know it', () => {
    assert.equal(dictation.kindLabel([{ id: 'gemini', label: 'Gemini (inline audio)' }], 'gemini'), 'Gemini (inline audio)');
    assert.equal(dictation.kindLabel([], 'gemini'), 'gemini');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch((err) => {
  console.error('test-dictation crashed:', err);
  process.exit(1);
});
