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
const seen = state && state.seenSeqs;
if (seen && typeof seen.forEach === 'function') {
seen.forEach((seq) => {
if (typeof seq === 'number' && Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
});
}
return maxSeq + 1;
}
// mergeServerRows(state, rows) -> Message[]
//
// Merge server-persisted `rows` (each stamped with its stable seq)
// into state.messages, never adding the same row twice:
//   - a seq already in state.seenSeqs is a redundant re-delivery -> drop;
//   - else a persisted row first tries to replace its seq-less
//     optimistic twin positionally (the trailing optimistic run maps
//     1:1, in order), then a content match, before being appended.
// Mutates state.seenSeqs (adds every seq it accepts).
export function mergeServerRows(state, rows) {
  const seen = state.seenSeqs;
  const out = state.messages.slice();
  // Trailing seq-less rows are the optimistic/live copies the client
  // appended just now, in order. A batch of persisted rows arriving
  // now corresponds to those trailing rows IN ORDER (both are
  // append-ordered), so align them positionally first — this keeps
  // two identical consecutive assistants (same text) in the right
  // order instead of swapping them by content match.
  const trailing = [];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] && typeof out[i].seq === 'number') break;
    trailing.unshift(i);
  }
  let ti = 0;
  for (const row of rows) {
    let replaceIdx = -1;
    if (typeof row.seq === 'number') {
      if (seen.has(row.seq)) continue; // already merged — drop
      seen.add(row.seq);
      // Positional align with the trailing optimistic run when this
      // row is plausibly the next one (same role).
      while (ti < trailing.length) {
        const idx = trailing[ti];
        const m = out[idx];
        ti++;
        if (m && typeof m.seq !== 'number' && m.role === row.role) { replaceIdx = idx; break; }
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

// tailSyncDomAction(prev, merged) -> 'noop' | 'append' | 'render'
//
// Decide how the DOM must be updated after mergeServerRows turned `prev`
// (state.messages before the merge) into `merged`.
//
//   - 'noop'   — nothing changed (same array reference, or identical rows).
//   - 'append' — a PURE append: every prior row is still at its old index by
//                reference, and rows were only added at the end. The cheap
//                syncTranscriptAppend path (render just messages[prevLen…])
//                is correct and flash-free here.
//   - 'render' — the prefix moved: mergeServerRows either replaced a seq-less
//                optimistic twin in place or spliced a late persisted row into
//                the middle. Appending the tail would repaint an on-screen row
//                (a visible duplicate) or drop a row at the bottom (wrong
//                order), so a full reconcile render is required. The reconcile
//                render reuses every unchanged node, so it does not re-animate.
//
// This is the guard syncTranscriptAppend documents but never enforced at its
// call site — the source of the duplicate/mis-ordered rows the next poll's
// full rebuild "fixed" with a visible reload.
export function tailSyncDomAction(prev, merged) {
  if (!Array.isArray(prev) || !Array.isArray(merged)) return 'noop';
  if (merged === prev) return 'noop';
  const prevLen = prev.length;
  let pureAppend = true;
  for (let i = 0; i < prevLen; i++) {
    if (merged[i] !== prev[i]) { pureAppend = false; break; }
  }
  if (!pureAppend) return 'render';
  return merged.length > prevLen ? 'append' : 'noop';
}

// insertionPointFor(out, seq) -> number
//
// Index at which a persisted row with `seq` belongs in an array that may end
// in a run of seq-less optimistic rows. The optimistic tail represents content
// the server has not persisted yet, so it always sorts after every persisted
// row: it takes precedence over the seq comparison by being skipped.
function insertionPointFor(out, seq) {
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (!m || typeof m.seq !== 'number') return i; // start of the optimistic tail
    if (m.seq > seq) return i;                     // first persisted row that sorts after
  }
  return out.length;
}