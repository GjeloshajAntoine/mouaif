'use strict';

// Tests for the chat head's Balance pill formatting
// (frontend/src/components/chat/usage.js → refreshProviderCredit).
//
// The pill is fed by GET /api/ai/provider-credit, which now has *two* success
// shapes: a money balance (`remaining`, a number of dollars) and an
// already-formatted figure (`value`) for Codex, the one subscription
// connection, whose plan window is a percentage. The bug this guards against is
// obvious in hindsight and easy to reintroduce: running "62%" through the
// currency formatter prints "$0.00", which reads as "you have no credit left"
// — a wrong number in a pill whose whole contract is that a number it shows is
// real. So: a percentage is never formatted as money, and a payload that
// carries neither figure leaves the pill hidden instead of showing "$0.00".
//
// The server side of both shapes is covered by scripts/test-provider-credit.js
// and scripts/test-provider-credit-route.js.

const assert = require('node:assert/strict');

// ---- minimal DOM -------------------------------------------------------
//
// The module under test is DOM-only (it builds the pills by hand so the SSE hot
// path stays a plain textContent assignment), so the test supplies the one
// document method it calls instead of pulling in a DOM library.
function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(), childNodes: [], className: '', dataset: {},
    hidden: false, _text: '',
    appendChild(child) { this.childNodes.push(child); return child; },
    // updateUsageSummary clears the head with `innerHTML = ''` before
    // rebuilding it, so the setter has to drop the children like the real one.
    set innerHTML(_v) { this.childNodes = []; },
    get innerHTML() { return ''; },
    set textContent(v) { this._text = String(v); this.childNodes = []; },
    get textContent() {
      return this._text + this.childNodes.map((c) => c.textContent).join('');
    }
  };
}
globalThis.document = { createElement: makeElement };

(async () => {
  const { refreshProviderCredit, updateProviderCredit, updateUsageSummary } =
    await import('../frontend/src/components/chat/usage.js');

  const realFetch = globalThis.fetch;

  // A summary element good enough for updateUsageSummary's innerHTML/DOM use.
  function fakeRefs() {
    const el = makeElement('span');
    el.innerHTML = '';
    return { usageSummary: { current: el } };
  }

  // The pill builder is not exported, so read the pills back off the element the
  // module built: each child is a <span> holding a label span and a value span,
  // which CSS separates with a small gap (textContent alone would run them
  // together), so join the two with a space the way the rendered pill reads.
  function pillTexts(el) {
    return el.childNodes.map((c) => c.childNodes.map((n) => n.textContent).join(' ').trim());
  }

  function stubFetch(body, status = 200) {
    globalThis.fetch = async () => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
  }

  function newState(providerId = 'codex') {
    return { chat: { providerId, modelId: 'm' }, messages: [], costSnapshot: null, attributedCost: 0 };
  }

  try {
    // ---- the money shape, unchanged ------------------------------------
    {
      const state = newState('openai-compatible');
      const refs = fakeRefs();
      stubFetch({ provider: 'openai-compatible', supported: true, label: 'Balance', remaining: 3.42 });
      await refreshProviderCredit(state, refs);
      assert.equal(state.providerCredit, 'Balance $3.42', state.providerCredit);
      assert.deepEqual(pillTexts(refs.usageSummary.current), ['Context --', 'Total --', 'Balance $3.42']);
      console.log('PASS a money balance still formats through the currency formatter');
    }

    // ---- the Codex plan-window shape -----------------------------------
    {
      const state = newState('codex');
      const refs = fakeRefs();
      stubFetch({ provider: 'codex', supported: true, label: 'Plan plus', value: '62%' });
      await refreshProviderCredit(state, refs);
      assert.equal(state.providerCredit, 'Plan plus 62%', state.providerCredit);
      assert.deepEqual(pillTexts(refs.usageSummary.current),
        ['Context --', 'Total --', 'Plan plus 62%']);
      console.log('PASS a Codex plan window shows as a percentage, never as $0.00');
    }

    // ---- nothing to show ------------------------------------------------
    {
      const state = newState('groq');
      const refs = fakeRefs();
      stubFetch({ provider: 'groq', supported: false });
      await refreshProviderCredit(state, refs);
      assert.equal(state.providerCredit, null);
      assert.deepEqual(pillTexts(refs.usageSummary.current), ['Context --', 'Total --']);
      console.log('PASS an unsupported provider leaves the pill off the head');
    }
    {
      // A 200 with neither figure is a payload we do not understand: no pill,
      // and specifically not a "$0.00" that would read as an empty account.
      const state = newState('codex');
      const refs = fakeRefs();
      stubFetch({ provider: 'codex', supported: true, label: 'Plan plus' });
      await refreshProviderCredit(state, refs);
      assert.equal(state.providerCredit, null);
      console.log('PASS a supported payload with no figure shows no pill');
    }
    {
      const state = newState('codex');
      const refs = fakeRefs();
      stubFetch({ error: 'Provider unreachable', code: 'EUNREACHABLE' }, 503);
      await refreshProviderCredit(state, refs);
      assert.equal(state.providerCredit, null);
      console.log('PASS a failed lookup is silent');
    }
    {
      const state = newState('');
      const refs = fakeRefs();
      let called = 0;
      globalThis.fetch = async () => { called++; return { status: 200, text: async () => '{}' }; };
      await refreshProviderCredit(state, refs);
      assert.equal(state.providerCredit, null);
      assert.equal(called, 0, 'no provider means no request');
      console.log('PASS a chat with no provider makes no request');
    }

    // A previously shown pill is cleared when the new answer has nothing.
    {
      const state = newState('codex');
      const refs = fakeRefs();
      updateProviderCredit(state, 'Plan plus 62%', refs);
      stubFetch({ provider: 'codex', supported: false });
      await refreshProviderCredit(state, refs);
      assert.equal(state.providerCredit, null);
      assert.deepEqual(pillTexts(refs.usageSummary.current), ['Context --', 'Total --']);
      console.log('PASS a stale pill is cleared rather than left on screen');
    }

    // updateUsageSummary is safe to call with no element at all.
    updateUsageSummary(newState(), null, { usageSummary: { current: null } });
    console.log('PASS a missing summary element is tolerated');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('\nall pill checks passed');
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
