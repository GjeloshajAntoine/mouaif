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
// options: { projectDir, modelId, providerId, audioBase64, mimeType,
//            filename, language, prompt }
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
    audioBase64: opts.audioBase64 || '',
    // A blob with no type reports ''; the server falls back to
    // application/octet-stream and the extension carries the container.
    mimeType: opts.mimeType || 'audio/webm',
    filename: opts.filename || '',
    language: opts.language || '',
    prompt: opts.prompt || ''
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

// dictationRank(row) — how good a dictation model a row looks like, strongest
// signal first:
//
//   3 — the name says it (`whisper-large-v3`, `voxtral-mini`, `parakeet`);
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
if (DICTATION_ID_HINTS.some((hint) => id.includes(hint))) return 3;
if (row.kind === 'gemini' || acceptsAudioInput(row)) return 2;
if (row.source === 'project') return 1;
return 0;
}

// recommendedModels(models, limit) -> rows, best first, capped
//
// What the picker shows under a "Recommended" heading. Rank-3 rows when there
// are any, because a name that says "whisper" is worth more than any guess:
// when the catalog has none of those (a Gemini-only or OpenRouter-only setup,
// where the names say nothing), the audio-capable rows are the best signal
// left. Ties keep the catalog's own order — the project's own records come
// first from the server.
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

// modelBadge(row) — the short reason a catalog row is on the list, used as the
// picker's second line when the model's name says nothing. Two cases are worth
// naming:
//
//   * 'from provider' — a live row is not a project model, so it disappears
//                       with the provider connection;
//   * 'audio in'      — the provider reports audio input but the id reads like
//                       a chat model (`openai/gpt-audio`, `meta/muse-spark`),
//                       which is exactly where the user would otherwise wonder
//                       why it is being offered at all.
//
// An empty string means "nothing to add", and the picker falls back to showing
// the provider id.
export function modelBadge(row) {
  if (!row) return '';
  const audio = Array.isArray(row.inputModalities)
    && row.inputModalities.some((x) => String(x).toLowerCase() === 'audio');
  if (row.source === 'live') return audio ? 'from provider · audio in' : 'from provider';
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
