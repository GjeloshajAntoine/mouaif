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

// syncThinkingSelect(refs, state)
//
// Rebuild the thinking <select> options from the active model's
// provider-reported descriptor, then restore the chat's stored
// thinkingLevel selection. Falls back to the generic presets when
// the provider reports nothing. Called whenever the chat record or
// the live model data changes.
// thinkingOptionsForSelect(descriptor) -> [{ value, label }]
//
// The same options as thinkingOptionsFor but without the __custom__
// sentinel. Used by consumers that do not render the free-form custom
// input (the Agents editor and the subagent authorization card), which
// surface a plain <select> of presets + "No thinking".
export function thinkingOptionsForSelect(descriptor) {
  return thinkingOptionsFor(descriptor).filter((o) => o.value !== "__custom__");
}

export function syncThinkingSelect(refs, state) {
  const sel = refs.thinkingLevel && refs.thinkingLevel.current;
  if (!sel) return;
  const tlVal = (state.chat && state.chat.thinkingLevel) || '';
  state.thinkingLevel = tlVal;

  const opts = thinkingOptionsFor(thinkingDescriptorFor(state));
  // Rebuild options in place. The select is a plain DOM node managed
  // outside Preact's render cycle, so replaceChildren is safe here.
  sel.replaceChildren();
  for (const o of opts) {
    const el = document.createElement('option');
    el.value = o.value;
    el.textContent = o.label;
    if (o.value === '__custom__') el.style.fontStyle = 'italic';
    sel.appendChild(el);
  }

  const custom = refs.thinkingLevelCustom && refs.thinkingLevelCustom.current;
  const inOpts = opts.some((o) => o.value === tlVal);
  if (inOpts) {
    sel.value = tlVal;
    if (custom) custom.hidden = true;
  } else if (tlVal) {
    // Stored value not in the reported set — keep it via the custom path.
    const hasCustomSentinel = opts.some((o) => o.value === '__custom__');
    if (hasCustomSentinel) {
      sel.value = '__custom__';
      if (custom) { custom.value = tlVal; custom.hidden = false; }
    } else {
      // No custom escape hatch (toggle kind) — the stored value can't
      // be represented; show "No thinking" and leave state untouched
      // so the next send uses the provider default.
      sel.value = '';
      if (custom) custom.hidden = true;
    }
  } else {
    sel.value = '';
    if (custom) custom.hidden = true;
  }
}
