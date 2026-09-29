'use strict';

// A frontend view must import every local helper it calls.
//
// The bug this pins: commit 67efda56 ("make the Back arrow return where you
// came from") rewrote the links in
// frontend/src/components/SettingsMcpRegistry.jsx and, in the same edit,
// dropped the `projectQS` import — while the store still built its
// configured-server request with it:
//
//   const r = await fetchJson('/api/mcp/servers' + projectQS(projectDir));
//
// esbuild bundles a free identifier as a global without a warning, so the
// build stayed green and the store still rendered. The ReferenceError only
// fired at runtime, inside the load effect: `loadConfigured()` rejected, so
// every card lost its Installed badge and its "Open" button. The store is
// built around its search field, and this class of mistake is invisible to
// `node --check` and to `vite build`.
//
// This test is a faithful loader: every module runs in its own function
// scope, its `import … from '…'` statements become real bindings (a bare
// specifier gets a stub, a relative path loads recursively), and the view is
// rendered. A helper the file forgot to import is simply not in scope, so the
// render reproduces the browser's `ReferenceError` instead of hiding it
// behind a global. No static guessing, so there are no false positives.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'frontend', 'src');
const ROOT = path.join(__dirname, '..');

let NODES = [], EFFECTS = [], STATES = [], CURSOR = 0, FIRST = true;
const REQUESTS = [];
const moduleCache = new Map();

// ---- render observability ----------------------------------------------

function resetRender() {
  NODES = []; EFFECTS = []; STATES = []; CURSOR = 0; FIRST = true;
}

const STUBS = {
  preact: {
    h(tag, attrs, ...children) { const node = { tag, attrs: attrs || {}, children }; NODES.push(node); return node; },
    Fragment: 'fragment',
    render() {}
  },
  'preact/hooks': {
    useState(initial) {
      const i = CURSOR++;
      if (FIRST) STATES[i] = typeof initial === 'function' ? initial() : initial;
      return [STATES[i], (value) => { STATES[i] = typeof value === 'function' ? value(STATES[i]) : value; }];
    },
    useEffect(effect) { EFFECTS.push(effect); },
    useRef(value) { const i = CURSOR++; if (FIRST) STATES[i] = { current: value }; return STATES[i]; },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn(); },
    useLayoutEffect(effect) { EFFECTS.push(effect); }
  },
  '@preact/signals': { signal: (v) => ({ value: v }) }
};

const API_STUB = {
  fetchJson: async (url) => {
    REQUESTS.push(String(url));
    if (String(url).startsWith('/api/mcp/registry')) return { status: 200, body: { servers: [], metadata: {} } };
    return { status: 200, body: { servers: [] } };
  },
  loadApp: async () => ({}), saveApp: async () => ({}), appProviders: () => [], loadAccounts: async () => ({}),
  invalidateModelsCache() {}, loadModels: async () => ({ models: [] })
};

// Bare specifiers that are not stubbed resolve to an empty object rather than
// crashing the loader; the component only touches them at render time.
const emptyStub = () => new Proxy({}, { get: (t, k) => (k === 'default' ? undefined : undefined) });

