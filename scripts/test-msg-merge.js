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
  const { mergeServerRows, isReplaceable, nextServerMessageIndex } = await import(
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

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });