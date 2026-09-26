// Unit test for the merge-by-seq transcript reconciliation
// (frontend/src/components/chat/msgMerge.js). Proves the fix for the
// "last few messages repeat on reload / while streaming" bug: the
// client's optimistic rows (no seq) must not be duplicated when the
// server's persisted twin (with seq) crosses the wire on the next
// reconcile — under a single per-chat row identity.
//
// Pure module, no preact/DOM — runnable directly.

'use strict';

let pass = 0, fail = 0;
function t(name, cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + JSON.stringify(msg)) : '')); }
}

async function run() {
  const { mergeServerRows, isReplaceable, nextServerMessageIndex, tailSyncDomAction } = await import(
    '../frontend/src/components/chat/msgMerge.js'
  );

  // Case 1: optimistic user msg (no seq) + server-persisted twin (seq 0).
  let s = { seenSeqs: new Set(), messages: [{ role: 'user', content: 'hi', ts: 'C' }] };
  let out = mergeServerRows(s, [{ role: 'user', content: 'hi', ts: 'S', seq: 0 }]);
  t('optimistic user replaced, not duplicated',
    out.length === 1 && out[0].seq === 0 && out[0].ts === 'S', out);

  // Case 2: live assistant bubble (no seq) + persisted twin (seq 1).
  s = { seenSeqs: new Set(), messages: [
    { role: 'user', content: 'hi', ts: 'C', seq: 0 },
    { role: 'assistant', content: 'answer', reasoning: '', ts: 'C' }
  ] };
  out = mergeServerRows(s, [{ role: 'assistant', content: 'answer', reasoning: '', ts: 'S', seq: 1, usage: {} }]);
  t('assistant live replaced, not duplicated',
    out.length === 2 && out[1].seq === 1, out);

  // Case 3: already-merged row re-delivered (same seq) — dropped.
  s = { seenSeqs: new Set([0, 1]), messages: [
    { role: 'user', content: 'hi', ts: 'S', seq: 0 },
    { role: 'assistant', content: 'answer', reasoning: '', ts: 'S', seq: 1 }
  ] };
  out = mergeServerRows(s, [{ role: 'user', content: 'hi', ts: 'S', seq: 0 }]);
  t('already-seen seq dropped (no re-add)', out.length === 2, out);

  // Case 4: genuine new append.
  s = { seenSeqs: new Set([0, 1]), messages: [
    { role: 'user', content: 'hi', ts: 'S', seq: 0 },
    { role: 'assistant', content: 'answer', reasoning: '', ts: 'S', seq: 1 }
  ] };
  out = mergeServerRows(s, [{ role: 'user', content: 'next', ts: 'S', seq: 2 }]);
  t('genuine append added', out.length === 3 && out[2].seq === 2, out);

  // Case 5: two identical consecutive assistants stay in order (the
  // positional align must not swap them).
  s = { seenSeqs: new Set([0]), messages: [
    { role: 'user', content: 'q', ts: 'S', seq: 0 },
    { role: 'assistant', content: 'same', reasoning: '', ts: 'C1' },
    { role: 'assistant', content: 'same', reasoning: '', ts: 'C2' }
  ] };
  out = mergeServerRows(s, [
    { role: 'assistant', content: 'same', reasoning: '', ts: 'S1', seq: 1 },
    { role: 'assistant', content: 'same', reasoning: '', ts: 'S2', seq: 2 }
  ]);
  t('identical assistants aligned positionally (no dup, no swap)',
    out.length === 3 && out[1].seq === 1 && out[1].ts === 'S1' && out[2].seq === 2 && out[2].ts === 'S2', out);

  // Case 6: tail-fetch index is based on persisted seq, not array
  // length. A live client can hold optimistic seq-less rows while the
  // server has already persisted rows 1..N; using messages.length as
  // `since` would skip row 1 here.
  s = { seenSeqs: new Set([0]), messages: [
    { role: 'user', content: 'hi', ts: 'S', seq: 0 },
    { role: 'assistant', content: 'live partial', reasoning: '', ts: 'C' }
  ] };
  t('nextServerMessageIndex ignores optimistic rows', nextServerMessageIndex(s) === 1, nextServerMessageIndex(s));

  // Case 7: isReplaceable rejects different content.
  t('isReplaceable false on different content',
    !isReplaceable({ role: 'assistant', content: 'a', reasoning: '' }, { role: 'assistant', content: 'b', reasoning: '' }));

  // Case 8: the tail fetch on an EARLY turn returns the whole transcript.
  // nextServerMessageIndex is max+1 over persisted rows only, so a chat whose
  // client holds just optimistic seq-less rows reports `since=0` and the
  // server answers with every row it has — tool rows included. Those tool rows
  // have no optimistic twin, and the old code pushed them onto the END of the
  // array, which placed the tool cards AFTER the assistant answer that
  // followed them and made syncTranscriptAppend render them out of order.
  s = { seenSeqs: new Set(), messages: [
    { role: 'user', content: 'run it', ts: 'C' },
    { role: 'assistant', content: 'answer', reasoning: '', ts: 'C' }
  ] };
  out = mergeServerRows(s, [
    { role: 'user', content: 'run it', ts: 'S', seq: 0 },
    { role: 'tool', phase: 'call', name: 'shell', ts: 'S', seq: 1 },
    { role: 'tool', phase: 'result', name: 'shell', ok: true, ts: 'S', seq: 2 },
    { role: 'assistant', content: 'answer', reasoning: '', ts: 'S', seq: 3 }
  ]);
  t('a full-transcript tail batch keeps seq order (tool rows stay above the answer)',
    out.map((m) => m.role + ':' + (m.seq == null ? 'x' : m.seq)).join(',') === 'user:0,tool:1,tool:2,assistant:3',
    out.map((m) => m.role + ':' + (m.seq == null ? 'x' : m.seq)).join(','));
  t('the optimistic tail rows were replaced, not duplicated',
    out.length === 4 && out.filter((m) => m.role === 'user').length === 1, out.length);

  // Case 9: a seq-less tail row with no twin in the batch (here an optimistic
  // user bubble whose POST is still in flight) sorts after every persisted
  // row, so new tool/answer rows land between the prefix and that tail.
  s = { seenSeqs: new Set([0]), messages: [
    { role: 'user', content: 'q', ts: 'S', seq: 0 },
    { role: 'user', content: 'q2', ts: 'C' }
  ] };
  out = mergeServerRows(s, [
    { role: 'tool', phase: 'call', name: 'shell', ts: 'S', seq: 1 },
    { role: 'assistant', content: 'done', reasoning: '', ts: 'S', seq: 2 }
  ]);
  t('an unmatched optimistic tail stays last while new persisted rows insert before it',
    out.map((m) => m.role + ':' + (m.seq == null ? 'x' : m.seq)).join(',') === 'user:0,tool:1,assistant:2,user:x',
    out.map((m) => m.role + ':' + (m.seq == null ? 'x' : m.seq)).join(','));

  // Case 9b: a tool row (never held client-side as a message) must not burn
  // the positional slot of the answer that follows it. The answer's twin is
  // replaced even when its text differs slightly (so the content fallback
  // cannot rescue it) — otherwise the optimistic copy stays below the
  // persisted one: a duplicate, out of order.
  s = { seenSeqs: new Set(), messages: [
    { role: 'user', content: 'q', ts: 'C' },
    { role: 'assistant', content: 'ans', reasoning: 'r', ts: 'C' }
  ] };
  out = mergeServerRows(s, [
    { role: 'user', content: 'q', ts: 'S', seq: 0 },
    { role: 'tool', phase: 'call', name: 'shell', ts: 'S', seq: 1 },
    { role: 'tool', phase: 'result', name: 'shell', ts: 'S', seq: 2 },
    { role: 'assistant', content: 'ans', reasoning: 'r ', ts: 'S', seq: 3 }
  ]);
  t('a tool row does not steal the answer\'s optimistic slot',
    out.map((m) => m.role + ':' + (m.seq == null ? 'x' : m.seq)).join(',') === 'user:0,tool:1,tool:2,assistant:3',
    out.map((m) => m.role + ':' + (m.seq == null ? 'x' : m.seq)).join(','));

  // Case 9c: multi-segment turn — tool rows between segments, every segment's
  // twin replaced in order, even with non-matching text.
  s = { seenSeqs: new Set(), messages: [
    { role: 'user', content: 'q', ts: 'C' },
    { role: 'assistant', content: 'seg1', ts: 'C' },
    { role: 'assistant', content: 'seg2', ts: 'C' },
    { role: 'assistant', content: 'final', ts: 'C' }
  ] };
  out = mergeServerRows(s, [
    { role: 'user', content: 'q', seq: 0 },
    { role: 'assistant', content: 'seg1 ', seq: 1 },
    { role: 'tool', phase: 'call', seq: 2 },
    { role: 'tool', phase: 'result', seq: 3 },
    { role: 'assistant', content: 'seg2 ', seq: 4 },
    { role: 'tool', phase: 'call', seq: 5 },
    { role: 'tool', phase: 'result', seq: 6 },
    { role: 'assistant', content: 'final ', seq: 7 }
  ]);
  t('multi-segment turn keeps seq order with no duplicates',
    out.map((m) => m.seq == null ? 'x' : m.seq).join(',') === '0,1,2,3,4,5,6,7',
    out.map((m) => m.seq == null ? 'x' : m.seq).join(','));

  // Case 9d: a client-only error card stays seq-less in the MIDDLE of the
  // transcript once later turns are persisted below it. A new turn's rows
  // must land at the bottom, not spliced above that card (which put the
  // answer above its question and above every turn after the error).
  s = { seenSeqs: new Set([0, 1, 2, 3]), messages: [
    { role: 'user', content: 'q1', seq: 0 },
    { role: 'assistant', content: 'a1', seq: 1 },
    { role: 'system', content: 'Network error' },
    { role: 'user', content: 'q2', seq: 2 },
    { role: 'assistant', content: 'a2', seq: 3 },
    { role: 'user', content: 'q3' }
  ] };
  out = mergeServerRows(s, [
    { role: 'user', content: 'q3', seq: 4 },
    { role: 'tool', phase: 'call', seq: 5 },
    { role: 'tool', phase: 'result', seq: 6 },
    { role: 'assistant', content: 'a3', seq: 7 }
  ]);
  t('a mid-transcript error card does not pull a new turn above older turns',
    out.map((m) => m.seq == null ? 'x' : m.seq).join(',') === '0,1,x,2,3,4,5,6,7',
    out.map((m) => m.seq == null ? 'x' : m.seq).join(','));

  // Case 10: rows already held at/above the new seq are not displaced — the
  // insertion point must skip past every persisted row that sorts before.
  s = { seenSeqs: new Set([0, 1]), messages: [
    { role: 'user', content: 'q', ts: 'S', seq: 0 },
    { role: 'assistant', content: 'a1', reasoning: '', ts: 'S', seq: 1 }
  ] };
  out = mergeServerRows(s, [{ role: 'tool', phase: 'call', name: 'shell', ts: 'S', seq: 2 }]);
  t('a later row lands after the persisted prefix', out.length === 3 && out[2].seq === 2, out.map((m) => m.seq));

  // ---- tailSyncDomAction: which DOM path a merge outcome needs -----------
  //
  // Regression for the "element appears twice / wrong order / random reload"
  // bug: applyTailSync used to run the cheap append (render only the new tail)
  // on EVERY merge that grew the array — but a merge that replaces an
  // optimistic twin or splices a row into the middle moves the prefix, so the
  // append repaints an on-screen row or drops one at the bottom. These assert
  // the guard now steering those cases to a full reconcile render instead.

  // Same array reference -> nothing to do.
  {
    const a = [{ role: 'user', content: 'hi', seq: 0 }];
    t('tailSyncDomAction: same reference is a no-op', tailSyncDomAction(a, a) === 'noop');
  }

  // Pure append: prefix rows unchanged by reference, one row added at the end.
  {
    const u = { role: 'user', content: 'hi', seq: 0 };
    const prev = [u];
    const merged = [u, { role: 'assistant', content: 'a', seq: 1 }];
    t('tailSyncDomAction: a genuine append uses the cheap path',
      tailSyncDomAction(prev, merged) === 'append');
  }

  // Optimistic twin replaced in place: prev[0] (seq-less) becomes the
  // persisted row (a NEW object) at index 0 -> prefix moved -> full render.
  {
    const prev = [{ role: 'user', content: 'hi' }];
    const merged = mergeServerRows({ seenSeqs: new Set(), messages: prev.slice() },
      [{ role: 'user', content: 'hi', seq: 0 }]);
    t('tailSyncDomAction: an in-place optimistic replace needs a full render',
      tailSyncDomAction(prev, merged) === 'render');
  }

  // Middle splice: a late persisted row (seq 1) lands between held rows while a
  // seq-less live segment stays last -> prefix moved -> full render, not append.
  {
    const live = { role: 'assistant', content: 'live', reasoning: '' };
    const prev = [{ role: 'user', content: 'q', seq: 0 }, live];
    const merged = mergeServerRows({ seenSeqs: new Set([0]), messages: prev.slice() },
      [{ role: 'tool', phase: 'call', name: 'shell', seq: 1 }]);
    t('tailSyncDomAction: a middle splice needs a full render',
      tailSyncDomAction(prev, merged) === 'render');
  }

  // Bad input is a safe no-op.
  t('tailSyncDomAction: non-arrays are a no-op',
    tailSyncDomAction(null, undefined) === 'noop' && tailSyncDomAction([], null) === 'noop');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });