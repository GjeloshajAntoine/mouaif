// A total is paired with the exclusive message cursor it covers. Keep this
// baseline independent of metadata PATCHes, which can race a live turn.
export function costSnapshot(body) {
  const cost = body && body.totalCost;
  if (!cost || !Number.isFinite(cost.total) || !Number.isInteger(body.nextSeq) || body.nextSeq < 0) return null;
  return { nextSeq: body.nextSeq, total: cost.total, known: !!cost.known };
}

export function summarizeChatUsage(messages, snapshot, liveInfo) {
  let latestContext = null;
  let totalCost = snapshot ? snapshot.total : 0;
  let hasKnownCost = snapshot ? snapshot.known : false;
  function addCost(cost) {
    if (cost && cost.known && Number.isFinite(cost.total)) {
      totalCost += cost.total;
      hasKnownCost = true;
    }
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
