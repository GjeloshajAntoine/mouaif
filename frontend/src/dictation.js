// mouaif web — Dictation helpers (recorder + transcription client)
//
// The browser half of dictation: what the MediaRecorder can actually produce,
// how long a recording is, and the one API call that turns bytes into text.
// Everything here is either pure or a thin fetch wrapper, so the two surfaces
// that dictate — the dictation page and the chat composer's mic button — share
// one implementation and `scripts/test-dictation.js` can exercise it without a
// browser.
//
// The audio never reaches a provider directly: recording is local, and the
// bytes are POSTed as base64 to `/api/ai/transcribe`, which holds the
// credential and performs the upstream call (docs/decisions.md section 10).

import { fetchJson } from './api.js';
import { formatCost } from './usage.js';

// ---- Recorder capabilities ---------------------------------------------

// CANDIDATE_TYPES — MediaRecorder mime types, best first. Opus-in-WebM is
// what every Chromium browser records and what the OpenAI-shaped
// transcription endpoints accept; Firefox records Ogg/Opus; Safari records
// MP4/AAC and rejects the other two. The list is probed in order and the
// first supported one wins, so the recorder never has to be told what this
// device does.
export const CANDIDATE_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg'
];

// recorderSupported(win) — true when this browser can capture audio at all.
// `win` defaults to the real window; tests pass a stub.
export function recorderSupported(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w) return false;
  const Recorder = w.MediaRecorder;
  if (typeof Recorder !== 'function') return false;
  if (!w.navigator || !w.navigator.mediaDevices) return false;
  return typeof w.navigator.mediaDevices.getUserMedia === 'function';
}

// pickRecorderMime(recorderType, win) — the first candidate the browser
// reports as recordable, or '' to let the browser choose its own default.
// `isEmpty: true` (no candidate worked) is not an error: MediaRecorder is
// allowed to pick a format it likes, and `blob.type` tells us afterwards what
// it actually produced.
export function pickRecorderMime(recorderType, win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  const Recorder = recorderType || (w && w.MediaRecorder);
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return '';
  for (const type of CANDIDATE_TYPES) {
    try {
      if (Recorder.isTypeSupported(type)) return type;
    } catch { /* a stub that throws means "not supported" */ }
  }
  return '';
}

// extensionForMime(mime) — the file name extension sent to the provider. The
// multipart field is named `file`, and providers sniff the bytes, but a name
// whose extension disagrees with the container makes some of them refuse the
// upload outright.
export function extensionForMime(mime) {
  const type = String(mime || '').toLowerCase();
  if (type.includes('webm')) return '.webm';
  if (type.includes('ogg')) return '.ogg';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return '.m4a';
  if (type.includes('mpeg') || type.includes('mp3')) return '.mp3';
  if (type.includes('wav')) return '.wav';
  if (type.includes('flac')) return '.flac';
  return '.webm';
}

// dictationFilename(mime, at) — a stable, provider-readable upload name. The
// timestamp is passed in (not read from the clock) so this stays pure.
export function dictationFilename(mime, at) {
  const stamp = new Date(at || 0).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return 'dictation-' + stamp + extensionForMime(mime);
}

// formatDuration(ms) — the recorder's clock, m:ss (with an hours field only
// once it is earned). Deliberately not a `XX:XX` timer: the leading segment
// is minutes, so a 2-second note reads "0:02".
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  if (hours) return hours + ':' + pad(minutes) + ':' + pad(seconds);
  return minutes + ':' + pad(seconds);
}

// MAX_RECORDING_MS — two minutes. Long enough for a paragraph dictated at
// speaking speed, short enough that the base64 body stays well inside the
// server's cap and the provider's own upload limit. The page stops recording
// at this point instead of silently dropping the tail.
export const MAX_RECORDING_MS = 120000;

// ---- Bytes → base64 ----------------------------------------------------

// blobToBase64(blob) — the wire encoding for POST /api/ai/transcribe. Uses
// FileReader when the browser has it (a straight read, no main-thread copy of
// every byte) and falls back to ArrayBuffer + btoa for workers and tests.
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    if (!blob) { reject(new Error('Nothing recorded')); return; }
    if (typeof FileReader === 'function') {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the recording'));
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(blob);
      return;
    }
    if (typeof blob.arrayBuffer !== 'function') { reject(new Error('This browser cannot read the recording')); return; }
    blob.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      resolve(btoa(binary));
    }).catch(() => reject(new Error('Could not read the recording')));
  });
}

