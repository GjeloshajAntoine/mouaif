// The composer's two optional tool buttons, end to end.
//
// The dictation microphone and the image-attachment button can each be hidden
// app-wide from Settings → Chat defaults. Hiding is *not* disabling, so the
// feature has the same three places it can silently half-break that the glass
// orb has (see scripts/test-file-orb.mjs), plus a fourth that is specific to a
// button that is simply not drawn:
//
//   1. the preference — `composerToolsFromApp()` must read the app store
//      defensively, because a value it cannot understand has to leave the
//      button *shown* rather than make a control vanish;
//   2. the plumbing — both keys are app-level, so they must be in
//      Settings.DEFAULTS (or they can never be reset) AND in
//      server-shared.js's CLIENT_SETTINGS_KEYS allowlist (or the server stores
//      them and strips them out of every /api/settings response, which looks
//      exactly like a switch that will not save);
//   3. the render — ChatView must draw each button behind its flag, and must
//      mount the image <input type="file"> either way: that element is the path
//      a *pasted* image travels, so hiding the button must never take it away;
//   4. the default — both flags default to *shown*. A feature that silently
//      disappeared after an update is worse than one the user turns off.
//
// This file owns 1-4 as source-level contracts. The rendered result is pinned
// against the real ChatView in scripts/test-dictation-chat.cjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// This file is ESM (for top-level await), but src/*.js is CommonJS.
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0;
const checks = [];
function check(name, fn) {
  checks.push(async () => {
    await fn();
    pass += 1;
    console.log('  ok   - ' + name);
  });
}

// ---- 1. the preference reader -------------------------------------------
const {
  composerToolsFromApp, COMPOSER_TOOLS_DEFAULT, DICTATION_BUTTON_KEY, IMAGE_BUTTON_KEY
} = await import(
  'data:text/javascript;base64,' + Buffer.from(read('frontend/src/components/chat/composerTools.js')).toString('base64')
);

check('the two keys are the app-store names the server allowlists', () => {
  assert.equal(DICTATION_BUTTON_KEY, 'dictationButton');
  assert.equal(IMAGE_BUTTON_KEY, 'imageButton');
});

check('both optional buttons are shown by default', () => {
  assert.equal(COMPOSER_TOOLS_DEFAULT.dictation, true);
  assert.equal(COMPOSER_TOOLS_DEFAULT.image, true);
  assert.ok(Object.isFrozen(COMPOSER_TOOLS_DEFAULT), 'the defaults are shared render state, so they are frozen');
});

check('composerToolsFromApp reads both booleans', () => {
  assert.deepEqual(composerToolsFromApp({ app: { dictationButton: false, imageButton: false } }), { dictation: false, image: false });
  assert.deepEqual(composerToolsFromApp({ app: { dictationButton: true, imageButton: false } }), { dictation: true, image: false });
  assert.deepEqual(composerToolsFromApp({ app: { dictationButton: false, imageButton: true } }), { dictation: false, image: true });
  assert.deepEqual(composerToolsFromApp({ app: { dictationButton: true, imageButton: true } }), { dictation: true, image: true });
});

check('a value it cannot read leaves the button shown, never hidden', () => {
  // Anything shaped differently is "a settings read that failed or never
  // happened" — not "the user hid a button". Both flags fall back to shown.
  for (const snapshot of [{}, null, undefined, { app: null }, { app: [] }, { app: 'nope' }, 0]) {
    assert.deepEqual(composerToolsFromApp(snapshot), { dictation: true, image: true },
      'snapshot ' + JSON.stringify(snapshot) + ' must read as the defaults');
  }
  // And per key: an absent, numeric, null or prose value resolves to shown.
  for (const raw of [undefined, null, 1, 0, 'yes', 'on', {}]) {
    const got = composerToolsFromApp({ app: { dictationButton: raw, imageButton: raw } });
    assert.deepEqual(got, { dictation: true, image: true }, 'raw ' + JSON.stringify(raw) + ' must read as shown');
  }
});

