// mouaif web — jump to a message by its seq
//
// The run list (RunDock.jsx) lists every prompt a recurring task started in the
// chat. The transcript only holds the newest pages until older ones are loaded,
// so a jump first pulls older pages until the row exists, then scrolls to it.

const DEFAULT_TIMEOUT_MS = 20000;
const BUSY_WAIT_MS = 120;

// findRowBySeq(root, seq) -> Element | null
export function findRowBySeq(root, seq) {
  if (!root || typeof root.querySelector !== 'function' || !Number.isFinite(seq)) return null;
  return root.querySelector('[data-seq="' + Math.trunc(seq) + '"]');
}

// findToolCard(root, callId) -> Element | null — a top-level tool card.
export function findToolCard(root, callId) {
  if (!root || typeof root.querySelector !== 'function' || !callId) return null;
  const id = String(callId);
  const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
  return root.querySelector('.tool-card[data-tool-id="' + esc + '"]');
}

// jumpToSeq({ root, seq, find, hasMore, loadOlder, scrollTo, flash, wait, now, timeoutMs }) -> Promise<boolean>
//
//   find(root)  optional: the element to land on, in place of the row with
//               `seq` (the agent dock looks for a tool card by call id)
//   hasMore()   whether an older page still exists
//   loadOlder() fetches and prepends one older page; resolves false when nothing
//               was inserted (also while the background drain holds the page latch)
// Resolves true once the row was found and scrolled to, false if it never
// appeared (deleted, or the wait ran out).
export async function jumpToSeq({ root, seq, find, hasMore, loadOlder, scrollTo, flash, wait, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const sleep = wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  const locate = find || ((r) => findRowBySeq(r, seq));
  for (;;) {
    const row = locate(root);
    if (row) {
      scrollTo(row);
      if (flash) flash(row);
      return true;
    }
    if (now() > deadline) return false;
    if (!hasMore()) {
      // Rows can still be arriving from the background drain.
      await sleep(BUSY_WAIT_MS);
      if (!locate(root) && !hasMore()) return false;
      continue;
    }
    const inserted = await loadOlder();
    if (!inserted) await sleep(BUSY_WAIT_MS);
  }
}

// flashRow(row) — a short highlight on the row a jump landed on.
export function flashRow(row, ms = 1700) {
  if (!row || !row.classList) return;
  row.classList.remove('chat-msg--flash');
  // Restart the animation when the same row is jumped to twice.
  void row.offsetWidth;
  row.classList.add('chat-msg--flash');
  setTimeout(() => row.classList.remove('chat-msg--flash'), ms);
}
