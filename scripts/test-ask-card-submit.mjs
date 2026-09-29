// Drive the real question card through failed, pending and successful requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function element(tag) {
  const classes = new Set();
  const handlers = {};
  return {
    tagName: tag.toUpperCase(), children: [], dataset: {}, attrs: {},
    value: '', disabled: false, hidden: false, textContent: '',
    get className() { return [...classes].join(' '); },
    set className(value) { classes.clear(); value.split(/\s+/).forEach((c) => classes.add(c)); },
    classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); } },
    setAttribute(key, value) { this.attrs[key] = value; },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    remove() { this.parent.children = this.parent.children.filter((child) => child !== this); },
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector.toUpperCase()) ? [child] : [],
        ...child.querySelectorAll(selector)
      ]);
    },
    addEventListener(event, handler) { handlers[event] = handler; },
    fire(event) { return handlers[event]?.({ target: this }); },
    click() { if (!this.disabled) return this.fire('click'); },
    scrollIntoView() {}
  };
}

const source = fs.readFileSync(new URL('../frontend/src/components/chat/cards.js', import.meta.url), 'utf8');
const start = source.indexOf('export function askUserCard(');
const end = source.indexOf('// toggleToolGroup', start);
const statuses = [];
let response;
const requests = [];
const askUserCard = vm.runInNewContext(source.slice(start, end).replace('export ', '') + '\naskUserCard;', {
  document: { createElement: element },
  requestAnimationFrame: () => {}, afterTranscriptAppend: () => {},
  fetchJson: async (url, init) => { requests.push({ url, ...JSON.parse(init.body) }); return response(); }
});
const options = [{ label: 'Main', value: 'main' }, { label: 'Trunk', value: 'trunk' }];
function mount(extra = {}) {
  const transcript = element('div');
  askUserCard({ callId: 'ask_test', question: 'Which branch?', options, presets: ['Use default'], ...extra },
    '/project', 'chat_test', { transcript: { current: transcript } }, (...status) => statuses.push(status));
  const card = transcript.children[0];
  const buttons = card.querySelectorAll('button');
  return {
    transcript, card, preset: buttons[0], options: card.querySelectorAll('.tool-card__ask-option'),
    submit: buttons.at(-2), dismiss: buttons.at(-1), note: card.querySelectorAll('textarea')[0],
    error: card.querySelectorAll('.tool-card__ask-error')[0]
  };
}

let ui = mount();
assert.equal(ui.submit.disabled, true);
ui.options[1].click();
ui.note.value = 'Keep hotfixes here';
ui.note.fire('input');
let finish;
response = () => new Promise((resolve) => { finish = resolve; });
let send = ui.submit.click();
assert.equal(ui.submit.textContent, 'Sending…');
assert.equal(ui.note.disabled, true);
assert.equal(ui.card.attrs['aria-busy'], 'true');
assert.ok(ui.card.querySelectorAll('button').every((button) => button.disabled));
ui.note.fire('input');
assert.equal(ui.submit.disabled, true, 'input events cannot unlock a pending request');
ui.dismiss.click();
assert.equal(requests.length, 1, 'no double submission');
finish({ status: 503 });
await send;
assert.equal(ui.transcript.children.length, 1);
assert.equal(ui.error.hidden, false);
assert.equal(ui.error.attrs.role, 'alert');
assert.equal(ui.note.value, 'Keep hotfixes here');
assert.equal(ui.options[1].attrs['aria-checked'], 'true');
assert.equal(ui.note.disabled, false);
assert.equal(ui.submit.disabled, false);
assert.equal(ui.card.attrs['aria-busy'], 'false');
assert.equal(ui.submit.textContent, 'Send answer');
response = () => ({ status: 200 });
await ui.submit.click();
assert.equal(ui.transcript.children.length, 0);
assert.deepEqual(requests.at(-1).payload, { choice: 'trunk', extra: 'Keep hotfixes here' });

ui = mount();
response = () => { throw new Error('Failed to fetch'); };
await ui.preset.click();
assert.equal(ui.error.hidden, false, 'network errors are shown beside the answer');
assert.equal(ui.submit.disabled, true, 'failed presets restore the empty-answer guard');
assert.equal(ui.dismiss.disabled, false);
assert.equal(ui.preset.disabled, false);
response = () => ({ status: 200 });
await ui.preset.click();
assert.equal(ui.transcript.children.length, 0);
assert.deepEqual(requests.at(-1).payload, { choice: 'Use default', extra: '' });

ui = mount();
response = () => { throw new Error('Offline'); };
await ui.dismiss.click();
assert.equal(ui.error.hidden, false);
assert.equal(ui.submit.disabled, true);
response = () => ({ status: 200 });
await ui.dismiss.click();
assert.equal(ui.transcript.children.length, 0);
assert.equal(requests.at(-1).decision, 'deny');
assert.equal('payload' in requests.at(-1), false);

ui = mount();
ui.note.value = 'Use a different branch';
ui.note.fire('input');
assert.equal(ui.submit.textContent, 'Send note');
await ui.submit.click();
assert.deepEqual(requests.at(-1).payload, { choice: '', extra: 'Use a different branch' });

ui = mount({ multiSelect: true });
ui.options.forEach((option) => option.click());
await ui.submit.click();
assert.deepEqual(requests.at(-1).payload, { choice: ['main', 'trunk'], extra: '' });
assert.deepEqual(statuses.at(-1), ['answer sent', 'success']);
console.log('Question card submission: pending lock, retry, presets, dismissal, note and multi-select passed');
