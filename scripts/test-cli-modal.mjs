// Exercise the real modal's startup, Run, recovery and phone viewport wiring.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CliScreen } from '../frontend/src/components/chat/utils.js';
import * as keys from '../frontend/src/components/chat/cliKeys.js';
import * as suggest from '../frontend/src/components/chat/cliSuggest.js';
const outputSource = fs.readFileSync(new URL('../frontend/src/components/chat/cliOutput.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '').replace('export function subscribeCliOutput', 'function subscribeCliOutput');

const source = fs.readFileSync(new URL('../frontend/src/components/chat/CliModal.jsx', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '').replace('export function CliModal', 'function CliModal');
const flush = () => new Promise(setImmediate);

function mount({ sessionStatus = 200, outputStatus = 200, running = true, commandStatus = 200 } = {}) {
  const hooks = [], requests = [], effects = [];
  const timers = new Set();
  const styles = {};
  let cursor = 0, nodes = [], eventSource, viewportCallback, resolveOutput;
  let nextSessionStatus = sessionStatus;
  const outputPromise = new Promise((resolve) => { resolveOutput = resolve; });
  const outputNode = { textContent: '', scrollTop: 0, scrollHeight: 200, clientHeight: 100,
    addEventListener() {}, removeEventListener() {} };
  const overlayNode = { style: { setProperty: (key, value) => { styles[key] = value; } } };
  function useRef(initial) {
    const i = cursor++;
    if (!hooks[i]) hooks[i] = { current: initial };
    return hooks[i];
  }
  const context = vm.createContext({
    ...keys, ...suggest, CliScreen,
    setTimeout: (fn) => { timers.add(fn); return fn; },
    clearTimeout: (fn) => timers.delete(fn),
    useRef,
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = initial;
      return [hooks[i], (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }];
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect(fn, deps = []) {
      const i = cursor++;
      const previous = hooks[i];
      if (previous && deps.every((value, j) => Object.is(value, previous.deps[j]))) return;
      effects.push(() => { previous?.cleanup?.(); hooks[i].cleanup = fn(); });
      hooks[i] = { deps };
    },
    useModal: () => ({ current: null }),
    useVisualViewport: (fn) => { viewportCallback = fn; },
    fetchJson: async (url, init) => {
      requests.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      if (url.startsWith('/api/tools/cli/session?')) return { status: nextSessionStatus,
        body: nextSessionStatus === 200 ? { id: 'cli_test', interactive: false, shell: '/bin/sh' } : { error: 'Cannot start shell' } };
      if (url.startsWith('/api/tools/cli/output?')) return outputPromise;
      if (url.startsWith('/api/files?')) return { status: 200, body: { entries: [] } };
      return { status: commandStatus, body: { error: 'Session lost' } };
    },
    EventSource: class {
      constructor() { this.listeners = {}; eventSource = this; }
      addEventListener(type, fn) { this.listeners[type] = fn; }
      close() { this.closed = true; }
    },
    h(tag, attrs, ...children) {
      attrs ||= {};
      const node = { tag, attrs, children: children.flat() };
      nodes.push(node);
      if (attrs.ref) {
        const dom = tag === 'pre' ? outputNode : attrs.class === 'cli__overlay' ? overlayNode :
          { value: attrs.value || '', focus() {}, setSelectionRange() {} };
        if (typeof attrs.ref === 'function') attrs.ref(dom);
        else attrs.ref.current = dom;
      }
      return node;
    }
  });
  vm.runInContext(outputSource + '\n' + source + '\nthis.CliModal = CliModal;', context);
  function render() {
    cursor = 0;
    nodes = [];
    context.CliModal({ projectDir: '/project', onClose() {} });
    for (const effect of effects.splice(0)) effect();
    return nodes;
  }
  render();
  return {
    render, requests, outputNode, styles,
    node: (label) => nodes.find((n) => n.attrs['aria-label'] === label),
    button: (text) => nodes.find((n) => n.tag === 'button' && n.children.includes(text)),
    viewport: (height, offsetTop) => viewportCallback({ height, offsetTop }),
    emit: (data) => eventSource.listeners.cli_output({ data: JSON.stringify({ id: 'cli_test', ...data }) }),
    replay: () => resolveOutput({ status: outputStatus, body: { running, chunks: [] } }),
    retry: () => { nextSessionStatus = 200; },
    cleanup: () => {
    for (const hook of hooks) hook?.cleanup?.();
    assert.equal(timers.size, 0, 'unmount clears output catch-up timers');
    }
  };
}

// Live output can arrive while the replay request is still pending. It paints
// against a null <pre> while loading; finishing startup must paint it again.
let ui = mount();
await flush();
ui.emit({ seq: 1, stream: 'stdout', data: 'ready> ' });
ui.render();
assert.equal(ui.outputNode.textContent, '');
ui.replay();
await flush();
ui.render();
assert.equal(ui.outputNode.textContent, 'ready>', 'startup output paints when the terminal mounts');
assert.ok(ui.node('Run command'), 'the compact send icon has an accessible Run label');
assert.equal(ui.button('Run'), undefined, 'Run does not widen the prompt with extra text');
assert.equal(ui.node('Terminal keys').attrs['aria-expanded'], false);
assert.equal(ui.node('Terminal keys').tag, 'button', 'keys are behind a compact toggle by default');
ui.node('Terminal keys').attrs.onClick();
ui.render();
assert.equal(ui.node('Terminal keys').attrs['aria-expanded'], true);
assert.ok(ui.node('Ctrl+C — interrupt the running command'));
ui.node('Command line').attrs.onInput({ currentTarget: { value: 'echo hello' } });
ui.render();
ui.node('Run command').attrs.onClick();
await flush();
assert.equal(ui.requests.filter((r) => r.body).at(-1).body.cmd, 'echo hello');
assert.equal(ui.requests.filter((r) => r.body).at(-1).body.raw, false);
ui.render();
ui.node('Command line').attrs.onKeyDown({ key: 'Enter', preventDefault() {} });
await flush();
assert.equal(ui.requests.filter((r) => r.body).at(-1).body.cmd, '', 'empty Enter accepts a program default');
ui.viewport(320, 28);
assert.equal(ui.styles['--cli-viewport-height'], '320px');
assert.equal(ui.styles['--cli-viewport-top'], '28px');
ui.emit({ seq: 2, stream: 'exit', data: '0' });
ui.render();
assert.ok(ui.node('Shell ended'));
assert.equal(ui.node('Command line'), undefined);
ui.cleanup();
console.log('PASS startup output, compact Run, optional keys, writes, viewport pan and exit controls');

for (const commandStatus of [404, 410]) {
  ui = mount({ commandStatus });
  ui.replay();
  await flush();
  ui.render();
  ui.node('Run command').attrs.onClick();
  await flush();
  ui.render();
  assert.ok(ui.node('Shell ended'), `HTTP ${commandStatus} offers Restart when the exit event was missed`);
  assert.equal(ui.node('Command line'), undefined);
  ui.node('Restart shell').attrs.onClick();
  ui.render();
  await flush();
  ui.render();
  assert.ok(ui.node('Run command'));
  assert.equal(ui.requests.filter((r) => r.url.startsWith('/api/tools/cli/session?')).length, 2);
  ui.cleanup();
}
console.log('PASS missing/dead sessions recover through Restart without reopening');

for (const options of [{ outputStatus: 404 }, { running: false }]) {
  ui = mount(options);
  ui.replay();
  await flush();
  ui.render();
  assert.ok(ui.node('Shell ended'), 'replay detects an ended shell without an exit frame');
  ui.cleanup();
}
ui = mount({ sessionStatus: 503 });
await flush();
ui.render();
assert.ok(ui.button('Retry'), 'startup failures have an actionable retry');
ui.retry();
ui.button('Retry').attrs.onClick();
ui.render();
ui.replay();
await flush();
ui.render();
assert.ok(ui.node('Run command'));
ui.cleanup();
console.log('PASS early shell exit and failed startup recovery');

const css = fs.readFileSync(new URL('../frontend/src/chat-composer.css', import.meta.url), 'utf8');
assert.match(css, /\.cli__overlay \{[^}]*top: var\(--cli-viewport-top[^}]*height: var\(--cli-viewport-height/);
assert.match(css, /\.cli__suggest \{[^}]*overflow-x: auto/);
assert.match(css, /\.cli__suggest-chip \{[^}]*min-height: var\(--tap\)/);
assert.match(css, /\.cli__prompt \{[^}]*height: 2rem[^}]*font-size: 1rem/);
assert.match(css, /\.cli__run::before,[\s\S]*?inset: 0\.5rem/);
console.log('PASS keyboard-safe overlay and compact control faces');
