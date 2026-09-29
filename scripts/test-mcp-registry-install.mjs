// Unit tests for frontend/src/components/settings/mcpRegistryInstall.js —
// the pure helpers behind the MCP store's install sheet.
import assert from 'node:assert/strict';
import {
  friendlyName, publisher, installOptions, summary, missingRequired,
  buildServerBody, findInstalled, relativeDate, isTemplate, fieldValue
} from '../frontend/src/components/settings/mcpRegistryInstall.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
}

const npmEntry = { server: {
  name: 'io.github.acme/weather-mcp',
  packages: [{ registryType: 'npm', identifier: '@acme/weather', version: '1.2.0', transport: { type: 'stdio' },
    environmentVariables: [
      { name: 'WEATHER_KEY', isRequired: true, isSecret: true, description: 'API key' },
      { name: 'UNITS', default: 'metric' },
      { name: 'EMPTY_OPT' }
    ] }]
} };
const remoteEntry = { server: {
  name: 'ai.example/search', title: 'Example Search',
  remotes: [
    { type: 'sse', url: 'https://example.ai/sse' },
    { type: 'streamable-http', url: 'https://example.ai/mcp', headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] }
  ]
} };

check('friendlyName prefers title, else humanises the last segment', () => {
  assert.equal(friendlyName(remoteEntry), 'Example Search');
  assert.equal(friendlyName(npmEntry), 'Weather mcp');
  assert.equal(publisher(npmEntry), 'io.github.acme');
});

check('npm package -> npx -y pkg@version with env fields', () => {
  const [o] = installOptions(npmEntry);
  assert.equal(o.kind, 'local');
  assert.equal(o.supported, true);
  assert.equal(o.command, 'npx');
  assert.deepEqual(o.args, ['-y', '@acme/weather@1.2.0']);
  assert.deepEqual(o.fields.map((f) => [f.name, f.required, f.secret, f.value]),
    [['WEATHER_KEY', true, true, ''], ['UNITS', false, false, 'metric'], ['EMPTY_OPT', false, false, '']]);
});

check('pypi uses uvx; oci uses docker run with -e forwards', () => {
  const py = installOptions({ server: { packages: [{ registryType: 'pypi', identifier: 'armor-mcp', transport: { type: 'stdio' } }] } })[0];
  assert.deepEqual([py.command, py.args], ['uvx', ['armor-mcp']]);
  const oci = installOptions({ server: { packages: [{ registryType: 'oci', identifier: 'ghcr.io/a/b:0.1', transport: { type: 'stdio' },
    environmentVariables: [{ name: 'TOKEN' }],
    packageArguments: [{ type: 'positional', value: 'serve' }, { type: 'named', name: '--transport', value: 'stdio' }] }] } })[0];
  assert.equal(oci.command, 'docker');
  assert.deepEqual(oci.args, ['run', '-i', '--rm', '-e', 'TOKEN', 'ghcr.io/a/b:0.1', 'serve', '--transport', 'stdio']);
});

check('streamable-http leads; sse is installable as the legacy transport', () => {
  const opts = installOptions(remoteEntry);
  assert.equal(opts[0].url, 'https://example.ai/mcp');
  assert.equal(opts[0].supported, true);
  assert.equal(opts[0].transport, 'http');
  assert.equal(opts[1].supported, true);
  assert.equal(opts[1].transport, 'sse');
  assert.match(opts[1].reason, /SSE/);
  const body = buildServerBody(opts[1], { name: 'S', scope: 'app' });
  assert.equal(body.transport, 'sse');
  assert.equal(body.url, 'https://example.ai/sse');
});

check('summary reports hosted/local and a needed key', () => {
  assert.deepEqual(summary(npmEntry), { kind: 'local', runtime: 'Node.js (npx)', needsKey: true, supported: true, option: installOptions(npmEntry)[0] });
  assert.equal(summary(remoteEntry).kind, 'remote');
  assert.equal(summary({ server: {} }).supported, false);
  assert.equal(summary({ server: {} }).option, null);
});

// A registry value can be a `{token}` template (KeyValueInput.value with a
// `variables` map). mouaif cannot resolve that map, so the value must read as
// missing: the card says "Needs API key", Install stays disabled, and the
// placeholder is never written into a header.
const templateEntry = { server: {
  name: 'ai.smithery/github', title: 'Smithery GitHub',
  remotes: [{ type: 'streamable-http', url: 'https://server.smithery.ai/@smithery-ai/github/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer {smithery_api_key}', isRequired: true, isSecret: true }] }]
} };