// ---- Transcription client ----------------------------------------------

// transcribeAudio(options) -> { text, model, kind, bytes, durationMs, usage, cost }
//
// options: { projectDir, modelId, providerId, kind, audioBase64, mimeType,
//            filename, language, prompt, chatId }
//
// `kind` is the request family the catalog offered the row under (the picker's
// "Sends as" read-out). It is echoed back so the request cannot disagree with
// what the user was shown: the server re-derives it from the live capability
// report, but a row the catalog classified is authoritative. An empty value
// leaves the decision to the server.
//
// `chatId` is optional and is what makes the run *attributed*: the composer
// microphone sends it, so the server adds the priced run to that chat's Total
// and to the project total (it is not a chat turn, so no message is written).
// The Dictation page sends none — its runs are point-of-use only.
//
// `usage` is the provider's own token report (null when it made none) and
// `cost` is the server's priced result for it, in the shape
// `transcribeCost()` formats; the browser never resolves pricing itself.
//
// Throws an Error carrying `.code` (the server's typed code) and `.status`,
// so the caller can tell "pick a model" apart from "the key was rejected"
// without string-matching the message.
export async function transcribeAudio(options) {
  const opts = options || {};
  const body = {
    projectDir: opts.projectDir || '',
    modelId: opts.modelId || '',
    providerId: opts.providerId || '',
    // The family the row was offered under, so the picker's read-out is what
    // the request does. The server ignores an unknown value and re-derives.
    kind: opts.kind || '',
    audioBase64: opts.audioBase64 || '',
    // A blob with no type reports ''; the server falls back to
    // application/octet-stream and the extension carries the container.
    mimeType: opts.mimeType || 'audio/webm',
    filename: opts.filename || '',
    language: opts.language || '',
    prompt: opts.prompt || '',
    // A chat-attributed run joins that chat's persisted Total. Empty for the
    // dictation page, whose runs belong to no chat.
    chatId: opts.chatId || ''
  };
  const r = await fetchJson('/api/ai/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status !== 200) {
    const err = new Error((r.body && r.body.error) || ('HTTP ' + r.status));
    err.code = (r.body && r.body.code) || 'EHTTP';
    err.status = r.status;
    throw err;
  }
  return r.body || {};
}

// ---- Live (as-you-speak) transcription ---------------------------------
//
// The composer's microphone can send audio *while* the user is still talking:
// the take is cut into segments, each completed segment is POSTed to the same
// `/api/ai/transcribe`, and the answers are stitched into one transcript that
// lands in the draft as it grows. Three facts shape the helpers below and the
// component that uses them:
//
//   * a segment is a *complete recording* — the browser's own muxer writes it,
//     container header and all — so it is the same kind of upload a take from
//     the dictation page produces. `createSegmentRecorder` is what produces
//     that, and its header explains why a timeslice cannot: only the first
//     timeslice is ever a file, which is why a chat take transcribed far worse
//     than the same words on the page;
//   * a segment is transcribed as if it were a whole recording, so the
//     transcript is the concatenation of the segments, in the order the audio
//     was spoken, which is why the component keeps one slot per segment index
//     instead of pushing results as they land (two in-flight segments can
//     finish out of order);
//   * the words at a boundary are the ones no single request heard whole.
//     Consecutive results from one microphone often share them (the model
//     hears the boundary from both sides), so the join drops a repeated
//     prefix/suffix before appending.

// LIVE_CHUNK_MS — how much audio one live request carries. Three seconds is a
// compromise the provider catalogue forces: a segment is standalone, so it has
// to be long enough to hold a couple of words with context and short enough
// that the model does not tidy up a sentence across the gap — while still
// short enough that the draft grows as the user speaks. `MAX_RECORDING_MS`
// caps the take at two minutes, so this is at most ~40 requests.
export const LIVE_CHUNK_MS = 3000;

// MIC_WAIT_DELAY_MS — how long a tap waits before it admits it is *preparing*.
//
// The composer mic resolves its model in two reads before the microphone opens,
// and on a normal connection both are answered in a few milliseconds — so
// `Preparing dictation…` used to be written and wiped on every single tap
// without ever being readable: a loading state that shows but is never useful.
// The wait is still real (a cold provider catalog is a round trip per
// connection), so it is not dropped — after this delay the button reports it,
// and a tap that is already through it never flashes the spinner at all. The
// state is decidable from values alone, so `micWaitPhase` owns it and the
// fixture that slows the reads down watches it (scripts/test-dictation-chat.cjs).
export const MIC_WAIT_DELAY_MS = 400;

