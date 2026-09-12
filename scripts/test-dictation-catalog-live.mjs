// The dictation catalog against the *real* OpenRouter catalogs.
//
// OpenRouter serves two of them, and which one you ask for decides whether
// dictation can work at all:
//
//   * `/models` — the chat catalog. It is sliced by output modality and
//     *defaults to `output_modalities=text`*, so not one of the 21
//     speech-to-text models is in it. What it does carry is a large family of
//     audio-*input* chat models (`openai/gpt-audio`, `google/gemini-2.5-flash`,
//     `mistralai/voxtral-small-24b-2507`), and every one of those answers
//     /audio/transcriptions with `400 Model … does not exist`. A dictation
//     catalog built by filtering this list therefore offers models that cannot
//     transcribe, which is the bug this file guards.
//   * `/models?output_modalities=transcription` — the speech-to-text catalog
//     (`openai/whisper-1`, `openai/gpt-4o-transcribe`, `google/chirp-3`, …),
//     which only the dictation slice asks for (see `listTranscriptionModels`
//     in src/ai-endpoints.js).
//
// Two earlier bugs are also reproduced here, because both are still easy to get
// wrong: classifying by id substring ("gemini" in the name made dozens of rows
// "Gemini models", so the catalog read as Google-only), and trusting an audio
// *input* report as proof of transcription ability.
//
// Run with no arguments: it skips unless it can reach OpenRouter (a sandbox
// without egress is a skip, not a failure) and falls back to the recorded
// fixtures. Pass `--record` once to freeze both payloads so the assertions
// still run offline.
//
// It is deliberately an offline-by-default check: the *shape* of a live
// catalog is what the other three dictation tests stub, and this one exists to
// keep the filter honest against real data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const transcribe = require('../src/transcribe.js');
const ai = require('../src/ai.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'dictation-openrouter-models.json');
const STT_FIXTURE = path.join(__dirname, 'fixtures', 'dictation-openrouter-stt-models.json');
const CHAT_URL = 'https://openrouter.ai/api/v1/models';
const STT_URL = CHAT_URL + '?output_modalities=transcription';

async function loadPayload(url, fixture) {
  if (process.argv.includes('--record')) {
    const res = await fetch(url);
    assert.equal(res.status, 200, url + ' answered ' + res.status);
    const json = await res.json();
    fs.mkdirSync(path.dirname(fixture), { recursive: true });
    fs.writeFileSync(fixture, JSON.stringify(json));
    console.log('recorded ' + (json.data || []).length + ' models from ' + url + ' -> ' + fixture);
    return json;
  }
  if (fs.existsSync(fixture)) return JSON.parse(fs.readFileSync(fixture, 'utf8'));
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.log('SKIP openrouter-catalog: no network (' + e.message + ') and no recorded fixture.');
    process.exit(0);
  }
  if (res.status !== 200) {
    console.log('SKIP openrouter-catalog: upstream answered ' + res.status);
    process.exit(0);
  }
  return res.json();
}

// parseThrough(payload, url, adapter) — run a payload through the real adapter,
// so this also covers the modality plumbing in src/ai-endpoints.js (OpenRouter's
// `architecture.input_modalities` / `output_modalities` are the only signals
// that identify a transcriber). The URL is asserted too: asking the chat
// endpoint for the transcription slice is the whole bug.
async function parseThrough(payload, url, adapter) {
  const realFetch = global.fetch;
  global.fetch = async (requested) => {
    const requestedUrl = typeof requested === 'string' ? requested : requested.url;
    assert.equal(requestedUrl, url, 'the adapter must ask OpenRouter for ' + url);
    return { ok: true, status: 200, json: async () => payload };
  };
  try {
    return await adapter();
  } finally {
    global.fetch = realFetch;
  }
}

const chatPayload = await loadPayload(CHAT_URL, FIXTURE);
const sttPayload = await loadPayload(STT_URL, STT_FIXTURE);
const chatRows = (await parseThrough(chatPayload, CHAT_URL, () => ai.listModels('openrouter', 'fixture-key')))
  .map((m) => Object.assign({}, m, { provider: 'openrouter' }));
