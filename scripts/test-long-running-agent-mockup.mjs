// Browser coverage for the long-running agent mockup.
//
// The mockup is a review harness: it renders the chat view with the
// production stylesheet and the production transcript renderers, plus a
// mockup-local long-running run card and a run designer. It never calls an
// app API, a provider, a tool runner or a settings store.
//
// What this checks:
//   * the page loads with no runtime error, at phone widths (360/390/430);
//   * the run designer opens, creates a run, and the run card appears;
//   * the live tweak path applies a change without restarting the run;
//   * pause / resume / skip / stop change the run state;
//   * nothing escapes the viewport (no horizontal overflow) and every action
//     control is at least a 44 px tap target.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { serveMockup } from './long-running-agent-mockup.mjs';
const require = createRequire(import.meta.url);
const { findChrome, createCdp, freePort } = require('./lib/capture-fixture.js');

const server = await serveMockup();
let chrome, cdp, profile;
try {
  const binary = findChrome();
  assert.ok(binary, 'Chrome is required');
  const port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-lra-mockup-'));
  chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 100; i++) {
    try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(p => p.type === 'page'); } catch {}
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Chrome started');
  cdp = await createCdp(page.webSocketDebuggerUrl);
  const exceptions = [];
  await cdp.send('Runtime.enable');
  const evaluate = async expression => {
    const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) { exceptions.push(out.exceptionDetails); throw Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text); }
    return out.result.value;
  };
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.fixtureErrors = [];
    window.addEventListener('error', event => window.fixtureErrors.push(event.message));
    window.addEventListener('unhandledrejection', event => window.fixtureErrors.push(String(event.reason)));
  ` });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  for (let i = 0; i < 100 && !await evaluate('!!window.mockup?.ready'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate('!!window.mockup?.ready'), true, 'mockup loaded');

  for (const width of [360, 390, 430]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
    const layout = await evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      designerHidden: getComputedStyle(document.querySelector('#designer')).transform
    }))()`);
    assert.ok(layout.overflow <= 1, 'no horizontal document overflow at ' + width + 'px');

    // The designer opens as a bottom sheet on a phone. Open it explicitly
    // (not by clicking the toggle button): the button TOGGLES, so a click
    // while the sheet is already open would close it again.
    await evaluate('mockup.closeDesigner()');
    await evaluate('mockup.openDesigner("create")');
    // The sheet slides in; wait for it to settle instead of guessing a
    // delay, so the geometry below is the resting one.
    for (let i = 0; i < 100; i++) {
    const settled = await evaluate("(()=>{const r=document.querySelector('#designer').getBoundingClientRect();return r.bottom<=innerHeight+1 && r.top<innerHeight;})()");
    if (settled) break;
    await new Promise(resolve => setTimeout(resolve, 50));
    }
    const sheet = await evaluate(`(() => {
      const panel = document.querySelector('#designer');
      const rect = panel.getBoundingClientRect();
      return {
        open: panel.dataset.open,
        visible: rect.top < innerHeight && rect.bottom > 0,
        fields: panel.querySelectorAll('.lra-field').length,
        footHeight: panel.querySelector('.lra-form__foot').getBoundingClientRect().height
      };
    })()`);
    assert.equal(sheet.open, '1', 'designer opens');
    assert.ok(sheet.visible, 'designer is on screen at ' + width + 'px');
    assert.ok(sheet.fields >= 6, 'create mode shows the creation fields');
    assert.ok(sheet.footHeight >= 44, 'the designer action row is a 44px target');

    // Create a run.
    await evaluate(`(() => {
      mockup.closeDesigner();
      mockup.startRun();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 400));
    const created = await evaluate(`(() => {
      const card = document.querySelector('.lra');
      return {
        card: !!card,
        className: card && card.className,
        steps: document.querySelectorAll('.lra__step').length,
        userMessage: !!document.querySelector('.chat-msg--user'),
        actions: [...document.querySelectorAll('.lra__action')].map(b => b.textContent)
      };
    })()`);
    assert.ok(created.card, 'the run card appears');
    assert.ok(created.className.includes('lra--running'), 'the run starts in the running state');
    assert.ok(created.steps > 0, 'the plan steps are listed');
    assert.ok(created.userMessage, 'the goal is echoed as the user message');
    assert.deepEqual(created.actions, ['Pause', 'Tweak', 'Skip step', 'Stop'], 'the live actions are the four run controls');

    // The live tweak path: open the designer on a running run, change the
    // agent, apply, and check the run kept its identity.
    const tweak = await evaluate(`(() => {
      const before = { agent: mockup.run.draft.agent, model: mockup.run.draft.model };
      mockup.openDesigner('tweak');
      const select = document.querySelector('#lra-agent');
      select.value = 'builder';
      select.dispatchEvent(new Event('change'));
      document.querySelector('#lra-instruction').value = 'skip the docs step';
      document.querySelector('#lra-instruction').dispatchEvent(new Event('input'));
      const fields = document.querySelectorAll('.lra-field').length;
      mockup.applyTweak();
      return { before, fields, after: mockup.run.draft.agent, instruction: mockup.run.pendingInstruction };
    })()`);
    assert.ok(tweak.fields < 6, 'tweak mode shows only the live-tweakable fields');
    assert.equal(tweak.after, 'builder', 'the tweak changes the agent');
    assert.equal(tweak.instruction, 'skip the docs step', 'the instruction is queued for the next turn');

    // Pause / resume / skip / stop.
    const controls = await evaluate(`(() => {
      const state = () => mockup.run.state;
      mockup.togglePause();
      const paused = state();
      mockup.togglePause();
      const resumed = state();
      const stepBefore = mockup.run.stepIndex;
      mockup.skipStep();
      const stepAfter = mockup.run.stepIndex;
      mockup.stopRun();
      return { paused, resumed, stepBefore, stepAfter, stopped: state() };
    })()`);
    assert.equal(controls.paused, 'paused', 'pause works');
    assert.equal(controls.resumed, 'running', 'resume works');
    assert.ok(controls.stepAfter > controls.stepBefore, 'skip advances the plan');
    assert.equal(controls.stopped, 'failed', 'stop ends the run');

    // The action targets are real touch targets.
    const taps = await evaluate(`(() => {
      const small = [...document.querySelectorAll('.lra__action, .lra-chip, .lra-form__foot .btn')]
        .map(el => ({ text: el.textContent, h: el.getBoundingClientRect().height }))
        .filter(row => row.h < 43.5);
      return small;
    })()`);
    assert.deepEqual(taps, [], 'every action control is at least 44px tall');

    // The tool cards are the production ones.
    const cards = await evaluate(`(() => ({
    toolCards: document.querySelectorAll('.tool-card').length,
    nestedHeads: document.querySelectorAll('.tool-card__head').length
    }))()`);
    assert.ok(cards.toolCards > 0, 'the production tool cards render inside the transcript');

    // The run card is pinned while the run is live and returns to the slot
    // it was created in when it settles.
    const slot = await evaluate(`(() => {
    mockup.startRun();
    const live = () => [...document.querySelector('#transcript').children]
      .map(node => node.classList.contains('lra') ? 'run' : 'row');
    const pinned = live();
    mockup.stopRun();
    const settled = live();
    return { pinned, settled };
    })()`);
    assert.equal(slot.pinned[slot.pinned.length - 1], 'run', 'the live run card is pinned last');
    assert.equal(slot.settled[1], 'run', 'the settled run card returns to its creation slot');

    // A tweak on a SETTLED run is applied at once: the run will never reach
    // another turn boundary, so queueing the instruction would strand it.
    const settledTweak = await evaluate(`(() => {
    const card = document.querySelector('.lra__note');
    mockup.openDesigner('tweak');
    const agent = document.querySelector('#lra-agent');
    agent.value = 'builder';
    agent.dispatchEvent(new Event('change'));
    mockup.applyTweak();
    return {
      agent: mockup.run.draft.agent,
      queued: mockup.run.pendingInstruction,
      note: card.textContent,
      noteHidden: card.hidden,
      meta: document.querySelector('.lra__meta').textContent
    };
    })()`);
    assert.equal(settledTweak.agent, 'builder', 'the settled run takes the new agent');
    assert.equal(settledTweak.queued, '', 'a settled run does not strand a queued instruction');
    assert.equal(settledTweak.noteHidden, false, 'the settled run shows what changed');
    assert.match(settledTweak.note, /already finished/, 'the card says the change applies to the next run');
    assert.match(settledTweak.meta, /builder/, 'the card meta shows the current agent');

    assert.deepEqual(await evaluate('window.fixtureErrors'), [], 'no runtime errors at ' + width + 'px');
    // Reset between widths: the next pass starts from a clean transcript.
    await evaluate('mockup.closeDesigner()');
    await evaluate('document.querySelector("#reset").click()');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await evaluate('document.querySelector("#designer").dataset.open'), '0', 'reset closes the designer');
  }
  console.log('long-running agent mockup: ok');
} finally {
  cdp?.close();
  chrome?.kill();
  // Chrome may still be writing its profile while it exits; retry the
  // removal instead of failing the run on a half-written directory.
  if (profile) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
  server.closeAllConnections();
  server.close();
}