// LIVE_OVERLAP_WORDS — the shortest repeated run, in words, that is treated as
// a seam between two chunks rather than as the speaker genuinely repeating
// themselves. One: contiguous timeslices are transcribed as separate
// recordings, so the word at the boundary is routinely written twice ("… the
// note" / "note is saved"), and that artifact is far more common than a
// deliberate repetition that happens to straddle a boundary — which loses one
// copy of itself, and can be typed back.
export const LIVE_OVERLAP_WORDS = 1;

// matchWords(text) — every word in a segment with where it sits, so a seam can
// be matched word-aligned while the text written back stays exactly what the
// provider returned. Punctuation is not part of a word (`three,` matches
// `three`), and digits and inner apostrophes are (`don't`, `2:30` → `2`, `30`).
function matchWords(text) {
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  const out = [];
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    out.push({ word: match[0].toLowerCase(), end: match.index + match[0].length });
  }
  return out;
}

// seamOverlap(previous, next) — how many characters at the start of `next`
// repeat the end of `previous`, or 0 when nothing does.
//
// Longest run first: every word-run that ends `previous` and opens `next` is a
// candidate, and the longest one (≥ `LIVE_OVERLAP_WORDS`) wins, so
// "…save the note" / "the note is saved" drops `the note`, not just `note`.
// The returned count is a *character* offset into `next` — everything up to
// the end of the last matched word — so the caller can splice the raw provider
// text rather than a normalised copy of it.
export function seamOverlap(previous, next) {
  const prevWords = matchWords(previous).map((w) => w.word);
  const nextWords = matchWords(next);
  const max = Math.min(prevWords.length, nextWords.length);
  for (let size = max; size >= LIVE_OVERLAP_WORDS; size--) {
    let same = true;
    for (let i = 0; i < size; i++) {
      if (prevWords[prevWords.length - size + i] !== nextWords[i].word) { same = false; break; }
    }
    if (same) return nextWords[size - 1].end;
  }
  return 0;
}

// joinTranscript(segments) — the transcript built from a take's segments.
//
// Empty entries are skipped: a chunk the model heard as silence, and a slot
// whose result has not arrived yet, both contribute nothing. Each remaining
// segment is appended after dropping a seam it repeats, and the result is a
// plain function of the list — so recomputing it after every arriving chunk
// can never make the draft drift or double up.
export function joinTranscript(segments) {
  const list = Array.isArray(segments) ? segments : [];
  let out = '';
  for (const raw of list) {
    const text = String(raw || '').trim();
    if (!text) continue;
    if (!out) { out = text; continue; }
    const overlap = seamOverlap(out, text);
    // Past a seam the separators between the two segments are ours, not the
    // provider's: `… the note` + `is saved` reads as one sentence.
    const rest = overlap ? text.slice(overlap).replace(/^[\s\p{P}]+/u, '') : text;
    if (rest) out += ' ' + rest;
  }
  return out;
}

// liveTakeCost(costs) -> { total, currency, known } | null
//
// A live take is billed once per chunk, so the take's price is the sum of the
// prices its chunks were answered with. Only *known* figures count — an
// unpriced chunk (a per-minute model reports no tokens) contributes nothing
// rather than a fabricated zero — and a take whose chunks were all unpriced
// returns `null`, which is the same "say nothing rather than `$0.00`"
// convention `transcribeCost` renders as `--`. Pure, so the arithmetic is
// decided from values alone and can be asserted without a recorder.
export function liveTakeCost(costs) {
  const list = Array.isArray(costs) ? costs : [];
  let total = 0;
  let known = false;
  for (const cost of list) {
    if (!cost || cost.known !== true) continue;
    const amount = Number(cost.total);
    if (!isFinite(amount) || amount <= 0) continue;
    total += amount;
    known = true;
  }
  return known ? { total, currency: 'USD', known: true } : null;
}