const sttRows = (await parseThrough(sttPayload, STT_URL, () => ai.listTranscriptionModels('openrouter', 'fixture-key')))
  .map((m) => Object.assign({}, m, { provider: 'openrouter' }));

// ---- The capability reports are carried through -------------------------

assert.ok(chatRows.length > 100, 'expected a real chat catalog, got ' + chatRows.length);
const withInputs = chatRows.filter((m) => Array.isArray(m.inputModalities));
const withOutputs = chatRows.filter((m) => Array.isArray(m.outputModalities));
assert.ok(withInputs.length > 0,
  'the adapter must carry architecture.input_modalities through');
assert.ok(withOutputs.length > 0,
  'and architecture.output_modalities with it');
assert.ok(withInputs.some((m) => m.inputModalities.includes('audio')),
  'and audio must appear among the inputs');
assert.ok(withOutputs.some((m) => m.outputModalities.includes('text')),
  'and text among the outputs');
assert.ok(sttRows.length > 10, 'the transcription slice is a real catalog, got ' + sttRows.length);
assert.ok(sttRows.every((m) => Array.isArray(m.outputModalities) && m.outputModalities.includes('transcription')),
  'every row of the transcription slice reports transcription output');
assert.ok(sttRows.some((m) => m.id === 'openai/whisper-1'),
  'the recorded slice carries at least one model a user would look for: '
  + sttRows.map((m) => m.id).join(', '));

// ---- An audio *input* report is not a transcription signal --------------

// The chat catalog's audio models used to be offered and then rejected by the
// provider, because the catalog sent every one of them to
// /audio/transcriptions. The ones that can hear are offered now — through the
// chat route, which is the endpoint that accepts them — and the ones that
// cannot be dictated with at all are not.
//
// A row is not offered for dictation when either of two things is true:
//   * `:batch` — served by the Batch API (submit a job, poll it), which a
//     microphone tap cannot reach; or
//   * its *name* says it belongs to /audio/transcriptions (`whisper-…`,
//     `voxtral-…`). Those ids have a sibling in the transcription slice
//     (`mistralai/voxtral-small-24b-2507-stt`) or a real entry there, and the
//     purpose-built multipart call is the right one for them.
const HINT = /whisper|transcribe|voxtral|parakeet/;
const audioChatRows = chatRows.filter((m) => Array.isArray(m.inputModalities) && m.inputModalities.includes('audio'));
assert.ok(audioChatRows.length > 0, 'the chat catalog has audio-input models to check');
for (const row of audioChatRows) {
  if (row.outputModalities.includes('transcription')) continue; // belongs in the STT slice
  if (row.id.endsWith(':batch')) {
    assert.equal(transcribe.isTranscriptionModel(row), false,
      row.id + ' is only callable through the Batch API, which cannot answer a dictation');
    continue;
  }
  if (HINT.test(row.id)) {
    assert.equal(transcribe.kindForModel(row), 'openai-compatible',
      row.id + ' names itself a transcriber, so it keeps the multipart route');
    continue;
  }
  assert.equal(transcribe.isTranscriptionModel(row), true,
    row.id + ' takes audio input, so it is dictated with — through /chat/completions');
  assert.equal(transcribe.kindForModel(row), 'openai-audio',
    row.id + ' must be sent to the endpoint that accepts it, not /audio/transcriptions');
}
for (const id of ['openai/gpt-audio', 'google/gemini-2.5-flash']) {
  const row = chatRows.find((m) => m.id === id);
  if (!row) continue;
  assert.equal(transcribe.kindForModel(row), 'openai-audio',
    id + ' is one of the audio-in chat models the chat route exists for');
}
assert.ok(sttRows.some((m) => m.id === 'mistralai/voxtral-small-24b-2507-stt'),
  'the speech-to-text sibling of the voxtral chat model is in the transcription slice');

