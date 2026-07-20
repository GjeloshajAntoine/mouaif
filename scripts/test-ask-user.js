'use strict';

// End-to-end smoke test for the new ask_user native tool
// (src/tools/ask.js) and the ask_user branch of the authorization
// module. Covers the runner payload shape, the binary-mode gate, the
// per-chat session grant, the `off` denial, the `ask` -> payload
// round trip via recordDecision, and the question-payload validation
// rules the dispatcher relies on. Prints a pass/fail summary and
// exits non-zero on any failure.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-ask-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-ask-project-'));
process.env.MOUAIF_HOME = home;

const settings = require('../src/settings.js');
const authz = require('../src/tools/authorization.js');
const ask = require('../src/tools/ask.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

async function main() {
  // 1) Module shape.
  check('exports SPEC', ask.SPEC && ask.SPEC.type === 'function' && ask.SPEC.function && ask.SPEC.function.name === 'ask_user');
  const params = ask.SPEC.function.parameters;
  check('SPEC has question param', params.properties.question && params.properties.question.type === 'string');
  check('SPEC has options array', params.properties.options && params.properties.options.type === 'array');
  check('SPEC has no options cap', params.properties.options.maxItems === undefined);
  check('SPEC still requires 2+ options', params.properties.options.minItems === 2);
  check('SPEC requires options', Array.isArray(params.required) && params.required.indexOf('options') !== -1);

  // 2) validateArgs — happy path.
  const ok = ask.validateArgs({
    question: 'Pick a default branch?',
    options: [
      { label: 'main', value: 'main', description: 'the canonical default' },
      { label: 'trunk', value: 'trunk' }
    ],
    multiSelect: false
  });
  check('happy path: question', ok.question === 'Pick a default branch?');
  check('happy path: 2 options', ok.options.length === 2);
  check('happy path: multiSelect false', ok.multiSelect === false);

  // 3) validateArgs — multiSelect defaults to false.
  const noMs = ask.validateArgs({
    question: 'q',
    options: [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }]
  });
  check('multiSelect defaults to false', noMs.multiSelect === false);

  // 4) validateArgs — long lists are allowed (the UI scrolls).
  const many = ask.validateArgs({
    question: 'q',
    options: [
      { label: 'a', value: 'a' },
      { label: 'b', value: 'b' },
      { label: 'c', value: 'c' },
      { label: 'd', value: 'd' },
      { label: 'e', value: 'e' },
      { label: 'f', value: 'f' },
      { label: 'g', value: 'g' },
      { label: 'h', value: 'h' }
    ]
  });
  check('8 options is allowed', many.options.length === 8);

  // 6) validateArgs — rejects 1 option.
  assert.throws(() => ask.validateArgs({
    question: 'q',
    options: [{ label: 'a', value: 'a' }]
  }), { code: 'EBADINPUT' });

  // 7) validateArgs — rejects duplicate value.
  assert.throws(() => ask.validateArgs({
    question: 'q',
    options: [{ label: 'a', value: 'x' }, { label: 'b', value: 'x' }]
  }), { code: 'EBADINPUT' });

  // 8) validateArgs — rejects empty question.
  assert.throws(() => ask.validateArgs({ question: '   ', options: [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }] }), { code: 'EBADINPUT' });
  assert.throws(() => ask.validateArgs({ options: [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }] }), { code: 'EBADINPUT' });

  // 9) validateArgs — rejects missing label or value.
  assert.throws(() => ask.validateArgs({ question: 'q', options: [{ label: 'a' }, { label: 'b', value: 'b' }] }), { code: 'EBADINPUT' });
  assert.throws(() => ask.validateArgs({ question: 'q', options: [{ value: 'a' }, { label: 'b', value: 'b' }] }), { code: 'EBADINPUT' });

  // 10) validateArgs — trims whitespace and clamps lengths.
  const clamped = ask.validateArgs({
    question: '  short  ',
    options: [
      { label: '  a  ', value: '  a  ', description: '   ' },
      { label: 'b', value: 'b' }
    ]
  });
  check('trims question', clamped.question === 'short');
  check('trims option label', clamped.options[0].label === 'a');
  check('trims option value', clamped.options[0].value === 'a');
  check('drops empty description', clamped.options[0].description === '');

  // 11) buildResult — answered.
  const r1 = ask.buildResult({
    choice: 'main',
    extra: 'use the trunk for hotfixes too',
    options: [{ label: 'main', value: 'main' }, { label: 'trunk', value: 'trunk' }],
    multiSelect: false
  });
  check('answered ok', r1.ok === true);
  check('answered result.answered', r1.result.answered === true);
  check('answered result.choice', r1.result.choice === 'main');
  check('answered result.extra', r1.result.extra === 'use the trunk for hotfixes too');
  check('answered result.cancelled', r1.result.cancelled === false);

  // 12) buildResult — multi-select.
  const r2 = ask.buildResult({
    choice: ['a', 'c'],
    extra: '',
    options: [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }, { label: 'c', value: 'c' }],
    multiSelect: true
  });
  check('multiSelect result.choice is array', Array.isArray(r2.result.choice));
  check('multiSelect result.choice length', r2.result.choice.length === 2);
  check('multiSelect result.choice[0]', r2.result.choice[0] === 'a');
  check('multiSelect result.choice[1]', r2.result.choice[1] === 'c');

  // 13) buildResult — cancelled.
  const r3 = ask.buildResult({
    choice: '',
    extra: '',
    options: [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }],
    multiSelect: false,
    cancelled: true
  });
  check('cancelled ok=false', r3.ok === false);
  check('cancelled result.cancelled', r3.result.cancelled === true);

  // 14) clampExtra — trims, clamps length.
  check('clampExtra trims', ask.clampExtra('   hi   ') === 'hi');
  check('clampExtra empty', ask.clampExtra('') === '');
  check('clampExtra clamps', ask.clampExtra('a'.repeat(1500)).length === ask.MAX_EXTRA_CHARS);

  // 15) Authorization — binary mode: `off` returns ETOOL_DISABLED.
  settings.setProject(projectDir, {
    chats: [{ id: 'ask00001', title: 'Ask test', trace: false }],
    tools: { ask_user: { mode: 'off' } }
  });
  await assert.rejects(
    authz.authorize({ projectDir, chatId: 'ask00001', callId: 'call_off', tool: 'ask_user' }),
    { code: 'ETOOL_DISABLED' }
  );

  // 16) Authorization — `ask` always prompts (no allowlist / allow shortcuts).
  settings.setProject(projectDir, {
    tools: { ask_user: { mode: 'ask' } }
  });
  const asked = await authz.authorize({
    projectDir, chatId: 'ask00001', callId: 'call_ask', tool: 'ask_user'
  });
  check('ask_user always prompts in ask mode', asked.decision === 'prompt');

  // 17) Authorization — even with a legacy `allow` value in the project
  //     file, the binary-mode clamp forces `ask`. A future migration
  //     can't bypass the prompt.
  settings.setProject(projectDir, {
    tools: { ask_user: { mode: 'allow' } }
  });
  const config = authz.getAuthorization(projectDir);
  check('legacy allow clamps to ask', config.tools.ask_user.mode === 'ask');

  // 18) recordDecision — payload round trip.
  settings.setProject(projectDir, { tools: { ask_user: { mode: 'ask' } } });
  authz.clearGrants(projectDir, 'ask00001');
  const gate = await authz.authorize({
    projectDir, chatId: 'ask00001', callId: 'call_payload', tool: 'ask_user'
  });
  assert.equal(gate.decision, 'prompt');
  const waitPromise = gate.wait;
  // Decision with payload — resolves the wait() with the payload.
  const payload = { choice: 'main', extra: 'prefer stable' };
  authz.recordDecision(projectDir, 'ask00001', 'call_payload', 'allow-once', payload);
  const resolved = await waitPromise;
  check('payload round trip: decision=allow', resolved.decision === 'allow');
  check('payload round trip: payload.choice', resolved.payload && resolved.payload.choice === 'main');
  check('payload round trip: payload.extra', resolved.payload && resolved.payload.extra === 'prefer stable');

  // 19) recordDecision — without payload, wait() still resolves with
  //     the original { decision: 'allow' } shape (backwards compat).
  const gate2 = await authz.authorize({
    projectDir, chatId: 'ask00001', callId: 'call_no_payload', tool: 'ask_user'
  });
  const waitPromise2 = gate2.wait;
  authz.recordDecision(projectDir, 'ask00001', 'call_no_payload', 'allow-once');
  const resolved2 = await waitPromise2;
  check('no payload: decision=allow', resolved2.decision === 'allow');
  check('no payload: no payload key', !resolved2.payload);

  // 20) recordDecision — deny rejects.
  const gate3 = await authz.authorize({
    projectDir, chatId: 'ask00001', callId: 'call_deny', tool: 'ask_user'
  });
  await assert.rejects(
    new Promise((resolve, reject) => {
      gate3.wait.then(resolve, reject);
      authz.recordDecision(projectDir, 'ask00001', 'call_deny', 'deny');
    }),
    { code: 'EDENIED' }
  );

  // 21) Tool listing — ask_user shows up alongside shell / subagent.
  const all = authz.getAuthorization(projectDir);
  check('authorization.tools.ask_user present', all && all.tools && all.tools.ask_user);
  check('authorization.tools.shell present', all && all.tools && all.tools.shell);
  check('authorization.tools.subagent present', all && all.tools && all.tools.subagent);
  check('authorization.tools.file present', all && all.tools && all.tools.file);

  // 22) Regression: a deny on ask_user must NOT poison the session. A
  //     later authorize for the same (or a new) callId must still prompt,
  //     never auto-EDENIED — otherwise the model sees a spurious
  //     `cancelled: true` for a question the user was never asked.
  authz.clearGrants(projectDir, 'ask00001');
  const denyGate = await authz.authorize({ projectDir, chatId: 'ask00001', callId: 'call_reissue', tool: 'ask_user' });
  assert.equal(denyGate.decision, 'prompt');
  await assert.rejects(
    new Promise((resolve, reject) => {
      denyGate.wait.then(resolve, reject);
      authz.recordDecision(projectDir, 'ask00001', 'call_reissue', 'deny');
    }),
    { code: 'EDENIED' }
  );
  // Same callId re-issued: still prompts (not auto-denied).
  const reGate = await authz.authorize({ projectDir, chatId: 'ask00001', callId: 'call_reissue', tool: 'ask_user' });
  check('deny does not poison re-issued callId', reGate.decision === 'prompt');
  // Resolve it with an answer so we don't leak a pending entry.
  authz.recordDecision(projectDir, 'ask00001', 'call_reissue', 'allow-once', { choice: 'a', extra: '' });
  await reGate.wait;

  // 23) Regression: allow-session on ask_user must NOT create a session
  //     grant. The next call must still prompt — ask_user has no
  //     "remember this" semantics, the user is always the source of truth.
  authz.clearGrants(projectDir, 'ask00001');
  const s1 = await authz.authorize({ projectDir, chatId: 'ask00001', callId: 'call_sess1', tool: 'ask_user' });
  assert.equal(s1.decision, 'prompt');
  authz.recordDecision(projectDir, 'ask00001', 'call_sess1', 'allow-session', { choice: 'a', extra: '' });
  await s1.wait;
  const s2 = await authz.authorize({ projectDir, chatId: 'ask00001', callId: 'call_sess2', tool: 'ask_user' });
  check('allow-session creates no grant for ask_user', s2.decision === 'prompt');
  authz.recordDecision(projectDir, 'ask00001', 'call_sess2', 'allow-once', { choice: 'b', extra: '' });
  await s2.wait;

  console.log('ask_user tool: ' + passed + ' passed, ' + failed + ' failed');
}

main().finally(() => {
  settings.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