// liveDictationEnabled(saved) — whether a take should be transcribed as the
// user speaks rather than on stop. Read from the app-level `dictation` key the
// dictation page owns (the same record the model choice comes from), default
// **on**: live dictation is what a user expects from a microphone button, and
// the page's switch is there for the setups that cannot afford a request every
// few seconds (a per-minute model, a metered link) or that reject chunked
// audio outright.
export function liveDictationEnabled(saved) {
const rec = saved || {};
return rec.live !== false;
}
// createLiveSegments() — the transcript slots for one take, as data.
//
// Exported and separate from the button so the ordering rules can be tested
// without a recorder. The store owes its caller exactly one thing: the text
// that belongs in the draft now, in speaking order, with each chunk's result
// kept under the index the recorder wrote it in — a chunk that lands after a
// later one must never be appended at the end.
//
//   const take = createLiveSegments();
//   take.set(0, 'first words');
//   take.set(2, 'third words');   // chunk 1 is still in flight
//   take.set(1, 'second words');
//   take.text() === 'first words second words third words'
export function createLiveSegments() {
const slots = new Map();
return {
set(index, text) {
slots.set(Number(index) || 0, String(text || '').trim());
},
text() {
const order = Array.from(slots.keys()).sort((a, b) => a - b);
return joinTranscript(order.map((key) => slots.get(key)));
},
// pending(issued) — how many chunks were sent but have not been answered.
// The caller counts what it sent; the store counts what came back, and the
// difference is what keeps a take from being closed with its last words
// still in flight.
pending(issued) {
return Math.max(0, (Number(issued) || 0) - slots.size);
},
// answered() — how many chunks came back at all. Callers that must not save
// an empty draft check this rather than `text()`.
answered() {
return slots.size;
}
};
}

// createSegmentRecorder(options) -> { start(), stop(), recording() }
//
// The recorder half of a live take: one MediaRecorder at a time on one stream,
// rotated so that **every segment handed over is a file**.
//
//   * `onSegment(blob, mimeType)` — one complete recording, in speaking order.
//     Called for every rotation, and once more when the take ends, so the
//     segment in progress is never dropped.
//   * `onEnd()` — the take is over: no further `onSegment` can arrive.
//   * `onError(event)` — the recorder failed; whatever it captured has already
//     been handed over, and the caller owns the wording of the failure.
//
// Why not `MediaRecorder.start(LIVE_CHUNK_MS)`: a timeslice cuts the *byte
// stream* at whatever offset the flush happens to land on. Only the first
// slice carries the container header, so every later slice is a fragment —
// measured in Chrome, slice 0 of a WebM take starts with the EBML magic
// `1a 45 df a3`, slice 1 starts with the size field of a block whose element
// id was the previous slice's last byte, and a boundary can fall anywhere at
// all. A fragment is not a container: the decoder gets no header, no tracks
// and no timestamps, so the provider answers with an error, with nothing, or
// with something invented. That is why a live take used to transcribe far
// worse in the composer than the same words on the dictation page — only the
// take's first ~3 s were ever a valid recording.
//
// Rotating costs a boundary and buys a decodable file in whatever container
// this browser records (WebM/Opus, Ogg/Opus, MP4/AAC): measured in Chrome, the
// next recorder is capturing within ~2 ms of the previous one's last audio
// block, and each segment carries its full `segmentMs` of audio. The provider
// still restarts its context at every segment, which is what the seam rule in
// `joinTranscript` is for.
//
// Everything it needs from the environment is injected — the constructor, the
// timers, the Blob factory — so the rotation can be tested without a browser
// and without waiting three seconds.
export function createSegmentRecorder(options) {
const o = options || {};
const Recorder = o.recorder;
const setTimer = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
const clearTimer = o.clearTimeout || ((timer) => clearTimeout(timer));
const wait = Number(o.segmentMs) > 0 ? Number(o.segmentMs) : LIVE_CHUNK_MS;
// The container the recorder was asked for. Cleared when the constructor
// rejects it, so the retry (and every later segment) lets the browser choose.
let mimeType = o.mimeType || '';
let current = null;
let parts = [];
let timer = null;
// `active` is the caller's intent, not the recorder's state: a rotation runs
// while it stays true, and turning it false is what makes the segment in
// progress the last one.
let active = false;
function makeBlob(chunks, type) {
if (o.createBlob) return o.createBlob(chunks, type);
return new Blob(chunks, { type });
}
function typeOf(recorder) {
return recorder.mimeType || mimeType || 'audio/webm';
}
// build() — a recorder wired to this take, remembering what it is given. The
// container we ask for is a preference, never a requirement: a browser that
// rejects it records its own default, and the type follows what it did.
function build() {
let recorder;
try {
recorder = mimeType ? new Recorder(o.stream, { mimeType }) : new Recorder(o.stream);
} catch {
mimeType = '';
recorder = new Recorder(o.stream);
}
parts = [];
recorder.ondataavailable = (event) => {
if (event && event.data && event.data.size) parts.push(event.data);
};
recorder.onstop = () => hand(recorder, typeOf(recorder));
recorder.onerror = (event) => fail(recorder, typeOf(recorder), event);
return recorder;
}
// hand(recorder, type) — hand this recorder's audio over, then either start the
// next segment (the take is still running) or report the end of the take.
function hand(recorder, type) {
const chunks = parts;
parts = [];
if (current === recorder) current = null;
if (timer) { clearTimer(timer); timer = null; }
if (chunks.length && o.onSegment) o.onSegment(makeBlob(chunks, type), type);
if (active) { begin(); return; }
if (o.onEnd) o.onEnd();
}
function fail(recorder, type, event) {
// A recorder error ends the take: what it did capture is still worth sending,
// which is what `hand` does before `onEnd` reports the take as finished.
active = false;
hand(recorder, type);
if (o.onError) o.onError(event || new Error('The recorder stopped unexpectedly.'));
}
function rotate() {
timer = null;
const recorder = current;
if (!recorder || recorder.state === 'inactive') return;
try { recorder.stop(); } catch { /* already stopping */ }
}
function begin() {
current = build();
timer = setTimer(rotate, wait);
current.start();
}
return {
start() {
if (active || !Recorder) return;
active = true;
begin();
},
// stop() — end the take. `active` is cleared *before* the recorder is stopped,
// so the segment that comes back is the last one whether the browser delivers
// `onstop` on a later task (it does) or inside `stop()` itself.
stop() {
if (!active) return;
active = false;
if (timer) { clearTimer(timer); timer = null; }
const recorder = current;
if (!recorder) { if (o.onEnd) o.onEnd(); return; }
try { recorder.stop(); } catch { hand(recorder, typeOf(recorder)); }
},
// recording() — whether a take is open. Read by the caller's unmount path and
// by the tests; the button tracks how it should look by itself.
recording() {
return active;
}
};
}


