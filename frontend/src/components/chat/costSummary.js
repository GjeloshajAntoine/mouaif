// A total is paired with the exclusive message cursor it covers. Keep this
// baseline independent of metadata PATCHes, which can race a live turn.
export function costSnapshot(body) {
  const cost = body && body.totalCost;
  if (!cost || !Number.isFinite(cost.total) || !Number.isInteger(body.nextSeq) || body.nextSeq < 0) return null;
  return { nextSeq: body.nextSeq, total: cost.total, known: !!cost.known };
}

// attributedCostAfter(held, snapshot, amount) -> { snapshot, total }
//
// Accumulate a non-turn run attributed to this chat (dictation) on top of an
// authoritative cost snapshot. `held` is what the caller kept from last time —
// `{ snapshot, total }` — and the snapshot *object* is the key: a rebase (tail
// sync or reload) hands over a fresh snapshot that already covers every
// attributed run, so the accumulator restarts from zero instead of adding the
// earlier runs a second time. Returns null when the amount is not a usable
// price, so a caller can skip the write entirely.
export function attributedCostAfter(held, snapshot, amount) {
  const delta = Number(amount);
  if (!Number.isFinite(delta) || delta <= 0) return null;
  const key = snapshot || null;
  const base = held && held.snapshot === key && Number.isFinite(held.total) ? held.total : 0;
  return { snapshot: key, total: base + delta };
}

// resolveLiveInfo(state, liveInfo) -> liveInfo | null
//
// The running turn registers `state._liveUsageInfo` (a getter for its current
// live envelope, incl. the in-flight subagent `liveCost`). Callers that rebuild
// the head summary for reasons unrelated to the stream — tail sync, reconcile,
// backfill, snapshot rebase — pass `null`; without this fallback those calls
// dropped the delegated cost from Total until the next usage_update or `done`,
// so the pill flickered down and back up while a subagent was running.
export function resolveLiveInfo(state, liveInfo) {
  if (liveInfo) return liveInfo;
  const get = state && state._liveUsageInfo;
  if (typeof get !== 'function') return null;
  try { return get() || null; } catch { return null; }
}

export function summarizeChatUsage(messages, snapshot, liveInfo, attributedCost) {
  let latestContext = null;
  let totalCost = snapshot ? snapshot.total : 0;
  let hasKnownCost = snapshot ? snapshot.known : false;
  function addCost(cost) {
    if (cost && cost.known && Number.isFinite(cost.total)) {
      totalCost += cost.total;
      hasKnownCost = true;
    }
  }
  // Non-turn runs attributed to this chat mid-session: dictation is billed work
  // that writes no message row, so the snapshot (which covers persisted rows)
  // cannot know about it until the page reloads. The server writes the same
  // number to the persisted chat and project totals, so this only covers the
  // window between the run and the next snapshot.
  if (Number.isFinite(attributedCost) && attributedCost > 0) {
    totalCost += attributedCost;
    hasKnownCost = true;
  }
  for (const message of messages || []) {
    if (!message || message.role !== 'assistant') continue;
    if (message.usage && typeof message.usage.promptTokens === 'number') latestContext = message.usage.promptTokens;
    // Older pages and persisted copies covered by the baseline must never
    // change Total. New server rows and optimistic, seq-less segments do.
    if (!snapshot || !Number.isInteger(message.seq) || message.seq >= snapshot.nextSeq) addCost(message.cost);
  }
  if (liveInfo) {
    if (liveInfo.usage && typeof liveInfo.usage.promptTokens === 'number') latestContext = liveInfo.usage.promptTokens;
    addCost(liveInfo.cost);
    // Subagent deltas are cleared by the stream's done handler when folded
    // into the final remainder, so they are included exactly once.
    addCost(liveInfo.liveCost);
  }
  return { latestContext, totalCost, hasKnownCost };
}
