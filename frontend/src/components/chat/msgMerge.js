// mouaif web — merge-by-seq transcript reconciliation
//
// Pure helpers shared by stream.js's reconcile/recovery path and the
// unit test (scripts/test-msg-merge.js). No preact/DOM dependencies.
//
// The duplication bug these solve: the client appends optimistic rows
// without a server seq (the user message before the POST, or the live
// assistant bubble before the server persists it). The server then
// persists the SAME message with a stable per-chat seq (both storage
// backends now emit `seq`). The old reconcile concatenated the server
// tail onto state.messages and matched rows by role+ts — but the
// optimistic ts (client clock) differs from the persisted ts (server
// clock), so the persisted twin was drawn a second time.
//
// mergeServerRows fixes identity: a row whose seq is already in
// state.seenSeqs is never re-added, and a persisted row REPLACES its
// seq-less optimistic twin in place (positionally, not by content) so
// the bubble keeps its spot and does not duplicate.

// isReplaceable(prev, next) -> bool
//
// Fallback content match when positional alignment can't place a row
// (used only for seq-less rows the positional pass skipped). Equality
// is by role + content — NOT ts, which differs between an optimistic
// and its persisted twin.
export function isReplaceable(prev, next) {
  if (!prev || !next) return false;
  if (prev.role !== next.role) return false;
  if (prev.content !== next.content) return false;
  if (prev.role === 'assistant' && (prev.reasoning || '') !== (next.reasoning || '')) return false;
  return true;
}

// nextServerMessageIndex(state) -> number
//
// Return the next server-side `seq` the client has not merged yet.
// This is intentionally based on stable per-row identity, not
// `state.messages.length`: while a turn is live the client holds
// optimistic seq-less rows (user bubble / assistant segment) that make
// the array longer than the persisted prefix. Using array length for
// `?fromSeq=` can skip the just-persisted server rows, delaying catch-up
// until a full rebuild or the end of the run.
export function nextServerMessageIndex(state) {
let maxSeq = -1;
const list = state && Array.isArray(state.messages) ? state.messages : [];
for (const m of list) {
if (m && typeof m.seq === 'number' && Number.isFinite(m.seq) && m.seq > maxSeq) maxSeq = m.seq;
}
return maxSeq + 1;
}

