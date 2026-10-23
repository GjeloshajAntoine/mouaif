'use strict';

// Shell review — the second model that reads a command before it is approved.
//
// What this test pins (docs/features/shell-review.md):
//
//   1. normalization: a legacy/hand-edited `shellReview` value reads safely,
//      an unknown mode falls back to `off`, and a missing prompt falls back to
//      the built-in one;
//   2. the request it builds: one system message (the review prompt) and one
//      user message (the command + working directory), no tools;
//   3. a review runs on the configured model — never the chat's — and is
//      priced with the same usage table the chat uses;
//   4. a failure never blocks the command: an off mode, a missing model, an
//      upstream error and a timeout all resolve `{ ok: false }` instead of
//      throwing, so the approval card simply has no verdict;
//   5. the automatic path reviews `always` once per call id (`ask` needs an
//      explicit `force`), and the verdict reaches both the pending approval
//      request and an `shell_review` event.
//
// No provider is contacted: `global.fetch` is replaced with a local SSE
// responder for each case.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.homedir(), '.mouaif-shell-review-'));
process.env.MOUAIF_HOME = home;

const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const authz = require('../src/tools/authorization.js');
const review = require('../src/shellReview.js');
const { handleTools } = require('../src/server-handlers-tools.js');

const projectDir = path.join(home, 'project');
fs.mkdirSync(projectDir);
// Providers global, models per project: the reviewer's connection lives in the
// app store and supplies the transport + credential; the project only names the
// provider + model id.
settings.setApp({
  providers: [{ id: 'openai-compatible', baseUrl: 'http://fixture/v1', apiKey: 'fixture-key' }]
});

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}
async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log('PASS  ' + name);
}

const originalFetch = global.fetch;
let fetchBody = null;
let fetchCount = 0;

