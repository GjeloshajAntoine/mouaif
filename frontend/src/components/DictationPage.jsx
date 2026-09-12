// mouaif web — DictationView (the `#/dictation` page)
//
// One screen for "speak, get text, do something with it":
//
//   * a big record button (the primary control, thumb-reachable);
//   * a live timer and level meter while recording, so a silent mic is
//     obvious before the user waits for a transcription;
//   * a model picker + a request-shape picker, because what a model *is* and
//     what dialect it speaks are separate facts — a self-hosted
//     `whisper-large-v3` on an OpenAI-shaped endpoint and a Gemini model with
//     an inline-audio endpoint behave differently and are selected separately;
//   * optional language and vocabulary hints;
//   * the transcript, editable in place (a transcript is a draft, not an
//     answer), with Copy / Insert in chat / Send to chat.
//
// The audio is recorded locally and POSTed as base64 to
// `/api/ai/transcribe`; the page never holds a provider credential
// (docs/decisions.md section 10). The helpers it uses live in
// `frontend/src/dictation.js`, which is pure enough to be unit-tested.
//
// Mobile-first: a single column, a 56px record button, ≥44px taps, no hover
// affordances, and a `dvh`-based height so the iOS keyboard does not push the
// actions off-screen (style notes live in dictation.css).
import { h, Fragment } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { fetchJson, activeProject, saveApp } from '../api.js';
import { ModelPickerField } from './ModelPickerField.jsx';
import {
  MAX_RECORDING_MS,
  autoKindId,
  blobToBase64,
  dictationFilename,
  formatDuration,
  kindLabel,
  kindShortLabel,
  loadDictationModels,
  modelsForKind,
  pickRecorderMime,
  pickerModels,
  recorderSupported,
  resolveDefaultModel,
  transcribeAudio,
  transcriptActions
} from '../dictation.js';

// Where the chosen dictation model / request shape live. App-level, not
// project-level: dictation is usually a one-off ("let me talk at this
// machine") and a project that never dictates should not grow a settings key
// for it. The project's model list is still the source of the models on offer.
const APP_KEY = 'dictation';

export function DictationView() {
  // ---- Settings / catalog -------------------------------------------------
  const [models, setModels] = useState([]);
  const [kinds, setKinds] = useState([]);
  const [totalModels, setTotalModels] = useState(0);
  const [modelId, setModelId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [kindId, setKindId] = useState('');
  const [kindTouched, setKindTouched] = useState(false);
  const [language, setLanguage] = useState('');
  const [prompt, setPrompt] = useState('');
  const [catalogBusy, setCatalogBusy] = useState(true);
  const [catalogError, setCatalogError] = useState('');

  // The project whose models are on offer, and whose newest chat the hand-off
  // targets. Normally that is the active project (the chat route is its
  // authoritative writer), but the Dictate tab is also reachable directly —
  // after a cold start, or from an installed PWA launch — where nothing has
  // written the signal yet. Falling back to the first registered project keeps
  // the tab useful instead of showing an empty picker, and the group title
  // names which project it settled on so nothing is ambiguous.
  const [project, setProject] = useState(() => ({
    dir: (activeProject.value && activeProject.value.dir) || '',
    name: (activeProject.value && activeProject.value.name) || ''
  }));
  const projectDir = project.dir;
  useEffect(() => {
    if (projectDir) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchJson('/api/projects/registered');
        const first = r.status === 200 && Array.isArray(r.body && r.body.projects) ? r.body.projects[0] : null;
        if (!cancelled && first) setProject({ dir: first.path || '', name: first.name || first.path || '' });
      } catch { /* no project is a valid state: the page says so */ }
    })();
    return () => { cancelled = true; };
  }, [projectDir]);

  // ---- Recorder -----------------------------------------------------------
  const [supported] = useState(() => recorderSupported());
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [recordingBlob, setRecordingBlob] = useState(null);
  const [recordingMime, setRecordingMime] = useState('');

  // ---- Transcription ------------------------------------------------------
  const [transcript, setTranscript] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [statusState, setStatusState] = useState('');
  const [lastRun, setLastRun] = useState(null);

  // Live copies of the two pieces of state `applyCatalog` has to read without
  // becoming an effect dependency: the shape the user has explicitly picked,
  // and the model currently selected. Reading state directly would work but
  // would also close the catalog effect over stale values on its second pass.
  const kindTouchedRef = useRef(false);
  const kindIdRef = useRef('');
  kindIdRef.current = kindId;
  const modelIdRef = useRef('');
  modelIdRef.current = modelId;

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const tickTimerRef = useRef(null);
  const levelTimerRef = useRef(null);
  const autoStopRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const levelBufferRef = useRef(null);

  // ---- Catalog load -------------------------------------------------------
  //
  // Two passes, because the two sources have very different costs:
  //
  //   1. the project's own models (`live=0`) — a settings read, so it resolves
  //      in milliseconds and the picker can paint the user's own records
  //      immediately;
  //   2. the connected providers' live catalogs (`refresh`), which cost one
  //      upstream round trip each on a cold cache and are then memoized for an
  //      hour. Those rows are appended without disturbing a selection the user
  //      made in the meantime.
  //
  // A project with no models at all is the normal fresh-install state and is
  // exactly why pass 2 exists: without it the page is unusable until the user
  // hand-edits `.mouaif.json`.
  const [liveBusy, setLiveBusy] = useState(false);
