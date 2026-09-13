// mouaif web — composer mic button (dictation in the chat view)
//
// A speech-to-text button that sits next to the image button. Tapping it
// starts dictation and a second tap stops it: the text lands in the composer
// at the caret, so the user reviews it before sending. That two-tap shape is
// deliberate — auto-sending a machine transcript is the one thing a chat input
// must never do.
//
// In a chat the take is transcribed *while the user speaks*. The take is cut
// into segments of LIVE_CHUNK_MS, each one a *complete recording* (see
// `createSegmentRecorder` — a MediaRecorder timeslice is not, and reading the
// fragments it produces is what made a chat take transcribe worse than the
// same words on the dictation page), every completed segment is POSTed as it
// arrives, and the draft grows at the caret with each answer; the button
// becomes the live indicator (it shows the running clock, not a static mic)
// and the chat's status row says what is going on. Live dictation is what the
// button does by default and is switched off on the dictation page
// (Settings → App defaults → Dictation → Live transcription), which falls back
// to the take it replaced: one request, when the user stops. See
// `liveDictationEnabled` in dictation.js.
//
// Two properties the live path has to keep, whatever the provider does:
//
//   * the draft is never left with a half-sentence appended after the text the
//     user typed — a segment's answer re-derives the whole transcript and the
//     live region of the draft is a *tail*, so the user's own words survive
//     every recompute;
//   * a segment that fails does not lose the take. The next segment's answer
//     is the whole transcript of the live region (not just its own words), so
//     the words said during a failure come back with the following one.
//
// A take is billed work, so the priced runs it produces are attributed to the
// chat it happened in (`chatId` on the request): the server adds them to that
// chat's Total and the project total, since a transcription writes no message
// row. The button only reports the figure; the totals are the server's.
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
import { formatCost } from '../../usage.js';
import {
  LIVE_CHUNK_MS,
  MAX_RECORDING_MS,
  blobToBase64,
  createLiveSegments,
  createSegmentRecorder,
  defaultDictationModel,
  dictationFilename,
  formatDuration,
  liveDictationEnabled,
  liveTakeCost,
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
const { language = '', onTranscript, onStatus, onProgress, promptRef } = props;
const [recording, setRecording] = useState(false);
const [status, setStatus] = useState('');
const [statusState, setStatusState] = useState('');
const [busy, setBusy] = useState(false);
const recorderRef = useRef(null);
const streamRef = useRef(null);
const chunksRef = useRef([]);
const stopTimerRef = useRef(null);
const startedAtRef = useRef(0);
// segmentsRef — the live take's rotator (see `createSegmentRecorder`), the one
// object that owns the MediaRecorder while a live take is open. `recorderRef`
// and `chunksRef` belong to the other arm: a take transcribed in one request
// when the user stops. Only one of the two is ever in play.
const segmentsRef = useRef(null);
// Live dictation state, all in refs: the recorder's events fire outside
// Preact's render cycle and two segments can be in flight at once, so what the
// take knows must not wait for a re-render to be true.
//
//   takeRef      — the transcript so far, one slot per segment index
//   liveStartRef — where the live region of the draft begins (the caret the
//                  take started at), so the tail can be rewritten in place
//   liveBaseRef  — the draft text before that region
//   issuedRef    — how many segments were sent (vs. answered: see `pending()`)
//   failedRef    — a segment failed, so the next answer must say so
//   liveRef      — the per-take flag: live when the user has it on for this
//                  take (see `start`, which is also where the rotator is built)
const takeRef = useRef(null);
const liveStartRef = useRef(0);
const liveBaseRef = useRef('');
const issuedRef = useRef(0);
const failedRef = useRef(false);
const liveRef = useRef(false);
// costRef — every segment's own priced answer for the take in progress. A
// segment is billed work even though nobody can price the *take* until it
// ends, so the sum is the honest figure for the finished take: the segments
// cover the take end to end, and a segment that failed contributed nothing to
// the list. `liveTakeCost` owns the arithmetic; it is what `settleTake`
// reports, and therefore what the chat adds to its Total (the chat-attributed
// cost).
const costRef = useRef([]);
// recordingRef mirrors the `recording` state for the async paths: a segment's
// answer arrives after the recorder's events, and whether the take is still
// open decides both what is published and whether it may be closed.
const recordingRef = useRef(false);
// A 1 Hz tick while recording, so the button's countdown (aria-label/title) is
// the live indicator it is meant to be: without it the label is only accurate
// at the one moment it is read.
const [tick, setTick] = useState(0);
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
// liveDraft() — { draft, text, base, caret } for the take in progress.
//
// `base` is the draft the user already had, `text` is the transcript so far,
// and `draft` is the two joined the way Chat.jsx joins a whole transcript: one
// space, never a newline, so a dictation dropped mid-sentence does not break
// the paragraph.
function liveDraft() {
const base = liveBaseRef.current;
const text = takeRef.current ? takeRef.current.text() : '';
const lead = text && base && !/\s$/.test(base) ? ' ' : '';
return { draft: base + lead + text, text, base: base + lead, caret: (base + lead + text).length };
}
// publishLive() — put the current transcript in the draft without closing the
// turn. `live: true` is what tells the chat view that this write owns a *tail*
// of the draft and the next one replaces it rather than appending again (see
// onTranscript in Chat.jsx); `cost: null` because the take is still running and
// has no price yet — the sum of its segments' prices is reported once, when
// it settles.
function publishLive() {
if (!onTranscript) return;
const live = liveDraft();
onTranscript(live.text, {
live: true,
model: modelRef.current ? { id: modelRef.current.id, provider: modelRef.current.provider || '' } : null,
cost: null
});
}
// settleTake(cost) — close the take: hand the finished transcript to the chat
// once, so it lands in the draft, is persisted, and the run's cost is
// reported. Called from the last outstanding segment's answer (a live take)
// or
// from the single request the stop makes (a non-live take).
function settleTake(cost) {
const take = takeRef.current;
const text = take ? take.text() : '';
takeRef.current = null;
liveBaseRef.current = '';
issuedRef.current = 0;
failedRef.current = false;
// The next take starts from zero: this ref accumulates across the segments
// of one take only.
costRef.current = [];
if (!text || !onTranscript) return;
onTranscript(text, {
model: modelRef.current ? { id: modelRef.current.id, provider: modelRef.current.provider || '' } : null,
cost: cost || null
});
}
// sendSegment(blob, mimeType) — hand one *complete recording* to the take.
//
// Called by the rotator with a finished segment, and once more when the take
// ends with the segment that was in progress. Segments are numbered in the
// order the recorder produced them (the order they were spoken) and their
// answers are stored by that number, so two in-flight requests that finish out
// of order still produce a transcript in speaking order.
function sendSegment(blob, mimeType) {
if (!blob || !blob.size) return;
const index = issuedRef.current++;
transcribeChunk(blob, mimeType, index);
}
// transcribeChunk(blob, mime, index) — POST one segment and fold the answer
// back into the take. Deliberately serialized on the *transcript*, not on the
// requests: an answer from an older segment is ignored if it arrives after the
// take was closed, and a failure is remembered so the next answer can say so
// (each segment's request covers the whole live region, so the words said
// during the failure come back with the next one rather than being lost).
async function transcribeChunk(blob, mime, index) {
const match = modelRef.current;
if (!match) return;
try {
const audioBase64 = await blobToBase64(blob);
if (!takeRef.current) return;
const out = await transcribeAudio({
projectDir: props.projectDir || '',
// The chat this take happens in. It is what makes the run *attributed*: the
// server adds the priced run to this chat's Total and the project total, since
// a transcription writes no message row. The dictation page omits it.
chatId: props.chatId || '',
modelId: match.id,
providerId: match.provider || '',
kind: match.kind || '',
audioBase64,
mimeType: mime,
filename: dictationFilename(mime, startedAtRef.current),
language
});
if (!takeRef.current) return;
failedRef.current = false;
takeRef.current.set(index, (out.text || '').trim());
// Remember this segment's price, so the take can settle with the sum of them
// (liveTakeCost). An unpriced segment (a per-minute model reports no tokens)
// contributes nothing rather than a fabricated zero.
if (out.cost) costRef.current.push(out.cost);
// Only while recording: once the user has stopped, the take is published by
// `maybeSettle` as the finished transcript, and publishing it here as well
// would move the caret twice for one answer.
if (recordingRef.current) publishLive();
} catch (e) {
if (!takeRef.current) return;
failedRef.current = true;
}
maybeSettle();
}
// maybeSettle() — close the take once the recorder has stopped *and* nothing
// is outstanding. The cost reported is the sum of the segments that answered:
// each one was a real, billed request, so the finished take has a price even
// though no single segment does. A take whose segments were all unpriced
// reports `null` and the status line says nothing about money rather than
// `$0.00`.
function maybeSettle() {
const take = takeRef.current;
if (!take) return;
if (recordingRef.current) {
// Still recording: report progress on the chat's status row. It says how many
// words have landed rather than an idle "Recording…", because the draft
// growing above it is the real progress bar. `onProgress` is what stops the
// draft write — which belongs to the user's text area — from stealing the
// caret on every segment; the note under the composer is the live indicator.
const words = take.text().split(/\s+/).filter(Boolean).length;
const message = failedRef.current
? 'Recording — part of what you said could not be transcribed; still listening…'
: (words ? words + ' words so far — tap the mic to stop.' : 'Recording — tap the mic again to stop.');
if (onProgress) onProgress(message, 'busy');
else say(message, 'busy');
return;
}
if (take.pending(issuedRef.current) > 0) return;
const failed = failedRef.current;
const text = take.text();
const summed = liveTakeCost(costRef.current);
settleTake(summed);
if (text && failed) {
say('Added to the composer — part of what you said could not be transcribed.', 'error');
return;
}
if (text) {
// Same convention as the one-request path: report the figure when the take
// had one, and say nothing about money when it did not (a `$0.00` would read
// as "free" rather than "not reported").
const summedLabel = summed ? formatCost(summed.total) : '--';
sayLocal(summedLabel === '--'
? 'Added to the composer — review it, then send.'
: 'Added to the composer (' + summedLabel + ') — review it, then send.', 'success');
return;
}
say(failed ? 'Transcription failed' : 'Nothing was recognised — try again a little closer to the mic.', 'error');
}


  // Stop on unmount: navigating away with a live recorder would leave the
  // browser's recording indicator lit forever. The rotator is stopped first —
  // it owns the recorder that is running — and the stream is released once both
  // arms have let go of it.
  useEffect(() => () => {
  recordingRef.current = false;
  clearStopTimer();
  const segments = segmentsRef.current;
  segmentsRef.current = null;
  if (segments) segments.stop();
  const recorder = recorderRef.current;
  if (recorder && recorder.state !== 'inactive') {
  try { recorder.stop(); } catch { /* already stopped */ }
  }
  releaseMic();
  }, []);

  // The 1 Hz tick. Only the rendered minutes/seconds matter, so the timer writes
  // state at the rate a human reads it rather than on every animation frame.
  useEffect(() => {
  if (!recording) return undefined;
  const timer = setInterval(() => setTick((n) => n + 1), 1000);
  return () => clearInterval(timer);
  }, [recording]);


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
        chatId: props.chatId || '',
        modelId: match.id,
        providerId: match.provider || '',
        kind: match.kind || '',
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

  // resolveModel() — the row this take will be sent to, and how the take should
  // be transcribed.
  //
  // Model choice: the remembered app-level dictation choice if it is still in
  // this project's list, else the one candidate, else the single row whose name
  // says it transcribes. `defaultDictationModel` owns that order, so this button
  // and the dictation page cannot disagree about which model a tap uses.
  //
  // The same app record carries `live` (the page's Live transcription switch),
  // which is why this is the one read: the two facts a take needs come from the
  // one place the user set them.
  async function resolveModel() {
  const app = await fetchJson('/api/settings');
  const saved = (app.status === 200 && app.body && app.body.app && app.body.app.dictation) || {};
  const catalog = await loadDictationModels(props.projectDir || '');
  const picked = defaultDictationModel(catalog.models, saved);
  if (!picked) return null;
  const row = catalog.models.find((m) => m.id === picked.modelId && (m.provider || '') === picked.providerId);
  if (!row) return null;
  return { row, live: liveDictationEnabled(saved) };
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
let resolved = null;
try {
resolved = await resolveModel();
} catch (e) {
setBusy(false);
say((e && e.message) || 'Could not load the dictation model list.', 'error');
return;
}
setBusy(false);
if (!resolved) {
say(NO_MODEL_MESSAGE, 'error');
return;
}
modelRef.current = resolved.row;

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
    // Where the live transcript starts. Captured before the first segment can
    // arrive: the caret as the user left it when they tapped, which is where a
    // finished transcript would have landed too.
    const promptEl = props.promptRef && props.promptRef.current;
    liveStartRef.current = promptEl && typeof promptEl.selectionStart === 'number'
    ? promptEl.selectionStart
    : (promptEl ? promptEl.value.length : 0);
    liveBaseRef.current = promptEl ? promptEl.value.slice(0, liveStartRef.current) : '';
    issuedRef.current = 0;
    failedRef.current = false;
    costRef.current = [];
    takeRef.current = createLiveSegments();
    // Live when the user asked for it. What that needs from the browser is a
    // MediaRecorder that can be started again and again, not one that hands over a
    // timeslice: a live take is a series of *complete* recordings rotated every
    // LIVE_CHUNK_MS (`createSegmentRecorder` in dictation.js explains why a
    // timeslice is not the same thing — reading its fragments is what made a chat
    // take transcribe worse than the same words on the dictation page). The other
    // arm keeps the original one-request-on-stop behaviour, which is what the
    // page's switch also turns this back into.
    liveRef.current = resolved.live;
    let recorder = null;
    if (liveRef.current) {
    const segments = createSegmentRecorder({
    recorder: win.MediaRecorder,
    stream,
    mimeType: mime,
    segmentMs: LIVE_CHUNK_MS,
    onSegment: sendSegment,
    onEnd: () => {
    // The rotator handed over the segment that was in progress: the take is
    // over, every segment has been sent, and `maybeSettle` closes it as soon as
    // their answers are in — or immediately, when there were none.
    segmentsRef.current = null;
    clearStopTimer();
    recordingRef.current = false;
    releaseMic();
    setRecording(false);
    maybeSettle();
    },
    onError: () => {
    segmentsRef.current = null;
    clearStopTimer();
    recordingRef.current = false;
    releaseMic();
    setRecording(false);
    say('The recorder stopped unexpectedly.', 'error');
    }
    });
    segmentsRef.current = segments;
    } else {
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
    recordingRef.current = false;
    releaseMic();
    setRecording(false);
    takeRef.current = null;
    if (blob && blob.size) transcribe(blob, type);
    else say('Nothing was captured — check the microphone is not muted.', 'error');
    };
    recorder.onerror = () => {
    clearStopTimer();
    recorderRef.current = null;
    recordingRef.current = false;
    releaseMic();
    setRecording(false);
    takeRef.current = null;
    say('The recorder stopped unexpectedly.', 'error');
    };
    recorderRef.current = recorder;
    }
    startedAtRef.current = Date.now();
    setRecording(true);
    recordingRef.current = true;
    say(liveRef.current
    ? 'Recording — the words appear in the composer as you speak; tap the mic to stop.'
    : 'Recording — tap the mic again to stop.', 'busy');
    if (liveRef.current) {
    try { segmentsRef.current.start(); } catch {
    // A recorder that cannot be built at all (no arm of the fallback worked):
    // the microphone is already open, so let go of it and say why, the way
    // the one-request path below does.
    segmentsRef.current = null;
    liveRef.current = false;
    recordingRef.current = false;
    releaseMic();
    setRecording(false);
    takeRef.current = null;
    say('Could not start the recorder.', 'error');
    return;
    }
    } else {
    // The one-request arm: nothing is published until the user stops, so the
    // chunks are collected and transcribed once.
    recorder.start();
    }
    stopTimerRef.current = setTimeout(() => stop(), MAX_RECORDING_MS);
    }
    function stop() {
    clearStopTimer();
    // `recording` flips here (the button must look stopped immediately), but the
    // take is deliberately kept: in a live take the segments still in flight are
    // the last words, and `maybeSettle` closes the take once they are answered.
    recordingRef.current = false;
    setRecording(false);
    if (liveRef.current) {
    // The rotator still holds the segment in progress: stopping it makes that
    // segment the last one, and its `onEnd` is where the take is closed. The
    // recorder is not stopped here — the rotator owns it, and stopping it from
    // two places would drop the audio it has not handed over yet.
    const segments = segmentsRef.current;
    if (segments) {
    segments.stop();
    return;
    }
    // No rotator (it was already torn down, e.g. by a recorder error): close the
    // take with the segments that did come back rather than leaving it open.
    liveRef.current = false;
    maybeSettle();
    return;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
    try { recorder.stop(); } catch { /* already stopped */ }
    }
    // A take that never went live has nothing to settle — the final blob is the
    // whole recording and `transcribe()` owns it from onstop.
    takeRef.current = null;
    }


  function onClick() {
    if (busy) return;
    if (recording) { stop(); return; }
    // A first-run user has to pick a model somewhere. The page is one tap
    // away and explains the choice; failing silently here would look like a
    // broken microphone.
    start();
  }

  // The 1 Hz `tick` is read here: it is what makes the label below advance while
  // recording. `void` documents that the value itself is not used.
  void tick;
  const elapsed = recording ? formatDuration(Date.now() - startedAtRef.current) : '';
  const label = recording ? 'Stop dictation (' + elapsed + ')' : 'Dictate';

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
