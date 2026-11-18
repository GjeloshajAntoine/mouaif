// Unit + component-render tests for the MCP management workspace:
//   - JSON import/export helpers (Claude/Cursor mcpServers, VS Code/.mcp.json servers,
//     bare snippets, single-server objects, secret redaction)
//   - Server summary + search/status/scope filtering
//   - SettingsMcpView & SettingsMcpEditView scoped rendering (no missing imports,
//     root <section> scroll container, inline permissions, discovered tools drawer,
//     and runtime controls in the editor)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  coerceImportedServer,
  filterMcpServers,
  parseMcpJson,
  serializeMcpServersJson,
  serverTargetSummary,
  summarizeMcpServers
} from '../frontend/src/components/settings/mcpJsonImport.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'frontend', 'src');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && (e.stack || e.message)));
  }
}

// ---- 1. JSON parsing & export -------------------------------------------

check('parseMcpJson handles Claude/Cursor mcpServers object', () => {
  const res = parseMcpJson(`{
    "mcpServers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        "env": { "LOG_LEVEL": "debug", "RETRIES": 3 }
      },
      "remote-docs": {
        "url": "https://docs.example.com/mcp",
        "headers": { "Authorization": "Bearer secret-token" }
      }
    }
  }`);
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
  assert.equal(res.servers.length, 2);
  assert.deepEqual(res.servers[0], {
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    env: { LOG_LEVEL: 'debug', RETRIES: '3' }
  });
  assert.deepEqual(res.servers[1], {
    name: 'remote-docs',
    transport: 'http',
    url: 'https://docs.example.com/mcp',
    headers: { Authorization: 'Bearer secret-token' }
  });
});

check('parseMcpJson handles VS Code servers map, .mcp.json servers array, and bare key:value snippet', () => {
  const vscode = parseMcpJson(`{
    "servers": {
      "legacy-sse": { "type": "sse", "url": "https://legacy.example.com/events" }
    }
  }`);
  assert.equal(vscode.ok, true);
  assert.equal(vscode.servers[0].transport, 'sse');
  assert.equal(vscode.servers[0].url, 'https://legacy.example.com/events');

  const mouaifArr = parseMcpJson(`{
    "servers": [
      { "name": "git", "command": "uvx", "args": ["mcp-server-git"] }
    ],
    "authorization": { "mode": "ask" }
  }`);
  assert.equal(mouaifArr.ok, true);
  assert.equal(mouaifArr.servers.length, 1);
  assert.equal(mouaifArr.servers[0].name, 'git');

  const snippet = parseMcpJson(`"github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },`);
  assert.equal(snippet.ok, true);
  assert.equal(snippet.servers[0].name, 'github');
  assert.equal(snippet.servers[0].command, 'npx');
});

check('parseMcpJson reports invalid JSON and missing required fields cleanly', () => {
  const bad = parseMcpJson('{ broken json ');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors[0].includes('Invalid JSON'));

  const missingCmd = coerceImportedServer({ args: ['a'] }, 'broken-srv');
  assert.equal(missingCmd.ok, false);
  assert.match(missingCmd.error, /broken-srv.*command/);

  const badProto = coerceImportedServer({ url: 'ftp://example.com/mcp' }, 'ftp-srv');
  assert.equal(badProto.ok, false);
  assert.match(badProto.error, /http:\/\/ or https:\/\//);
});

check('serializeMcpServersJson redacts configured secret values into placeholders', () => {
  const json = serializeMcpServersJson([
    {
      name: 'GitHub',
      slug: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@mcp/github'],
      env: { GITHUB_TOKEN: { configured: true } }
    },
    {
      name: 'Remote',
      slug: 'remote',
      transport: 'http',
      url: 'https://api.example.com/mcp',
      headers: { Authorization: { configured: true } },
      oauth: { enabled: true, clientId: 'cid-1' }
    }
  ]);
  const parsed = JSON.parse(json);
  assert.equal(parsed.mcpServers.github.env.GITHUB_TOKEN, '<GITHUB_TOKEN>');
  assert.equal(parsed.mcpServers.remote.headers.Authorization, '<Authorization>');
  assert.equal(parsed.mcpServers.remote.oauth.clientId, 'cid-1');
});

// ---- 2. Summaries & filtering -------------------------------------------

