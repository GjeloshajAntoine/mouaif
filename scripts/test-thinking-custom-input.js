'use strict';
// Regression test: an in-progress "Custom…" thinking level survives a re-sync.
//
// syncThinkingSelect() is an imperative DOM rebuild outside Preact's render
// cycle. It runs on every background live-model fetch — the provider catalog
// can land seconds after the chat paints — and rebuilding the <select> used to
// reset `hidden = true` on the custom input. The field the user had just
// revealed through the "Custom…" row vanished under their finger, and the
// focus() that ran alongside it fired on a display:none element, so no
// keyboard opened and no value could ever be typed.
//
// The fix keeps the open state in the refs bag (`_thinkingCustomOpen`), lets
// syncThinkingSelect() see it, and holds the sentinel + field open until the
// entry is committed on blur/Enter. This test drives the real thinking.js
// against a minimal DOM stub and asserts both halves: the field stays open
// across a re-sync, and it closes once the value is committed.
const assert = require('node:assert/strict');
const path = require('node:path');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- a DOM just big enough for syncThinkingSelect ------------------
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    textContent: '',
    value: '',
    hidden: false,
    style: {},
    focused: 0,
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren() { this.children = []; },
    focus() { this.focused++; }
  };
}
const document = { createElement: makeEl };
globalThis.document = document;

const refsFor = () => {
  const sel = makeEl('select');
  const custom = makeEl('input');
  custom.hidden = true;
  return {
    thinkingLevel: { current: sel },
    thinkingLevelCustom: { current: custom },
    _sel: sel,
    _custom: custom
  };
};

// A levels descriptor, so the option list is provider-reported (the
// OpenRouter / Copilot reasoning shape that produced the screenshot).
const DESCRIPTOR = { kind: 'levels', levels: ['minimal', 'low', 'medium', 'high', 'xhigh'] };
const chatState = (thinkingLevel) => ({
  chat: { thinkingLevel },
  liveByProvider: { p1: [{ id: 'm1', thinking: DESCRIPTOR }] },
  _providerId: 'p1'
});
// thinkingDescriptorFor reads state.chat.{providerId,modelId}.
const stateWith = (thinkingLevel) => {
  const s = chatState(thinkingLevel);
  s.chat.providerId = 'p1';
  s.chat.modelId = 'm1';
  return s;
};

(async () => {
  const thinking = await import(path.join('..', 'frontend', 'src', 'components', 'chat', 'thinking.js'));
  const { syncThinkingSelect, setThinkingCustomOpen, thinkingCustomOpen, thinkingOptionsFor } = thinking;

  // The option list really does carry the sentinel the screenshot circles.
  const opts = thinkingOptionsFor(DESCRIPTOR);
  check('levels descriptor appends the Custom… sentinel',
    opts.some((o) => o.value === '__custom__' && o.label === 'Custom…'));

  // ---- the reported bug: pick Custom…, then a live fetch lands ----
  {
    const refs = refsFor();
    const state = stateWith('');
    syncThinkingSelect(refs, state);
    check('a fresh sync leaves the custom input hidden', refs._custom.hidden === true);

    // The user taps the "Custom…" row (Chat.jsx onChange).
    state.thinkingLevel = '__custom__';
    setThinkingCustomOpen(refs, true);
    check('picking Custom… reveals the input', refs._custom.hidden === false);
    check('picking Custom… focuses the input', refs._custom.focused === 1);

    // A background live-model fetch lands and re-syncs.
    syncThinkingSelect(refs, state);
    check('the input is STILL visible after a re-sync', refs._custom.hidden === false,
      'the field was hidden while the user was typing');
    check('the select still shows Custom… after a re-sync', refs._sel.value === '__custom__');
    check('the re-sync did not steal / re-fire focus', refs._custom.focused === 1);
    check('the open flag survives the re-sync', thinkingCustomOpen(refs) === true);
  }

  // ---- the entry is committed on blur, then the sync reconciles ----
  {
    const refs = refsFor();
    const state = stateWith('');
    syncThinkingSelect(refs, state);
    state.thinkingLevel = '__custom__';
    setThinkingCustomOpen(refs, true);
    syncThinkingSelect(refs, state);

    // Typed value + blur (Chat.jsx onBlur).
    const typed = '8192';
    refs._custom.value = typed;
    const wasOpen = thinkingCustomOpen(refs);
    setThinkingCustomOpen(refs, false);
    check('the flag was set before the commit', wasOpen === true);
    check('committing hides the input', refs._custom.hidden === true);
    state.thinkingLevel = typed;
    state.chat.thinkingLevel = typed;

    // The next sync keeps the stored value through the custom path,
    // because '8192' is not one of the reported levels.
    syncThinkingSelect(refs, state);
    check('a stored custom value still shows Custom…', refs._sel.value === '__custom__');
    check('a stored custom value re-fills the input', refs._custom.value === typed);
    check('a stored custom value keeps the input visible', refs._custom.hidden === false);
  }

  // ---- a plain preset commits back to a closed field --------------
  {
    const refs = refsFor();
    const state = stateWith('');
    state.thinkingLevel = '__custom__';
    setThinkingCustomOpen(refs, true);
    syncThinkingSelect(refs, state);

    setThinkingCustomOpen(refs, false);
    state.thinkingLevel = 'high';
    state.chat.thinkingLevel = 'high';
    syncThinkingSelect(refs, state);
    check('a preset value hides the input again', refs._custom.hidden === true);
    check('a preset value is selected in the dropdown', refs._sel.value === 'high');
  }

  // ---- a toggle descriptor has no sentinel to hold open -----------
  {
    const refs = refsFor();
    const state = {
      chat: { providerId: 'p1', modelId: 'm1', thinkingLevel: '__custom__' },
      liveByProvider: { p1: [{ id: 'm1', thinking: { kind: 'toggle' } }] }
    };
    setThinkingCustomOpen(refs, true);
    syncThinkingSelect(refs, state);
    check('a toggle model never shows the custom input', refs._custom.hidden === true,
      'there is no Custom… row to select');
    check('a toggle model shows Thinking / No thinking only',
      refs._sel.value === '' || refs._sel.value === 'on');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