// The Google chat models are the reason this test grew a second half. They are
// filed upstream under `output_modalities: ["text"]`, so the transcription slice
// never lists them — reading only that slice is what left the dictation picker
// with no Google chat model at all.
const googleChatAudio = audioChatRows.filter((m) => /^google\//.test(m.id) && !m.id.endsWith(':batch'));
if (googleChatAudio.length) {
  assert.ok(googleChatAudio.every((m) => transcribe.kindForModel(m) === 'openai-audio'),
    'every Google chat model that can hear is dictated with over the chat route');
  assert.ok(!sttRows.some((m) => /^google\/gemini/.test(m.id)),
    'and none of them is in the transcription slice, which is why the chat slice is read too');
}

// ---- The transcription slice is what dictation may offer ----------------

const candidates = transcribe.transcriptionCandidates(sttRows);
assert.deepEqual(candidates.map((c) => c.id), sttRows.map((c) => c.id),
  'every row of the transcription slice is offered, and the fallback does not narrow it');
const nonGoogle = candidates.filter((c) => !/^google\//.test(c.id));
assert.ok(nonGoogle.length > candidates.length / 2,
  'the list does not read as "only Google models": '
  + candidates.length + ' candidates, ' + nonGoogle.length + ' of them not Google');
for (const c of candidates) {
  assert.ok(c.outputModalities.includes('transcription'),
    c.id + ' was offered without the provider reporting that it transcribes');
}

// ---- The transport is the connection, never the id ----------------------

// `google/chirp-3` on OpenRouter is served by /audio/transcriptions, not by
// Gemini's per-model generateContent path — a URL that cannot exist there.
assert.equal(transcribe.kindForModel(sttRows.find((m) => m.id === 'google/chirp-3')), 'openai-compatible',
  'a google/-namespaced row behind an OpenAI-shaped connection keeps that shape');
for (const m of sttRows) {
  assert.equal(transcribe.kindForModel(m), 'openai-compatible',
    m.id + ' is reached through the OpenRouter connection, so it is multipart, not Gemini');
}

// ---- The family classification is not substring-based --------------------

for (const m of chatRows) {
  if (!/^google\//.test(m.id) && m.id !== 'gemini' && m.provider !== 'gemini') {
    assert.equal(transcribe.kindForModel(m), transcribe.kindForModel({ ...m, id: m.id.replace(/gemini/gi, 'zzz') }),
      m.id + ' must not change family because its name contains "gemini"');
  }
}

// A regression guard on the exact failure: at least one row in the real
// catalog contains "gemini" without being addressable as a Gemini model.
const lookalikes = chatRows.filter((m) => /gemini/i.test(m.id) && !/^google\//.test(m.id));
if (lookalikes.length) {
  for (const m of lookalikes) {
    assert.notEqual(transcribe.kindForModel(m), 'gemini',
      m.id + ' only *looks* like a Gemini model; classifying it as one sends it to the wrong endpoint');
  }
  console.log('  (' + lookalikes.length + ' gemini-lookalike id(s) in the live catalog: '
    + lookalikes.slice(0, 3).map((m) => m.id).join(', ') + ')');
}

const googleCount = candidates.filter((c) => /^google\//.test(c.id)).length;
// The two slices are read together for dictation now, so the summary reports
// both: the chat slice's audio-input rows are candidates too, over the chat
// route.
const chatCandidates = chatRows.filter(transcribe.isTranscriptionModel);
const chatAudioRoute = chatCandidates.filter((m) => transcribe.kindForModel(m) === 'openai-audio').length;
console.log('PASS openrouter catalog: ' + sttRows.length + ' transcription models -> ' + candidates.length
  + ' candidates (' + googleCount + ' google, ' + nonGoogle.length + ' other) over /audio/transcriptions, '
  + 'plus ' + chatAudioRoute + ' of the ' + chatRows.length + ' chat models over /chat/completions'
  + ' (the audio-input ones, which the transcription slice never lists), modality signals carried through');
