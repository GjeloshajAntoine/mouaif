// Ask-user card UI fixture — the real card, the real stylesheet, a stub
// transcript.
//
// Run `node scripts/ask-ui-fixture.mjs --write /tmp/mouaif-ask-ui` and serve
// the directory with any static server (a long-lived node child started from a
// non-interactive shell gets reaped; python's http.server survives), then open
// it at 390px wide. The page mounts overlay cards through the same
// `mountOverlayCard` / `askUserCard` path the chat uses, so what this shows is
// what the chat shows — the parts a build cannot check and a unit test cannot
// render (option rows clipped by the scroll cap, a card left behind after a
// cancel, a tool_call card and a pending ask card both claiming one call id).
//
// The page exposes `window.fixture`:
//   fixture.live()         mount the live ask card (3 options)
//   fixture.long()         mount a card with long option descriptions
//   fixture.many()         mount a card with 8 options
//   fixture.pair()         call card then the live card for the SAME call id
//                          (two raw cards: the app's caller de-dupes first —
//                          see the note in the scenario)
//   fixture.dismissed()    a question the user dismissed (the frame is ok:false)
//   fixture.cancel()       the Stop path: removePendingAuthorizationCards()
//   fixture.measure()      geometry of every ask card and option row
//   fixture.html()         the transcript's outerHTML
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const INDEX_HTML = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<link rel="stylesheet" href="/app.css"></head>'
  + '<body><main id="root" class="app__main"></main>'
  + '<script type="module" src="/app.js"></script></body></html>';