const [liveFailures, setLiveFailures] = useState([]);
const [catalogProviders, setCatalogProviders] = useState([]);

  // applyCatalog(catalog, saved, opts) — fold one catalog response into the page
// state.
//
// Which request shape is selected is decided here, once, from three inputs in
// priority order:
//
//   1. the shape the user picked in this session (they are looking at the
//      chips; nothing may move under them);
//   2. the shape that actually has models — this is what the second, live pass
//      usually changes, because the project's own rows may have been empty;
//   3. `saved.kind`, the shape remembered from a previous session.
//
// `opts.onlyIfEmpty` additionally protects a model the user has picked since
// the first pass resolved, so a slow live response cannot overwrite it.
function applyCatalog(catalog, saved, opts) {
  const onlyIfEmpty = !!(opts && opts.onlyIfEmpty);
  const rows = catalog.models;
  setModels(rows);
  setKinds(catalog.kinds);
  setTotalModels(catalog.total);
  setLiveFailures(Array.isArray(catalog.liveFailures) ? catalog.liveFailures : []);
  setCatalogProviders(Array.isArray(catalog.providers) ? catalog.providers : []);

  // The family to show. `autoKindId` weighs the models by family, so a
  // project whose models are all Gemini opens on Gemini rather than on the
  // first entry of the family list. A remembered shape is only honoured when
  // it still has rows — an empty `preferred` must fall through, not "match"
  // every row.
  const preferred = (saved && saved.kind) || '';
  const remembered = preferred && modelsForKind(rows, preferred).length ? preferred : '';
  const family = remembered || autoKindId(catalog.kinds, rows);
  const nextKind = kindTouchedRef.current ? (kindIdRef.current || family) : family;
  setKindId(nextKind);

  const fallback = resolveDefaultModel(rows, saved, nextKind);
  if (fallback && (!onlyIfEmpty || !modelIdRef.current)) {
    setModelId(fallback.modelId);
    setProviderId(fallback.providerId);
  }
}

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setCatalogBusy(true);
      setCatalogError('');
      let saved = {};
      try {
        const app = await fetchJson('/api/settings');
        if (app.status === 200 && app.body && app.body.app) saved = app.body.app[APP_KEY] || {};
      } catch { /* a settings read failure must not block the recorder */ }
      let catalog = { models: [], kinds: [], total: 0 };
      try {
        catalog = await loadDictationModels(projectDir, { live: false });
      } catch (e) {
        if (!cancelled) setCatalogError(e && e.message ? e.message : 'Could not load models');
      }
      if (cancelled) return;
      applyCatalog(catalog, saved);
      // With no connected provider there is nothing to fetch, and with no
      // project there is no query to make.
      const hasProviders = Array.isArray(catalog.providers) && catalog.providers.length > 0;
      setCatalogBusy(false);
      if (!projectDir || !hasProviders) return;
      setLiveBusy(true);
      try {
        const live = await loadDictationModels(projectDir);
        if (!cancelled) applyCatalog(live, saved, { onlyIfEmpty: true });
      } catch { /* the project rows already painted; live is a bonus */ } finally {
        if (!cancelled) setLiveBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectDir]);

  // ---- Recorder lifecycle -------------------------------------------------
  const clearTimers = useCallback(() => {
    if (tickTimerRef.current) { clearInterval(tickTimerRef.current); tickTimerRef.current = null; }
    if (levelTimerRef.current) { clearInterval(levelTimerRef.current); levelTimerRef.current = null; }
    if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null; }
  }, []);

  const releaseMic = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream && typeof stream.getTracks === 'function') {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* already stopped */ }
      }
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch { /* already closed */ }
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    levelBufferRef.current = null;
    setLevel(0);
  }, []);

  const stopRecording = useCallback(() => {
    clearTimers();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* already stopped */ }
    }
    setRecording(false);
  }, [clearTimers]);

  // Unmount safety: a page change while recording must not leave the mic
  // indicator lit or the MediaStream alive.
  useEffect(() => () => {
    clearTimers();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* already stopped */ }
    }
    const stream = streamRef.current;
    if (stream && typeof stream.getTracks === 'function') {
      for (const track of stream.getTracks()) { try { track.stop(); } catch { /* already stopped */ } }
    }
  }, [clearTimers]);

  // A simple RMS meter. It is deliberately coarse — a 60ms sample redrawn 4x
  // a second is enough to tell "the mic is muted" from "the mic is live", and
  // it costs one getByteTimeDomainData call per interval.
  function startLevelMeter(stream, win) {
    try {
      const Ctor = win.AudioContext || win.webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      levelBufferRef.current = new Uint8Array(analyser.fftSize);
      levelTimerRef.current = setInterval(() => {
        const node = analyserRef.current;
        const buffer = levelBufferRef.current;
        if (!node || !buffer) return;
        node.getByteTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          const v = (buffer[i] - 128) / 128;
          sum += v * v;
        }
        // sqrt(2) scales a full-scale sine's RMS to 1, so the bar reaches the
        // right edge on a loud but not clipped input.
        setLevel(Math.min(1, Math.sqrt(sum / buffer.length) * Math.SQRT2));
      }, 250);
    } catch { /* no meter on this device; recording still works */ }
  }

  async function startRecording() {
    setStatus('');
    setStatusState('');
    const win = typeof window !== 'undefined' ? window : null;
    if (!win || !recorderSupported(win)) {
      setStatus('This browser cannot record audio.');
      setStatusState('error');
      return;
    }
    let stream;
    try {
      stream = await win.navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setStatus(e && e.name === 'NotAllowedError'
        ? 'Microphone permission was refused. Allow it in the browser, then tap again.'
        : 'Could not open the microphone: ' + ((e && e.message) || e));
      setStatusState('error');
      return;
    }
    streamRef.current = stream;
    const mime = pickRecorderMime(win.MediaRecorder, win);
    let recorder;
    try {
      recorder = mime ? new win.MediaRecorder(stream, { mimeType: mime }) : new win.MediaRecorder(stream);
    } catch {
      // A mis-set mimeType throws on some Safari builds; retry with the
      // browser's own default rather than failing the whole feature.
      try { recorder = new win.MediaRecorder(stream); } catch (e) {
        releaseMic();
        setStatus('Could not start the recorder: ' + ((e && e.message) || e));
        setStatusState('error');
        return;
      }
    }
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event && event.data && event.data.size) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || mime || 'audio/webm';
      const blob = chunksRef.current.length
        ? new Blob(chunksRef.current, { type })
        : null;
      chunksRef.current = [];
      mediaRecorderRef.current = null;
      releaseMic();
      setRecording(false);
      if (blob && blob.size) {
        setRecordingBlob(blob);
        setRecordingMime(type);
        setStatus('Recorded ' + formatDuration(Date.now() - startedAtRef.current) + '. Ready to transcribe.');
        setStatusState('success');
      } else {
        setStatus('Nothing was captured — check that the microphone is not muted.');
        setStatusState('error');
      }
    };
    recorder.onerror = () => {
      releaseMic();
      setRecording(false);
      setStatus('The recorder stopped unexpectedly.');
      setStatusState('error');
    };
    mediaRecorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setRecordingBlob(null);
    setRecordingMime('');
    setElapsedMs(0);
    setRecording(true);
    recorder.start();
    tickTimerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 200);
    autoStopRef.current = setTimeout(() => stopRecording(), MAX_RECORDING_MS);
    startLevelMeter(stream, win);
  }

  // ---- Transcribe ---------------------------------------------------------
  async function runTranscription() {
    if (!modelId) {
      setStatus('Pick a dictation model first.');
      setStatusState('error');
      return;
    }
    if (!recordingBlob) {
      setStatus('Record something first.');
      setStatusState('error');
      return;
    }
    setBusy(true);
    setStatus('Transcribing with ' + modelId + '…');
    setStatusState('busy');
    try {
      const audioBase64 = await blobToBase64(recordingBlob);
      const out = await transcribeAudio({
        projectDir,
        modelId,
        providerId,
        audioBase64,
        mimeType: recordingMime || recordingBlob.type || 'audio/webm',
        filename: dictationFilename(recordingMime || recordingBlob.type, startedAtRef.current),
        language,
        prompt
      });
      setTranscript(out.text || '');
      setLastRun({ model: out.model, kind: out.kind, bytes: out.bytes, durationMs: out.durationMs });
      setStatus('Transcribed with ' + ((out.model && out.model.id) || modelId) + '.');
      setStatusState('success');
    } catch (e) {
      setStatus((e && e.message) || 'Transcription failed');
      setStatusState('error');
    } finally {
      setBusy(false);
    }
  }

  // ---- Transcript actions -------------------------------------------------
  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(transcript);
      setStatus('Transcript copied.');
      setStatusState('success');
    } catch {
      setStatus('Could not copy — long-press the text instead.');
      setStatusState('error');
    }
  }

  // appendToLatestChat(value) — put the transcript into a chat draft.
  //
  // `send` decides whether the message is also sent: dictation is a *draft*
  // input method, so the default hand-off fills the composer and leaves the
  // send decision to the user.
  async function appendToLatestChat(send) {
    const dir = projectDir;
    if (!dir) {
      setStatus('Open a project first, then this can hand the text to a chat.');
      setStatusState('error');
      return;
    }
    setBusy(true);
    try {
      const listed = await fetchJson('/api/chats?projectDir=' + encodeURIComponent(dir) + '&limit=1');
      if (listed.status !== 200) throw new Error((listed.body && listed.body.error) || ('HTTP ' + listed.status));
      const chat = (listed.body && listed.body.chats && listed.body.chats[0]) || null;
      if (!chat) throw new Error('This project has no chat yet — start one in the Chats tab.');
      const previous = typeof chat.draft === 'string' ? chat.draft : '';
      const joined = previous.trim() ? previous.replace(/\s+$/, '') + '\n' + transcript : transcript;
      const patched = await fetchJson('/api/chats/' + encodeURIComponent(chat.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir: dir, draft: joined })
      });
      if (patched.status !== 200) throw new Error((patched.body && patched.body.error) || ('HTTP ' + patched.status));
      setStatus(send
        ? 'Draft filled in "' + (chat.title || chat.id) + '" — send it from the chat.'
        : 'Draft filled in "' + (chat.title || chat.id) + '".');
      setStatusState('success');
    } catch (e) {
      setStatus((e && e.message) || 'Could not reach the chat.');
      setStatusState('error');
    } finally {
      setBusy(false);
    }
  }

  // ---- Derived ------------------------------------------------------------
