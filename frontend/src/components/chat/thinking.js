// mouaif web — Thinking-level options
//
// Builds the per-model thinking dropdown options. Options come from
// the provider when available: each model record may carry a
// `thinking` descriptor attached by the server (see src/ai.js —
// "Thinking capability descriptors"):
//
//   { kind: 'levels', levels: ['minimal','low','medium','high',...] }
//   { kind: 'budget' }   — raw token budget (Anthropic, Gemini 2.5+)
//   { kind: 'toggle' }   — on/off only (Ollama `think` flag)
//
// When the active model has no descriptor (unknown model, provider
// reports nothing), the UI falls back to the generic low/medium/high
// presets so the control stays usable.

const FALLBACK_LEVELS = ['low', 'medium', 'high'];

// thinkingDescriptorFor(state) -> descriptor | null
//
// Resolve the active chat model's thinking descriptor from the
// per-provider live cache (seeded from the project-level model list,
// then refreshed with provider-reported data).
export function thinkingDescriptorFor(state) {
  const c = state && state.chat;
  if (!c || !c.providerId || !c.modelId) return null;
  const live = (state.liveByProvider && state.liveByProvider[c.providerId]) || [];
  const found = live.find((m) => m && m.id === c.modelId);
  return (found && found.thinking) || null;
}

// thinkingOptionsFor(descriptor) -> [{ value, label }]
//
// The "" value is always "No thinking". A '__custom__' sentinel
// option is appended when the control should offer free-form input
// (numeric budgets or levels beyond the reported set).
export function thinkingOptionsFor(descriptor) {
  const opts = [{ value: '', label: 'No thinking' }];
  if (descriptor && descriptor.kind === 'toggle') {
    opts.push({ value: 'on', label: 'Thinking' });
    return opts;
  }
  if (descriptor && descriptor.kind === 'levels'
      && Array.isArray(descriptor.levels) && descriptor.levels.length) {
    for (const lv of descriptor.levels) {
      opts.push({ value: lv, label: lv.charAt(0).toUpperCase() + lv.slice(1) });
    }
  } else {
    // 'budget' and the no-descriptor fallback share the same presets;
    // budget providers accept the preset → token-count mapping on the
    // server (low=2048, medium=8192, high=16384).
    for (const lv of FALLBACK_LEVELS) {
      opts.push({ value: lv, label: lv.charAt(0).toUpperCase() + lv.slice(1) });
    }
  }
  opts.push({ value: '__custom__', label: 'Custom…' });
  return opts;
}

// thinkingOptionsForSelect(descriptor) -> [{ value, label }]
//
// The same options as thinkingOptionsFor but without the __custom__
// sentinel. Used by consumers that render a plain <select> of presets
// and no free-form input: the Agents editor and the subagent
// authorization card (see ThinkingSelectField.jsx).
export function thinkingOptionsForSelect(descriptor) {
  return thinkingOptionsFor(descriptor).filter((o) => o.value !== '__custom__');
}

// effectiveThinkingLevel(stored) -> string
//
// The value actually sent to the provider. A stored value that is not one
// of the reported levels is a free-form entry (a token budget or an effort
// name), so it travels verbatim; the __custom__ sentinel itself is never a
// value — it only means "the user is typing", and resolves to nothing. It
// is also a self-heal for a chat written by the buggy build that persisted
// the sentinel: no request may go out with it as reasoning_effort.
export function effectiveThinkingLevel(stored) {
  const v = typeof stored === "string" ? stored.trim() : "";
  return v === "__custom__" ? "" : v;
}

// thinkingLabelFor(options, value) -> string
//
// The trigger/row label for a value, tolerating one that is outside the
// reported set (the model changed, or the user typed a number).
export function thinkingLabelFor(options, value) {
  const hit = (options || []).find((o) => o && o.value === value);
  if (hit) return hit.label;
  return value || "No thinking";
}