// loadDictationModels(projectDir, opts) -> { models, kinds, total, providers, liveFailures }
//
// `models` is what this project can dictate with: the project's own model
// records plus the connected providers' live catalogs, each entry already
// carrying the request family (`kind`) it will use, whether a provider
// connection exists for it (`connected`), and which of the two it came from
// (`source`: 'project' | 'live'). `kinds` is the family list the page's shape
// control renders.
//
// opts.live === false skips the live catalogs (a faster paint); opts.refresh
// forces them even when the server has a cached copy.
//
// A failure resolves to an empty list instead of throwing: the dictation
// page's first paint must not depend on a settings read.
export async function loadDictationModels(projectDir, opts) {
  const options = opts || {};
  const query = new URLSearchParams({ projectDir: projectDir || '' });
  if (options.live === false) query.set('live', '0');
  if (options.refresh) query.set('refresh', '1');
  const r = await fetchJson('/api/ai/transcribe/models?' + query.toString());
  if (r.status !== 200) return { models: [], kinds: [], total: 0, providers: [], liveFailures: [], error: r.body };
  return {
    models: Array.isArray(r.body && r.body.models) ? r.body.models : [],
    kinds: Array.isArray(r.body && r.body.kinds) ? r.body.kinds : [],
    total: (r.body && r.body.total) || 0,
    providers: Array.isArray(r.body && r.body.providers) ? r.body.providers : [],
    liveFailures: Array.isArray(r.body && r.body.liveFailures) ? r.body.liveFailures : []
  };
}

// kindLabel(kinds, id) — the human label for a family id, for the model rows.
// Unknown ids are shown as-is rather than hidden.
export function kindLabel(kinds, id) {
  const found = (kinds || []).find((k) => k && k.id === id);
  return found ? found.label : (id || '');
}

// kindShortLabel(id) — the two-word form for a chip on a narrow phone, where
// the full `OpenAI-compatible (multipart /audio/transcriptions)` label would
// wrap to three lines.
export function kindShortLabel(id) {
  if (id === 'gemini') return 'Gemini';
  if (id === 'openai-audio') return 'OpenAI chat';
  if (id === 'openai-compatible') return 'OpenAI-shaped';
  return id || 'unknown';
}