// The reviewer's own provider: openai-compatible, keyless (a local endpoint
// shape works for this test), answering one SSE stream of text.
function mockProvider(text, { fail = false } = {}) {
  fetchCount = 0;
  global.fetch = async (_url, init) => {
    fetchCount++;
    fetchBody = JSON.parse(init.body);
    if (fail) {
      return new Response(JSON.stringify({ error: { message: 'upstream exploded' } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    const frames = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30 } }),
      'data: [DONE]'
    ];
    return new Response(frames.join('\n\n') + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
}

function configure(shellReview) {
  settings.setProject(projectDir, { shellReview });
}

// post(body) — drive the real REST handler with a fixture request/response.
// No HTTP server is started: handleTools owns the route and this test only
// needs the status + parsed body it answers with.
async function post(body) {
  const req = {
    method: 'POST',
    on(name, callback) {
      if (name === 'data') process.nextTick(() => callback(Buffer.from(JSON.stringify(body))));
      if (name === 'end') process.nextTick(callback);
    }
  };
  const res = {
    status: 0,
    data: '',
    writeHead(status) { this.status = status; },
    write(chunk) { this.data += chunk; },
    end(chunk) { this.data += chunk || ''; }
  };
  await handleTools(req, res, new URL('http://fixture/api/tools/shell/review'), null);
  let parsed = null;
  try { parsed = JSON.parse(res.data); } catch { parsed = res.data; }
  return { status: res.status, body: parsed };
}

async function main() {
  // ---- 1. normalization ---------------------------------------------------
  check('an unknown mode falls back to off', () => {
    assert.equal(review.normalize({ mode: 'sometimes' }).mode, 'off');
    assert.equal(review.normalize(null).mode, 'off');
    assert.equal(review.normalize('always').mode, 'off');
  });
  check('a blank prompt falls back to the built-in instruction', () => {
    const cfg = review.normalize({ mode: 'always', providerId: 'p', modelId: 'm', prompt: '   ' });
    assert.equal(cfg.prompt, review.DEFAULT_PROMPT);
    assert.match(cfg.prompt, /SAFE, CAUTION or DANGER/);
  });
  check('configured only needs a non-off mode (defaults to the app/chat model)', () => {
    assert.equal(review.configured({ mode: 'always', providerId: 'p', modelId: 'm' }), true);
    assert.equal(review.configured({ mode: 'always' }), true);
    assert.equal(review.configured({ mode: 'off', providerId: 'p', modelId: 'm' }), false);
  });
  check('autoAllow defaults to true unless explicitly false', () => {
    assert.equal(review.normalize({ mode: 'always' }).autoAllow, true);
    assert.equal(review.normalize({ mode: 'always', autoAllow: false }).autoAllow, false);
  });
  check('a very long command is capped and says it was', () => {
    const capped = review.clampCommand('x'.repeat(9000));
    assert.ok(capped.length < 9000 + 100);
    assert.match(capped, /command truncated/);
  });

  // ---- 2. the request -----------------------------------------------------
  check('the request is the prompt + the command and its folder, with no tools', () => {
    const messages = review.buildMessages({ prompt: 'Review this.', cmd: 'ls -la', cwd: '/p/dir' });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, 'Review this.');
    assert.match(messages[1].content, /Working directory: \/p\/dir/);
    assert.match(messages[1].content, /ls -la/);
  });
  check('the verdict is the last recognised word of the answer', () => {
    assert.deepEqual(review.parseReview('Deletes files.\nDANGER'), { text: 'Deletes files.\nDANGER', verdict: 'DANGER' });
    assert.equal(review.parseReview('Nothing to report').verdict, '');
    assert.equal(review.parseReview('CAUTION: then SAFE?' ).verdict, 'SAFE');
  });

  // ---- 3. a review on the same model as the app (or an explicit pin) -------
  configure({ mode: 'ask', providerId: 'openai-compatible', modelId: 'reviewer-model', prompt: 'What does this do?' });
  mockProvider('Deletes the build folder.\nCAUTION');
  await checkAsync('a review runs on the configured reviewer and is priced', async () => {
    const out = await review.reviewCommand({ projectDir, cmd: 'rm -rf build', cwd: projectDir });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.model.id, 'reviewer-model');
    assert.equal(out.verdict, 'CAUTION');
    assert.match(out.text, /Deletes the build folder/);
    // Priced through src/usage.js: an unknown model id leaves the price
    // unknown rather than guessing zero, and the usage is reported.
    assert.ok(out.usage && out.usage.promptTokens === 120);
    assert.equal(typeof out.cost.known, 'boolean');
    // The reviewer is a single no-tool turn: it must not be advertised a tool
    // surface, or it could act instead of answering.
    assert.equal(fetchBody.tools, undefined);
    assert.equal(fetchBody.messages[0].content, 'What does this do?');
  });
  await checkAsync('when no reviewer model is pinned, review uses the chat model automatically', async () => {
    const chat = chats.createChat(projectDir, { title: 'Chat model review' });
    chats.updateChat(projectDir, chat.id, { providerId: 'openai-compatible', modelId: 'chat-main-model' });
    configure({ mode: 'always', prompt: 'Check safety.' });
    mockProvider('Read-only listing.\nSAFE');
    const out = await review.reviewCommand({ projectDir, chatId: chat.id, cmd: 'ls -la', cwd: projectDir });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.model.id, 'chat-main-model', 'falls back to the chat model');
    assert.equal(out.verdict, 'SAFE');
  });

  // ---- 4. failures never block a command ----------------------------------
  await checkAsync('an off mode refuses without contacting a provider', async () => {
    configure({ mode: 'off', providerId: 'openai-compatible', modelId: 'reviewer-model' });
    mockProvider('should not be called');
    const out = await review.reviewCommand({ projectDir, cmd: 'echo hi' });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'EREVIEW_OFF');
    assert.equal(fetchCount, 0);
  });
  await checkAsync('when no model exists anywhere in the project or chats, returns EREVIEW_MODEL', async () => {
    const emptyProject = path.join(home, 'empty-project');
    fs.mkdirSync(emptyProject, { recursive: true });
    settings.setProject(emptyProject, { shellReview: { mode: 'always' } });
    mockProvider('should not be called');
    const out = await review.reviewCommand({ projectDir: emptyProject, cmd: 'echo hi' });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'EREVIEW_MODEL');
    assert.equal(fetchCount, 0);
  });
  await checkAsync('an upstream failure resolves ok:false instead of throwing', async () => {
    configure({ mode: 'ask', providerId: 'openai-compatible', modelId: 'reviewer-model' });
    mockProvider('ignored', { fail: true });
    const out = await review.reviewCommand({ projectDir, cmd: 'echo hi' });
    assert.equal(out.ok, false);
    assert.equal(typeof out.error, 'string');
  });
  await checkAsync('an already-aborted signal resolves ok:false', async () => {
    configure({ mode: 'ask', providerId: 'openai-compatible', modelId: 'reviewer-model' });
    mockProvider('never seen');
    const controller = new AbortController();
    controller.abort();
    const out = await review.reviewCommand({ projectDir, cmd: 'echo hi', signal: controller.signal });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'EABORTED');
  });
  await checkAsync('no command is an input error', async () => {
    const out = await review.reviewCommand({ projectDir, cmd: '  ' });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'EBADINPUT');
  });

  // ---- 5. the automatic path ----------------------------------------------
  await checkAsync('ask mode starts nothing without force; always mode reviews once per call', async () => {
    const chat = chats.createChat(projectDir, { title: 'Review chat' });
    configure({ mode: 'ask', providerId: 'openai-compatible', modelId: 'reviewer-model' });
    mockProvider('Safe enough.\nSAFE');
    assert.equal(review.startReview({ projectDir, chatId: chat.id, callId: 'call-a', cmd: 'ls', onEvent: () => {} }), null,
      'ask mode does not review a model call on its own');
    assert.equal(fetchCount, 0);

    configure({ mode: 'always', providerId: 'openai-compatible', modelId: 'reviewer-model' });
    mockProvider('Safe enough.\nSAFE');
    const events = [];
    const first = review.startReview({ projectDir, chatId: chat.id, callId: 'call-b', cmd: 'ls', onEvent: (n, d) => events.push({ n, d }) });
    const second = review.startReview({ projectDir, chatId: chat.id, callId: 'call-b', cmd: 'ls', onEvent: (n, d) => events.push({ n, d }) });
    assert.ok(first && second);
    assert.equal(first, second, 'the same call id reuses one request');
    const out = await first;
    assert.equal(out.ok, true);
    assert.equal(fetchCount, 1, 'one request for one call id');
    assert.equal(events.length, 1);
    assert.equal(events[0].n, 'shell_review');
    assert.equal(events[0].d.id, 'call-b');
    assert.equal(events[0].d.verdict, 'SAFE');
  });

  await checkAsync('when autoAllow is enabled (default), a SAFE verdict auto-allows the pending command on Ask', async () => {
    const chat = chats.createChat(projectDir, { title: 'Auto-allow chat', providerId: 'openai-compatible', modelId: 'chat-main-model' });
    configure({ mode: 'always' });
    mockProvider('Reads a file.\nSAFE');
    const pending = await authz.authorize({
      projectDir, chatId: chat.id, callId: 'call-auto', tool: 'shell',
      cmd: 'cat README.md', summary: 'cat README.md'
    });
    assert.equal(pending.decision, 'prompt');
    const reviewOut = await review.startReview({ projectDir, chatId: chat.id, callId: 'call-auto', cmd: 'cat README.md', onEvent: () => {} });
    assert.equal(reviewOut.autoAllowed, true, 'SAFE verdict marks autoAllowed: true');
    const decision = await pending.wait;
    assert.equal(decision.decision, 'allow', 'pending prompt is automatically resolved as allowed');
    assert.equal(authz.listPending(projectDir, chat.id).length, 0, 'no longer pending');
  });

  await checkAsync('CAUTION / DANGER verdicts (or autoAllow: false) stay parked on the pending approval request', async () => {
    const chat = chats.createChat(projectDir, { title: 'Pending chat' });
    configure({ mode: 'always', providerId: 'openai-compatible', modelId: 'reviewer-model' });
    mockProvider('Modifies files.\nCAUTION');
    // Park a real approval request, then let the review attach to it.
    const pending = await authz.authorize({
      projectDir, chatId: chat.id, callId: 'call-c', tool: 'shell',
      cmd: 'rm -rf build', summary: 'rm -rf build'
    });
    assert.equal(pending.decision, 'prompt');
    review.startReview({ projectDir, chatId: chat.id, callId: 'call-c', cmd: 'rm -rf build', onEvent: () => {} });
    // The attach happens in the promise's `.then`; wait on the pending entry
    // rather than a timer, then read it through the public list.
    for (let i = 0; i < 100 && !authz.listPending(projectDir, chat.id)[0].review; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const recovered = authz.listPending(projectDir, chat.id)[0];
    assert.ok(recovered.review, 'a reconnecting client still sees the verdict');
    assert.equal(recovered.review.verdict, 'CAUTION');
    assert.equal(recovered.review.autoAllowed, false);
    assert.equal(recovered.details.workingDirectory, projectDir);
    assert.equal(settings.getProject(projectDir).shellReview.mode, 'always');
    assert.equal(settings.getProject(projectDir).tools, undefined, 'reviewing grants no permanent tool permission');
    authz.recordDecision(projectDir, chat.id, 'call-c', 'deny');
    await assert.rejects(pending.wait, (e) => e.code === 'EDENIED');
  });

  await checkAsync('attachReview reports false once the call is no longer pending', async () => {
    assert.equal(authz.attachReview(projectDir, 'no-such-chat', 'call-x', { ok: true, text: 'x' }), false);
    assert.equal(authz.attachReview(projectDir, 'c', '', { ok: true }), false);
  });

  // ---- 6. the REST route --------------------------------------------------
  await checkAsync('POST /api/tools/shell/review answers a review and attributes its cost', async () => {
    const subDir = path.join(projectDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    const chat = chats.createChat(projectDir, { title: 'Route chat' });
    chats.updateChat(projectDir, chat.id, { workingDir: subDir });
    configure({ mode: 'ask', providerId: 'openai-compatible', modelId: 'reviewer-model' });
    mockProvider('Lists the folder.\nSAFE');
    const res = await post({ projectDir, chatId: chat.id, cmd: 'ls' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.verdict, 'SAFE');
    assert.match(fetchBody.messages[1].content, new RegExp('Working directory: ' + subDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the route defaults cwd from the chat working folder when omitted');
    // A review is priced work that is not a chat turn: when the chat is named,
    // its persisted total carries it (the dictation rule).
    assert.equal(typeof chats.getChat(projectDir, chat.id).totalCost.total, 'number');
  });
  await checkAsync('the route refuses an off mode with 409 and no provider call', async () => {
    configure({ mode: 'off', providerId: 'openai-compatible', modelId: 'reviewer-model' });
    mockProvider('should not be called');
    const res = await post({ projectDir, cmd: 'ls' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'EREVIEW_OFF');
    assert.equal(fetchCount, 0);
  });
  await checkAsync('the route rejects a missing command and an unknown chat', async () => {
    configure({ mode: 'ask', providerId: 'openai-compatible', modelId: 'reviewer-model' });
    assert.equal((await post({ projectDir, cmd: '  ' })).status, 400);
    assert.equal((await post({ projectDir, chatId: 'nope', cmd: 'ls' })).status, 404);
  });

  console.log('\n' + passed + ' assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = originalFetch;
  fs.rmSync(home, { recursive: true, force: true });
});
