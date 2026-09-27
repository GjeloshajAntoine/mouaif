// The project card's search field: what the card renders, and when.
//
// A browser fixture showed the layout, but the parts that are easy to break
// are not visual: when a request is sent, which answer is allowed to land on
// the screen, what the list shows while typing, and what closing the field
// leaves behind. Those are pinned here by running the real component with a
// minimal hook harness — per-component state slots, dependency-aware effects,
// and effect cleanups — and a fake server.
//
// The contracts:
//   1. The field exists only after the magnifier is tapped, and it is focused.
//   2. A settled term — not every keystroke — is what reaches /api/chats/search.
//   3. A stale answer is dropped. Two terms in flight, the older answering
//      last, must not overwrite the newer one.
//   4. While a term is unanswered the card falls back to the normal chat list:
//      a result must never be shown for a term the server did not see.
//   5. Closing the field clears the term and the results — reopening starts
//      from the project's chats, not from the previous query.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = (file) => fs.readFileSync(new URL('../frontend/src/' + file, import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace(/^export /gm, '');

const PROJECT = { id: 'p1', name: 'mouaif', path: '/fixture/project & name', totalCost: { total: 1.5, known: true } };
const CHATS = [
  { id: 'aaaa1111', title: 'Fix chat view arrow layout', createdAt: '2026-03-02T15:40:00Z', totalCost: { total: 0, known: false }, messageCount: 4 },
  { id: 'bbbb2222', title: 'Review ui', createdAt: '2026-03-02T14:53:00Z', totalCost: { total: 0.07, known: true }, messageCount: 3 }
];
const HITS = [
  { id: 'bbbb2222', title: 'kumquat notes', matchField: 'title', snippet: 'kumquat notes', createdAt: '2026-03-02T15:39:00Z', totalCost: { total: 0.6, known: true }, messageCount: 12 },
  { id: 'eeee5555', title: 'Rebuild the pipeline', matchField: 'message', snippet: 'the kumquat handler moved', createdAt: '2026-03-02T13:00:00Z', totalCost: { total: 0.2, known: true }, messageCount: 8 },
  { id: 'ffff6666', title: 'Scratch', matchField: 'draft', snippet: 'kumquats not sent yet', createdAt: '2026-03-01T09:00:00Z', totalCost: { total: 0, known: false }, messageCount: 0 }
];

