# Frontend data-flow review

Review date: 2026-11-22. Scope: `frontend/src` (~75k lines), searched for two-way data flow: values stored in two places, children changing props, props copied into state that never updates, and route views that don't rebuild when their parameters change. This was a targeted search for those patterns, not a line-by-line read.

## Bugs fixed

### 1. Sending right after changing the thinking level could use the old level

Files: `frontend/src/components/chat/` (`thinking.js`, `stream.js`, `useChatState.js`, `Chat.jsx`, `modelPicker.js`).

**Cause.** The level was kept in two places. Sending read a copy in the chat's shared state (`state.thinkingLevel`), while the dropdown read the saved chat record (`state.chat.thinkingLevel`), which only updated once the server confirmed the save. Each time the dropdown refreshed (`syncThinkingSelect`), it copied the old saved value back over the copy that sending read.

**What went wrong.**

- Typing a custom budget and tapping Send straight away sent the previous level. Leaving the field commits it and refreshes the dropdown before the server has confirmed.
- The same happened if the model list finished loading after you picked a level but before the server confirmed it. The dropdown also jumped back to the old value.
- While a custom value was being typed, a model-list refresh made sending ignore what was typed.

**Fix.** The chat record is now the only stored copy.

- `saveRunSettings(state, patch, updateChat)` in `thinking.js` is the only way to change it: it updates `state.chat` right away, then saves to the server. The server's acknowledgement carries the same value back.
- `effectiveThinkingLevel(state, refs)` works out the level to send: what's typed in the custom field if it's open, otherwise the chat record's level. Sending uses it.
- The duplicate `state.thinkingLevel` and `state.maxOutputTokens` fields were removed from `useChatState.js`.

**Max output tokens** had the same duplicate. Sending now reads `state.chat.maxOutputTokens`.

### 2. The custom actions list had three writers that each updated it differently

File: `frontend/src/components/chat/useChatState.js`.

The initial chat load and the refresh each wrote the list their own way, skipping the one setter (`state._setCustomActions`) that already existed and checks for changes. All three now go through that setter.

### 3. Opening the File tags page for a different project kept the old project's tags

File: `frontend/src/components/App.jsx`.

`SettingsTagsView` stores the `projectId` once when it opens, and the id wasn't part of the key that tells the app to rebuild a route view. It is now. Nothing links there with a different id today, so this is mainly a guard.

## Checked and left alone

- The chat view's shared state object (`state` in `useChatState.js`) that other modules write to directly is a documented design choice, so it stays. Only the duplicate copies inside it were removed.
- No components were found changing data passed in from their parent, and no hidden copies when lists are edited (for example `ValueKindsView.jsx` copies deeply before editing).
- Editors that start from a passed-in value and then keep a local draft are intentional, not bugs: `StyleValueEditor` in `StylesPanel.jsx`, `ArtifactDetail` in `ArtifactsModal.jsx` (rebuilt per artifact by its key), `AuthModelPicker.jsx`, `TreeNavigator.jsx`.
- `SettingsHiddenContentView` keeps its list while you open a file, on purpose, so `filePath` is not part of the route rebuild key.

## Tests

- `scripts/test-thinking-custom-input.js` has new checks for each situation in bug 1: a re-sync mid-draft, a commit sent before the server confirms, a preset pick surviving a model-list refresh, and no write without a chat record. 30/30 pass.
- Also passing: `scripts/test-chat-request-fixes.js` (23/23), `scripts/test-chat-draft-performance.js`, `scripts/test-at-invocations.mjs` (23/23).
- ESLint is clean on the touched files, and the web bundle was rebuilt.
- Not yet checked in the Docker test app or a browser.

## Docs

`docs/agent/features/max-output-tokens.md` now describes the chat record as the single source.
