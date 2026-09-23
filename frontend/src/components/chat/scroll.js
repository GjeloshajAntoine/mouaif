// mouaif web — Chat transcript scroll helpers
//
// The transcript auto-scrolls to the newest message on every append
// while the user is "pinned" to the bottom. Once they scroll up
// more than a threshold we treat them as reading history: appends
// no longer yank the view down, a floating "↓" button appears, and
// a counter tracks how many new rows arrived in the meantime.
// Tapping the button (or scrolling back to the very bottom) re-pins.

// isNearBottom(el) -> bool
//
// "Near" is a 48px threshold — enough to absorb sub-pixel rounding
// without flapping when the user nudges the scroll position.
export function isNearBottom(el) {
if (!el) return true;
return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

// scrollTranscriptToBottom(refs)
//
// Pin to the bottom and clear the pending counter. Pin again on the
// next frame so streaming subagent output (which expands after this
// tick) doesn't stop a few pixels above the newest content.
export function scrollTranscriptToBottom(refs) {
  const el = refs.transcript.current;
  if (!el) return;
  refs.pinnedToBottom.current = true;
  refs.pendingCount.current = 0;
  updateJumpButton(refs);
  pinTranscriptAfterSettle(refs);
}

// pinTranscriptAfterSettle(refs)
//
// Re-pin to the bottom once the transcript has finished reflowing.
// A single `scrollTop = scrollHeight` pins against the PRE-layout
// height; content that grows a frame or two later (markdown code
// blocks, reflowing tool cards, image decode, font metrics) leaves the
// view a few pixels above the newest row with no further append to
// re-trigger a pin — the last element ends up half-visible below the
// fold. Schedule a short, bounded run of rAF checkpoints that re-pin
// while the content keeps growing and stop once the layout is stable.
// Only runs while still pinned (a user scroll-up cancels it) and
// while no chunked render is in flight (that path owns the scroll).
// Key by the stable transcript ref, not the refs bag (rebuilt by Preact).
const pendingPins = new WeakMap();
const programmedTops = new WeakMap();
export function isTranscriptPinScroll(refs, top) {
  const expected = programmedTops.get(refs.transcript);
  programmedTops.delete(refs.transcript);
  return expected != null && Math.abs(expected - top) < 1;
}

export function cancelTranscriptPin(refs) {
  programmedTops.delete(refs.transcript);
  const pending = pendingPins.get(refs.transcript);
  if (!pending) return;
  cancelAnimationFrame(pending.frame);
  pendingPins.delete(refs.transcript);
}

export function pinTranscriptAfterSettle(refs) {
  const el = refs.transcript.current;
  if (!el || !refs.pinnedToBottom.current || refs._suspendScrollPin || refs._insertAnchor) return;
  const existing = pendingPins.get(refs.transcript);
  if (existing && existing.el === el) {
    existing.stableFrames = 0;
    return;
  }
  cancelTranscriptPin(refs);
  const pending = { el, frame: null, stableFrames: 0, frames: 0 };
  pendingPins.set(refs.transcript, pending);
  function step() {
    if (pendingPins.get(refs.transcript) !== pending) return;
    if (!refs.pinnedToBottom.current || refs.transcript.current !== el || refs._suspendScrollPin || refs._insertAnchor) {
      pendingPins.delete(refs.transcript);
      return;
    }
    // All layout reads happen once per frame, after the token burst. Share
    // this scheduler with mutation/resize observers rather than repinning
    // independently for every source of content growth.
    const height = el.scrollHeight;
    const top = el.scrollTop;
    const viewport = el.clientHeight;
    if (height - top - viewport < 1) pending.stableFrames++;
    else {
      pending.stableFrames = 0;
      const bottom = Math.max(0, height - viewport);
      programmedTops.set(refs.transcript, bottom);
      el.scrollTop = bottom;
    }
    if (pending.stableFrames >= 2 || ++pending.frames >= 240) {
      pendingPins.delete(refs.transcript);
      return;
    }
    pending.frame = requestAnimationFrame(step);
  }
  pending.frame = requestAnimationFrame(step);
}

// scrollToolBodyToBottomSoon(descendant)
//
// Pin the nearest .tool-card__body to the bottom, for the live preview hot
// paths (a subagent's nested activity and a shell command's output both stream
// into one).
//
// A naive pin reads `scrollHeight` and writes `scrollTop` — a forced layout —
// and schedules a second, identical pair on the next frame, which on a
// token-rate stream is two synchronous layouts per chunk: exactly what made a
// long build log stall the page. This version performs the scroll at most once
// per animation frame per body, so the caller's chunk handling stays free of
// layout reads, and bounds the re-pin run (240 frames) so a body that keeps
// growing cannot hold the frame loop open indefinitely.
const pendingBodyScrolls = new WeakMap();

// Bounded re-pin budget for one coalesced scroll. Generous enough to cover a
// frame or two of post-append reflow, small enough that a body growing every
// frame stops quickly once the stream goes quiet.
const MAX_BODY_SCROLL_FRAMES = 4;

export function scrollToolBodyToBottomSoon(descendant) {
  if (typeof requestAnimationFrame !== 'function') return;
  const body = descendant && descendant.closest && descendant.closest('.tool-card__body');
  if (!body) return;
  // Already scheduled for the upcoming frame: the pin is a single
  // `scrollTop = scrollHeight` and it will observe every node appended before
  // it runs, so a second chunk in the same frame needs no second schedule.
  if (pendingBodyScrolls.has(body)) return;
  const pending = { frames: 0, cancelled: false };
  pendingBodyScrolls.set(body, pending);
  function step() {
    // Cancelled while the frame was queued (the card was replaced by its
    // result, the transcript was rebuilt) — a browser rAF cannot be un-queued,
    // so the frame is neutralised here instead.
    if (pending.cancelled) return;
    // Forget a body that left the document rather than scrolling it.
    if (body.isConnected === false) {
      pendingBodyScrolls.delete(body);
      return;
    }
    body.scrollTop = body.scrollHeight;
    // Usually settled: the write above landed after the appends. If the body
    // is still short of the bottom, something reflowed later in this frame
    // (wrapped text, a decoded image), so follow up — bounded, so a body that
    // grows every frame cannot hold the loop open once the stream goes quiet.
    const settled = body.scrollHeight - body.scrollTop - body.clientHeight < 1;
    if (settled || ++pending.frames >= MAX_BODY_SCROLL_FRAMES) {
      pendingBodyScrolls.delete(body);
      return;
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// cancelToolBodyScroll(descendant)
//
// Neutralise a scheduled coalesced scroll. Called when a live preview is torn
// down (its card is replaced by the result body) so the queued frame cannot
// scroll nodes that are about to be removed. The frame itself still runs — a
// browser rAF cannot be un-queued — so it is flagged instead, and a later
// schedule for the same body starts from a fresh, unflagged entry.
export function cancelToolBodyScroll(descendant) {
  const body = descendant && descendant.closest && descendant.closest('.tool-card__body');
  if (!body) return;
  const pending = pendingBodyScrolls.get(body);
  if (pending) pending.cancelled = true;
  pendingBodyScrolls.delete(body);
}

// updateJumpButton(refs)
//
// Show or hide the floating "↓ N" button based on the current
// pinned state and pending count.
export function updateJumpButton(refs) {
  const btn = refs.jumpBtn.current;
  if (!btn) return;
  const show = !refs.pinnedToBottom.current && refs.pendingCount.current > 0;
  btn.hidden = !show;
  if (show) {
    const label = btn.querySelector('.chat-view__jump-count');
    if (label) {
      label.textContent = refs.pendingCount.current > 99 ? '99+' : String(refs.pendingCount.current);
    }
  }
}

// afterTranscriptAppend(refs, countNew)
//
// Centralised "something was appended" hook. While pinned, keep the
// view glued to the bottom; while unpinned, bump the FAB counter
// instead of scrolling. Replaces the raw `scrollTop = scrollHeight`
// assignments scattered through the append helpers.
export function afterTranscriptAppend(refs, countNew) {
  const el = refs.transcript.current;
  if (!el) return;
  // While a chunked transcript render is filling in, don't pin to the
  // bottom on every chunk — the transcript is still growing and
  // scrollTop = scrollHeight on each step would yank the scrollbar
  // down dozens of times. The chunked pass re-pins once at the end.
  if (refs._suspendScrollPin) return;
  // The scroll listener owns the pin state. Reading geometry here would
  // force layout for every token, and could repin someone reading history.
  if (refs.pinnedToBottom.current) {
    pinTranscriptAfterSettle(refs);
  } else if (countNew) {
    refs.pendingCount.current += 1;
    updateJumpButton(refs);
  }
}