// heldSeqs(messages) -> Set<number>
//
// The seqs of the saved rows the client holds. Derived from the message list
// on demand instead of kept as a second store: a separate seen-set had to be
// rebuilt on load, rebuild and chat switch, and any path that forgot left it
// disagreeing with the list it described.
export function heldSeqs(messages) {
const set = new Set();
if (!Array.isArray(messages)) return set;
for (const m of messages) {
if (m && typeof m.seq === 'number' && Number.isFinite(m.seq)) set.add(m.seq);
}
return set;
}
// mergeServerRows(state, rows) -> Message[]
//
// Merge server-persisted `rows` (each stamped with its stable seq)
// into state.messages, never adding the same row twice:
//   - a seq the client already holds (or saw earlier in this batch) is a
//     redundant re-delivery -> drop;
//   - a row carrying a `clientId` replaces the held row with that id, or is
//     inserted at its seq position when this client never drew it;
//   - a legacy row (no clientId) first tries to replace its seq-less
//     optimistic twin positionally (the trailing optimistic run maps
//     1:1, in order), then a content match, before being appended.
// Pure: returns a new array and never mutates `state`.
export function mergeServerRows(state, rows) {
  const out = state.messages.slice();
  const seen = heldSeqs(out);
  // Trailing seq-less rows are the optimistic/live copies the client
  // appended just now, in order. A batch of persisted rows arriving
  // now corresponds to those trailing rows IN ORDER (both are
  // append-ordered), so align them positionally first — this keeps
  // two identical consecutive assistants (same text) in the right
  // order instead of swapping them by content match.
  //
  // The run is held by object reference, not index: a persisted row with no
  // twin is spliced in ahead of the run, which shifts every later index, so a
  // stored index would then point at the row BEFORE the intended twin.
  const trailing = [];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] && typeof out[i].seq === 'number') break;
    trailing.unshift(out[i]);
  }
  let ti = 0;
  for (const row of rows) {
    let replaceIdx = -1;
    if (typeof row.seq === 'number') {
      if (seen.has(row.seq)) continue; // already merged — drop
      seen.add(row.seq);
      // Exact identity first: a saved row that echoes the clientId of an
      // unsaved row IS that row (docs/features/chat-client-row-ids.md).
      // When the batch row carries an id, the guessing below never runs:
      // an id that matches nothing held here means this client never drew
      // the row (another tab's turn, a tool row), so it is inserted by seq
      // and cannot steal the slot of an unrelated optimistic row.
      if (typeof row.clientId === 'string' && row.clientId) {
        replaceIdx = indexOfClientId(out, row.clientId);
        if (replaceIdx >= 0) {
          const t = trailing.indexOf(out[replaceIdx]);
          if (t >= ti) ti = t + 1;
          out[replaceIdx] = row;
        } else {
          out.splice(insertionPointFor(out, row.seq), 0, row);
        }
        continue;
      }
      // Legacy rows (saved before clientId existed, or from a server
      // that does not echo it) fall back to guessing. Positional align
      // with the trailing optimistic run: the next
      // trailing row of the same role is this row's twin. Skipped rows
      // are consumed only on a match — a persisted row with no optimistic
      // twin (a tool call/result the client never held as a message) must
      // not burn the slot of the answer that follows it, or that answer's
      // persisted twin is appended below its optimistic copy (a duplicate).
      for (let j = ti; j < trailing.length; j++) {
      const m = trailing[j];
      if (!m || m.role !== row.role) continue;
      const idx = out.indexOf(m);
      if (idx === -1) continue;
      replaceIdx = idx;
      ti = j + 1;
      break;
      }
      // Fall back to a content match among remaining seq-less rows.
      if (replaceIdx === -1) {
        for (let i = out.length - 1; i >= 0; i--) {
          const m = out[i];
          if (m && typeof m.seq !== 'number' && isReplaceable(m, row)) { replaceIdx = i; break; }
        }
      }
    }
    if (replaceIdx >= 0) out[replaceIdx] = row;
    // No seq-less twin to replace. The batch is the persisted record of rows
    // the client has not merged yet, so put the row at its seq position
    // rather than blindly pushing it:
    //
    //  - `out`'s seq-less trailing optimistics (the live segments) sort LAST,
    //    because the server has not persisted them yet. Inserting at the
    //    first persisted row we already hold keeps the tail preserved.
    //  - A batch can lead with rows belonging BETWEEN persisted rows we hold
    //    — the common case being the tail fetch on an early turn, where the
    //    cursor is still 0 and the server returns the WHOLE transcript. The
    //    optimistic user/assistant rows we do hold replace their twins, but
    //    the tool call/result rows of that same turn have no twin. Appending
    //    them placed the tool cards after the assistant answer that followed
    //    them, and syncTranscriptAppend renders only the appended tail, so
    //    the DOM order was wrong too.
    else out.splice(insertionPointFor(out, row.seq), 0, row);
  }
  return out;
}