function createCard() {
  // ---- hook harness ------------------------------------------------------
  //
  // State is per component instance, keyed by the render path, because the
  // card's chat list is a *child* component: sharing one slot array between
  // parent and child would have the child read the parent's state (which is
  // exactly what the first version of this test did, and it "passed" nothing).
  const instances = new Map();
  let current = null;
  let stack = [];
  let nodes = [];

  function instanceFor(key) {
    let inst = instances.get(key);
    if (!inst) { inst = { states: [], refs: [], effects: [], cursor: 0 }; instances.set(key, inst); }
    return inst;
  }

  function h(tag, attrs, ...children) {
    if (typeof tag === 'function') {
      const selfKey = stack.join('/') + '/' + (attrs && attrs.key != null ? attrs.key : tag.name || 'c');
      const inst = instanceFor(selfKey);
      const prevCurrent = current, prevStack = stack;
      current = inst;
      inst.cursor = 0;
      stack = selfKey.split('/');
      const out = tag(Object.assign({}, attrs, { children }));
      current = prevCurrent;
      stack = prevStack;
      return out;
    }
    const node = { tag, attrs: attrs || {}, children };
    nodes.push(node);
    return node;
  }

  const callComponent = (fn) => h(fn, {});

  function useState(initial) {
    const inst = current, i = inst.cursor++;
    if (i >= inst.states.length) inst.states[i] = typeof initial === 'function' ? initial() : initial;
    return [inst.states[i], (value) => { inst.states[i] = typeof value === 'function' ? value(inst.states[i]) : value; }];
  }
  function useRef(value) {
    const inst = current, i = inst.cursor++;
    if (!inst.refs[i]) inst.refs[i] = { current: value };
    return inst.refs[i];
  }
  function useEffect(fn, deps) {
    const inst = current, i = inst.cursor++;
    const prev = inst.effects[i];
    const changed = !prev || !deps || !prev.deps
      || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]));
    inst.effects[i] = { deps, cleanup: prev ? prev.cleanup : undefined, rearm: changed, fn };
  }

  // Effects run after the commit, like React: pending timers from the previous
  // pass are cleaned up before the new ones are armed (this is what makes the
  // debounce coalesce keystrokes instead of stacking a request per keystroke),
  // and a component that mounted in *this* pass runs its effect for the first
  // time. State written by an effect paints on the next render, exactly as in
  // Preact — so a test that waits for a request renders again to see the
  // answer (see `settle`).
  function commitEffects() {
    for (const inst of instances.values()) {
      for (const slot of Object.values(inst.effects)) {
        if (!slot || !slot.rearm) continue;
        if (typeof slot.cleanup === 'function') slot.cleanup();
        slot.cleanup = slot.fn();
        slot.rearm = !slot.deps;   // no deps: re-run on every commit
      }
    }
  }

  const requests = [];
  const pending = new Map();   // query -> resolve, so a test can answer out of order
  let mode = 'ok';             // ok | error | manual

  // ---- component under test ---------------------------------------------
  const context = vm.createContext({
    URLSearchParams, setTimeout, clearTimeout, Object,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    projectsReload: { value: 0 },
    nav() {},
    Fragment: 'fragment',
    PromptIcon: 'prompt-icon',
    useClickOutside() {},
    formatCost: (n) => '$' + n.toFixed(2),
    confirm: () => true,
    alert() {},
    useRef, useState, useEffect, h,
    fetchJson: async (url) => {
      if (url.startsWith('/api/projects/registered')) return { status: 200, body: { projects: [PROJECT] } };
      if (url.startsWith('/api/chats/search')) {
        const q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [])[1] || '');
        requests.push(q);
        if (mode === 'manual') return new Promise((resolve) => pending.set(q, resolve));
        if (mode === 'error') return { status: 500, body: { error: 'boom' } };
        return { status: 200, body: { chats: q === 'kumquat' ? HITS : [], query: q, total: 0 } };
      }
      if (url.startsWith('/api/chats?')) return { status: 200, body: { chats: CHATS, total: CHATS.length } };
      if (url.startsWith('/api/prompts')) return { status: 200, body: { prompts: [] } };
      return { status: 404, body: {} };
    }
  });
  vm.runInContext(source('components/Projects.jsx'), context);

  // A commit: paint, then flush effects (mounts included), then paint the
  // state the effects wrote. Preact does this itself; here it has to be asked
  // for, because a state write outside an event handler still needs a render.
  function render() {
    nodes = [];
    stack = [];
    current = null;
    callComponent(context.ProjectsView);
    commitEffects();
    return nodes;
  }

  const select = (predicate) => nodes.filter((node) => node.tag && predicate(node));
  const field = () => select((node) => node.attrs.class === 'project-card__search-input')[0] || null;
  const magnifier = () => select((node) => node.attrs.class === 'project-card__search-open')[0] || null;
  const closeBtn = () => select((node) => node.attrs.class === 'project-card__search-close')[0] || null;
  const empty = () => select((node) => node.attrs.class === 'project-card__chats-empty')[0] || null;
  // A chat row is `project-card__chat` or `project-card__chat project-card__chat--match`.
  // The prefix alone would also catch `project-card__chats-empty` and
  // `project-card__chats-more`, which are `<li>`s in the same list.
  const isChatRow = (node) => node.tag === 'li'
    && /^project-card__chat(\s|$)/.test(String(node.attrs.class || ''));
  const chatRows = () => select(isChatRow);
  const rowTitles = () => chatRows().map((node) => node.attrs.key);
  const rowMatches = () => chatRows().map((node) => node.attrs['data-match'] || null);
  const snippetText = () => select((node) => node.attrs.class === 'project-card__chat-snippet')
    .map((node) => node.children.filter((c) => typeof c === 'string').join(''));
  const badgeText = () => select((node) => node.attrs.class === 'project-card__chat-badge')
    .map((node) => node.children.filter((c) => typeof c === 'string').join(''));

  const settle = async () => { await new Promise((r) => setTimeout(r, 260)); await new Promise((r) => setImmediate(r)); };

  return {
    requests, render, field, magnifier, closeBtn, empty, rowTitles, rowMatches, snippetText, badgeText,
    project: PROJECT,
    setMode: (next) => { mode = next; },
    answer: (q, body) => { const resolve = pending.get(q); pending.delete(q); resolve(body); },
    // Type into the field the way a keyboard does: the keystroke paints and
    // re-arms the debounce, then the answer paints when it settles.
    async type(text) {
      const input = field();
      input.attrs.onInput({ currentTarget: { value: text } });
      render();          // the keystroke paints and the effect re-arms
      await settle();
      return render();   // the answer paints
    },
    // Type without letting the debounce fire: the mid-flight state.
    typeImmediate(text) {
      const input = field();
      input.attrs.onInput({ currentTarget: { value: text } });
      return render();
    },
    async mount() {
      for (let i = 0; i < 4; i++) {
        render();
        await new Promise((r) => setImmediate(r));
      }
      return render();
    },
    click(node) { node.attrs.onClick({ stopPropagation() {} }); return render(); }
  };
}