check('summarizeMcpServers and filterMcpServers match servers, tools, status, and off state', () => {
  const servers = [
    {
      id: '1', name: 'Filesystem', slug: 'filesystem', scope: 'app', status: 'ready',
      command: 'npx', args: ['-y', '@mcp/fs'],
      tools: [{ name: 'read_text', composedName: 'mcp__filesystem__read_text', description: 'Read a file' }]
    },
    {
      id: '2', name: 'Postgres', slug: 'postgres', scope: 'project', status: 'errored',
      command: 'uvx', args: ['mcp-postgres'],
      tools: []
    },
    {
      id: '3', name: 'Disabled Srv', slug: 'disabled_srv', scope: 'project', status: 'stopped',
      transport: 'http', url: 'https://disabled.example/mcp',
      tools: [{ name: 'ping', composedName: 'mcp__disabled_srv__ping' }]
    }
  ];
  const mcpAuth = { mode: 'ask', servers: { disabled_srv: { mode: 'off' } }, tools: {} };
  const stats = summarizeMcpServers(servers, mcpAuth);
  assert.deepEqual(stats, {
    total: 3, ready: 1, starting: 0, errored: 1, stopped: 1, off: 1, tools: 2, appCount: 1, projectCount: 2
  });
  assert.equal(serverTargetSummary(servers[0]), 'npx -y @mcp/fs');
  assert.equal(serverTargetSummary(servers[2]), 'https://disabled.example/mcp');

  assert.deepEqual(filterMcpServers(servers, { filter: 'ready', mcpAuth }).map((s) => s.id), ['1']);
  assert.deepEqual(filterMcpServers(servers, { filter: 'errored', mcpAuth }).map((s) => s.id), ['2']);
  assert.deepEqual(filterMcpServers(servers, { filter: 'off', mcpAuth }).map((s) => s.id), ['3']);
  assert.deepEqual(filterMcpServers(servers, { filter: 'app', mcpAuth }).map((s) => s.id), ['1']);
  assert.deepEqual(filterMcpServers(servers, { filter: 'project', mcpAuth }).map((s) => s.id), ['2', '3']);
  assert.deepEqual(filterMcpServers(servers, { search: 'read_text', mcpAuth }).map((s) => s.id), ['1']);
});

// ---- 3. Scoped module loader & component render checks ------------------

function rewriteImports(text) {
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
        const [orig, alias] = p.split(/\s+as\s+/).map((s) => s.trim());
        return alias ? orig + ': ' + alias : orig;
      });
      if (bindings.length) parts.push('const { ' + bindings.join(', ') + ' } = ' + call + ' || {};');
    }
    return parts.join(' ');
  });
  out = out.replace(/^import\s+(['"])([^'"]+)\1;?[^\S\n]*$/gm, '');
  out = out.replace(/^export\s+/gm, '');
  return out;
}

function topExports(text) {
  const names = [];
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  return names;
}

function createScopedHarness(fetchImpl) {
  let nodes = [], states = [], cursor = 0, first = true, effects = [];
  const cache = new Map();

  const preactStub = {
    h(tag, attrs, ...children) {
    if (typeof tag === 'function') {
      const out = tag(Object.assign({}, attrs || {}, { children }));
      return out;
    }
    const node = { tag, attrs: attrs || {}, children };
    nodes.push(node);
    return node;
    },
    Fragment: 'fragment'
  };
  const hooksStub = {
    useState(init) {
      const i = cursor++;
      if (first) states[i] = typeof init === 'function' ? init() : init;
      return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }];
    },
    useEffect(fn) { effects.push(fn); },
    useRef(v) { const i = cursor++; if (first) states[i] = { current: v }; return states[i]; },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; }
  };

  function resolveLocal(spec, fromFile) {
    if (spec.endsWith('.css')) return '__css__';
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const c of [base, base + '.js', base + '.jsx']) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    throw new Error('Unresolved import ' + spec + ' from ' + fromFile);
  }

  function loadFile(absFile) {
    if (cache.has(absFile)) return cache.get(absFile);
    const exports = {};
    cache.set(absFile, exports);
    const raw = fs.readFileSync(absFile, 'utf8');
    const names = topExports(raw);
    const body = rewriteImports(raw) + '\n' + names.map((n) => `exports[${JSON.stringify(n)}] = ${n};`).join('\n');
    const fn = new Function('exports', '__req', body);
    fn(exports, (spec) => {
      if (spec === 'preact') return preactStub;
      if (spec === 'preact/hooks') return hooksStub;
      const resolved = resolveLocal(spec, absFile);
      if (resolved === '__css__') return {};
      if (/[\\/]api\.js$/.test(resolved)) {
        return {
          fetchJson: fetchImpl,
          setActiveProject() {},
          activeProject: { value: { dir: '/workspace/demo' } }
        };
      }
      if (/[\\/]router\.js$/.test(resolved)) {
        return { nav() {}, back() {}, replace() {} };
      }
      return loadFile(resolved);
    });
    return exports;
  }

  return {
    loadFile,
    render(View, props, { fresh = false } = {}) {
      cursor = 0;
      nodes = [];
      effects = [];
      if (fresh) { first = true; states = []; }
      const tree = View(props);
      first = false;
      return { tree, nodes, runEffects: () => effects.forEach((fn) => fn()) };
    }
  };
}

const sampleServers = [
  {
    id: 'srv1', name: 'GitHub', slug: 'github', scope: 'app', status: 'ready',
    transport: 'stdio', command: 'npx', args: ['-y', '@mcp/github'],
    env: { GITHUB_TOKEN: { configured: true } }, headers: {},
    tools: [
      { name: 'list_issues', composedName: 'mcp__github__list_issues', description: 'List repo issues' }
    ]
  },
  {
    id: 'srv2', name: 'Local DB', slug: 'local_db', scope: 'project', status: 'errored',
    transport: 'stdio', command: 'node', args: ['db-mcp.js'],
    env: {}, headers: {},
    error: { code: 'EMCP_START', message: 'Connection closed' },
    stderr: { text: 'Error: missing DB_URL', truncated: false },
    tools: []
  }
];