// tailSyncDomAction(prev, merged) -> 'noop' | 'append' | 'reconcile'
//
// Decide how the DOM must be updated after mergeServerRows turned `prev`
// (state.messages before the merge) into `merged`.
//
//   - 'noop'      — nothing changed (same array reference, or a same-length
//                   array with every row still at its old index).
//   - 'append'    — a PURE append: every prior row is still at its old index by
//                   reference AND the old array ended on a persisted row, so
//                   the new rows occupy exactly messages[prevLen…]. The cheap
//                   syncTranscriptAppend path (render just that slice) is exact
//                   and flash-free.
//   - 'reconcile' — anything else that grew or rewrote the array: an optimistic
//                   twin replaced in place, a persisted row spliced in before
//                   the retained seq-less tail, or a tail expansion whose new
//                   rows do not sit at prevLen. Appending the tail would repaint
//                   an on-screen row or drop a row at the bottom, so this needs
//                   the keyed reconciler — which REUSES every row already on
//                   screen by key and only builds the genuinely new ones.
//
// Why a reconcile and not a full renderTranscript:
//
//   A tail sync is always the same chat, and mergeServerRows only ever adds
//   rows or replaces a seq-LESS optimistic twin in place — it never removes or
//   edits a persisted row. So every persisted row already on screen is still in
//   `merged` under the same key and is reused untouched; only the optimistic
//   tail (which the DOM renders from the live stream, not from state.messages)
//   changes identity. The header cards cannot have moved either: their inputs
//   (system prompt, tool catalog, agent files, skills) come from other stores.
//   Calling renderTranscript here therefore did work a reconcile does not need
//   — most expensively, snapshotExpandedState + restoreExpandedState over every
//   tool card twice — on the very first frame after returning to a running chat
//   from another app. That full pass was the "the chat takes seconds to come
//   back" cost, and the keyed reconcile it fell through to was already reusing
//   the nodes; only the wrapper re-parsed and re-walked them.
//
// Callers must still route 'reconcile' through a helper that falls back to a
// full render when the transcript has no message rows yet or a chunked pass is
// mid-flight (see transcript.js reconcileTranscript): there the reconciler
// would build the whole transcript in one blocking pass instead of painting the
// tail first.
export function tailSyncDomAction(prev, merged) {
  if (!Array.isArray(prev) || !Array.isArray(merged)) return 'noop';
  if (merged === prev) return 'noop';
  const prevLen = prev.length;
  let prefixIntact = true;
  for (let i = 0; i < prevLen; i++) {
    if (merged[i] !== prev[i]) { prefixIntact = false; break; }
  }
  // Same length: an in-place optimistic replace (prefix moved) needs a reconcile
  // to key the persisted row and drop the replaced node; an identical prefix is
  // a genuine no-op.
  if (merged.length <= prevLen) return prefixIntact ? 'noop' : 'reconcile';
  // Growing array: the cheap append is exact only when the prefix is untouched
  // and the old array ended on a persisted row, so the new rows start at
  // prevLen. A retained seq-less tail makes those indices name the optimistic
  // row instead, which is the resume case and must reconcile.
  const lastOld = prevLen > 0 ? prev[prevLen - 1] : null;
  if (prefixIntact && (!lastOld || typeof lastOld.seq === 'number')) return 'append';
  return 'reconcile';
}

// indexOfClientId(list, clientId) -> number
//
// Index of the row carrying `clientId`, or -1.
function indexOfClientId(list, clientId) {
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m && m.clientId === clientId) return i;
  }
  return -1;
}

// newClientId(prefix) -> string
//
// A fresh id for a row the client draws before the server saves it. Sent
// with the request so the server stores it, then matched when the saved
// row comes back. Random, so two tabs never collide.
export function newClientId(prefix) {
  let rand = '';
  try {
    const bytes = new Uint8Array(9);
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) rand += b.toString(36).padStart(2, '0');
  } catch {
    rand = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  return (prefix || 'c') + '_' + rand.slice(0, 18);
}

// insertionPointFor(out, seq) -> number
//
// Index at which a persisted row with `seq` belongs in an array that may end
// in a run of seq-less optimistic rows. The optimistic tail represents content
// the server has not persisted yet, so it always sorts after every persisted
// row.
//
// Seq-less rows are not only the tail: a client-side error card (or a
// subagent answer) stays in the MIDDLE of the transcript, seq-less, once later
// turns are persisted below it. Such a row says nothing about where `seq`
// belongs, so it must not end the scan — stopping at the first seq-less row
// spliced a new turn's rows ABOVE every older turn that followed the error
// (the answer landing above its question). Only persisted rows are compared:
// the row goes before the first one that sorts after it, else right after the
// last persisted row (i.e. ahead of the optimistic tail).
function insertionPointFor(out, seq) {
  let afterLastPersisted = 0;
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (!m || typeof m.seq !== 'number') continue;
    if (m.seq > seq) return i;                     // first persisted row that sorts after
    afterLastPersisted = i + 1;
  }
  return afterLastPersisted;
}