check('a {token} value is a placeholder, not a value', () => {
  const [o] = installOptions(templateEntry);
  assert.equal(o.fields[0].value, 'Bearer {smithery_api_key}');
  assert.equal(o.fields[0].template, true);
  assert.equal(isTemplate('Bearer {token}'), true);
  assert.equal(isTemplate('Bearer abc123'), false);
  assert.equal(fieldValue(o.fields[0]), '');
  assert.equal(fieldValue(o.fields[0], { Authorization: ' Bearer real ' }), 'Bearer real');
  assert.deepEqual(missingRequired(o, {}), ['Authorization']);
});

check('summary flags a template-only key, and prefers the option with nothing to fill', () => {
  const s = summary(templateEntry);
  assert.equal(s.needsKey, true);
  assert.equal(s.option.fields[0].template, true);
  // A hosted endpoint that asks for a key loses to one that does not.
  const mixed = { server: { name: 'io.x/mixed', remotes: [
    { type: 'streamable-http', url: 'https://a.example/mcp', headers: [{ name: 'X-Api-Key', value: '{key}', isRequired: true }] },
    { type: 'streamable-http', url: 'https://b.example/mcp' }
  ] } };
  assert.equal(summary(mixed).option.url, 'https://b.example/mcp');
  assert.equal(summary(mixed).needsKey, false);
});

check('buildServerBody omits a template value instead of sending it', () => {
  const [o] = installOptions(templateEntry);
  const body = buildServerBody(o, { name: 'Smithery GitHub', scope: 'app' });
  assert.deepEqual(body.headers, {});
  assert.equal(body.url, 'https://server.smithery.ai/@smithery-ai/github/mcp');
  const typed = buildServerBody(o, { name: 'S', scope: 'app', values: { Authorization: 'Bearer tk' } });
  assert.deepEqual(typed.headers, { Authorization: 'Bearer tk' });
});

check('missingRequired and buildServerBody (stdio)', () => {
  const [o] = installOptions(npmEntry);
  assert.deepEqual(missingRequired(o, {}), ['WEATHER_KEY']);
  assert.deepEqual(missingRequired(o, { WEATHER_KEY: 'k' }), []);
  const body = buildServerBody(o, { name: 'Weather', scope: 'project', projectDir: '/p', values: { WEATHER_KEY: ' k ' } });
  assert.deepEqual(body, { projectDir: '/p', scope: 'project', name: 'Weather', transport: 'stdio',
    command: 'npx', args: ['-y', '@acme/weather@1.2.0'], env: { WEATHER_KEY: 'k', UNITS: 'metric' } });
  assert.equal(buildServerBody(o, { name: 'W', scope: 'project', projectDir: '' }).scope, 'app');
});

check('buildServerBody (http) with headers, and OAuth drops Authorization', () => {
  const [o] = installOptions(remoteEntry);
  const plain = buildServerBody(o, { name: 'S', scope: 'app', values: { Authorization: 'Bearer x' } });
  assert.deepEqual(plain.headers, { Authorization: 'Bearer x' });
  assert.equal(plain.url, 'https://example.ai/mcp');
  const oauth = buildServerBody(o, { name: 'S', scope: 'app', values: { Authorization: 'Bearer x' }, oauth: true });
  assert.deepEqual(oauth.headers, {});
  assert.deepEqual(oauth.oauth, { enabled: true, clientId: '', scope: '' });
});

check('findInstalled matches by URL or package id', () => {
  assert.equal(findInstalled(remoteEntry, [{ id: 'a', url: 'https://example.ai/mcp/' }]).id, 'a');
  assert.equal(findInstalled(npmEntry, [{ id: 'b', args: ['-y', '@acme/weather@1.0.0'] }]).id, 'b');
  assert.equal(findInstalled(npmEntry, [{ id: 'c', args: ['@acme/weather-extra'] }]), null);
});

check('relativeDate', () => {
  const now = Date.parse('2026-01-31T00:00:00Z');
  assert.equal(relativeDate('2026-01-31T00:00:00Z', now), 'today');
  assert.equal(relativeDate('2026-01-28T00:00:00Z', now), '3 days ago');
  assert.equal(relativeDate('2025-10-31T00:00:00Z', now), '3 months ago');
  assert.equal(relativeDate('', now), '');
});

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