const h1 = createScopedHarness(async (url) => {
  if (String(url).startsWith('/api/mcp/servers')) return { status: 200, body: { servers: sampleServers } };
  if (String(url).startsWith('/api/tools/authorization')) {
    return { status: 200, body: { mcp: { mode: 'ask', allowlist: [], servers: { github: { mode: 'allow' } }, tools: {} } } };
  }
  if (String(url).startsWith('/api/projects/registered')) {
    return { status: 200, body: { projects: [{ id: 'p1', name: 'Demo', path: '/workspace/demo' }] } };
  }
  return { status: 200, body: {} };
});

const mcpMod = h1.loadFile(path.join(SRC, 'components/SettingsMcp.jsx'));
const editMod = h1.loadFile(path.join(SRC, 'components/SettingsMcpEdit.jsx'));

let r1 = h1.render(mcpMod.SettingsMcpView, { projectDir: '/workspace/demo', chatId: 'c1', from: 'projects' }, { fresh: true });
r1.runEffects();
await new Promise((r) => setTimeout(r, 20));
r1 = h1.render(mcpMod.SettingsMcpView, { projectDir: '/workspace/demo', chatId: 'c1', from: 'projects' });

check('Project MCP keeps server cards and tools without a scope switcher', () => {
  assert.ok(!r1.nodes.some((n) => n.attrs?.['aria-label'] === 'MCP scope'));
  assert.ok(r1.nodes.some((n) => n.tag === 'a' && n.attrs?.href?.includes('/mcp/new?projectDir=')));
  const hasBrowse = r1.nodes.some((n) => n.tag === 'a' && String(n.children).includes('Browse store'));
  const hasImportBtn = r1.nodes.some((n) => n.tag === 'button' && String(n.children).includes('Import JSON'));
  const hasDefaultPerm = r1.nodes.some((n) => n.attrs && n.attrs['aria-label'] === 'Project MCP default authorization');
  const hasRowPerm = r1.nodes.some((n) => n.attrs && n.attrs['aria-label'] === 'GitHub authorization');
  assert.ok(hasBrowse, 'renders Browse store button');
  assert.ok(hasImportBtn, 'renders Import JSON button');
  assert.ok(hasDefaultPerm, 'renders default MCP permission control');
  assert.ok(hasRowPerm, 'renders per-server MCP permission control');

  // Expand tools drawer on srv1
  const toggleBtn = r1.nodes.find((n) => n.tag === 'button' && String(n.attrs.class || '').includes('mcp__tools-toggle'));
  assert.ok(toggleBtn, 'renders inline tools drawer toggle');
  toggleBtn.attrs.onClick();
  const rExpanded = h1.render(mcpMod.SettingsMcpView, { projectDir: '/workspace/demo', chatId: 'c1', from: 'projects' });
  const hasToolItem = rExpanded.nodes.some((n) => n.tag === 'code' && String(n.children).includes('list_issues'));
  assert.ok(hasToolItem, 'expanding tools drawer lists discovered tools inline');
});

check('App MCP stays app-wide even with an active project', () => {
  const app = h1.render(mcpMod.SettingsMcpView, {}, { fresh: true });
  assert.ok(!app.nodes.some((n) => n.attrs?.['aria-label'] === 'MCP scope'));
  assert.ok(app.nodes.some((n) => n.tag === 'a' && n.attrs?.href === '#/settings/mcp/new?scope=app'));
  const editor = h1.render(editMod.SettingsMcpEditView, { scope: 'project' }, { fresh: true });
  assert.ok(!editor.nodes.some((n) => n.attrs?.['aria-label'] === 'Server scope'));
  assert.ok(editor.nodes.some((n) => n.tag === 'a' && n.attrs?.href === '#/settings/mcp?scope=app'));
});

let rEdit = h1.render(editMod.SettingsMcpEditView, { id: 'srv1', projectDir: '/workspace/demo', scope: 'app' }, { fresh: true });
rEdit.runEffects();
await new Promise((r) => setTimeout(r, 20));
rEdit = h1.render(editMod.SettingsMcpEditView, { id: 'srv1', projectDir: '/workspace/demo', scope: 'app' });

check('SettingsMcpEditView renders runtime card, server permission, and discovered tools even for app-scoped server in a project', () => {
  const hasRestart = rEdit.nodes.some((n) => n.tag === 'button' && String(n.children).includes('Restart'));
  const hasCopyJson = rEdit.nodes.some((n) => n.tag === 'button' && String(n.children).includes('Copy JSON'));
  const hasToolRow = rEdit.nodes.some((n) => String(n.attrs && n.attrs.class || '').includes('mcp__tools-row'));
  assert.ok(hasRestart, 'editor shows Restart / Start lifecycle button');
  assert.ok(hasCopyJson, 'editor shows Copy JSON button');
  assert.ok(hasToolRow, 'editor shows discovered tools for app-scoped server');
});

if (failed) {
  console.error(failed + ' test(s) failed');
  process.exit(1);
}
console.log('PASS MCP management UI tests');
