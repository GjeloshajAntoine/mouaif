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

// scrollToolBodyToBottom(descendant)
//
// Find the nearest .tool-card__body in the ancestor chain and pin
// it to the bottom. Used by the subagent card so nested activity
// stays visible while streaming.
export function scrollToolBodyToBottom(descendant) {
  const body = descendant && descendant.closest && descendant.closest('.tool-card__body');
  if (!body) return;
  body.scrollTop = body.scrollHeight;
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
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
