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
  const source = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    .replace(/^import .*;$/gm, '');
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
  assert.deepEqual(
    transcribe.parseTranscribeResponse('openai-compatible', 200, JSON.stringify({ text: ' hello ' })),
    { text: 'hello' }
  );
  assert.deepEqual(
    transcribe.parseTranscribeResponse('openai-compatible', 200, JSON.stringify({ transcript: 'local server' })),
    { text: 'local server' }
  );
  const gemini = transcribe.parseTranscribeResponse('gemini', 200, JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'first ' }, { text: 'second' }] } }]
  }));
  assert.deepEqual(gemini, { text: 'first second' });
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

check('mimeTypeFor maps the containers a MediaRecorder produces', () => {
  assert.equal(transcribe.mimeTypeFor('dictation-1.webm'), 'audio/webm');
  assert.equal(transcribe.mimeTypeFor('x.m4a'), 'audio/mp4');
  assert.equal(transcribe.mimeTypeFor('x.ogg'), 'audio/ogg');
  assert.equal(transcribe.mimeTypeFor('x.wav'), 'audio/wav');
  assert.equal(transcribe.mimeTypeFor('x.unknown'), 'application/octet-stream');
  assert.equal(transcribe.mimeTypeFor(''), 'application/octet-stream');
});

// ---- 2. Browser helpers -------------------------------------------------

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

  check('autoKindId picks the family the project actually uses', () => {
    const kinds = [{ id: 'openai-compatible' }, { id: 'gemini' }];
    assert.equal(dictation.autoKindId(kinds, [
      { id: 'gemini-2.5-flash', kind: 'gemini' },
      { id: 'gemini-2.5-pro', kind: 'gemini' },
      { id: 'whisper-1', kind: 'openai-compatible' }
    ]), 'gemini');
    // A tie resolves to the order of `kinds`, which puts OpenAI first.
    assert.equal(dictation.autoKindId(kinds, [
      { id: 'a', kind: 'gemini' }, { id: 'b', kind: 'openai-compatible' }
    ]), 'openai-compatible');
    assert.equal(dictation.autoKindId(kinds, []), 'openai-compatible');
    assert.equal(dictation.autoKindId([], []), '');
  });

  check('modelsForKind filters the rows and passes everything through on all/empty', () => {
    const models = [{ id: 'a', kind: 'gemini' }, { id: 'b', kind: 'openai-compatible' }];
    assert.deepEqual(dictation.modelsForKind(models, 'gemini').map((m) => m.id), ['a']);
    assert.deepEqual(dictation.modelsForKind(models, 'all').map((m) => m.id), ['a', 'b']);
    assert.deepEqual(dictation.modelsForKind(models, '').map((m) => m.id), ['a', 'b']);
    assert.deepEqual(dictation.modelsForKind(null, 'gemini'), []);
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