const bundle = await build({
  stdin: {
    contents: `
import { h, render } from 'preact';
import { useState, useRef } from 'preact/hooks';
import { askUserCard, removePendingAuthorizationCards } from './frontend/src/components/chat/cards.js';
import { appendToolCallCard, appendToolResultCard } from './frontend/src/components/chat/transcript.js';
import { mountOverlayCard } from './frontend/src/components/chat/overlay.js';
import './frontend/src/style.css';

// The chat's imperative renderer writes into a refs bag of { current }
// objects. Only the members the card paths actually touch are stubbed.
const refs = {
  transcript: { current: null },
  pinnedToBottom: { current: true },
  pendingCount: { current: 0 },
  jumpBtn: { current: null },
  _suspendScrollPin: false
};
let status = '';

const OPTIONS = [
  { label: 'main', value: 'main', description: 'the canonical default branch' },
  { label: 'trunk', value: 'trunk', description: 'the release line we cut from' },
  { label: 'develop', value: 'develop', description: 'integration branch for the next release' }
];
const LONG = [
  { label: 'Keep every notification', value: 'all', description: 'Status updates, authorizations and completions all raise a notification, including the ones you have already seen in the app.' },
  { label: 'Only what needs me', value: 'attention', description: 'Authorizations and questions interrupt; progress and completion stay silent until you open the chat again.' }
];
const MANY = Array.from({ length: 8 }, (_, i) => ({
  label: 'Option ' + (i + 1),
  value: 'opt' + (i + 1),
  description: 'what picking option ' + (i + 1) + ' means for this project'
}));
// Descriptions long enough to wrap onto a second line on a 390px phone: the
// three-line rows are what make the scroll cap cut a row in half.
const WRAP = ['Keep every notification', 'Only what needs me right now', 'Ask me later when the chat is idle', 'Nothing at all, stay quiet', 'Notify the desktop only'].map((label, i) => ({
  label, value: 'v' + i,
  description: 'Status updates, authorizations and completions all raise a notification, including the ones you have already seen in this app.'
}));

function cardData(options, extra) {
  return Object.assign({
    tool: 'ask_user', projectDir: '/fixture/project',
    question: 'Which branch should the release be cut from?',
    options, multiSelect: false, presets: []
  }, extra || {});
}
function mount(options, extra, callId) {
  const id = callId || ('call_' + Math.random().toString(36).slice(2, 8));
  const data = Object.assign({ callId: id }, cardData(options, extra));
  mountOverlayCard(refs, id, () => askUserCard(data, '/fixture/project', 'chat_fixture', refs, (txt, st) => { status = txt + ' (' + st + ')'; }));
  return id;
}

function measure() {
  const t = refs.transcript.current;
  const tRect = t.getBoundingClientRect();
  const cards = Array.from(t.querySelectorAll('.tool-card')).map((card) => {
    const opts = card.querySelector('.tool-card__ask-options');
    const oRect = opts ? opts.getBoundingClientRect() : null;
    const rows = Array.from(card.querySelectorAll('.tool-card__ask-option')).map((el) => {
      const r = el.getBoundingClientRect();
      const desc = el.querySelector('.tool-card__ask-option-desc');
      const dRect = desc ? desc.getBoundingClientRect() : null;
      return {
        label: el.querySelector('.tool-card__ask-option-label').textContent,
        top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
        insideList: oRect ? (r.top >= oRect.top - 0.5 && r.bottom <= oRect.bottom + 0.5) : null,
        descBottom: dRect ? Math.round(dRect.bottom) : null,
        descInsideList: (dRect && oRect) ? (dRect.bottom <= oRect.bottom + 0.5) : null
      };
    });
    return {
      classes: card.className,
      authCallId: card.dataset.authCallId || null,
      toolId: card.dataset.toolId || null,
      head: card.querySelector('.tool-card__head') ? card.querySelector('.tool-card__head').textContent : null,
      args: card.querySelector('.tool-card__args') ? card.querySelector('.tool-card__args').textContent : null,
      summary: card.querySelector('.tool-card__result-summary') ? card.querySelector('.tool-card__result-summary').textContent : null,
      question: card.querySelector('.tool-card__ask-question') ? card.querySelector('.tool-card__ask-question').textContent : null,
      listClientHeight: opts ? opts.clientHeight : null,
      listScrollHeight: opts ? opts.scrollHeight : null,
      listTop: oRect ? Math.round(oRect.top) : null,
      listBottom: oRect ? Math.round(oRect.bottom) : null,
      rows
    };
  });
  return { status, viewport: { w: innerWidth, h: innerHeight }, transcript: { top: Math.round(tRect.top), bottom: Math.round(tRect.bottom) }, cards };
}

function reset() {
  const t = refs.transcript.current;
  t.innerHTML = '';
  // mountOverlayCard refuses to mount into an empty transcript (a rebuild
  // would wipe the card), so the fixture always keeps one painted row.
  const row = document.createElement('div');
  row.className = 'chat-msg chat-msg--user';
  const body = document.createElement('div');
  body.className = 'chat-msg__body';
  body.textContent = 'Which branch should the release be cut from?';
  row.appendChild(body);
  t.appendChild(row);
  status = '';
}

function frame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function Host() {
  const [stamp, setStamp] = useState(0);
  const bump = () => setStamp((v) => v + 1);
  const t = useRef(null);
  const attach = (el) => { t.current = el; refs.transcript.current = el; if (el && !el.dataset.seeded) { el.dataset.seeded = '1'; reset(); } };
  window.fixture = {
    // mountOverlayCard defers through whenTranscriptSettled, so every scenario
    // yields two frames before it can be measured or screenshotted.
    live: async () => { reset(); mount(OPTIONS); bump(); await frame(); },
    long: async () => { reset(); mount(LONG); bump(); await frame(); },
    many: async () => { reset(); mount(MANY, { presets: ['use the default', 'ask me later'] }); bump(); await frame(); },
    wrap: async () => { reset(); mount(WRAP, { presets: ['Ask me later'] }); bump(); await frame(); },
    pair: async () => {
    reset();
    const id = 'call_dup_fixture';
    // Both primitives for one call id, in the order the transcript rebuild
    // writes them: the persisted call row first ...
    appendToolCallCard({ id, name: 'ask_user', args: { question: 'Which branch should the release be cut from?', options: OPTIONS, multiSelect: false } }, refs, true);
    // ... then the live card the pending queue mounts.
    mount(OPTIONS, null, id);
    bump();
    await frame();
    // NOTE: two cards is this scenario's raw output, not what the app shows.
    // appendToolCallCard is called directly here, so the caller's de-dup never
    // runs; in the app this order is caught earlier, by renderMessageRow, which
    // skips the call row when a card already carries that data-tool-id — and an
    // ask_user overlay card carries both ids. The resolve() scenario is the
    // order that reaches appendToolCallCard (the question is up, then the call
    // frames arrive) and is where "one card must survive" is checked.
    },
    // The live order: the question is on screen, then the call's own
    // tool_call / tool_result frames arrive because the answer was submitted
    // from the OS notification or a second tab (this tab never saw the
    // click). One card must survive, not two.
    resolve: async () => {
    reset();
    const id = 'call_dup_fixture';
    mount(OPTIONS, null, id);
    await frame();
    const args = { question: 'Which branch should the release be cut from?', options: OPTIONS, multiSelect: false };
    appendToolCallCard({ id, name: 'ask_user', args }, refs, true);
    appendToolResultCard({
      id, name: 'ask_user', ok: true,
      result: { answered: true, choice: 'main', extra: '', options: OPTIONS.map((o) => ({ label: o.label, value: o.value })), multiSelect: false, cancelled: false }
    }, refs, true);
    bump();
    await frame();
    },
    // The reverse order, and the duplicate that survived the first fix: the
    // call card is already up (the answer came from another tab, so this tab
    // never saw the click) and a LATE mount path — the reconcile poll's
    // pending snapshot, or a live-replay reconnect — tries to mount the
    // question again. authCardGuard() must see the call card as that call's
    // existing representation and refuse, leaving exactly one card.
    late: async () => {
    reset();
    const id = 'call_late_fixture';
    const args = { question: 'Which branch should the release be cut from?', options: OPTIONS, multiSelect: false };
    appendToolCallCard({ id, name: 'ask_user', args }, refs, true);
    appendToolResultCard({
      id, name: 'ask_user', ok: true,
      result: { answered: true, choice: 'main', extra: '', options: OPTIONS.map((o) => ({ label: o.label, value: o.value })), multiSelect: false, cancelled: false }
    }, refs, true);
    // A real mount attempt through the shared guard (not a direct call), so
    // what is measured is the production de-dupe, not the fixture's markup.
    mountOverlayCard(refs, id, () => askUserCard(
      Object.assign({ callId: id }, cardData(OPTIONS)),
      '/fixture/project', 'chat_fixture', refs, (txt) => { status = txt; }
    ));
    bump();
    await frame();
    },
    // A prompt for a call with nothing on screen must still mount: the
    // guard must not block the ordinary first render.
    fresh: async () => { reset(); mount(OPTIONS, null, 'call_fresh_fixture'); bump(); await frame(); },
    cancel: async () => { removePendingAuthorizationCards(refs); bump(); await frame(); },
    // A question the user DISMISSED: the runner answers it with ok:false and
    // cancelled:true, so the collapsed card has to report the dismissal
    // instead of leaving it as a bare error (see isExpectedToolFailure).
    dismissed: async () => {
      reset();
      const id = 'call_dismiss_fixture';
      appendToolCallCard({ id, name: 'ask_user', args: { question: 'Which branch?', options: OPTIONS, multiSelect: false } }, refs, true);
      appendToolResultCard({
        id, name: 'ask_user', ok: false,
        result: { answered: false, choice: '', extra: '', options: OPTIONS.map((o) => ({ label: o.label, value: o.value })), multiSelect: false, cancelled: true }
      }, refs, true);
      bump();
      await frame();
    },
    reset: async () => { reset(); bump(); await frame(); },
    frame, measure, html: () => refs.transcript.current.outerHTML
  };
  return h('section', { class: 'chat-view', style: 'height:100dvh' },
    h('div', { class: 'chat-view__transcript', ref: attach })
  );
}
render(h(Host), document.getElementById('root'));
`,
    resolveDir: process.cwd(),
    sourcefile: 'ask-ui-fixture.jsx',
    loader: 'jsx'
  },
  bundle: true,
  write: false,
  outdir: '/tmp/mouaif-ask-ui-fixture',
  format: 'esm',
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl' }
});

const files = Object.fromEntries(bundle.outputFiles.map((file) => [
  file.path.endsWith('.css') ? '/app.css' : '/app.js',
  file.text
]));

const writeDirIndex = process.argv.indexOf('--write');
if (writeDirIndex !== -1) {
  const dir = process.argv[writeDirIndex + 1] || '/tmp/mouaif-ask-ui';
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
  console.log('Ask UI fixture written to ' + dir);
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
  server.listen(0, '127.0.0.1', () => console.log('Ask UI fixture: http://127.0.0.1:' + server.address().port));
  setTimeout(() => { server.closeAllConnections(); server.close(); }, 10 * 60 * 1000);
}
