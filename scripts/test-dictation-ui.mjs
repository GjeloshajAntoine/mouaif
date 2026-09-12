// Dictation UI fixture — the real components, a fake API, a fake microphone.
//
// Run `node scripts/test-dictation-ui.mjs`, then open the printed URL (or point
// the Chrome debug session at it). Everything below the components is stubbed:
// the settings API, the transcribe endpoint, MediaRecorder, and getUserMedia.
// What stays real is the rendering, the record/stop state machine, the level
// meter's absence-tolerance, the model picker, and the transcript actions —
// the parts a build cannot check and a unit test cannot render.
//
// Note the two deliberate stubs in the page: `MediaRecorder` is an object with
// a static `isTypeSupported`, because the component probes it before
// constructing the recorder (that is the code path a wrong stub would hide),
// and `getUserMedia` returns a fake stream with stop()-able tracks so the
// unmount cleanup is exercised too.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const INDEX_HTML = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<link rel="stylesheet" href="/app.css"></head>'
  + '<body><main id="root" class="app__main app__main--flush"></main>'
  + '<script type="module" src="/app.js"></script></body></html>';

const bundle = await build({
  stdin: {
    contents: `
import { h, render } from 'preact';
import { useState, useRef } from 'preact/hooks';
import { DictationView } from './frontend/src/components/DictationPage.jsx';
import { MicButton } from './frontend/src/components/chat/MicButton.jsx';
import { setActiveProject } from './frontend/src/api.js';
import './frontend/src/style.css';

// The page and the mic button both resolve the project from the shared
// active-project signal (the chat route is its authoritative writer). The
// fixture stands in for "the user is looking at a project".
setActiveProject('/fixture/project', 'fixture');

// ---- Fake provider data ------------------------------------------------
const MODELS = [
  { id: 'whisper-1', provider: 'openai-compatible', label: 'Whisper 1', kind: 'openai-compatible', auth: 'apikey', connected: true },
  { id: 'whisper-large-v3', provider: 'groq', label: 'Whisper large v3', kind: 'openai-compatible', auth: 'apikey', connected: true },
  { id: 'gemini-2.5-flash', provider: 'gemini', label: 'Gemini 2.5 Flash', kind: 'gemini', auth: 'apikey', connected: false }
];
const KINDS = [
  { id: 'openai-compatible', label: 'OpenAI-compatible (multipart /audio/transcriptions)' },
  { id: 'gemini', label: 'Gemini (inline audio)' }
];
// Two scenarios, switchable from the page. The 'project' scenario has its own
// model records; the 'live' scenario is the fresh-install case this page had to
// be fixed for — no project models at all, one connected provider answering the
// catalog.
window.fixture = {
  failTranscribe: false,
  recorded: [],
  // The composer-mic scenario transcribes as you speak: the fake recorder
  // hands over a chunk every liveChunkMs (a stand-in for the real 3 s), and
  // the first two answers repeat the word 'sentence' at the seam so the join
  // rule is visible in the draft.
  liveTakes: true,
  liveChunkMs: 250,
  liveChunks: 2,
  transcribeCount: 0,
  // Derived from the hash, not only from the click handler: opening
  // #live-only directly (the normal way to look at one scenario) has to select
  // it too.
  scenario: location.hash.indexOf('live-only') >= 0 ? 'live'
    : (location.hash.indexOf('mixed') >= 0 ? 'mixed' : 'project'),
  // The live scenario starts with nothing remembered, which is the state a
  // fresh install is in: the page has to adopt a model from the live rows.
  settings: { dictation: (location.hash.indexOf('live-only') >= 0)
    ? {}
    : { modelId: 'whisper-1', providerId: 'openai-compatible', kind: 'openai-compatible' } }
};
const LIVE_ONLY = [
  { id: 'gemini-2.5-flash', provider: 'gemini', label: 'Gemini 2.5 Flash', kind: 'gemini', source: 'live', connected: true },
  { id: 'gemini-2.5-pro', provider: 'gemini', label: 'Gemini 2.5 Pro', kind: 'gemini', source: 'live', connected: true }
];
// The mixed case the "only Google models" report was about: one OpenRouter
// connection whose row ids are namespaced with a google/ prefix without being
// Gemini models — the connection, not the name, decides the transport — next
// to a provider that reports what each model produces. deepgram/nova-3 is the
// row whose name says nothing and that only the output report identifies.
const MIXED = [
{ id: 'google/chirp-3', provider: 'openrouter', label: 'Google: Chirp 3', kind: 'openai-compatible', source: 'live', connected: true, inputModalities: ['audio'], outputModalities: ['transcription'] },
{ id: 'openai/whisper-large-v3', provider: 'openrouter', label: 'OpenAI: Whisper Large V3', kind: 'openai-compatible', source: 'live', connected: true, inputModalities: ['audio'], outputModalities: ['transcription'] },
{ id: 'nvidia/parakeet-tdt-0.6b-v3', provider: 'openrouter', label: 'nvidia/parakeet-tdt-0.6b-v3', kind: 'openai-compatible', source: 'live', connected: true, inputModalities: ['audio'], outputModalities: ['transcription'] },
{ id: 'deepgram/nova-3', provider: 'openrouter', label: 'deepgram/nova-3', kind: 'openai-compatible', source: 'live', connected: true, inputModalities: ['audio'], outputModalities: ['transcription'] },
{ id: 'whisper-1', provider: 'groq', label: 'Whisper 1', kind: 'openai-compatible', source: 'live', connected: true }
];

window.fetch = async (input, options = {}) => {
  const url = new URL(input, location.origin);
  let body = {}, status = 200;
  if (url.pathname === '/api/settings') {
    body = { app: window.fixture.settings, defaults: {}, home: '/tmp/mouaif' };
  } else if (url.pathname === '/api/settings/app') {
    // The real route the page writes through (saveApp in api.js). A shallow
    // merge into the app store, key by key, exactly like the server's PUT.
    const patch = JSON.parse(options.body || '{}');
    Object.assign(window.fixture.settings, patch);
    body = { app: window.fixture.settings };
  } else if (url.pathname === '/api/ai/transcribe/models') {
    const live = url.searchParams.get('live') !== '0';
    if (window.fixture.scenario === 'mixed') {
      body = live
        ? { models: MIXED, kinds: KINDS, total: 0, providers: ['openrouter', 'groq'], liveFailures: [] }
        : { models: [], kinds: KINDS, total: 0, providers: ['openrouter', 'groq'], liveFailures: [] };
    } else if (window.fixture.scenario === 'live') {
      // The fast pass has nothing; the live pass supplies the models.
      body = live
        ? { models: LIVE_ONLY, kinds: KINDS, total: 0, providers: ['gemini'], liveFailures: [] }
        : { models: [], kinds: KINDS, total: 0, providers: ['gemini'], liveFailures: [] };
    } else {
      body = { models: MODELS, kinds: KINDS, total: MODELS.length + 4, providers: ['openai-compatible', 'groq', 'gemini'], liveFailures: [] };
    }
  } else if (url.pathname === '/api/ai/transcribe') {
    const payload = JSON.parse(options.body || '{}');
    window.fixture.recorded.push(payload);
    const runs = (window.fixture.transcribeCount = (window.fixture.transcribeCount || 0) + 1);
    if (window.fixture.failTranscribe) { status = 401; body = { error: 'Incorrect API key provided', code: 'ENOAUTH' }; }
    // A priced run, so the page's "Last run" line shows what the feature does
    // with a real answer (a provider report plus a known price). Setting
    // fixture.unpriced = true in the console shows the unknown case, which is
    // what a per-minute model really returns.
    //
    // A live take is answered per chunk, so the fixture answers the way a
    // provider does for chunked audio: consecutive segments that repeat the
    // word at the seam ('... dictated sentence' / 'sentence about ...'). That
    // is what makes the join rule visible in the composer, not just in a test.
    else body = {
    text: window.fixture.liveTakes
      ? (runs === 1 ? 'This is a dictated sentence' : 'sentence about mouaif and the MediaRecorder API.')
      : 'This is a dictated sentence about mouaif and the MediaRecorder API.',
    model: { id: payload.modelId, provider: payload.providerId || 'openai-compatible' },
    kind: 'openai-compatible', bytes: 4096, durationMs: 812,
    usage: { promptTokens: 1000, completionTokens: 100 },
    cost: window.fixture.unpriced
      ? { input: 0, output: 0, total: 0, currency: 'USD', known: false }
      : { input: 0.0003, output: 0.00025, total: 0.00055, currency: 'USD', known: true }
    };
  } else if (url.pathname === '/api/chats') {
    body = { chats: [{ id: 'chat-1', title: 'Dictation fixture chat', draft: 'existing draft' }], total: 1 };
  } else if (url.pathname.startsWith('/api/chats/')) {
    body = { chat: { id: 'chat-1', title: 'Dictation fixture chat', draft: 'existing draft' } };
  }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

// ---- Fake microphone ---------------------------------------------------
//
// The recorder hands over audio on its timeslice, which is the whole of what
// "live" means from the browser's side: start(ms) emits a chunk every ms,
// and stop() emits the final (empty) one the real recorder also produces.
// The fake drives that on a short timer rather than waiting 3 seconds, so the
// composer-mic scenario shows the as-you-speak path in a couple of seconds.
class FakeMediaRecorder {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || 'audio/webm';
    this.state = 'inactive';
    this.chunks = 0;
    this.timer = null;
    window.fixture.lastRecorder = this;
  }
  static isTypeSupported(type) { return type.indexOf('mp4') < 0; }
  start(timeslice) {
    this.state = 'recording';
    if (this.onstart) this.onstart();
    if (timeslice) {
      this.timer = setInterval(() => {
        if (this.state !== 'recording') return;
        // A handful of timeslices, then the recorder stops being fed audio —
        // the same shape as a real take that ends without the user tapping.
        if (this.chunks >= (window.fixture.liveChunks || 2)) { clearInterval(this.timer); this.timer = null; return; }
        this.chunks += 1;
        if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) });
      }, window.fixture.liveChunkMs || 250);
    }
  }
  stop() {
    this.state = 'inactive';
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // The recorder's final chunk carries no audio.
    if (this.ondataavailable) this.ondataavailable({ data: new Blob([], { type: this.mimeType }) });
    if (this.ondataavailable && !this.chunks) this.ondataavailable({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) });
    if (this.onstop) this.onstop();
  }
}
window.MediaRecorder = FakeMediaRecorder;
const stream = { getTracks: () => [{ stop() { window.fixture.streamStopped = true; } }] };
if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} });
navigator.mediaDevices.getUserMedia = async () => stream;

// ---- Two surfaces, one page -------------------------------------------
function Host() {
  const [view, setView] = useState(location.hash.replace(/^#\\/?/, '') || 'page');
  const [micText, setMicText] = useState('');
  const [micStatus, setMicStatus] = useState('');
  // The real chat view remembers the live region of the draft and replaces it
  // on the take's final hand-off (see onTranscript in Chat.jsx). The fixture
  // keeps the same two facts so the composer-mic scenario shows the real
  // behaviour rather than a second implementation's: a live chunk replaces the
  // tail while the take runs, the settled hand-off replaces it once, and
  // anything that is not a live take appends.
  const tailRef = useRef(null);
  const onTranscript = (text, meta) => {
    const live = !!(meta && meta.live);
    const tail = tailRef.current;
    if (live) {
      setMicText((prev) => {
        const base = tail ? prev.slice(0, tail.start) : prev;
        return (base && !/\\s$/.test(base) ? base + ' ' : base) + text;
      });
      tailRef.current = { start: tail ? tail.start : micText.length, text };
      setMicStatus('live: ' + text);
      return;
    }
    if (tail) {
      const next = micText.slice(0, tail.start) + (text && micText.slice(0, tail.start) ? ' ' : '') + text;
      setMicText(next);
      tailRef.current = null;
      setMicStatus('added');
      return;
    }
    setMicText((prev) => (prev && !/\\s$/.test(prev) ? prev + ' ' : prev) + text);
    setMicStatus('added');
  };
  return h('div', { class: 'fixture' },
    h('nav', { class: 'fixture__switch' },
      ['page', 'composer', 'live-only', 'mixed'].map((name) => h('button', {
        key: name, type: 'button', class: 'btn' + (view === name ? ' btn--primary' : ''),
        onClick: () => {
          window.fixture.scenario = name === 'live-only' ? 'live' : (name === 'mixed' ? 'mixed' : 'project');
          location.hash = name;
          setView(name);
        }
      }, name === 'page' ? 'Dictation page' : (name === 'composer' ? 'Composer mic' : (name === 'mixed' ? 'Provider models' : 'No project models'))))
    ),
    view === 'composer'
      ? h('section', { class: 'chat-view' },
          h('div', { class: 'chat-view__composer' },
            h(MicButton, {
              projectDir: '/fixture/project',
              promptRef: { current: null },
              onTranscript,
              onStatus: (message) => setMicStatus(message),
              onProgress: (message) => setMicStatus(message)
            }),
            h('textarea', { class: 'input chat-view__textarea', value: micText, rows: 3, onInput: (e) => setMicText(e.target.value) })
          ),
          h('p', { class: 'status' }, micStatus)
        )
      : h(DictationView, { key: view + window.fixture.scenario })
  );
}
render(h(Host), document.getElementById('root'));
`,
    resolveDir: process.cwd(),
    sourcefile: 'dictation-ui-fixture.jsx',
    loader: 'jsx'
  },
  bundle: true,
  write: false,
  outdir: '/tmp/mouaif-dictation-ui-fixture',
  format: 'esm',
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl' },
  plugins: [{
    // MicButton navigates back to the dictation page on its empty state. The
    // real router owns the hash → route signal, which the fixture does not
    // want; the stub keeps `nav()`'s contract and nothing else. esbuild only
    // accepts package names as alias keys, so this is a resolve plugin.
    name: 'stub-router',
    setup(build) {
      build.onResolve({ filter: /(^|\/)router\.js$/ }, (args) => (
        args.path.startsWith('.')
          ? { path: new URL('./dictation-ui-fixture-router.js', import.meta.url).pathname }
          : null
      ));
    }
  }]
});

const files = Object.fromEntries(bundle.outputFiles.map((file) => [
  file.path.endsWith('.css') ? '/app.css' : '/app.js',
  file.text
]));

// `--write <dir>` emits the bundle instead of serving it, so the fixture can be
// served by any static server. That matters in this workspace: a long-lived
// node child started from a non-interactive shell gets reaped, while a python
// http.server survives, and the point of this fixture is to be *opened*.
const writeDirIndex = process.argv.indexOf('--write');
if (writeDirIndex !== -1) {
  const dir = process.argv[writeDirIndex + 1] || '/tmp/mouaif-dictation-ui';
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
  console.log('Dictation UI fixture written to ' + dir);
} else {
const server = http.createServer((req, res) => {
  if (files[req.url]) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(files[req.url]);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(INDEX_HTML);
  }
});
server.listen(0, '127.0.0.1', () => console.log('Dictation UI fixture: http://127.0.0.1:' + server.address().port));
setTimeout(() => { server.closeAllConnections(); server.close(); }, 10 * 60 * 1000);
}
