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
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
import { h, render } from 'preact';
import { useState } from 'preact/hooks';
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
window.fixture = { failTranscribe: false, recorded: [], settings: { dictation: { modelId: 'whisper-1', providerId: 'openai-compatible', kind: 'openai-compatible' } } };

window.fetch = async (input, options = {}) => {
  const url = new URL(input, location.origin);
  let body = {}, status = 200;
  if (url.pathname === '/api/settings') {
    if (options.method === 'PUT') {
      const patch = JSON.parse(options.body);
      Object.assign(window.fixture.settings, patch.dictation ? { dictation: patch.dictation } : {});
      body = { app: window.fixture.settings };
    } else {
      body = { app: window.fixture.settings, defaults: {}, home: '/tmp/mouaif' };
    }
  } else if (url.pathname === '/api/ai/transcribe/models') {
    body = { models: MODELS, kinds: KINDS, total: MODELS.length + 4 };
  } else if (url.pathname === '/api/ai/transcribe') {
    const payload = JSON.parse(options.body || '{}');
    window.fixture.recorded.push(payload);
    if (window.fixture.failTranscribe) { status = 401; body = { error: 'Incorrect API key provided', code: 'ENOAUTH' }; }
    else body = { text: 'This is a dictated sentence about mouaif and the MediaRecorder API.', model: { id: payload.modelId, provider: payload.providerId || 'openai-compatible' }, kind: 'openai-compatible', bytes: 4096, durationMs: 812 };
  } else if (url.pathname === '/api/chats') {
    body = { chats: [{ id: 'chat-1', title: 'Dictation fixture chat', draft: 'existing draft' }], total: 1 };
  } else if (url.pathname.startsWith('/api/chats/')) {
    body = { chat: { id: 'chat-1', title: 'Dictation fixture chat', draft: 'existing draft' } };
  }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

// ---- Fake microphone ---------------------------------------------------
class FakeMediaRecorder {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || 'audio/webm';
    this.state = 'inactive';
  }
  static isTypeSupported(type) { return type.indexOf('mp4') < 0; }
  start() { this.state = 'recording'; if (this.onstart) this.onstart(); }
  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) });
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
  return h('div', { class: 'fixture' },
    h('nav', { class: 'fixture__switch' },
      ['page', 'composer'].map((name) => h('button', {
        key: name, type: 'button', class: 'btn' + (view === name ? ' btn--primary' : ''),
        onClick: () => { location.hash = name; setView(name); }
      }, name === 'page' ? 'Dictation page' : 'Composer mic'))
    ),
    view === 'composer'
      ? h('section', { class: 'chat-view' },
          h('div', { class: 'chat-view__composer' },
            h(MicButton, {
              projectDir: '/fixture/project',
              onTranscript: (text) => { setMicText(micText ? micText + ' ' + text : text); setMicStatus('added'); }
            }),
            h('textarea', { class: 'input chat-view__textarea', value: micText, rows: 3, onInput: (e) => setMicText(e.target.value) })
          ),
          h('p', { class: 'status' }, micStatus)
        )
      : h(DictationView, null)
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

const server = http.createServer((req, res) => {
  if (files[req.url]) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(files[req.url]);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<link rel="stylesheet" href="/app.css"></head>'
      + '<body><main id="root" class="app__main app__main--flush"></main>'
      + '<script type="module" src="/app.js"></script></body></html>');
  }
});
server.listen(0, '127.0.0.1', () => console.log('Dictation UI fixture: http://127.0.0.1:' + server.address().port));
setTimeout(() => { server.closeAllConnections(); server.close(); }, 10 * 60 * 1000);
