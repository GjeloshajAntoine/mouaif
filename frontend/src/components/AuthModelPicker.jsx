// mouaif web — stateful adapter for an imperative authorization card
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { ModelPickerField } from './ModelPickerField.jsx';
import { ThinkingSelectField } from './ThinkingSelectField.jsx';

// AuthModelPicker({ models, initialValue, onChange })
//
// Owns the per-run model + thinking selection for the subagent
// authorization card and passes it through to the props-driven
// ModelPickerField / ThinkingSelectField. `onChange` receives the full
// selection object whenever either changes so the host can read it for
// the decision payload:
//   { modelOverride: { providerId, modelId } | null,
//     thinkingLevel: string,  // '' = inherit
//     model: { ... } }        // the picked model row (for its thinking descriptor)
export function AuthModelPicker({ models, initialValue, onChange }) {
const [value, setValue] = useState(initialValue || null);
const [thinking, setThinking] = useState('');
function onModelChange(next) {
const modelId = (next && next.modelId) || '';
const nextValue = next;
setValue(nextValue);
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