check('the string forms a TEXT store hands back are honoured', () => {
  // The app store holds a TEXT blob, so a hand-edited store.sqlite (or a
  // settings file merged from a project) can legitimately hand us 'false'.
  assert.deepEqual(composerToolsFromApp({ app: { dictationButton: 'false', imageButton: 'false' } }), { dictation: false, image: false });
  assert.deepEqual(composerToolsFromApp({ app: { dictationButton: 'true', imageButton: 'true' } }), { dictation: true, image: true });
  assert.deepEqual(composerToolsFromApp({ app: { dictationButton: 'false' } }), { dictation: false, image: true });
  assert.deepEqual(composerToolsFromApp({ app: { imageButton: 'false' } }), { dictation: true, image: false });
});

// ---- 2. the server-side plumbing ----------------------------------------
check('both keys are resettable app defaults', () => {
  const settingsSrc = read('src/settings.js');
  assert.match(settingsSrc, /dictationButton: true,/, 'Settings.DEFAULTS must carry the mic key, defaulting to shown');
  assert.match(settingsSrc, /imageButton: true,/, 'Settings.DEFAULTS must carry the image key, defaulting to shown');
  // RESETTABLE_APP_KEYS is derived from Object.keys(DEFAULTS), so being in
  // DEFAULTS is what makes the keys reachable by Settings → reset.
  const shared = read('src/server-shared.js');
  assert.match(shared, /new Set\(\[\.\.\.Object\.keys\(settings\.DEFAULTS\)/, 'resettable keys come from DEFAULTS');
});

check('both keys survive the client allowlist', () => {
  const shared = read('src/server-shared.js');
  const listStart = shared.indexOf('const CLIENT_SETTINGS_KEYS = Object.freeze([');
  assert.ok(listStart > -1, 'CLIENT_SETTINGS_KEYS block found');
  const listEnd = shared.indexOf(']);', listStart);
  const block = shared.slice(listStart, listEnd);
  assert.match(block, /'dictationButton'/, 'the mic key must be allowlisted or the server stores it and strips it');
  assert.match(block, /'imageButton'/, 'the image key must be allowlisted or the server stores it and strips it');
});

check('the running server would round-trip both keys', () => {
  // Exercise the real modules against a throwaway store, rather than pattern
  // matching: set each key through settings.js, then confirm settingsForClient
  // (the function every /api/settings response goes through) still has it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-composer-tools-'));
  const priorHome = process.env.MOUAIF_HOME;
  process.env.MOUAIF_HOME = home;
  try {
    // Fresh module registry so settings.js captures the temp home.
    const settings = require(path.join(ROOT, 'src/settings.js'));
    const { settingsForClient } = require(path.join(ROOT, 'src/server-shared.js'));
    settings.setApp({ dictationButton: false, imageButton: false });
    const stored = settings.getApp();
    assert.equal(stored[DICTATION_BUTTON_KEY], false, 'settings.js persists the mic key');
    assert.equal(stored[IMAGE_BUTTON_KEY], false, 'settings.js persists the image key');
    const published = settingsForClient(stored);
    assert.equal(published[DICTATION_BUTTON_KEY], false, 'the client sees the hidden microphone');
    assert.equal(published[IMAGE_BUTTON_KEY], false, 'the client sees the hidden image button');
    // The defaults are published too, and they mean "shown" — which is the
    // state a fresh install and the Settings → reset path both land on.
    const defaults = settingsForClient(settings.DEFAULTS);
    assert.equal(defaults[DICTATION_BUTTON_KEY], true, 'the default is a shown microphone');
    assert.equal(defaults[IMAGE_BUTTON_KEY], true, 'the default is a shown image button');
  } finally {
    if (priorHome === undefined) delete process.env.MOUAIF_HOME;
    else process.env.MOUAIF_HOME = priorHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---- 3. the render guards ------------------------------------------------
const chat = read('frontend/src/components/chat/Chat.jsx');

check('ChatView draws the microphone only when it is enabled', () => {
  // The guard has to be the flag and the element has to be the real MicButton,
  // or "hidden" would mean "installed anyway and styled away".
  assert.match(chat, /composerTools\.dictation\s*\n?\s*\? h\(MicButton, \{[^}]*projectDir, chatId/,
    'the microphone must sit behind composerTools.dictation');
  assert.match(chat, /composerTools\.dictation[\s\S]{0,400}?: null,/,
    'a hidden microphone renders nothing at all');
});

check('ChatView draws the image button only when it is enabled', () => {
  assert.match(chat, /composerTools\.image\s*\n?\s*\? h\('button', \{ class: 'chat-view__iconbtn chat-view__image-btn'/,
    'the image button must sit behind composerTools.image');
  // The button's own markup must disappear with the flag, not merely its paint.
  const afterFlag = chat.slice(chat.indexOf('composerTools.image'));
  assert.match(afterFlag.slice(0, 900), /\n\s*: null,/, 'a hidden image button renders nothing at all');
});

check('the image file input is mounted either way', () => {
  // Paste, and the annotation editor's own capture, both travel through this
  // input. Hiding the *button* must remove a control, never the capability.
  assert.match(chat, /composerTools\.image[\s\S]{0,900}?h\('input', \{ ref: refs\.imageInput/,
    'the file input must not be inside the button’s conditional branch');
});

check('the composer keeps the message box, the send button and the status line', () => {
  for (const anchor of ["id: 'chatComposer'", 'chat-view__send', 'chat-view__status']) {
    assert.ok(chat.includes(anchor), anchor + ' must stay in the composer');
  }
});

// ---- 4. the settings surface --------------------------------------------
check('Settings → Chat defaults exposes both switches', () => {
  const settingsUi = read('frontend/src/components/SettingsDefaults.jsx');
  assert.match(settingsUi, /from '\.\/chat\/composerTools\.js'/, 'the view shares the reader with the chat');
  for (const id of ['sd-dictation-button', 'sd-image-button']) {
    assert.ok(settingsUi.includes("id: '" + id + "'"), 'switch ' + id + ' exists');
  }
  // Each row autosaves its own key, and says what happened in its own
  // aria-live status line (the pattern the other Chat defaults rows use).
  assert.match(settingsUi, /'dictationButton', \{ dictationButton: v \}/, 'the mic switch saves its key');
  assert.match(settingsUi, /'imageButton', \{ imageButton: v \}/, 'the image switch saves its key');
  for (const row of ['dictationButtonMsg', 'imageButtonMsg']) {
    assert.match(settingsUi, new RegExp("'aria-live': 'polite' \\}, " + row), 'a status line exists for ' + row);
  }
});

check('the chat re-reads the preference when its data loads', () => {
  const state = read('frontend/src/components/chat/useChatState.js');
  assert.match(state, /setComposerTools\(composerToolsFromApp\(app\)\)/, 'the chat seeds the flags from /api/settings');
  assert.match(state, /const \[composerTools, setComposerTools\] = useState\(\(\) => Object\.assign\(\{\}, COMPOSER_TOOLS_DEFAULT\)\)/,
    'and starts from "both shown" so a slow fetch never makes a button flicker out');
  assert.match(state, /^\s*composerTools,$/m, 'the flags reach ChatView');
});

check('the feature ships with a doc, listed in the docs index', () => {
  // The rule is per-feature documentation in the same commit as the code; a
  // doc the code already cites but that does not exist is the failure mode.
  const doc = read('docs/features/composer-tool-buttons.md');
  assert.match(doc, /^# Composer tool buttons\n/, 'the page starts with its single H1');
  const index = read('docs/README.md');
  assert.match(index, /\(features\/composer-tool-buttons\.md\)/, 'the docs index links the page');
});

// Run them in order; the first failure rejects and stops the file.
for (const run of checks) await run();
console.log('\ntest-composer-tools: OK (' + pass + ' checks)');