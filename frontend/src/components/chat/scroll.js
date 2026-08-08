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