function resolveLocal(spec, fromFile) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, base + '.js', base + '.jsx', path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Rewrite imports into `__req()` bindings and drop `export` keywords, so the
// file body can run inside a wrapper function with its own scope.
function rewrite(text) {
  let out = text;
  out = out.replace(/^import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2;?[^\S\n]*$/gm, (_whole, clause, _q, spec) => {
    const call = "__req('" + spec + "')";
    const c = clause.trim();
    const braced = c.match(/\{([\s\S]*)\}/);
    const defaultPart = c.replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim();
    const parts = [];
    if (defaultPart && /^[A-Za-z_$][\w$]*$/.test(defaultPart)) {
      parts.push('const ' + defaultPart + ' = (' + call + ' && ' + call + '.default) ? ' + call + '.default : ' + call + ';');
    }
    if (braced) {
      const bindings = braced[1].split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
        const [orig, alias] = p.replace(/^type\s+/, '').split(/\s+as\s+/).map((s) => s.trim());
        return alias ? orig + ': ' + alias : orig;
      });
      if (bindings.length) parts.push('const { ' + bindings.join(', ') + ' } = ' + call + ' || {};');
    } else if (!parts.length) {
      parts.push('const __side = ' + call + ';');
    }
    return parts.join(' ');
  });
  out = out.replace(/^import\s+(['"])([^'"]+)\1;?[^\S\n]*$/gm, "__req('$2');");
  out = out.replace(/^export\s+default\s+/gm, 'const __default = ');
  out = out.replace(/^export\s+/gm, '');
  return out;
}

function loadModule(file, requested = []) {
  const id = path.resolve(file);
  if (moduleCache.has(id)) return moduleCache.get(id);
  const exports = {};
  moduleCache.set(id, exports);
  const names = requested.length ? requested : topLevelExports(fs.readFileSync(id, 'utf8'));
  const shim = names.map((n) => 'exports[' + JSON.stringify(n) + '] = ' + n + ';').join('\n');
  const code = rewrite(fs.readFileSync(id, 'utf8')) + '\n' + shim;
  const factory = new Function('exports', 'module', '__req', code);
  factory(exports, { exports }, (spec) => requireSpec(spec, id));
  return exports;
}

// The names a file exports, read from its `export` statements — so a module
// can publish what the loader needs without a hand-maintained list.
function topLevelExports(text) {
  const names = [];
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const piece of m[1].split(',')) {
      const alias = piece.trim().split(/\s+as\s+/).pop();
      if (/^[A-Za-z_$][\w$]*$/.test(alias)) names.push(alias);
    }
  }
  return names;
}

const BARE_STUBS = {
  preact: () => STUBS.preact,
  'preact/hooks': () => STUBS['preact/hooks'],
  '@preact/signals': () => STUBS['@preact/signals']
};

function requireSpec(spec, fromFile) {
  if (spec.startsWith('.')) {
    const id = resolveLocal(spec, fromFile);
    if (!id) return {};
    if (/[\\/]api\.js$/.test(id)) {
      const apiSource = fs.readFileSync(id, 'utf8');
      // The real api.js imports @preact/signals; give the component the stub
      // fetchJson so requests are observable.
      return { fetchJson: API_STUB.fetchJson, loadApp: API_STUB.loadApp, saveApp: API_STUB.saveApp, appProviders: () => [], loadAccounts: async () => ({}) };
    }
    return loadModule(id);
  }
  if (BARE_STUBS[spec]) return BARE_STUBS[spec]();
  return emptyStub();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Render the view the way the page's own harness does: reset the hook cursor
// each call so slots line up, but keep the state the handlers wrote (only a
// `fresh` render re-initializes).
function renderView(view, props, { fresh = false } = {}) {
  CURSOR = 0;
  if (fresh) resetRender();
  const out = view(props);
  FIRST = false;
  return out;
}

async function run() {
  const registryFile = path.join(SRC, 'components/SettingsMcpRegistry.jsx');
  const exports = loadModule(registryFile);
  const view = exports.SettingsMcpRegistryView;
  assert.equal(typeof view, 'function', 'the store view exports a component');

  const projectDir = '/fixture/project';
  renderView(view, { projectDir }, { fresh: true });
  const searchBox = NODES.find((n) => n.attrs && n.attrs['aria-label'] === 'Search the MCP store');
  assert.ok(searchBox, 'the store renders its search field');
  EFFECTS.slice().forEach((effect) => effect());
  await sleep(30);

  assert.ok(REQUESTS.some((u) => u.startsWith('/api/mcp/registry')),
    'the store loads registry results; it asked for ' + JSON.stringify(REQUESTS));
  assert.ok(REQUESTS.some((u) => u === '/api/mcp/servers?projectDir=' + encodeURIComponent(projectDir)),
    'the project-scoped configured-server request carries projectDir; it asked for ' + JSON.stringify(REQUESTS));

  // Type a query and let the debounce fire: the store must send it to the
  // registry endpoint. This is the search the feature is built around.
  REQUESTS.length = 0;
  searchBox.attrs.onInput({ target: { value: 'github' } });
  renderView(view, { projectDir });
  EFFECTS.slice().forEach((effect) => effect());
  await sleep(500); // > SEARCH_DEBOUNCE_MS

  assert.ok(REQUESTS.some((u) => u.includes('search=github')),
    'typing sends a registry search request; it asked for ' + JSON.stringify(REQUESTS));

  console.log('PASS MCP store requests results and search (registry + project-scoped configured servers)');
}

run().catch((e) => {
  console.error('FAIL ' + (e && e.stack || e));
  process.exit(1);
});
