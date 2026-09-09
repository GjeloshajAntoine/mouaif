// Exercise the existing serve handlers on an isolated ephemeral server.
// Never start/stop the host-managed CLI or read/write user settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-hidden-http-'));
process.env.MOUAIF_HOME = path.join(root, 'home');
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const projectDir = path.join(root, 'project');
fs.mkdirSync(projectDir);
const original = 'public line\nprivate fixture line\nlast line';
fs.writeFileSync(path.join(projectDir, 'sample.txt'), original);
const require = createRequire(import.meta.url);
const server = require('../src/index.js').createServer(0);
const { runFileTool } = require('../src/tools/files.js');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
async function request(endpoint, body) {
  const response = await fetch(base + endpoint, body ? {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  } : undefined);
  return { status: response.status, body: await response.json() };
}
try {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  const html = await home.text();
  const script = html.match(/src="(\/assets\/index-[^"]+\.js)"/)[1];
  assert.equal((await fetch(base + script)).status, 200, 'serve delivers built entry');
  const endpoint = '/api/settings/hide-file-content';
  const qs = '?' + new URLSearchParams({ projectDir });
  assert.deepEqual((await request(endpoint + qs)).body.rules, []);
  const rules = [{ path: 'sample.txt', ranges: [{ start: 2, end: 2 }] }];
  const saved = await request(endpoint, { projectDir, rules });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.rules, rules);
  assert.deepEqual((await request(endpoint + qs)).body.rules, rules);
  const preview = await request('/api/file?' + new URLSearchParams({ projectDir, path: 'sample.txt' }));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.content, original, 'owner preview sees the original');
  const read = await runFileTool('read_file', { projectDir, args: { path: 'sample.txt', startLine: 2, endLine: 2 } });
  assert.equal(read.result.body, '[hidden]', 'agent sliced read does not see original');
  const search = await runFileTool('search_files', { projectDir, args: { query: 'private fixture' } });
  assert.equal(search.result.matches.length, 0);
  assert.equal(fs.readFileSync(path.join(projectDir, 'sample.txt'), 'utf8'), original, 'redaction never changes the file');
  assert.equal((await request(endpoint, { projectDir, rules: [] })).status, 200);
  assert.deepEqual((await request(endpoint + qs)).body.rules, []);
  console.log('PASS serve entry/assets, redaction API save/reload/remove, original owner preview and filtered agent tools');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
