// mouaif web — Chat transcript backward pagination
//
// Long chats used to load their ENTIRE transcript on open: the server
// returned every message, the client built every DOM node, and only
// then did the first screen (and the head usage summary, which iterates
// the full list) become usable. The chat now loads just the newest page
// of messages and fetches older pages on demand as the user scrolls to
// the top.
//
// This module owns the small amount of state that coordinate the
// windowed fetches: how many rows are loaded so far, the next `beforeSeq`
// cursor, whether an older page still exists, and a latch so only one
// page is in flight at a time. It hooks the transcript's scroll listener
// to trigger loads near the top.
//
// The loader is deliberately non-blocking. A page-request resolves and
// prepends via transcript.js `prependOlderTranscript`, which preserves
// the user's scroll position. Failures keep the previous page intact and
// allow a retry on the next scroll (no retry loop).

const PAGE_SIZE = 100;
const NEAR_TOP_PX = 48;

export const PAGE_SIZE_DEFAULT = PAGE_SIZE;

// createPager() -> { offset, beforeSeq, hasMore, loading, total, firstSeq }
//
// Stable per-chat pagination cursor. `offset` counts loaded rows so far;
// `firstSeq` is the smallest seq on screen (the exclusive upper bound for
// the next older page). `beforeSeq` mirrors the server's next-before-seq
// answer. A single object per chat (kept in a ref) so the initial load and
// the scroll-up loader share one cursor.
export function createPager() {
return {
  offset: 0,
  beforeSeq: null,
  hasMore: true,
  loading: false,
  total: null,
  firstSeq: null
};
}

// recordInitialPage(pager, body) -> void
//
// Seed the cursor from the FIRST page (the newest rows the server
// returned when the chat opened). `body` is the window fetch response.
export function recordInitialPage(pager, body) {
if (!pager || !body) return;
pager.offset = Array.isArray(body.messages) ? body.messages.length : 0;
pager.total = typeof body.total === 'number' ? body.total : null;
// The next older page is everything strictly below the oldest row we
// hold. The server echoes the smallest seq on this page (beforeSeq),
// which is exactly that bound.
pager.beforeSeq = typeof body.beforeSeq === 'number' && body.beforeSeq >= 0
  ? body.beforeSeq
  : (Array.isArray(body.messages) && body.messages.length
      ? body.messages[0].seq
      : null);
pager.firstSeq = Array.isArray(body.messages) && body.messages.length
  ? body.messages[0].seq
  : null;
// An absent `hasMore` must not latch pagination off. Older servers (and
// the legacy message endpoints) omit the flag; reading that as "false"
// left a pager that can never load history even though a valid
// `beforeSeq` bound was returned. Only an explicit `false` stops the
// loader; otherwise infer from whether a cursor actually exists.
pager.hasMore = typeof body.hasMore === 'boolean'
  ? body.hasMore
  : pager.beforeSeq !== null && pager.beforeSeq !== undefined;
}

// resetPager(pager) -> void
//
// Clear the cursor for a chat/project change. The next initial page
// re-seeds it.
export function resetPager(pager) {
if (!pager) return;
pager.offset = 0;
pager.beforeSeq = null;
pager.hasMore = true;
pager.loading = false;
pager.total = null;
pager.firstSeq = null;
}

// shouldLoadOlder(pager, scrollTop) -> boolean
//
// Whether the scroll-up loader should fetch another page. True only
// when the user is near the top, an older page exists, and no load is
// already in flight.
export function shouldLoadOlder(pager, scrollTop) {
if (!pager) return false;
if (pager.loading) return false;
if (!pager.hasMore) return false;
if (pager.beforeSeq === null) return false;
return scrollTop < NEAR_TOP_PX;
}

export { NEAR_TOP_PX };
