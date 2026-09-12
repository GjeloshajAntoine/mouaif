// mouaif web — composer mic button (dictation in the chat view)
//
// A speech-to-text button that sits next to the image button. Tapping it
// starts dictation and a second tap stops it and transcribes: the text lands
// in the composer at the caret, so the user reviews it before sending.
// That two-tap shape is deliberate — auto-sending a machine transcript is the
// one thing a chat input must never do.
//
// Which model transcribes is *not* chosen here. The app-wide dictation choice
// (Settings-free, remembered in the app store under `dictation`, picked on the
// dictation page) is honoured the same way the chat picker remembers a model;
// tapping the button with nothing configured reports the reason in the chat's
// status row and points at the page. That check happens *before* the
// microphone opens, so the user is never asked to record a take that cannot be
// sent. One place decides, every surface obeys.
//
// The server owns the credential: this component records locally and POSTs
// base64 to /api/ai/transcribe (docs/decisions.md section 10).

import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { nav } from '../../router.js';
import {
  MAX_RECORDING_MS,
  blobToBase64,
  defaultDictationModel,
  dictationFilename,
  formatDuration,
  loadDictationModels,
  pickRecorderMime,
  recorderSupported,
  transcribeAudio,
  transcribeCost
} from '../../dictation.js';

// NO_MODEL_MESSAGE — the one wording for "nothing is configured", shared by the
// pre-flight check (a tap that cannot transcribe) and the transcribe fallback.
// It names the destination, because the chat's status row is the only place a
// phone user will read it. `dictationPageHint` owns the "where to go" half, so
// this copy and the exported hint cannot drift apart.
const NO_MODEL_MESSAGE = 'No dictation model yet — ' + dictationPageHint();

