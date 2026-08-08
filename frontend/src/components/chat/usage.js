// mouaif web — Chat usage / cost / context rendering
//
// Three concerns: the per-turn "model • context 14.8K/200K (7%) •
// cost $0.04 • 37 tok/s" line under each assistant bubble, the
// "Context -- / Total --" summary at the top of the chat, and the
// per-provider credit pill (when the upstream exposes it). The
// upstream is the source of truth for token counts and cost; this
// module only formats what the server already computed.

import { fetchJson } from '../../api.js';
import { formatCost, formatTokPerSecond, formatTokens } from '../../usage.js';

// setChatStatus(refs, text, state)
//
// Helper for the status pill in the composer. Uses the same
// data-state pattern as src/api.js → setStatus so styling stays
// consistent (success / busy / error).
export function setChatStatus(refs, text, state) {
  if (!refs.status.current) return;
  refs.status.current.textContent = text;
  if (state) refs.status.current.dataset.state = state;
  else delete refs.status.current.dataset.state;
}

// activeContextWindow(state) -> number | null
//
// Token budget of the chat's current model, looked up from the live
// catalog (project entries merged in at load). Returns null when
// the model is unknown or the provider doesn't expose a context
// size (e.g. Ollama).
export function activeContextWindow(state) {
  const c = state.chat;
  if (!c || !c.modelId || !c.providerId) return null;
  const live = state.liveByProvider || {};
  const arr = live[c.providerId] || [];
  for (const m of arr) {
    if (m && m.id === c.modelId && typeof m.contextWindow === 'number' && m.contextWindow > 0) {
      return m.contextWindow;
    }
  }
  // Fall back to the project-level model record.
  for (const m of (state.models || [])) {
    if (m && m.provider === c.providerId && m.id === c.modelId && typeof m.contextWindow === 'number' && m.contextWindow > 0) {
      return m.contextWindow;
    }
  }
  return null;
}

// updateProviderCredit(state, text, refs)
//
// Stash the credit text on state and rebuild the head summary. The
// text format is "<label> <amount>", e.g. "Balance $3.42". Pass
// null to clear.
export function updateProviderCredit(state, text, refs) {
  state.providerCredit = text || null;
  updateUsageSummary(state, null, refs);
}

// refreshProviderCredit(state, refs)
//
// Fetch the current provider's remaining credit, if the provider
// exposes one. Errors are silent (the pill is purely informational).
export async function refreshProviderCredit(state, refs) {
  const provider = state.chat && state.chat.providerId ? state.chat.providerId : '';
  if (!provider) return updateProviderCredit(state, null, refs);
  try {
    const r = await fetchJson('/api/ai/provider-credit?provider=' + encodeURIComponent(provider));
    if (r.status !== 200 || !r.body || !r.body.supported) return updateProviderCredit(state, null, refs);
    if (typeof r.body.remaining !== 'number') return updateProviderCredit(state, null, refs);
    const label = r.body.label || 'Balance';
    updateProviderCredit(state, label + ' ' + formatCost(r.body.remaining), refs);
  } catch {
    updateProviderCredit(state, null, refs);
  }
}

// updateUsageSummary(state, liveInfo, refs)
//
// Rebuild the head summary. "Context" is the latest upstream prompt
// size (not a sum: every turn already includes earlier context).
// "Total" is the cumulative cost across the chat. The credit pill
// is appended when one is known.
export function updateUsageSummary(state, liveInfo, refs) {
  const el = refs.usageSummary.current;
  if (!el) return;
  const assistant = (state.messages || []).filter((m) => m && m.role === 'assistant');
  let latestContext = null;
  let totalCost = 0;
  let hasKnownCost = false;
  for (const m of assistant) {
    if (m.usage && typeof m.usage.promptTokens === 'number') latestContext = m.usage.promptTokens;
    if (m.cost && m.cost.known && typeof m.cost.total === 'number') {
      totalCost += m.cost.total;
      hasKnownCost = true;
    }
  }
  if (liveInfo) {
    if (liveInfo.usage && typeof liveInfo.usage.promptTokens === 'number') latestContext = liveInfo.usage.promptTokens;
    if (liveInfo.cost && liveInfo.cost.known && typeof liveInfo.cost.total === 'number') {
      totalCost += liveInfo.cost.total;
      hasKnownCost = true;
    }
  }
  el.innerHTML = '';
  // Each value is rendered as a pill (label + number) so the head
  // reads as a row of status chips. The label is a separate span
  // from the number so the label can be tinted softer than the
  // number without touching font-size. Helper builds the pill in
  // one place so the three calls below stay symmetric.
  const makePill = (label, value, opts) => {
    const pill = document.createElement('span');
    if (opts && opts.cls) pill.className = opts.cls;
    const labelEl = document.createElement('span');
    labelEl.className = 'chat-view__usage-summary-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'chat-view__usage-summary-value';
    valueEl.textContent = value;
    pill.appendChild(labelEl);
    pill.appendChild(valueEl);
    return pill;
  };
  el.appendChild(makePill('Context', latestContext == null ? '--' : formatTokens(latestContext)));
  el.appendChild(makePill('Total', hasKnownCost ? formatCost(totalCost) : '--'));
  if (state.providerCredit) {
    // The credit pill is informational, not a budget number, so it
    // gets the success-palette treatment in CSS instead of the
    // accent treatment the first two pills get. Keeps the head
    // from reading as "three identical budget chips".
    // Provider credit is already shaped like "Balance $3.42" by
    // updateProviderCredit above; split on the first space so the
    // label (Balance) and the value ($3.42) each get their own
    // span.
    const creditText = state.providerCredit;
    const space = creditText.indexOf(' ');
    const creditLabel = space > 0 ? creditText.slice(0, space) : creditText;
    const creditValue = space > 0 ? creditText.slice(space + 1) : '';
    const credit = makePill(creditLabel, creditValue, { cls: 'chat-view__usage-summary-credit' });
    el.appendChild(credit);
  }
}

