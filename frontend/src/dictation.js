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

// transcribeAudio(options) -> { text, model, kind, bytes, durationMs }
//
// options: { projectDir, modelId, providerId, audioBase64, mimeType,
//            filename, language, prompt }
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

// autoKindId(kinds, models) — which family the <select> should start on.
// The most common family among the project's dictation models wins, so a
// project with three Gemini models does not open on the OpenAI shape. The
// list of `kinds` decides the tie-break order (its own order, which puts the
// OpenAI family first).
export function autoKindId(kinds, models) {
  const ids = (kinds || []).map((k) => k && k.id).filter(Boolean);
  const counts = new Map();
  for (const model of (models || [])) {
    if (!model || !model.kind) continue;
    counts.set(model.kind, (counts.get(model.kind) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const id of ids) {
    const count = counts.get(id) || 0;
    if (count > bestCount) { best = id; bestCount = count; }
  }
  if (best) return best;
  if (ids.length && counts.size === 0) return ids[0];
  if (ids.length) return ids[0];
  return '';
}

// modelsForKind(models, kind) — the rows for the family currently selected.
// `kind === 'all'` (or empty) shows everything.
export function modelsForKind(models, kind) {
  const list = Array.isArray(models) ? models : [];
  if (!kind || kind === 'all') return list;
  return list.filter((m) => m && m.kind === kind);
}

// resolveDefaultModel(models, saved, kind) -> { modelId, providerId } | null
//
// Which model a surface should dictate with before the user has picked one in
// this session. In order:
//
//   1. the remembered `{ modelId, providerId }`, if it is still in the list
//      (a deleted or renamed model must not be sent to the server);
//   2. the only model in the family currently selected — with one candidate
//      there is no decision to make, and demanding one is a dead end;
//   3. otherwise nothing, and the picker is the user's first step.
//
// Returning `null` rather than a guess is deliberate: sending a chat model to a
// transcription endpoint produces a provider error, which is a worse first
// experience than an empty picker with a "pick a model" placeholder.
export function resolveDefaultModel(models, saved, kind) {
  const list = Array.isArray(models) ? models : [];
  const want = saved || {};
  if (want.modelId) {
    const exact = list.find((m) => m && m.id === want.modelId && (m.provider || '') === (want.providerId || ''));
    const byId = exact || list.find((m) => m && m.id === want.modelId);
    if (byId) return { modelId: byId.id, providerId: byId.provider || '' };
  }
  const family = modelsForKind(list, kind);
  if (family.length === 1) return { modelId: family[0].id, providerId: family[0].provider || '' };
  return null;
}

// pickerModels(models) — the rows reshaped for <ModelPickerField>: the picker
// needs { id, provider, label } and keys a selection on provider+id, which is
// exactly the pair the transcribe endpoint needs. `label` carries the row's
// origin for a live catalog entry, so the picker's second line says where the
// model came from instead of repeating the provider id.
export function pickerModels(models) {
  return (Array.isArray(models) ? models : []).map((m) => ({
    id: m.id,
    provider: m.provider || '',
    label: m.label || ''
  }));
}

// sourceLabel(row) — where a catalog row came from, for the picker's subtitle.
// A live row is not a project model, and saying so is what tells the user why
// it will disappear if the provider connection is removed.
export function sourceLabel(row) {
  if (row && row.source === 'live') return 'from provider';
  return '';
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
