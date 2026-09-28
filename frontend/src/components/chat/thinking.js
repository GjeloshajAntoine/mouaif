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

// setThinkingCustomOpen(refs, open, value)
//
// Reveal / hide the free-form custom input for the '__custom__'
// sentinel. Kept here rather than inline in the chat view because the
// open state has to survive `syncThinkingSelect` (see its note) and
// both live in this module.
export function setThinkingCustomOpen(refs, open, value) {
  if (refs) refs._thinkingCustomOpen = !!open;
  const input = refs && refs.thinkingLevelCustom && refs.thinkingLevelCustom.current;
  if (!input) return;
  input.hidden = !open;
  if (open) {
    if (typeof value === 'string') input.value = value;
    input.focus();
  }
}

// commitThinkingCustom(refs)
//
// End an in-progress entry *without* hiding the field. Blur is not a
// dismissal — tapping the composer, the keyboard opening and the
// closing native picker all fire one — so the visibility is left to the
// next `syncThinkingSelect`, which reconciles it against the value that
// was just stored (a known level hides the field and shows its label; a
// free-form number keeps it visible). This clears only the open flag.
export function commitThinkingCustom(refs) {
  if (refs) refs._thinkingCustomOpen = false;
}

// thinkingCustomOpen(refs) -> bool
//
// True while the user is mid-entry in the custom input. Cleared by the
// commit paths (blur / Enter) before they persist, so the next sync
// falls back to normal reconciliation.
export function thinkingCustomOpen(refs) {
  return !!(refs && refs._thinkingCustomOpen);
}

// syncThinkingSelect(refs, state)
//
// Rebuild the thinking <select> options from the active model's
// provider-reported descriptor, then restore the chat's stored
// thinkingLevel selection. Falls back to the generic presets when
// the provider reports nothing. Called whenever the chat record or
// the live model data changes.
//
// This is an imperative DOM rebuild that leaves Preact's render cycle
// alone — which is exactly why it must not close an open custom
// input. It runs on every background live-model fetch (the provider
// catalog can land seconds after the chat paints), and rebuilding the
// <select> used to reset `hidden = true` on the custom input: the
// field the user had just revealed vanished under their finger, and
// the focus() that ran alongside it fired on a display:none element
// so no keyboard ever opened. An in-progress entry now wins over the
// stored value until it is committed.

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
  // An entry in progress outranks everything reconciled above: the user
  // is typing a value that is not stored yet, so a re-sync must leave
  // the sentinel selected and the field visible (and keep the focus).
  if (thinkingCustomOpen(refs) && opts.some((o) => o.value === '__custom__')) {
    sel.value = '__custom__';
    if (custom) custom.hidden = false;
  }
}