// ---- 1. the field is hidden until the magnifier is tapped -----------------
const card = createCard();
await card.mount();
assert.equal(card.field(), null, 'no search field before the magnifier is tapped');
assert.deepEqual(card.rowTitles(), ['aaaa1111', 'bbbb2222'], 'the card lists the project chats');
assert.ok(card.magnifier(), 'the magnifier button is on the card');
assert.equal(card.magnifier().attrs['aria-expanded'], 'false', 'the toggle reports the field as closed');
assert.ok(card.magnifier().attrs['aria-label'].includes('Search chats'), 'the magnifier is labelled');

card.click(card.magnifier());
assert.ok(card.field(), 'tapping the magnifier renders the field');
assert.equal(card.field().attrs.type, 'search', 'the field is a search input');
assert.equal(card.field().attrs['aria-label'], 'Search chats in ' + PROJECT.name, 'the field names its project');
assert.equal(card.field().attrs.enterkeyhint, 'search', 'the phone keyboard offers Search');
assert.equal(card.magnifier().attrs['aria-expanded'], 'true', 'the toggle reports the field as open');
assert.equal(card.requests.length, 0, 'opening the field sends no request');
assert.deepEqual(card.rowTitles(), ['aaaa1111', 'bbbb2222'], 'opening the field keeps the normal chat list');
assert.equal(card.closeBtn().attrs['aria-label'], 'Close search', 'the field offers a close action');

// ---- 2. only a settled term is searched, and the rows are the results -----
await card.type('kumquat');
assert.deepEqual(card.requests, ['kumquat'], 'one request for the settled term');
assert.deepEqual(card.rowTitles(), ['bbbb2222', 'eeee5555', 'ffff6666'], 'the list is the search results');
assert.deepEqual(card.rowMatches(), ['title', 'message', 'draft'], 'each row reports why it matched');
assert.deepEqual(card.snippetText(), ['the kumquat handler moved', 'kumquats not sent yet'],
  'a message or draft hit shows its snippet; a title hit does not repeat the title');
assert.deepEqual(card.badgeText(), ['text', 'draft'], 'the badge distinguishes a message hit from a draft hit');

