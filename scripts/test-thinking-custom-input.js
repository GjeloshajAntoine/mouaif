'use strict';
// Regression test: the thinking-level control is a popover, and nothing
// outside a Preact render hides the custom field.
//
// History, because this file is the guard for it. The control used to be a
// bare <select> plus a `hidden` <input> that `syncThinkingSelect()` rebuilt
// by hand outside Preact's render cycle. Two bugs came from that:
//
//   1. A background model-catalog fetch called syncThinkingSelect, which
//      reset `hidden = true` on the input — the field vanished while the
//      user was typing, and the focus() in the same tick fired on a
//      display:none element so no keyboard opened.
//   2. The input's own onBlur hid it. A blur is not a dismissal (tapping the
//      composer, the keyboard opening and the closing native picker all fire
//      one), so "Custom…" flashed and vanished.
//
// The fix removed the imperative path: ThinkingPicker.jsx derives the
// field's visibility from the selected value every render. This test pins
// the invariants that the popover rewrite must keep — the option shaping in
// thinking.js, and that the sentinel never reaches the wire.
const assert = require('node:assert/strict');
const path = require('node:path');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// A levels descriptor: the OpenRouter / Copilot reasoning shape (the one in
// the original bug report — Minimal/Low/Medium/High/Xhigh + Custom…).
const DESCRIPTOR = { kind: 'levels', levels: ['minimal', 'low', 'medium', 'high', 'xhigh'] };

(async () => {
  const thinking = await import(path.join('..', 'frontend', 'src', 'components', 'chat', 'thinking.js'));
  const {
    thinkingOptionsFor, thinkingOptionsForSelect, effectiveThinkingLevel, thinkingLabelFor
  } = thinking;

  // ---- the option list the popover renders -------------------------
  {
    const opts = thinkingOptionsFor(DESCRIPTOR);
    check('a levels descriptor lists the reported levels',
      DESCRIPTOR.levels.every((lv) => opts.some((o) => o.value === lv)));
    check('levels append the Custom… sentinel',
      opts.some((o) => o.value === '__custom__' && o.label === 'Custom…'));
    check('No thinking is always first',
      opts[0].value === '' && opts[0].label === 'No thinking');

    const budget = thinkingOptionsFor({ kind: 'budget' });
    check('a budget descriptor keeps the presets and offers Custom…',
      budget.some((o) => o.value === 'low') && budget.some((o) => o.value === '__custom__'));

    const toggle = thinkingOptionsFor({ kind: 'toggle' });
    check('a toggle descriptor offers no free-form input',
      !toggle.some((o) => o.value === '__custom__'),
      'a toggle model has no Custom… row');
    check('a toggle descriptor offers Thinking',
      toggle.some((o) => o.value === 'on' && o.label === 'Thinking'));

    check('the no-descriptor fallback still offers Custom…',
      thinkingOptionsFor(null).some((o) => o.value === '__custom__'));

    // The shared <select> consumers (Agents editor, auth card) must not
    // receive the sentinel — they render no free-form input.
    check('thinkingOptionsForSelect drops the sentinel',
      !thinkingOptionsForSelect(DESCRIPTOR).some((o) => o.value === '__custom__'));

    // ---- the sentinel must never reach the wire --------------------
    // Picking "Custom…" used to store '__custom__' on the chat; the old
    // stream.js read the input's live DOM value to compensate. Now the
    // committed value is stored directly, but a chat saved by that build
    // can still carry the sentinel.
    check('a stored __custom__ resolves to no value',
      effectiveThinkingLevel('__custom__') === '',
      'the sentinel would be sent as reasoning_effort');
    check('a reported level passes through',
      effectiveThinkingLevel('xhigh') === 'xhigh');
    check('a free-form number passes through',
      effectiveThinkingLevel('4096') === '4096');
    check('a non-string resolves to empty',
      effectiveThinkingLevel(undefined) === '' && effectiveThinkingLevel(null) === '');
    check('surrounding whitespace is trimmed',
      effectiveThinkingLevel('  high  ') === 'high');

    // ---- the trigger label -----------------------------------------
    check('a reported level shows its label',
      thinkingLabelFor(opts, 'xhigh') === 'Xhigh');
    check('no value shows No thinking',
      thinkingLabelFor(opts, '') === 'No thinking');
    check('a value outside the reported set shows itself',
      thinkingLabelFor(opts, '4096') === '4096',
      'a stored custom number must not read as "No thinking"');
  }

  // ---- the component has no imperative DOM writer -------------------
  // The whole class of bug came from a module poking `.hidden` at a node
  // Preact owns. Guard the shape, not just the behaviour.
  {
    const fs = require('node:fs');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'frontend', 'src', 'components', 'chat', 'ThinkingPicker.jsx'), 'utf8');
    check('ThinkingPicker declares the custom field with a value binding',
      /value:\s*draft/.test(src), 'the input must be controlled, not patched');
    check('ThinkingPicker never writes .hidden imperatively',
      !/\.hidden\s*=/.test(src) && !/customInput/.test(src));
    check('ThinkingPicker is a <dialog> popover, not a native <select>',
      /h\('dialog'/.test(src) && !/h\('select'/.test(src));
    check('ThinkingPicker publishes the visual-viewport vars the sheet needs',
      /--model-picker-viewport-height/.test(src) && /--model-picker-viewport-top/.test(src));
    check('ThinkingPicker commits a typed value on blur',
    /onBlur:\s*\([^)]*\)\s*=>\s*commitDraft\(/.test(src));
    check('ThinkingPicker does not hide the field on blur',
    !/onBlur:[^,]*setOpen\(false\)/.test(src),
    'blur is not a dismissal');
    check('ThinkingPicker clears the draft through a ref before closing',
    /draftRef\.current\s*=\s*''/.test(src),
    'a stale draft would PATCH over the row the user picked');
    check('a blur into the panel does not commit',
    /relatedTarget/.test(src) && /popRef\.current\.contains\(to\)/.test(src));

    const chat = fs.readFileSync(
      path.join(__dirname, '..', 'frontend', 'src', 'components', 'chat', 'Chat.jsx'), 'utf8');
    check('Chat.jsx no longer renders the native thinking <select>',
      !/chat-view__thinking-select/.test(chat));
    check('Chat.jsx no longer renders the hidden custom input',
      !/chat-view__thinking-custom/.test(chat));
    check('Chat.jsx renders ThinkingPicker',
      /h\(ThinkingPicker,\s*\{/.test(chat));

    const hook = fs.readFileSync(
      path.join(__dirname, '..', 'frontend', 'src', 'components', 'chat', 'useChatState.js'), 'utf8');
    check('useChatState no longer calls syncThinkingSelect',
      !/syncThinkingSelect/.test(hook),
      'the imperative rebuild is gone');
    check('useChatState no longer holds the thinking DOM refs',
      !/thinkingLevelCustom/.test(hook) && !/thinkingLevel\s*=\s*useRef/.test(hook));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