// ---- Which model to dictate with -----------------------------------------
//
// Choosing a dictation model is a different problem from choosing a chat
// model: a chat catalog is full of rows that cannot transcribe at all, and a
// provider's live list can carry hundreds of them. The server already decides
// what is *offered* (src/transcribe.js), but what is offered is still a flat
// list rendered provider by provider, alphabetically — so these three helpers
// decide what to show first and what to select before the user has said
// anything.

// DICTATION_ID_HINTS — model ids that say "I transcribe". Deliberately the
// same short list the server filters on (src/transcribe.js OPENAI_MODEL_HINTS)
// so the picker cannot recommend something the catalog would not have offered.
const DICTATION_ID_HINTS = ['whisper', 'transcribe', 'transcription', 'voxtral', 'parakeet'];

// acceptsAudioInput(row) — the provider reported audio among the model's input
// modalities (OpenRouter's `architecture.input_modalities`). Absent means
// "unknown", never "no".
export function acceptsAudioInput(row) {
  const list = row && row.inputModalities;
  return Array.isArray(list) && list.some((x) => String(x).toLowerCase() === 'audio');
}

// reportsTranscription(row) — the provider reported `transcription` among the
// model's output modalities. This is the strongest signal there is: the row's
// job *is* speech-to-text (`openai/whisper-1`, `google/chirp-3`, …), and it is
// what the server offers the dictation slice for. The mirror image matters
// just as much — a reported output list without `transcription` means the row
// is a chat model that merely takes audio, and the server's catalog leaves
// those out.
export function reportsTranscription(row) {
  const list = row && row.outputModalities;
  return Array.isArray(list) && list.some((x) => String(x).toLowerCase() === 'transcription');
}

// dictationRank(row) — how good a dictation model a row looks like, strongest
// signal first:
//
//   3 — the provider reports `transcription` output, or the name says it
//       (`whisper-large-v3`, `voxtral-mini`, `parakeet`);
//   2 — it takes audio, or it is a Gemini model (there is no separate Gemini
//       speech-to-text product: audio is an inline part on the general models);
//   1 — the user wrote the record themselves, so it is intentional even when
//       the name says nothing (`my-self-hosted-asr`);
//   0 — it is only here because a project with nothing recognisable gets
//       everything rather than nothing.
//
// This is a *display* rank. It never decides what is addressable: the server's
// `kind` still owns the transport.
export function dictationRank(row) {
  if (!row) return 0;
  const id = String(row.id || '').toLowerCase();
  if (reportsTranscription(row) || DICTATION_ID_HINTS.some((hint) => id.includes(hint))) return 3;
  if (row.kind === 'gemini' || acceptsAudioInput(row)) return 2;
  if (row.source === 'project') return 1;
  return 0;
}

// recommendedModels(models, limit) -> rows, best first, capped
//
// What the picker shows under a "Recommended" heading. Rank-3 rows when there
// are any, because the provider telling us the model's output is a transcript
// — or a name that says so — is worth more than any guess: when the catalog
// has none of those (a Gemini-only setup, or a provider that reports neither
// names nor outputs), the audio-capable rows are the best signal left. Ties
// keep the catalog's own order — the project's own records come first from the
// server.
export function recommendedModels(models, limit) {
const max = limit || 5;
const ranked = (Array.isArray(models) ? models : [])
.map((row, index) => ({ row, index, rank: dictationRank(row) }))
.filter((entry) => entry.rank >= 2)
.sort((a, b) => (b.rank - a.rank) || (a.index - b.index));
const strong = ranked.filter((entry) => entry.rank >= 3);
const worth = strong.length ? strong : ranked;
return worth.slice(0, max).map((entry) => entry.row);
}