// rememberDictationChoice() — nothing to persist here: the page owns the
// remembered model. This button only reads it, so a user who dictates mostly
// in the chat never has to open the page after the first setup.
export function MicButton(props) {
const { language = '', onTranscript, onStatus } = props;
const [recording, setRecording] = useState(false);
const [status, setStatus] = useState('');
const [statusState, setStatusState] = useState('');
const [busy, setBusy] = useState(false);
const recorderRef = useRef(null);
const streamRef = useRef(null);
const chunksRef = useRef([]);
const stopTimerRef = useRef(null);
const startedAtRef = useRef(0);
// The model this take will be sent to, resolved before the microphone opens
// (see start()). Held in a ref so the recorder's onstop callback — registered
// when recording began — reads the row that was resolved for *this* take.
const modelRef = useRef(null);
// say(message, state) — report on both surfaces: the button (title and
// aria-label, which is all a sighted user gets on hover) and the chat's status
// row under the composer, which is the one line a phone can actually see.
// Before this reached the chat, a tap with nothing configured recorded,
// stopped, and then left the screen exactly as it was: the only report was a
// `title` no phone displays. See onStatus in Chat.jsx.
function say(message, state) {
setStatus(message || '');
setStatusState(state || '');
if (onStatus) onStatus(message || '', state || '');
}
// sayLocal(message, state) — the button's own line only. Used by the success
// branch, where the chat writes its own message ("dictation added" plus the
// run's cost) and must not be overwritten by a second wording of the same
// event.
function sayLocal(message, state) {
setStatus(message || '');
setStatusState(state || '');
}

  function releaseMic() {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream && typeof stream.getTracks === 'function') {
      for (const track of stream.getTracks()) { try { track.stop(); } catch { /* already stopped */ } }
    }
  }

  function clearStopTimer() {
    if (stopTimerRef.current) { clearTimeout(stopTimerRef.current); stopTimerRef.current = null; }
  }

  // Stop on unmount: navigating away with a live recorder would leave the
  // browser's recording indicator lit forever.
  useEffect(() => () => {
    clearStopTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* already stopped */ }
    }
    releaseMic();
  }, []);

  async function transcribe(blob, mime) {
  setBusy(true);
  say('Transcribing…', 'busy');
  try {
  // The row resolved when recording started; the fallback covers a take that
  // reached here without one (a caller that constructs the button differently).
  const match = modelRef.current || await resolveModel();
  if (!match) {
  say(NO_MODEL_MESSAGE, 'error');
  setBusy(false);
  return;
  }
      const audioBase64 = await blobToBase64(blob);
      const out = await transcribeAudio({
        projectDir: props.projectDir || '',
        modelId: match.id,
        providerId: match.provider || '',
        audioBase64,
        mimeType: mime,
        filename: dictationFilename(mime, startedAtRef.current),
        language
      });
      const text = (out.text || '').trim();
      if (!text) {
        say('Nothing was recognised — try again a little closer to the mic.', 'error');
        setBusy(false);
        return;
      }
      if (onTranscript) onTranscript(text, { model: out.model, kind: out.kind, usage: out.usage || null, cost: out.cost || null });
      // The chat's status row is the visible report (Chat.jsx writes
      // "dictation added" plus the cost there); this button's own line is the
      // tooltip/aria-label. Both stay quiet when the run is unpriced: a
      // `$0.00` would read as "free" for a per-minute model that simply does
      // not report tokens.
      //
      // The success wording is local-only on purpose: the chat has already
      // written its own line for the same event, and a second version of it
      // would replace the cost with a sentence.
      const label = transcribeCost(out).label;
      sayLocal(label === '--'
      ? 'Added to the composer — review it, then send.'
      : 'Added to the composer (' + label + ') — review it, then send.', 'success');
    } catch (e) {
      say((e && e.message) || 'Transcription failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  // resolveModel() — the row this take will be sent to.
  //
  // Model choice: the remembered app-level dictation choice if it is still in
  // this project's list, else the one candidate, else the single row whose name
  // says it transcribes. `defaultDictationModel` owns that order, so this button
  // and the dictation page cannot disagree about which model a tap uses.
  async function resolveModel() {
  const app = await fetchJson('/api/settings');
  const saved = (app.status === 200 && app.body && app.body.app && app.body.app.dictation) || {};
  const catalog = await loadDictationModels(props.projectDir || '');
  const picked = defaultDictationModel(catalog.models, saved);
  return picked
  ? catalog.models.find((m) => m.id === picked.modelId && (m.provider || '') === picked.providerId) || null
  : null;
  }
  async function start() {
  const win = typeof window !== 'undefined' ? window : null;
  if (!recorderSupported(win)) {
  say('This browser cannot record audio.', 'error');
  return;
  }
  // The model is resolved *before* the microphone opens: a take the app cannot
  // transcribe is a take the user should not be asked to record. `busy` is held
  // across the two reads so a double tap cannot start two recorders while the
  // catalog is in flight.
  setBusy(true);
  let match = null;
  try {
  match = await resolveModel();
  } catch (e) {
  setBusy(false);
  say((e && e.message) || 'Could not load the dictation model list.', 'error');
  return;
  }
  setBusy(false);
  if (!match) {
  say(NO_MODEL_MESSAGE, 'error');
  return;
  }
  modelRef.current = match;
  let stream;
    try {
      stream = await win.navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      say(e && e.name === 'NotAllowedError'
        ? 'Microphone permission was refused.'
        : 'Could not open the microphone.', 'error');
      return;
    }
    streamRef.current = stream;
    const mime = pickRecorderMime(win.MediaRecorder, win);
    let recorder;
    try {
      recorder = mime ? new win.MediaRecorder(stream, { mimeType: mime }) : new win.MediaRecorder(stream);
    } catch {
      try { recorder = new win.MediaRecorder(stream); } catch {
        releaseMic();
        say('Could not start the recorder.', 'error');
        return;
      }
    }
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event && event.data && event.data.size) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      clearStopTimer();
      const type = recorder.mimeType || mime || 'audio/webm';
      const blob = chunksRef.current.length ? new Blob(chunksRef.current, { type }) : null;
      chunksRef.current = [];
      recorderRef.current = null;
      releaseMic();
      setRecording(false);
      if (blob && blob.size) transcribe(blob, type);
      else say('Nothing was captured — check the microphone is not muted.', 'error');
    };
    recorder.onerror = () => {
      clearStopTimer();
      recorderRef.current = null;
      releaseMic();
      setRecording(false);
      say('The recorder stopped unexpectedly.', 'error');
    };
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setRecording(true);
    say('Recording — tap the mic again to stop.', 'busy');
    recorder.start();
    stopTimerRef.current = setTimeout(() => stop(), MAX_RECORDING_MS);
  }

  function stop() {
    clearStopTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* already stopped */ }
    }
    setRecording(false);
  }

  function onClick() {
    if (busy) return;
    if (recording) { stop(); return; }
    // A first-run user has to pick a model somewhere. The page is one tap
    // away and explains the choice; failing silently here would look like a
    // broken microphone.
    start();
  }

  const label = recording
    ? 'Stop dictation (' + formatDuration(Date.now() - startedAtRef.current) + ')'
    : 'Dictate';
  const svg = recording
    // A filled square: the same "stop" glyph the send button uses while a
    // turn streams, so the two stoppable states look alike.
    ? h('path', { d: 'M7 7h10v10H7Z', fill: 'currentColor' })
    : h('path', {
      d: 'M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Zm7 9a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-3.08A7 7 0 0 0 19 11Z',
      fill: 'currentColor'
    });

  return h('button', {
    class: 'chat-view__mic-btn' + (recording ? ' is-recording' : ''),
    type: 'button',
    onClick,
    disabled: busy,
    title: status || 'Dictate',
    'aria-label': label,
    'aria-pressed': recording ? 'true' : 'false',
    'data-state': statusState || undefined
  },
    h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' }, svg)
  );
}

// dictationPageHint() — the copy shown when the mic is tapped with no model
// configured, exported so the chat view (and its test) can reuse the exact
// wording, and so the "go pick one" affordance and the message cannot drift.
export function dictationPageHint() {
  return 'Open Settings → App defaults → Dictation to pick a dictation model.';
}

// goDictate() — navigate to the dictation page, which lives under Settings
// (App defaults) rather than in the bottom tab bar. Exported for the
// empty-state action; `nav` is the app's one hash writer.
export function goDictate() {
  nav('settings/dictation');
}
