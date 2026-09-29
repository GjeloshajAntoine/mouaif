'use strict';
// Regression test: the custom thinking-level field survives focus changes.
//
// The field is revealed by the "Custom…" row and must stay visible while
// the user works in it. Two independent mechanisms used to hide it:
//
//  1. syncThinkingSelect() rebuilds the <select> imperatively on every
//     background live-model fetch (useChatState.js _onLiveModels), which
//     reset `hidden = true` on the custom input. The focus() in the same
//     change handler then fired on a display:none element, so no keyboard
//     opened.
//  2. The input's own onBlur hid it. A blur is not a dismissal — tapping
//     the composer, the keyboard opening and the closing native picker all
//     fire one — so "Custom…" flashed and vanished: the field never
//     appeared.
//
// The fix keeps the open flag in the refs bag (`_thinkingCustomOpen`),
// lets syncThinkingSelect() see it, and splits the two endings: blur
// commits a typed value (leaving visibility to the sync), and
// commitThinkingCustom() clears the flag WITHOUT hiding anything. This
// test drives the real thinking.js against a minimal DOM stub.
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

// A levels descriptor: the OpenRouter / Copilot reasoning shape that
// produced the report (Minimal/Low/Medium/High/Xhigh + Custom…).
const DESCRIPTOR = { kind: 'levels', levels: ['minimal', 'low', 'medium', 'high', 'xhigh'] };
const stateWith = (thinkingLevel) => ({
  chat: { thinkingLevel, providerId: 'p1', modelId: 'm1' },
  liveByProvider: { p1: [{ id: 'm1', thinking: DESCRIPTOR }] }
});