// resolveDefaultModel(models, saved) -> { modelId, providerId } | null
//
// Which model a surface should dictate with before the user has picked one in
// this session, in order:
//
//   1. the remembered `{ modelId, providerId }`, if it is still in the list
//      (a deleted or renamed model must not be sent to the server);
//   2. the only model on offer — with one candidate there is no decision to
//      make, and demanding one is a dead end;
//   3. otherwise nothing, and the picker is the user's first step.
//
// Returning `null` rather than a guess is deliberate: sending a chat model to a
// transcription endpoint produces a provider error, which is a worse first
// experience than an empty picker with a "pick a model" placeholder.
export function resolveDefaultModel(models, saved) {
const list = Array.isArray(models) ? models : [];
const want = saved || {};
if (want.modelId) {
const exact = list.find((m) => m && m.id === want.modelId && (m.provider || '') === (want.providerId || ''));
const byId = exact || list.find((m) => m && m.id === want.modelId);
if (byId) return { modelId: byId.id, providerId: byId.provider || '' };
}
if (list.length === 1) return { modelId: list[0].id, providerId: list[0].provider || '' };
return null;
}

// defaultDictationModel(models, saved) -> { modelId, providerId } | null
//
// The two surfaces' one entry point: `resolveDefaultModel`, plus one more step
// that is only safe for dictation — when exactly one row's name says it
// transcribes and nothing else does, adopting it is not a decision, it is a
// suggestion the user can override in one tap. Two `whisper-*` rows from two
// providers (or none) still leaves the picker asking, because a wrong guess
// here is a provider error rather than a cosmetic surprise.
export function defaultDictationModel(models, saved) {
const rows = Array.isArray(models) ? models : [];
const remembered = resolveDefaultModel(rows, saved);
if (remembered) return remembered;
const strong = rows.filter((row) => dictationRank(row) >= 3);
if (strong.length === 1) return { modelId: strong[0].id, providerId: strong[0].provider || '' };
return null;
}

// pickerModels(models) — the rows reshaped for <ModelPickerField>: the picker
// needs { id, provider, label } and keys a selection on provider+id, which is
// exactly the pair the transcribe endpoint needs.
//
// The picker renders `label` as the row's second line under the id, so it gets
// whichever of the two is more informative: a real display name when the
// provider gave one (`Whisper large v3`), otherwise the badge explaining why
// the row is here (`from provider · audio in`). A live OpenRouter row's label
// is just its slug repeated, which is why it does not win.
export function pickerModels(models) {
  return (Array.isArray(models) ? models : []).map((m) => ({
    id: m.id,
    provider: m.provider || '',
    label: (m.label && m.label !== m.id) ? m.label : modelBadge(m)
  }));
}

// catalogNote(state) -> { text, loading }
//
// The read-out under the model picker: what is on offer, or what is still on
// its way. The page reads its catalog in two passes of very different cost — a
// project settings lookup, then a round trip per connected provider (memoized
// an hour server-side) — so "still loading" is a state the page genuinely
// spends time in, and it is the state the old inline expression got wrong: on
// the first paint `models` is empty and the note claimed **No models**, which
// is the one conclusion a request that has not answered yet must not invite.
//
// `loading` is what the page turns into a spinner and an `aria-busy` group, so
// the same fact reaches a screen reader as reaches the eye. The text is built
// here, out of the render body, because it is decided from values alone.
//
//   { catalogBusy, liveBusy, projectCount, hasLive }
export function catalogNote(state) {
const s = state || {};
if (s.catalogBusy) return { text: 'Loading models…', loading: true };
if (s.liveBusy) return { text: 'Looking for models from your providers…', loading: true };
const projectCount = Number(s.projectCount) || 0;
const hasLive = !!s.hasLive;
if (projectCount) {
return {
text: projectCount + (projectCount === 1 ? ' project model' : ' project models')
+ (hasLive ? ', plus models from your provider' : ''),
loading: false
};
}
return { text: hasLive ? 'Models from your provider connections' : 'No models', loading: false };
}

// busyPhase(state) -> '' | 'catalog' | 'live' | 'transcribe' | 'handoff'
//
// Which of the page's four waits is in flight, as one word. The page has one
// `busy` flag for the two request-shaped waits (a transcription and the
// transcript hand-off to a chat) because both must block the same taps, but
// they are different things to *report*: a spinner on the Transcribe button
// for a run that is actually filling a chat's draft would name the wrong
// operation. A long-lived wait (the catalog) wins over a short one, because it
// is the one the user is looking at the page to resolve.
//
// Returns '' when nothing is in flight, which is what every loading affordance
// is rendered from — nothing here reads a timer or a DOM.
export function busyPhase(state) {
const s = state || {};
if (s.catalogBusy) return 'catalog';
if (s.liveBusy) return 'live';
if (s.transcribing) return 'transcribe';
if (s.handoff) return 'handoff';
return '';
}