// renderUsageMeta(el, info, state)
//
// Render the per-turn breakdown. Pure DOM, no framework — the chat
// view intentionally avoids Preact here so the SSE hot path stays
// as cheap as a textContent assignment. The line is a flat row of
// "•"-separated tokens sized for a 360 px viewport.
export function renderUsageMeta(el, info, state) {
  el.innerHTML = '';
  el.hidden = false;
  const modelId = info.modelId || '';
  const usage = info.usage || {};
  const cost = info.cost || null;
  const tokens = [];
  if (modelId) tokens.push(modelId);
  if (typeof usage.promptTokens === 'number') {
    let label = 'context ' + formatTokens(usage.promptTokens);
    // When the model's context window is known, show how much of
    // it this turn consumed so the user can see the budget fill
    // up (e.g. "context 14.8K/200K (7%)").
    const win = activeContextWindow(state);
    if (win) {
      const pct = Math.round((usage.promptTokens / win) * 100);
      label += '/' + formatTokens(win) + ' (' + pct + '%)';
    }
    tokens.push(label);
  }
  if (typeof usage.completionTokens === 'number') {
    tokens.push('output ' + formatTokens(usage.completionTokens));
  }
  // Anthropic prompt-cache metrics. Shown only when the provider
  // actually reported cached tokens (reads or writes), so the line
  // reads "cache 1.2K read · 800 written" on tool-heavy Claude turns
  // and stays unchanged for every other provider.
  if ((typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0)
    || (typeof usage.cacheCreationTokens === 'number' && usage.cacheCreationTokens > 0)) {
    const parts = [];
    if (usage.cacheReadTokens > 0) parts.push(formatTokens(usage.cacheReadTokens) + ' read');
    if (usage.cacheCreationTokens > 0) parts.push(formatTokens(usage.cacheCreationTokens) + ' written');
    tokens.push('cache ' + parts.join(' · '));
  }
  if (cost && cost.known) {
    tokens.push('cost ' + formatCost(cost.total));
  } else if (cost && cost.known === false) {
    tokens.push('--');
  }
  // tok/s: prefer the live counter when present (it's
  // continuously updated from the SSE message stream), fall back
  // to the final rate from the done event.
  let rate = info.liveRate;
  if (rate == null && info.streamingMs && typeof usage.completionTokens === 'number') {
    rate = info.streamingMs > 0 ? (usage.completionTokens / info.streamingMs) * 1000 : 0;
  }
  if (rate != null) tokens.push({ kind: 'rate', label: formatTokPerSecond(rate) });
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'chat-msg__meta-sep';
      sep.textContent = '\u00b7';
      el.appendChild(sep);
    }
    const item = tokens[i];
    const span = document.createElement('span');
    if (typeof item === 'string') {
      span.textContent = item;
      if (i === 0) {
        // First token is always the model id (the row above is
        // guaranteed to be an assistant message). Tag it so the
        // CSS can underline it without having to rely on
        // :first-child matching a sibling that's sometimes a
        // separator (when the model id is missing, the first
        // sibling IS a separator).
        span.dataset.token = 'model';
      } else if (/^context /.test(item)) {
        span.dataset.token = 'context';
      } else if (/^output /.test(item)) {
        span.dataset.token = 'output';
      } else if (/^cost /.test(item)) {
        span.dataset.token = 'cost';
      }
      // The "--" fallback (model never reported a cost) is NOT
      // tagged cost on purpose: it would pick up the accent tint
      // and read as a real zero, not as "unknown". Leaving it
      // untagged means it stays in the default --muted color.
    } else if (item && item.kind === 'rate') {
      span.textContent = item.label;
      span.dataset.token = 'rate';
    }
    el.appendChild(span);
  }
}
