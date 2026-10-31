'use strict';

// The worker that runs `module` hooks (src/hooks.js, docs/features/hooks.md).
//
// One shared worker runs one hook at a time. A hook is an ES-module-shaped
// source with `export default async (event, ctx) => decision`. It is
// evaluated in a fresh vm context with no `require`, `process`, `fetch` or
// timers: only the event and `ctx.log(...)` / `ctx.match(re, text)`. This
// keeps cheap per-call hooks cheap (no process spawn); it is NOT a security
// boundary — a module hook has the same trust as a command hook, and the
// parent recycles this worker when a hook runs past its timeout.
//
// Message in:  { id, source, event }
// Message out: { id, ok: true, result, logs } | { id, ok: false, error, logs }

const { parentPort } = require('node:worker_threads');
const vm = require('node:vm');

const MAX_CACHED = 32;
const MAX_LOG_LINES = 50;
const cache = new Map();

// `export default <expr>` becomes an assignment; any other `export` or an
// `import` is refused, so a hook cannot pull in modules.
function transform(source) {
  if (/^\s*import\s/m.test(source) || /\bimport\s*\(/.test(source)) throw new Error('module hooks cannot import other modules');
  const out = source.replace(/^\s*export\s+default\s+/m, '__hook.default = ');
  if (out === source) throw new Error('a module hook needs `export default async (event, ctx) => { … }`');
  if (/^\s*export\s/m.test(out)) throw new Error('a module hook has a single `export default`');
  return out;
}

function compile(source) {
  let fn = cache.get(source);
  if (fn) return fn;
  const sandbox = { __hook: {} };
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(transform(source), { filename: 'hook-module.js' }).runInContext(sandbox, { timeout: 1000 });
  fn = sandbox.__hook.default;
  if (typeof fn !== 'function') throw new Error('export default must be a function');
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  cache.set(source, fn);
  return fn;
}

if (parentPort) parentPort.on('message', async ({ id, source, event }) => {
  const logs = [];
  const ctx = Object.freeze({
    log: (...parts) => { if (logs.length < MAX_LOG_LINES) logs.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ').slice(0, 500)); },
    match: (re, text) => new RegExp(re).test(String(text == null ? '' : text))
  });
  try {
    const fn = compile(source);
    const result = await fn(event, ctx);
    // Only plain data crosses back: a decision object, a string (context) or nothing.
    const plain = result === undefined || result === null ? null : JSON.parse(JSON.stringify(result));
    parentPort.postMessage({ id, ok: true, result: plain, logs });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String((e && e.message) || e).slice(0, 500), logs });
  }
});

// Exposed for the parent's save-time check (compile only, nothing runs but
// the module's top level, under a 1 s budget).
module.exports = { transform };
