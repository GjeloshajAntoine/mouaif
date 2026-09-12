// The dictation catalog against the *real* OpenRouter model list.
//
// This is the bug report, reproduced. The owner's report was "there's only
// Google models", and the cause was in the candidate filter: a loose
// `id.includes('gemini')` test classified dozens of Google-ish OpenRouter
// entries as Gemini models, and because the Gemini family is on the candidate
// list by definition, the filter kept little else — a 445-model catalog
// reduced to Google entries plus one Whisper.
//
// Run with no arguments: it skips unless it can reach OpenRouter (a sandbox
// without egress is a skip, not a failure). Pass `--record <file>` once to
// freeze a payload into a fixture so the assertions still run offline.
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

async function loadPayload() {
  const recordIndex = process.argv.indexOf('--record');
  if (recordIndex !== -1) {
    const target = process.argv[recordIndex + 1] || FIXTURE;
    const res = await fetch('https://openrouter.ai/api/v1/models');
    assert.equal(res.status, 200, 'OpenRouter answered ' + res.status);
    const json = await res.json();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(json));
    console.log('recorded ' + (json.data || []).length + ' models -> ' + target);
    return json;
  }
  if (fs.existsSync(FIXTURE)) return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/models');
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

const payload = await loadPayload();

// Parse through the real adapter, so this also covers the modality plumbing in
// src/ai-endpoints.js (OpenRouter's `architecture.input_modalities` is the only
// signal that identifies an audio model whose name says nothing).
const realFetch = global.fetch;
global.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
let models;
try {
  models = await ai.listModels('openrouter', 'fixture-key');
} finally {
  global.fetch = realFetch;
}
assert.ok(models.length > 100, 'expected a real catalog, got ' + models.length);

const rows = models.map((m) => Object.assign({}, m, { provider: 'openrouter' }));

// ---- The capability signal is carried through ---------------------------

const withModalities = rows.filter((m) => Array.isArray(m.inputModalities));
assert.ok(withModalities.length > 0,
  'the adapter must carry architecture.input_modalities through');
assert.ok(withModalities.some((m) => m.inputModalities.includes('audio')),
  'and audio must appear among them');

// ---- The filter is not Gemini-only --------------------------------------

const candidates = transcribe.transcriptionCandidates(rows);
assert.ok(candidates.length > 0, 'the catalog is not empty');

const nonGoogle = candidates.filter((c) => !/^google\//.test(c.id));
assert.ok(nonGoogle.length > 0,
  'non-Google models survive the filter, or the list reads as "only Google". Got: '
  + candidates.map((c) => c.id).join(', '));

// The specific shapes that carry audio capability without an audio-ish name.
for (const id of ['openai/gpt-audio', 'mistralai/voxtral-small-24b-2507']) {
  const hit = candidates.some((c) => c.id === id);
  if (rows.some((m) => m.id === id)) {
    assert.ok(hit, id + ' accepts audio input and must be offered');
  }
}

// Every candidate is either recognisable by name, marked, or reported as
// accepting audio. Nothing gets in on a substring accident.
for (const c of candidates) {
  const byName = /whisper|transcri|voxtral|parakeet/.test(c.id);
  const byModality = Array.isArray(c.inputModalities) && c.inputModalities.includes('audio');
  const byGemini = /^google\//.test(c.id);
  assert.ok(byName || byModality || byGemini,
    c.id + ' was kept without a name hint, an audio modality or a google/ prefix');
}

// ---- The family classification is not substring-based --------------------

for (const m of rows) {
  if (!/^google\//.test(m.id) && m.id !== 'gemini' && m.provider !== 'gemini') {
    assert.equal(transcribe.kindForModel(m), transcribe.kindForModel({ ...m, id: m.id.replace(/gemini/gi, 'zzz') }),
      m.id + ' must not change family because its name contains "gemini"');
  }
}

// A regression guard on the exact failure: at least one row in the real
// catalog contains "gemini" without being addressable as a Gemini model.
const lookalikes = rows.filter((m) => /gemini/i.test(m.id) && !/^google\//.test(m.id));
if (lookalikes.length) {
  for (const m of lookalikes) {
    assert.notEqual(transcribe.kindForModel(m), 'gemini',
      m.id + ' only *looks* like a Gemini model; classifying it as one sends it to the wrong endpoint');
  }
  console.log('  (' + lookalikes.length + ' gemini-lookalike id(s) in the live catalog: '
    + lookalikes.slice(0, 3).map((m) => m.id).join(', ') + ')');
}

const googleCount = candidates.filter((c) => /^google\//.test(c.id)).length;
console.log('PASS openrouter catalog: ' + models.length + ' models -> ' + candidates.length + ' candidates ('
  + googleCount + ' google, ' + nonGoogle.length + ' other), modality signal carried through');