(async () => {
  const thinking = await import(path.join('..', 'frontend', 'src', 'components', 'chat', 'thinking.js'));
  const {
    syncThinkingSelect, setThinkingCustomOpen, commitThinkingCustom,
    thinkingCustomOpen, thinkingOptionsFor
  } = thinking;

  const opts = thinkingOptionsFor(DESCRIPTOR);
  check('levels descriptor appends the Custom… sentinel',
    opts.some((o) => o.value === '__custom__' && o.label === 'Custom…'));

  // ---- mechanism 2: a blur / focus move must not hide the field ----
  {
    const refs = refsFor();
    const state = stateWith('');
    syncThinkingSelect(refs, state);
    check('a fresh sync leaves the custom input hidden', refs._custom.hidden === true);

    setThinkingCustomOpen(refs, true);            // user taps "Custom…"
    check('picking Custom… reveals the input', refs._custom.hidden === false);
    check('picking Custom… focuses the input', refs._custom.focused === 1);

    // The user taps the composer: the input blurs with nothing typed.
    // Chat.jsx returns early on an empty value and does NOT hide it.
    commitThinkingCustom(refs);
    check('commitThinkingCustom clears the open flag', thinkingCustomOpen(refs) === false);
    check('commitThinkingCustom does NOT hide the input', refs._custom.hidden === false,
      'blur hid the field — "Custom…" flashes and vanishes');

    // A later background re-sync may now reconcile against the stored
    // (still empty) value, which legitimately returns to "No thinking".
    syncThinkingSelect(refs, state);
    check('a later re-sync reconciles an abandoned empty field',
      refs._sel.value === '' && refs._custom.hidden === true);
  }

  // ---- mechanism 1: a live-catalog re-sync must not close it -------
  {
    const refs = refsFor();
    const state = stateWith('');
    syncThinkingSelect(refs, state);

    state.thinkingLevel = '__custom__';
    setThinkingCustomOpen(refs, true);
    syncThinkingSelect(refs, state);              // background catalog lands
    check('the input is STILL visible after a re-sync', refs._custom.hidden === false);
    check('the select still shows Custom… after a re-sync', refs._sel.value === '__custom__');
    check('the flag survives the re-sync', thinkingCustomOpen(refs) === true);
    check('the re-sync does not re-fire focus', refs._custom.focused === 1);
  }

  // ---- a committed free-form number keeps the field open -----------
  {
    const refs = refsFor();
    const state = stateWith('');
    state.thinkingLevel = '__custom__';
    setThinkingCustomOpen(refs, true);

    refs._custom.value = '4096';
    commitThinkingCustom(refs);
    state.chat.thinkingLevel = '4096';
    syncThinkingSelect(refs, state);
    check('a stored free-form number keeps the input visible', refs._custom.hidden === false);
    check('a stored free-form number re-fills the input', refs._custom.value === '4096');
    check('a stored free-form number shows Custom…', refs._sel.value === '__custom__');
  }

  // ---- editing a saved custom budget survives catalog refresh ------
  {
    const refs = refsFor();
    const state = stateWith('4096');
    syncThinkingSelect(refs, state);
    setThinkingCustomOpen(refs, true);
    refs._custom.value = '8192';
    syncThinkingSelect(refs, state);
    check('refresh preserves edits to a saved custom value', refs._custom.value === '8192');
    refs._custom.value = '';
    syncThinkingSelect(refs, state);
    check('refresh preserves clearing a saved custom value', refs._custom.value === '');
    check('editing a saved custom value stays visible', refs._custom.hidden === false);
    commitThinkingCustom(refs);
    state.chat.thinkingLevel = '8192';
    syncThinkingSelect(refs, state);
    check('the edited custom value reconciles after commit', refs._custom.value === '8192');
  }

  // The visible saved field must start a new draft when edited. Exercise
  // the actual JSX handler without mounting the rest of the chat view.
  {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const source = fs.readFileSync('frontend/src/components/chat/Chat.jsx', 'utf8');
    const handler = source.match(/'aria-label': 'Custom thinking level',\s*onInput: \(\) => \{([\s\S]*?)\n        \},/);
    assert.ok(handler, 'custom field has an input handler');
    const s = { refs: refsFor(), state: stateWith('4096') };
    vm.runInNewContext(handler[1], { s });
    check('editing a saved field starts a new custom draft', thinkingCustomOpen(s.refs));
    check('sending an edited field reads its draft', s.state.thinkingLevel === '__custom__');

    const apply = source.match(/function onApplyThinkingCustom\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(apply, 'custom editor has an explicit Apply action');
    const patches = [];
    s.updateChat = (patch) => { patches.push(patch); Object.assign(s.state.chat, patch); };
    s.refs._custom.blur = () => {};
    s.refs._custom.value = ' 8192 ';
    const applyDraft = () => vm.runInNewContext('(() => {' + apply[1] + '})()', {
      refs: s.refs, s, commitThinkingCustom, syncThinkingSelect
    });
    applyDraft();
    check('Apply saves a trimmed custom value', patches[0].thinkingLevel === '8192');
    check('Apply ends the custom draft', !thinkingCustomOpen(s.refs));
    s.refs._custom.value = '';
    applyDraft();
    check('Apply with an empty value turns thinking off', patches[1].thinkingLevel === '');
    check('empty Apply closes the custom editor', s.refs._custom.hidden);
  }

  // ---- a committed KNOWN level closes the field --------------------
  {
    const refs = refsFor();
    const state = stateWith('');
    state.thinkingLevel = '__custom__';
    setThinkingCustomOpen(refs, true);

    refs._custom.value = 'xhigh';
    commitThinkingCustom(refs);
    state.chat.thinkingLevel = 'xhigh';
    syncThinkingSelect(refs, state);
    check('a known level hides the input', refs._custom.hidden === true);
    check('a known level is selected in the dropdown', refs._sel.value === 'xhigh');
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
    check('a toggle model never shows the custom input', refs._custom.hidden === true);
    check('a toggle model shows Thinking / No thinking only',
      refs._sel.value === '' || refs._sel.value === 'on');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