// micWaitPhase(state) -> 'prepare' | 'transcribe' | ''
//
// Which wait the *composer microphone* is in, and therefore which one it
// reports. The button's one wait today is the model resolve (`preparing`),
// which happens before the microphone opens; a pending segment of a live take
// (`transcribing`) will read here too once it has something to say, so the
// two decisions cannot drift apart. A tap that is *both* reports the resolve —
// no transcription can be in flight before one has been resolved.
//
// `preparing` is deliberately the delayed half of the resolve: the reads are
// two requests and normally answer in milliseconds, so reporting them
// unconditionally is how the spinner ended up flashing on every tap and never
// being readable. `delayMs` is how long the caller has been resolving, and
// `MIC_WAIT_DELAY_MS` is the point past which the wait is worth a word. The
// value is passed in rather than read here, so the decision stays a pure
// function of its arguments (and testable without timers).
export function micWaitPhase(state) {
const s = state || {};
if (s.preparing && Number(s.delayMs) >= MIC_WAIT_DELAY_MS) return 'prepare';
if (s.transcribing) return 'transcribe';
return '';
}

// modelBadge(row) — the short reason a catalog row is on the list, used as the
// picker's second line when the model's name says nothing. Two cases are worth
// naming:
//
//   * 'from provider' — a live row is not a project model, so it disappears
//                       with the provider connection. A row the provider
//                       itself reports as producing transcripts needs nothing
//                       more than that;
//   * 'audio in'      — the provider reports audio input but the id reads like
//                       a chat model (`meta/muse-spark`), which is where the
//                       user would otherwise wonder why it is offered.
//
// An empty string means "nothing to add", and the picker falls back to showing
// the provider id.
export function modelBadge(row) {
  if (!row) return '';
  const audio = acceptsAudioInput(row);
  if (row.source === 'live') {
    return (audio && !reportsTranscription(row)) ? 'from provider · audio in' : 'from provider';
  }
  return '';
}

// transcribeCost(result) -> { known, total, label }
//
// What a transcription cost, as the two surfaces that report a run need it.
// `--` covers both unknowns — a model with no pricing record and a provider
// that reported no tokens (a per-minute model like `whisper-1` reports
// neither) — because the chat's cost line uses exactly that convention and a
// fabricated `$0.00` would claim the run was free.
//
// The number itself is computed server-side (src/usage.js) next to the same
// pricing table the chat prices with, so the page never has to know about
// pricing resolution; it only formats what it was handed.
export function transcribeCost(result) {
  const cost = result && result.cost;
  const total = cost ? Number(cost.total) : NaN;
  const known = !!(cost && cost.known) && isFinite(total) && total >= 0;
  return { known, total: known ? total : 0, label: known ? formatCost(total) : '--' };
}

// lastRunLine(run) -> string
//
// The one-line report under the transcript: what the last transcription used,
// how big the recording was, how long it took, and what it cost. Extracted
// from the page so the format is testable without a media recorder: the cost
// is the only number here the user cannot get back from anywhere else
// (a transcription is not a chat turn, so no chat or project total covers it),
// and it must read `--` rather than `$0.00` when the run was unpriced.
//
// `run`: { model: { id }, kind, bytes, durationMs, costLabel, usage }
export function lastRunLine(run) {
  const r = run || {};
  const parts = [
    (r.model && r.model.id) || 'unknown model',
    kindShortLabel(r.kind),
    Math.round((r.bytes || 0) / 1024) + ' kB',
    (Math.round((r.durationMs || 0) / 100) / 10) + 's',
    'cost ' + (r.costLabel || '--')
  ];
  return 'Last run: ' + parts.join(' · ');
}

// transcriptActions(props) — the taps offered under a transcript, as data.
//
// The page renders one chip per entry, in order, so the action set is
// testable without a DOM and the same set can be reused by any future
// surface (a share sheet, a queue).
//   { id, label, disabled }
export function transcriptActions(props) {
  const opts = props || {};
  const hasText = !!(opts.text && opts.text.trim());
  const actions = [
    { id: 'copy',   label: 'Copy',           disabled: !hasText },
    { id: 'insert', label: 'Insert in chat', disabled: !hasText || !opts.chatId },
    { id: 'send',   label: 'Send to chat',   disabled: !hasText || !opts.chatId },
    { id: 'clear',  label: 'Clear',          disabled: !hasText && !opts.hasRecording }
  ];
  return actions;
}