// ---- 3. an unanswered term shows no stale rows ---------------------------
card.typeImmediate('kumquat no');
assert.equal(card.empty(), null, 'the searching state is not the empty state');
assert.deepEqual(card.rowTitles(), [], 'a term still being typed never shows the previous term\'s hits');
assert.ok(
  card.render().some((node) => node.attrs.class === 'project-card__chats-empty'
    && /searching/.test(String(node.children[0]))),
  'the card says it is searching instead of showing rows for another term'
);

// ---- 4. a stale answer never lands ---------------------------------------
const race = createCard();
await race.mount();
race.click(race.magnifier());
race.setMode('manual');
await race.type('alpha');
await race.type('beta');
assert.deepEqual(race.requests, ['alpha', 'beta'], 'both terms were sent');
// 'beta' was typed last, so it is the current term — and 'alpha' answers after it.
race.answer('beta', { status: 200, body: { chats: [{ id: 'dddd4444', title: 'beta hit', matchField: 'title', snippet: 'beta hit', createdAt: '2026-03-02T10:00:00Z', totalCost: { total: 0, known: false }, messageCount: 1 }], query: 'beta' } });
await new Promise((r) => setImmediate(r));
race.render();
race.answer('alpha', { status: 200, body: { chats: [{ id: 'cccc3333', title: 'alpha hit', matchField: 'title', snippet: 'alpha hit', createdAt: '2026-03-02T09:00:00Z', totalCost: { total: 0, known: false }, messageCount: 1 }], query: 'alpha' } });
await new Promise((r) => setImmediate(r));
race.render();
assert.deepEqual(race.rowTitles(), ['dddd4444'], 'the answer for the current term wins, whatever order they arrive in');
assert.equal(race.empty(), null, 'the dropped answer raises no state of its own');

// ---- 5. a failure is stated, and a "no match" is not a failure -----------
const failing = createCard();
await failing.mount();
failing.click(failing.magnifier());
failing.setMode('error');
await failing.type('zzzz');
assert.deepEqual(failing.rowTitles(), [], 'a failed search shows no rows');
assert.ok(failing.empty(), 'a failed search says so');
assert.ok(/search failed/.test(String(failing.empty().children[0])), 'the message names the failure');
assert.ok(/500/.test(String(failing.empty().children[0])), 'the message carries the status');

failing.setMode('ok');
await failing.type('nope');
assert.ok(failing.empty(), 'no match shows the empty state');
assert.ok(/No chat matches/.test(String(failing.empty().children[0])), 'the empty state quotes the term');

// ---- 6. closing resets everything; reopening starts fresh ---------------
failing.click(failing.closeBtn());
assert.equal(failing.field(), null, 'closing removes the field');
assert.equal(failing.magnifier().attrs['aria-expanded'], 'false', 'the toggle reports the field as closed');
assert.equal(failing.empty(), null, 'closing clears the search states');
assert.deepEqual(failing.rowTitles(), ['aaaa1111', 'bbbb2222'], 'closing restores the normal chat list');
failing.click(failing.magnifier());
assert.equal(failing.field().attrs.value, '', 'reopening starts from an empty term');
assert.deepEqual(failing.rowTitles(), ['aaaa1111', 'bbbb2222'], 'reopening does not re-run the old query');
failing.click(failing.magnifier());
assert.equal(failing.field(), null, 'the magnifier closes the field it opened');

// ---- 7. Escape closes the field -----------------------------------------
const escaping = createCard();
await escaping.mount();
escaping.click(escaping.magnifier());
await escaping.type('kumquat');
assert.deepEqual(escaping.rowTitles(), ['bbbb2222', 'eeee5555', 'ffff6666'], 'the field is open with results');
escaping.field().attrs.onKeyDown({ key: 'Escape', preventDefault() {} });
escaping.render();
assert.equal(escaping.field(), null, 'Escape closes the field');
assert.deepEqual(escaping.rowTitles(), ['aaaa1111', 'bbbb2222'], 'Escape restores the normal chat list');

console.log('ok');