const kindModels = modelsForKind(models, kindId);
const pickerList = pickerModels(kindModels);
const selection = modelId ? { providerId, modelId } : null;
const actions = transcriptActions({ text: transcript, chatId: projectDir, hasRecording: !!recordingBlob });
// The note above the picker distinguishes the two sources it merges.
const projectCount = models.filter((m) => m.source !== 'live').length;
const hasLive = models.some((m) => m.source === 'live');
const providers = Array.isArray(catalogProviders) ? catalogProviders : [];

// refreshCatalog() — re-read both passes with the server's cache bypassed.
// The live list is memoized for an hour, so without this a model added to a
// provider account would not appear until the cache aged out.
async function refreshCatalog() {
  if (liveBusy || catalogBusy) return;
  setLiveBusy(true);
  setStatus('');
  setStatusState('');
  try {
    const catalog = await loadDictationModels(projectDir, { refresh: true });
    applyCatalog(catalog, { kind: kindId, modelId, providerId }, { onlyIfEmpty: false });
  } catch (e) {
    setStatus((e && e.message) || 'Could not refresh the model list.');
    setStatusState('error');
  } finally {
    setLiveBusy(false);
  }
}

function onPickModel(next) {
  setModelId(next ? next.modelId : '');
  setProviderId(next ? next.providerId : '');
  setStatus('');
  setStatusState('');
}

  // Persisting the choice is best-effort: a failure to remember the model must
  // never look like a failure to record.
  async function remember(patch) {
    try {
      const app = await fetchJson('/api/settings');
      const current = (app.status === 200 && app.body && app.body.app && app.body.app[APP_KEY]) || {};
      await saveApp({ [APP_KEY]: Object.assign({}, current, patch) });
    } catch { /* the picker still works for this session */ }
  }

  function onPickKind(next) {
    // Recorded in the ref as well as in state: the catalog callbacks compare
    // against the ref, and a state update would not be visible to a response
    // that is already in flight.
    kindTouchedRef.current = true;
    setKindTouched(true);
    setKindId(next);
    // The row list is filtered by family, so a model from the previous family
    // can silently vanish. Clearing it makes the empty picker honest instead
    // of leaving a stale id that no longer has a row.
    modelIdRef.current = '';
    setModelId('');
    setProviderId('');
    remember({ kind: next });
  }

  const selectedRow = models.find((m) => m.id === modelId && (m.provider || '') === providerId) || null;
  // While the user has not touched the control, the shape is the selected
  // model's own: that is what the request will actually use. After a tap, the
  // chip is the user's answer and wins — including when it disagrees with the
  // model they then pick, which is exactly how a mis-inferred model gets
  // overridden.
  const effectiveKind = kindTouched
    ? kindId
    : ((selectedRow && selectedRow.kind) || kindId);

  // The record button's own caption. Recording beats every other state, then
  // "stop is available" beats "transcribe".
  const recordLabel = recording ? 'Stop' : (elapsedMs ? 'Record again' : 'Record');
  const canTranscribe = !!recordingBlob && !!modelId && !busy && !recording;

  return h('section', { class: 'dictation' },
    h('div', { class: 'view-head' },
      h('a', { href: '#/projects', class: 'view-back', 'aria-label': 'Back to chats' }, '←'),
      h('h2', { class: 'view-title' }, 'Dictation')
    ),

    // ---- 1. Speak ---------------------------------------------------------
    h('div', { class: 'dictation__card dictation__card--recorder' },
      h('div', { class: 'dictation__clock' },
        h('span', { class: 'dictation__time', 'aria-live': 'polite' }, formatDuration(elapsedMs)),
        h('span', { class: 'dictation__limit' }, 'max ' + formatDuration(MAX_RECORDING_MS))
      ),
      h('div', { class: 'dictation__meter', role: 'meter', 'aria-label': 'Input level', 'aria-valuenow': Math.round(level * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 },
        h('span', { class: 'dictation__meter-fill', style: { width: Math.round((recording ? level : 0) * 100) + '%' } })
      ),
      h('button', {
      class: 'dictation__record' + (recording ? ' is-recording' : (recordingBlob ? ' is-secondary' : '')),
      type: 'button',
      disabled: !supported || busy,
      onClick: recording ? stopRecording : startRecording,
      'aria-label': recording ? 'Stop recording' : recordLabel
      },
      h('span', { class: 'dictation__record-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'dictation__record-label' }, busy && !recordingBlob ? 'Working…' : recordLabel)
      ),
      // The transcribe action only exists while there is an untranscribed
      // recording: a permanently disabled button would suggest the feature is
      // broken rather than waiting. When there is one, it is the primary
      // action and Record steps back to secondary.
      recordingBlob && !recording
      ? h('div', { class: 'dictation__recorder-actions' },
        h('span', { class: 'dictation__ready' }, 'Recording ready'),
        h('button', {
        class: 'dictation__transcribe',
        type: 'button',
        disabled: !canTranscribe,
        onClick: runTranscription,
        'aria-label': 'Transcribe the recording'
        }, busy ? 'Transcribing…' : 'Transcribe')
      )
      : null,
      !supported
        ? h('p', { class: 'hint hint--compact' }, 'This browser cannot record audio. Dictation needs a browser with MediaRecorder and microphone access.')
        : null
    ),

    // ---- 2. Model + request shape -----------------------------------------
    h('div', { class: 'group' },
      h('div', { class: 'group__title' }, 'Model', h('span', { class: 'group__title-note' }, projectDir ? (project.name || 'this project') : 'no project')),
      h('div', { class: 'dictation__fields' },
        h('div', { class: 'dictation__field' },
        h('span', { class: 'label' }, 'Dictation model'),
        h(ModelPickerField, {
          models: pickerList,
          value: selection,
          onChange: onPickModel,
          onOpen: () => { /* the catalog is already loaded */ },
          placeholder: catalogBusy ? 'Loading models…' : (emptyHint(kindModels, totalModels) || 'Pick a model'),
          ariaLabel: 'Pick dictation model',
          // 'sheet' rather than 'dropdown': on a phone the dropdown popup
          // renders in flow and covers the transcript directly beneath it,
          // while the sheet variant uses the same mobile viewport modal the
          // chat head's picker does (and the same desktop card).
          variant: 'sheet',
          refreshEmpty: 'No dictation models'
        })
        ),
        h('div', { class: 'dictation__field' },
        h('span', { class: 'label' }, 'Request shape'),
        kinds.length
          ? h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Transcription request shape' },
            kinds.map((k) =>
            h('label', { key: k.id, class: 'seg__item' + (effectiveKind === k.id ? ' seg__item--on' : '') },
              h('input', {
              type: 'radio',
              name: 'dictation-kind',
              value: k.id,
              checked: effectiveKind === k.id,
              onChange: () => onPickKind(k.id)
              }),
              h('span', { class: 'seg__pill', title: k.label }, kindShortLabel(k.id))
            )
            )
          )
          // With no catalog there is no shape to choose between, so the
          // control is replaced by a dash rather than a single fake
          // "unknown" chip — a one-option radio group is just decoration.
          : h('span', { class: 'dictation__kind-empty' }, '—'),
        h('span', { class: 'hint hint--compact dictation__kind-hint' },
          kinds.length ? (kindLabel(kinds, effectiveKind) || 'Pick a request shape') : 'No request shape to choose')
        )
      ),
      h('div', { class: 'dictation__fields' },
        h('div', { class: 'dictation__field' },
        h('label', { class: 'label', for: 'dictation-language' }, 'Language (optional)'),
        h('input', {
          class: 'input', id: 'dictation-language', type: 'text',
          placeholder: 'en, fr, de…',
          value: language,
          onInput: (e) => setLanguage(e.target.value.slice(0, 20))
        })
        ),
        h('div', { class: 'dictation__field' },
        h('label', { class: 'label', for: 'dictation-prompt' }, 'Vocabulary hint (optional)'),
        h('input', {
          class: 'input', id: 'dictation-prompt', type: 'text',
          placeholder: 'mouaif, MediaRecorder, SSE…',
          value: prompt,
          onInput: (e) => setPrompt(e.target.value.slice(0, 400))
        })
        )
      ),
      // Where the rows came from, and the one action that can add more. The
      // live catalogs are memoized server-side for an hour, so a provider that
      // just gained a model needs this tap to show up.
      h('div', { class: 'dictation__catalog-note' },
        h('span', { class: 'hint hint--compact' },
        liveBusy
          ? 'Looking for models from your providers…'
          : (projectCount
            ? projectCount + (projectCount === 1 ? ' project model' : ' project models')
            + (hasLive ? ', plus models from your provider' : '')
            : (hasLive ? 'Models from your provider connections' : 'No models'))),
        projectDir && providers.length
        ? h('button', {
          class: 'dictation__refresh',
          type: 'button',
          disabled: liveBusy || catalogBusy,
          onClick: refreshCatalog,
          'aria-label': 'Refresh the model list from the provider'
          }, liveBusy ? 'Refreshing…' : 'Refresh')
        : null
      ),
      catalogError
        ? h('p', { class: 'hint hint--compact dictation__error' }, 'Could not read the model list: ' + catalogError)
        : null,
      // A provider that could not answer is reported per-provider: one
      // unreachable or badly-keyed connection must not look like "no models".
      liveFailures.length
        ? h('p', { class: 'hint hint--compact dictation__error' },
          liveFailures.map((f) => f.provider + ': ' + f.error).join(' · '))
        : null,
      !catalogBusy && !liveBusy && !models.length
        ? h('p', { class: 'hint hint--compact' }, providers.length
          ? 'Your providers returned no usable models. Check the connection in Settings → Providers, then tap Refresh.'
          : 'No models yet, and no provider connection to list them from. Connect a provider in Settings → Providers (or add a model to this project in .mouaif.json), then come back.')
        : null
      ),

    // ---- 3. Transcript ----------------------------------------------------
    h('div', { class: 'group' },
      h('div', { class: 'group__title' }, 'Transcript'),
      h('div', { class: 'dictation__transcript' },
        h('textarea', {
          class: 'input dictation__textarea',
          rows: 6,
          placeholder: 'The transcript appears here and stays editable.',
          value: transcript,
          'aria-label': 'Transcript',
          onInput: (e) => setTranscript(e.target.value)
        }),
        h('div', { class: 'dictation__actions' },
          actions.map((action) => h('button', {
            key: action.id,
            class: 'btn' + (action.id === 'send' ? ' btn--primary' : '') + (action.id === 'clear' ? ' btn--ghost' : ''),
            type: 'button',
            disabled: action.disabled || busy,
            onClick: () => {
              if (action.id === 'copy') return copyTranscript();
              if (action.id === 'clear') { setTranscript(''); setStatus(''); setStatusState(''); return undefined; }
              return appendToLatestChat(action.id === 'send');
            }
          }, action.label))
        )
      ),
      lastRun
        ? h('p', { class: 'hint hint--compact' },
            'Last run: ' + ((lastRun.model && lastRun.model.id) || 'unknown model')
            + ' · ' + (kindShortLabel(lastRun.kind))
            + ' · ' + Math.round((lastRun.bytes || 0) / 1024) + ' kB'
            + ' · ' + Math.round((lastRun.durationMs || 0) / 100) / 10 + 's')
        : null
    ),

    // ---- Status -----------------------------------------------------------
    h('p', {
      class: 'status dictation__status',
      'aria-live': 'polite',
      'data-state': statusState || undefined
    }, status)
  );
}

// emptyHint(models, total) — the *placeholder* text on the model trigger when
// there is nothing to pick. Kept out of the render body so the three distinct
// reasons (no models at all, none in this request shape, catalog still
// loading) each get a sentence instead of a generic "none".
function emptyHint(models, total) {
  if (models && models.length) return '';
  if (!total) return 'No models in this project';
  return 'No model in this request shape';
}
