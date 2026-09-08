// mouaif web — stateful adapter for an imperative authorization card
import { h } from 'preact';
import { useState, useMemo, useCallback } from 'preact/hooks';
import { ModelPickerField } from './ModelPickerField.jsx';
import { ThinkingSelectField } from './ThinkingSelectField.jsx';
import {
loadPinned, loadRecent, loadRecentFromServer, touchRecent, togglePin
} from './chat/modelPicker.js';
// AuthModelPicker({ models, initialValue, projectDir, onChange })
//
// Owns the per-run model + thinking selection for the subagent
// authorization card and passes it through to the props-driven
// ModelPickerField / ThinkingSelectField. `onChange` receives the full
// selection object whenever either changes so the host can read it for
// the decision payload:
//   { modelOverride: { providerId, modelId } | null,
//     thinkingLevel: string,  // '' = inherit
//     model: { ... } }        // the picked model row (for its thinking descriptor)
//
// Bookmark state (pinned / recent) is owned here — the same source of
// truth the chat top bar picker uses — so the card shows the Pinned and
// Recent sections. `pinned` lives in localStorage (per project); `recent`
// is a server-backed cache refreshed when the sheet opens.
export function AuthModelPicker({ models, initialValue, projectDir, onChange }) {
const [value, setValue] = useState(initialValue || null);
const [thinking, setThinking] = useState('');
// A minimal `state`-shaped bag with the fields the bookmark helpers read
// (projectDir for localStorage keys / server fetch, recentModels for the
// recent cache). Recomputed when projectDir changes so a project switch
// never leaves stale pinnings or recents behind.
const bookmarks = useMemo(() => ({
props: { projectDir },
recentModels: [],
}), [projectDir]);
const [recent, setRecent] = useState(() => loadRecent(bookmarks));
const [pinned, setPinned] = useState(() => loadPinned(bookmarks));
// Refresh the server-backed Recent list when the sheet opens, so stale
// entries are never briefly shown. `ModelPickerField` calls `onOpen` as
// the sheet becomes visible; the fresh list lands in one re-render (the
// same "open instantly, refresh Recent in the background" behavior the
// chat top bar picker documents).
const refreshRecent = useCallback(() => {
let alive = true;
loadRecentFromServer(bookmarks).then((refreshed) => {
if (alive && refreshed) setRecent(loadRecent(bookmarks));
});
return () => { alive = false; };
}, [bookmarks]);
function onModelChange(next) {
const nextValue = next;
setValue(nextValue);
// Record recency for a real pick (mirrors the chat top bar), so the
// authored model surfaces under Recent next time the picker opens.
if (nextValue && nextValue.providerId && nextValue.modelId) {
touchRecent(bookmarks, nextValue.providerId, nextValue.modelId);
setRecent(loadRecent(bookmarks));
}
if (onChange) onChange({
modelOverride: nextValue ? { providerId: nextValue.providerId, modelId: nextValue.modelId } : null,
thinkingLevel: thinking,
model: nextValue
});
}
function onThinkingChange(tl) {
setThinking(tl);
if (onChange) onChange({
modelOverride: value ? { providerId: value.providerId, modelId: value.modelId } : null,
thinkingLevel: tl,
model: value
});
}
const onTogglePin = useCallback((m) => {
if (!m || !m.provider || !m.id) return;
togglePin(bookmarks, m.provider, m.id);
setPinned(loadPinned(bookmarks));
// A newly pinned model leaves Recent to avoid duplication, matching
// the chat top bar picker. Refresh Recent from the cache so any
// pin-in-common entry is dropped.
setRecent(loadRecent(bookmarks));
}, [bookmarks]);
const clearLabel = initialValue
? '(chat default) ' + initialValue.modelId
: '(chat default)';
const pickedModel = value && models.find((m) => m.id === value.modelId && m.provider === value.providerId);
return h('div', { class: 'auth-model-picker' },
h(ModelPickerField, {
models,
value,
variant: 'sheet',
allowClear: true,
clearLabel,
ariaLabel: 'Model for this subagent run',
pinned,
recent,
onTogglePin,
onOpen: refreshRecent,
onChange: onModelChange
}),
h(ThinkingSelectField, {
value: thinking,
descriptor: pickedModel && pickedModel.thinking,
inheritLabel: 'Inherit chat thinking',
ariaLabel: 'Thinking level for this subagent run',
onChange: onThinkingChange
})
);
}
