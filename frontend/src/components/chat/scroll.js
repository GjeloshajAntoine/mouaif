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
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => {
    if (refs.pinnedToBottom.current && refs.transcript.current === el) {
      el.scrollTop = el.scrollHeight;
    }
  });
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
let _settleToken = 0;
export function pinTranscriptAfterSettle(refs) {
  const token = ++_settleToken;
  const el = refs.transcript.current;
  if (!el) return;

  let stableFrames = 0;
  const STABLE_FRAMES_TO_STOP = 2;
  // Long transcript renders reflow well past a short fixed budget: image
  // decode, async markdown, tool-card expansion, and the reasoning
  // <details> collapse all grow the tail a frame or many frames later.
  // A hard frame cap that expires before the layout stabilises strands
  // the view 100s of px above the newest row (the "scroll not following /
  // not at the bottom on open" bug). Keep re-pinning while content is
  // still growing, and stop only after a couple of consecutive stable
  // frames. The stable-frame requirement (not a frame count) bounds it:
  // static content settles in ~2 frames; content that keeps growing
  // keeps following. A user scroll-up still cancels it at any frame.
  const MAX_FRAMES = 240; // generous ceiling; stable frames stop far sooner

  function step(frame) {
    if (token !== _settleToken) return; // superseded by a newer pin
    if (!refs.pinnedToBottom.current) return; // user scrolled up
    if (refs._suspendScrollPin || refs._insertAnchor) return; // chunked pass owns scroll
    if (refs.transcript.current !== el) return; // detached / re-created
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap < 1) {
      stableFrames += 1;
      if (stableFrames >= STABLE_FRAMES_TO_STOP) return;
    } else {
      stableFrames = 0;
      el.scrollTop = el.scrollHeight;
    }
    if (frame < MAX_FRAMES) requestAnimationFrame(() => step(frame + 1));
  }
  requestAnimationFrame(() => step(0));
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
  if (refs.pinnedToBottom.current || isNearBottom(el)) {
    scrollTranscriptToBottom(refs);
  } else if (countNew) {
    refs.pendingCount.current += 1;
    updateJumpButton(refs);
  }
}
